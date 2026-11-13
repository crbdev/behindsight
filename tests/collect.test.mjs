// End-to-end tests of the collector and the investigation tool against a local test site.
// They need the skill's dependencies and Playwright's Chromium (scripts/setup.sh); without them they are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/behindsight');
const script = (name) => path.join(SKILL, 'scripts', name);
const run = (file, args, env = {}) => new Promise((resolve) => execFile('node', [file, ...args], { env: { ...process.env, ...env }, timeout: 170000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));

const hasDeps = existsSync(path.join(SKILL, 'node_modules/playwright'));
const hasBrowser = hasDeps && (await run(script('check.mjs'), [])).code === 0;
const browser = { skip: hasBrowser ? false : 'Playwright and its Chromium are not installed' };
const deps = { skip: hasDeps ? false : 'the skill dependencies are not installed' };

const page = (extra = '') => `<html><head><title>Acme | Widgets</title></head><body><nav><a href="/pricing">Pricing</a></nav><h1>Acme widgets</h1><p>${'Widgets for busy teams. '.repeat(80)}</p>${extra}</body></html>`;
const challenge = '<html><head><title>Just a moment...</title></head><body><h1>Verifying you are human</h1><p>This may take a few seconds.</p></body></html>';

// A local site whose routes are given per test. Returns its origin and a count of requests per path prefix.
async function site(routes) {
  const hits = {};
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = Object.keys(routes).find((k) => (k.endsWith('*') ? url.pathname.startsWith(k.slice(0, -1)) : url.pathname === k));
    hits[key] = (hits[key] || 0) + 1;
    const [status, type, body] = key ? routes[key](server.address().port) : [404, 'text/plain', 'not found'];
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { origin: `http://localhost:${server.address().port}`, hits, close: () => new Promise((resolve) => server.close(resolve)) };
}
// Width and height of a JPEG, read from its frame header.
function jpegSize(buf) {
  for (let i = 2; i < buf.length;) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const collect = async (origin, extra = []) => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'behindsight-collect-')), 'out');
  const result = await run(script('collect.mjs'), [origin, '--out', out, '--no-wappalyzer', '--no-ads', '--no-seo', '--no-jobs', '--no-history', '--no-content', '--wait', '200', ...extra]);
  const collected = existsSync(path.join(out, 'collected.json')) ? JSON.parse(await readFile(path.join(out, 'collected.json'), 'utf8')) : null;
  return { ...result, out, collected };
};

test('a homepage that answers with HTTP 403 stops the run and writes no evidence', browser, async () => {
  const s = await site({ '/*': () => [403, 'text/html', challenge] });
  const r = await collect(s.origin);
  await s.close();
  assert.equal(r.code, 2);
  assert.equal(r.collected, null);
  assert.match(r.stderr, /HTTP 403/);
});

test('a bot-challenge homepage served with status 200 stops the run', browser, async () => {
  const s = await site({ '/*': () => [200, 'text/html', challenge] });
  const r = await collect(s.origin);
  await s.close();
  assert.equal(r.code, 2);
  assert.equal(r.collected, null);
});

test('--force collects a blocked homepage anyway', browser, async () => {
  const s = await site({ '/*': () => [403, 'text/html', challenge] });
  const r = await collect(s.origin, ['--force']);
  await s.close();
  assert.equal(r.code, 0);
  assert.equal(r.collected.pages[0].status, 403);
});

test('a blocked inner page is recorded as failed, not as evidence', browser, async () => {
  const s = await site({ '/': () => [200, 'text/html', page()], '/pricing': () => [403, 'text/html', challenge] });
  const r = await collect(s.origin);
  await s.close();
  const pricing = r.collected.pages.find((p) => p.kind === 'pricing');
  assert.match(pricing.error, /HTTP 403/);
  assert.equal(pricing.file, null);
  assert.equal(pricing.screenshot, null);
  assert.match(await readFile(path.join(r.out, 'summary.md'), 'utf8'), /pricing: .*FAILED/);
});

test('each captured page gets a screenshot of the top of the page', browser, async () => {
  const s = await site({ '/': () => [200, 'text/html', page()], '/pricing': () => [200, 'text/html', page('<p>Pro $12/mo</p>')] });
  const r = await collect(s.origin);
  await s.close();
  assert.deepEqual(r.collected.pages.map((p) => p.screenshot), ['screenshots/home.jpg', 'screenshots/pricing.jpg']);
  const shot = await readFile(path.join(r.out, 'screenshots/home.jpg'));
  assert.deepEqual([shot[0], shot[1]], [0xff, 0xd8], 'a JPEG file');
  assert.deepEqual(jpegSize(shot), { width: 1080, height: 675 });
  assert.match(await readFile(path.join(r.out, 'summary.md'), 'utf8'), /screenshots\/home\.jpg/);
});

test('--no-screenshots takes none', browser, async () => {
  const s = await site({ '/': () => [200, 'text/html', page()], '/pricing': () => [200, 'text/html', page()] });
  const r = await collect(s.origin, ['--no-screenshots']);
  await s.close();
  assert.deepEqual(r.collected.pages.map((p) => p.screenshot), [null, null]);
  assert.equal(existsSync(path.join(r.out, 'screenshots')), false);
});

test('the evidence records the version of the skill that collected it', browser, async () => {
  const s = await site({ '/': () => [200, 'text/html', page()], '/pricing': () => [200, 'text/html', page()] });
  const r = await collect(s.origin, ['--no-screenshots']);
  await s.close();
  assert.equal(r.collected.version, JSON.parse(await readFile(path.join(SKILL, 'package.json'), 'utf8')).version);
});

test('a sitemap index whose files all fail is given up on quickly', browser, async () => {
  const s = await site({
    '/': () => [200, 'text/html', page()],
    '/pricing': () => [200, 'text/html', page()],
    '/robots.txt': (port) => [200, 'text/plain', `Sitemap: http://localhost:${port}/sitemap.xml\n`],
    '/sitemap.xml': (port) => [200, 'application/xml', `<sitemapindex>${Array.from({ length: 300 }, (_, i) => `<sitemap><loc>http://localhost:${port}/sm-${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`],
    '/sm-*': () => [403, 'text/html', 'Forbidden']
  });
  const r = await collect(s.origin);
  await s.close();
  assert.equal(r.code, 0);
  assert.ok(s.hits['/sm-*'] <= 60, `${s.hits['/sm-*']} requests for child sitemaps`);
  assert.equal(r.collected.sitemap.truncated, true);
});

test('a tracking request with a malformed event name does not lose the run', browser, async () => {
  const s = await site({
    '/': () => [200, 'text/html', page(`<script>fetch('/g/collect?v=2',{method:'POST',body:'en=50%_off_click'})</script>`)],
    '/pricing': () => [200, 'text/html', page()],
    '/g/collect': () => [204, 'text/plain', '']
  });
  const r = await collect(s.origin);
  await s.close();
  assert.equal(r.code, 0);
  assert.ok(r.collected.events.some((e) => e.name === '50%_off_click'));
});

test('the content sample reads posts and never loads the category pages a blog index links to', browser, async () => {
  const posts = Array.from({ length: 6 }, (_, i) => `/blog/post-${i + 1}-about-widgets/`);
  const menu = '<nav><a href="/blog/news/">News</a><a href="/blog/guides/">Guides</a></nav>';
  const listing = `<html><head><title>News</title></head><body>${menu}<main>${Array.from({ length: 14 }, (_, i) => `<a href="/blog/post-${i + 1}-about-widgets/">Post ${i + 1}</a> <time datetime="2026-10-01">Oct 1</time>`).join(' ')}</main></body></html>`;
  const s = await site({
    '/': () => [200, 'text/html', page('<nav><a href="/blog/">Blog</a></nav>')],
    '/pricing': () => [200, 'text/html', page()],
    '/blog/': () => [200, 'text/html', `<html><head><title>Blog</title></head><body>${menu}<main>${posts.map((p, i) => `<a href="${p}"><h2>Post ${i + 1} about widgets</h2></a>`).join('')}</main></body></html>`],
    '/blog/news/': () => [200, 'text/html', listing],
    '/blog/guides/': () => [200, 'text/html', listing],
    '/blog/post-*': () => [200, 'text/html', `<html><head><title>A post</title></head><body><article><h1>A post about widgets</h1><time datetime="2026-10-05">Oct 5</time><p>${'Widgets need care and regular oiling. '.repeat(60)}</p></article></body></html>`],
    '/robots.txt': (port) => [200, 'text/plain', `Sitemap: http://localhost:${port}/sitemap.xml\n`],
    '/sitemap.xml': (port) => [200, 'application/xml', `<sitemapindex><sitemap><loc>http://localhost:${port}/sitemap-posts.xml</loc></sitemap><sitemap><loc>http://localhost:${port}/sitemap-tags.xml</loc></sitemap></sitemapindex>`],
    '/sitemap-posts.xml': (port) => [200, 'application/xml', `<urlset>${posts.map((p) => `<url><loc>http://localhost:${port}${p}</loc><lastmod>2026-10-05</lastmod></url>`).join('')}</urlset>`],
    '/sitemap-tags.xml': (port) => [200, 'application/xml', `<urlset><url><loc>http://localhost:${port}/blog/news/</loc></url><url><loc>http://localhost:${port}/blog/guides/</loc></url></urlset>`]
  });
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'behindsight-content-')), 'out');
  const r = await run(script('collect.mjs'), [s.origin, '--out', out, '--no-wappalyzer', '--no-ads', '--no-seo', '--no-jobs', '--no-history', '--wait', '200', '--content-posts', '6']);
  await s.close();
  assert.equal(r.code, 0);
  const content = JSON.parse(await readFile(path.join(out, 'collected.json'), 'utf8')).content;
  assert.deepEqual(content.posts.map((p) => new URL(p.url).pathname).sort(), posts);
  assert.equal(s.hits['/blog/news/'] || 0, 0);
  assert.equal(s.hits['/blog/guides/'] || 0, 0);
});

test('--quick skips the content sample, hiring and history, and says so', browser, async () => {
  const s = await site({ '/': () => [200, 'text/html', page()], '/pricing': () => [200, 'text/html', page()] });
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'behindsight-quick-')), 'out');
  const r = await run(script('collect.mjs'), [s.origin, '--out', out, '--quick', '--no-wappalyzer', '--no-ads', '--no-seo', '--wait', '200']);
  await s.close();
  assert.equal(r.code, 0);
  const collected = JSON.parse(await readFile(path.join(out, 'collected.json'), 'utf8'));
  assert.equal(collected.mode, 'quick');
  for (const key of ['content', 'jobs', 'history']) assert.match(collected[key].skipped, /quick/);
});

test('a missing browser gives a one-line instruction, not a stack trace', deps, async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'behindsight-nobrowser-'));
  const r = await run(script('collect.mjs'), ['http://localhost:9', '--out', path.join(empty, 'out'), '--no-seo'], { PLAYWRIGHT_BROWSERS_PATH: empty });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /setup\.sh/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('the setup check fails when the browser is missing and names the fix', deps, async () => {
  const empty = await mkdtemp(path.join(tmpdir(), 'behindsight-nobrowser-'));
  const r = await run(script('check.mjs'), [], { PLAYWRIGHT_BROWSERS_PATH: empty });
  assert.equal(r.code, 1);
  assert.match(r.stdout + r.stderr, /setup\.sh/);
});

test('two investigations started at the same time are both saved, under different IDs', deps, async () => {
  // Each investigation fetches a script that takes a second to arrive, so all three are in flight together.
  const server = http.createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('/*! Example Vendor SDK */'); }, 1000));
  await new Promise((resolve) => server.listen(0, resolve));
  const dir = await mkdtemp(path.join(tmpdir(), 'behindsight-race-'));
  await writeFile(path.join(dir, 'collected.json'), JSON.stringify({ domain: 'acme.com', stack: [], investigations: [{ id: 'inv-1', tool: 'page' }] }));
  await writeFile(path.join(dir, 'network.json'), JSON.stringify([{ url: `http://localhost:${server.address().port}/sdk.js`, type: 'script' }]));
  const results = await Promise.all([1, 2, 3].map(() => run(script('investigate.mjs'), ['host', dir, 'localhost'])));
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0]);
  const saved = JSON.parse(await readFile(path.join(dir, 'collected.json'), 'utf8')).investigations;
  assert.deepEqual(saved.map((i) => i.id), ['inv-1', 'inv-2', 'inv-3', 'inv-4']);
  assert.deepEqual(saved.slice(1).map((i) => i.file), ['investigations/inv-2-host.txt', 'investigations/inv-3-host.txt', 'investigations/inv-4-host.txt']);
});
