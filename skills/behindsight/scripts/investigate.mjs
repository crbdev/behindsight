#!/usr/bin/env node
// Follow-up evidence for a teardown folder, saved as citable investigations (inv-1, inv-2, ...).
//
// Usage:
//   node scripts/investigate.mjs page <dir> <url> [--label <text>] [--click <text>]... [--select "<label>=<option>"]... [--scroll] [--wait <ms>]
//   node scripts/investigate.mjs host <dir> <host>
//   node scripts/investigate.mjs seo <dir> keywords [--url-like <pattern>] [--limit 50]
//   node scripts/investigate.mjs seo <dir> competitors --keywords "<kw1>, <kw2>, ..."
//   node scripts/investigate.mjs ads <dir> --platform google|meta|linkedin --name "<advertiser name>" [--country US]
//   node scripts/investigate.mjs content <dir> <blog-index-url> [--posts 20]
//   node scripts/investigate.mjs jobs <dir> <careers-page-or-job-board-url>

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEvents, extractPage, loadEnv, registrableDomain, siteHelpers, sleep } from './lib.mjs';
import { collectAds } from './ads.mjs';
import { cadence, collectContent, savePosts } from './content.mjs';
import { collectJobs, findBoards } from './jobs.mjs';
import { createClient, seoCredentials } from './seo.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
// Clicking any of these could submit data, buy something or create an account, which the skill never does.
const UNSAFE_CLICK = /\b(submit|send|sign ?up|register|create (an )?account|log ?in|sign ?in|buy|purchase|checkout|check out|add to (cart|bag)|place order|pay|subscribe|start (free )?trial|get started|book (a )?(demo|meeting|call)|request|download|delete|unsubscribe)\b/i;

const [command, dir, ...rest] = process.argv.slice(2);
if (!command || !dir || !existsSync(path.join(dir || '', 'collected.json'))) {
  console.error('Usage: node scripts/investigate.mjs <page|host|seo|ads|content|jobs> <teardown-dir> ... (see the header of this file)');
  process.exit(1);
}

const flags = { click: [], select: [] };
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--click') flags.click.push(rest[++i]);
  else if (a === '--select') flags.select.push(rest[++i]);
  else if (a === '--scroll') flags.scroll = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = rest[++i];
  else positional.push(a);
}

const collectedPath = path.join(dir, 'collected.json');
const collected = JSON.parse(await readFile(collectedPath, 'utf8'));
collected.investigations ||= [];
const id = `inv-${collected.investigations.length + 1}`;
const invDir = path.join(dir, 'investigations');
await mkdir(invDir, { recursive: true });
const signatures = JSON.parse(await readFile(path.join(SKILL_DIR, 'scripts/signatures.json'), 'utf8'));
const siteHost = collected.domain;
const helpers = siteHelpers({ siteHost, siteRoot: registrableDomain(siteHost), signatures });
const knownStack = new Set(collected.stack.map((s) => s.name));

async function save(record, digest) {
  collected.investigations.push({ id, at: new Date().toISOString(), ...record });
  await writeFile(collectedPath, JSON.stringify(collected, null, 2));
  console.log(`${id} saved. Cite it with evidence type "investigation" and ref "${id}".\n`);
  console.log(digest);
}

// ---------- page: capture a URL after optional clicks ----------

async function investigatePage() {
  const url = positional[0];
  if (!url) throw new Error('page needs a URL');
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (req) => {
    let post = null;
    try { post = req.postData(); } catch {}
    requests.push({ url: req.url().slice(0, 2000), type: req.resourceType(), post: post && post.length < 20000 ? post : null });
  });
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(2500);

  const readText = () => page.evaluate(() => document.body.innerText).catch(() => '');
  let before = await readText();
  const actions = [];
  async function clickText(text) {
    if (UNSAFE_CLICK.test(text)) { actions.push({ click: text, result: 'refused: could submit, buy or sign up' }); return; }
    // Sites often render hidden duplicates (mobile menus, other A/B variants); use the first visible match.
    const candidates = page.getByRole('button', { name: text }).or(page.getByRole('tab', { name: text })).or(page.getByRole('switch', { name: text }))
      .or(page.getByRole('radio', { name: text })).or(page.getByRole('option', { name: text })).or(page.getByText(text, { exact: true }));
    let target = null;
    for (let tries = 0; tries < 8 && !target; tries++) {
      for (const c of await candidates.all()) if (await c.isVisible().catch(() => false)) { target = c; break; }
      if (!target) await sleep(1000);
    }
    if (!target) { actions.push({ click: text, result: 'not found (no visible element with this text)' }); return; }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    const unsafe = await target.evaluate((el) => {
      const t = (el.closest('button, a, input') || el);
      // A button only submits when it belongs to a form; buttons default to type "submit" either way.
      return ((t.type === 'submit' || t.type === 'image') && !!t.form) || (t.tagName === 'A' && /checkout|cart|signup|register/i.test(t.href || ''));
    }).catch(() => false);
    if (unsafe) { actions.push({ click: text, result: 'refused: submit button or checkout link' }); return; }
    await target.click({ timeout: 5000 }).catch((e) => actions.push({ click: text, result: `failed: ${e.message.split('\n')[0]}` }));
    await sleep(1500);
    if (!actions.find((a) => a.click === text)) {
      // A click can hit the wrong element and change nothing; report what actually changed on the page.
      const after = await readText();
      const old = new Set(before.split('\n').map((l) => l.trim()));
      const appeared = [...new Set(after.split('\n').map((l) => l.trim()).filter((l) => l && !old.has(l)))];
      actions.push({ click: text, result: appeared.length ? 'clicked; page changed' : 'clicked; no visible change', newText: appeared.slice(0, 20) });
      before = after;
    }
  }
  for (const text of flags.click) await clickText(text);
  for (const spec of flags.select) {
    const [label, option] = spec.split('=').map((x) => x.trim());
    const selects = await page.locator('select').all();
    let done = null;
    for (const sel of selects) {
      if (!(await sel.isVisible().catch(() => false))) continue;
      const info = await sel.evaluate((el) => ({ label: (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.name || '') + ' ' + [...el.options].map((o) => o.text).join(' | '), options: [...el.options].map((o) => o.text.trim()) }));
      if (label && !info.label.toLowerCase().includes(label.toLowerCase())) continue;
      const match = info.options.find((o) => o.toLowerCase().includes(option.toLowerCase()));
      if (!match) { done = { select: spec, result: `option not found; options are ${info.options.join(' | ')}` }; break; }
      await sel.selectOption({ label: match }).catch(() => {});
      await sleep(1500);
      const after = await readText();
      const old = new Set(before.split('\n').map((l) => l.trim()));
      const appeared = [...new Set(after.split('\n').map((l) => l.trim()).filter((l) => l && !old.has(l)))];
      done = { select: spec, result: appeared.length ? `selected "${match}"; page changed` : `selected "${match}"; no visible change`, newText: appeared.slice(0, 20) };
      before = after;
      break;
    }
    if (done) { actions.push(done); continue; }
    // Custom dropdowns (a button that opens a list) aren't <select> elements: click the label, then the option.
    const n = actions.length;
    await clickText(label);
    await clickText(option);
    const opened = actions[n]?.result || '';
    const picked = actions[n + 1]?.result || '';
    actions.splice(n, 2, { select: spec, result: `custom dropdown: label ${opened}; option ${picked}`, newText: actions[n + 1]?.newText || [] });
  }
  if (flags.scroll) {
    for (let y = 0; y < 8; y++) { await page.mouse.wheel(0, 1200); await sleep(350); }
    actions.push({ scroll: true });
  }
  if (flags.wait) { await sleep(Number(flags.wait)); actions.push({ wait: Number(flags.wait) }); }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(500);
  const data = await page.evaluate(extractPage);
  const shot = `investigations/${id}.jpg`;
  await page.screenshot({ path: path.join(dir, shot), type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: 0, width: 1440, height: 2400 } }).catch(() => {});
  await browser.close();

  const textFile = `investigations/${id}.md`;
  await writeFile(path.join(dir, textFile), [`# ${data.title}`, '', `URL: ${data.url}`, `Investigation: ${id}${flags.label ? ` (${flags.label})` : ''}`, `Actions: ${JSON.stringify(actions)}`, '', data.text].join('\n'));
  await writeFile(path.join(invDir, `${id}-network.json`), JSON.stringify(requests.map(({ post, ...r }) => r), null, 1));

  const vendors = new Map();
  const events = [];
  for (const r of requests) {
    let u;
    try { u = new URL(r.url); } catch { continue; }
    const v = helpers.matchVendor(u);
    if (v) {
      const e = vendors.get(v.name) || { name: v.name, category: v.category, ids: new Set() };
      for (const i of helpers.extractIds(v, r.url)) e.ids.add(`${i.label} ${i.value}`);
      vendors.set(v.name, e);
    }
    events.push(...extractEvents(u, r.post));
  }
  const vendorList = [...vendors.values()].map((v) => ({ name: v.name, category: v.category, ids: [...v.ids], newToStack: !knownStack.has(v.name) }));
  const uniqueEvents = [...new Map(events.map((e) => [`${e.platform}|${e.name}`, e])).values()];
  const record = {
    tool: 'page', label: flags.label || null, url, finalUrl: data.url, status: resp?.status() ?? null, actions,
    file: textFile, screenshot: shot, network: `investigations/${id}-network.json`, requestCount: requests.length,
    title: data.title, h1: data.h1, h2: data.h2, ctas: data.ctas, forms: data.forms, jsonLd: data.jsonLd,
    vendors: vendorList, events: uniqueEvents
  };
  const digest = [
    `Page ${data.url} (HTTP ${record.status}), ${requests.length} requests.`,
    `Actions: ${actions.map((a) => a.click || a.select ? `${a.click ? `click "${a.click}"` : `select "${a.select}"`}: ${a.result}${a.newText?.length ? ` (new text: ${a.newText.slice(0, 10).join(' | ')})` : ''}` : a.scroll ? 'scrolled' : `waited ${a.wait}ms`).join('; ') || 'none'}`,
    `H1: ${data.h1.join(' | ')}`,
    `H2: ${data.h2.slice(0, 12).join(' | ')}`,
    `CTAs: ${data.ctas.slice(0, 12).map((c) => `"${c.text}"`).join(', ')}`,
    `Forms: ${data.forms.map((f) => `[${f.fields.join(', ')}]`).join('; ') || 'none'}`,
    `Vendors: ${vendorList.map((v) => `${v.name}${v.newToStack ? ' (NEW)' : ''}${v.ids.length ? ` ${v.ids.join(', ')}` : ''}`).join('; ')}`,
    `Events: ${uniqueEvents.map((e) => `${e.platform}:${e.name}`).join(', ') || 'none'}`,
    `Full text: ${textFile}. Screenshot: ${shot}.`
  ].join('\n');
  await save(record, digest);
}

// ---------- host: fetch an unidentified host's scripts and pull out clues ----------

async function investigateHost() {
  const host = positional[0]?.replace(/^https?:\/\//, '').split('/')[0];
  if (!host) throw new Error('host needs a host name');
  const network = existsSync(path.join(dir, 'network.json')) ? JSON.parse(await readFile(path.join(dir, 'network.json'), 'utf8')) : [];
  const hits = network.filter((r) => { try { return new URL(r.url).hostname === host; } catch { return false; } });
  const scripts = [...new Set(hits.filter((r) => r.type === 'script').map((r) => r.url))].slice(0, 3);
  const urls = scripts.length ? scripts : [...new Set(hits.map((r) => r.url))].slice(0, 2);
  const fetched = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
      const body = (await r.text()).slice(0, 400000);
      fetched.push({ url: u, status: r.status, server: r.headers.get('server'), contentType: r.headers.get('content-type'), body });
    } catch (e) {
      fetched.push({ url: u, error: e.message });
    }
  }
  // Endpoints that only accept POSTs have no script to read; reload a page that calls the host and record
  // which script sends the request and what it posts.
  const initiators = new Set();
  const payloads = [];
  const pageUrl = hits.find((h) => h.page)?.page;
  if (pageUrl) {
    const browser = await chromium.launch();
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (e) => {
      try { if (new URL(e.request.url).hostname !== host) return; } catch { return; }
      const frames = [...(e.initiator?.stack?.callFrames || []), ...(e.initiator?.stack?.parent?.callFrames || [])];
      for (const f of frames) if (f.url && !f.url.includes(host)) initiators.add(f.url);
      if (e.initiator?.url) initiators.add(e.initiator.url);
      if (e.request.postData && payloads.length < 3) payloads.push(e.request.postData.slice(0, 1500));
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(5000);
    await browser.close();
    for (const u of [...initiators].slice(0, 3)) {
      if (fetched.some((f) => f.url === u)) continue;
      try {
        const r = await fetch(u, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
        fetched.push({ url: u, status: r.status, server: r.headers.get('server'), contentType: r.headers.get('content-type'), body: (await r.text()).slice(0, 400000), initiator: true });
      } catch (e) { fetched.push({ url: u, error: e.message, initiator: true }); }
    }
  }
  const all = fetched.map((f) => f.body || '').join('\n') + '\n' + payloads.join('\n');
  const uniq = (arr, n = 15) => [...new Set(arr)].slice(0, n);
  const hints = {
    copyright: uniq(all.match(/(?:©|\(c\)|copyright)[^\n"'`]{3,80}/gi) || []),
    domainsMentioned: uniq((all.match(/\b[a-z0-9-]+\.(?:io|com|ai|net|co|app|dev|cloud)\b/gi) || []).map((d) => d.toLowerCase()).filter((d) => !d.endsWith(siteHost)), 25),
    globals: uniq((all.match(/window\.([A-Za-z_$][\w$]{2,40})\s*=/g) || []).map((g) => g.replace(/\s*=$/, ''))),
    banners: uniq(all.match(/\/\*![^*]{5,200}\*\//g) || [], 5),
    sourceMaps: uniq(all.match(/sourceMappingURL=[^\s'"]+/g) || [], 5),
    productWords: uniq((all.match(/["'`]([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)?) (?:SDK|Pixel|Tag|Analytics|Tracker|Agent)["'`]/g) || []))
  };
  const file = `investigations/${id}-host.txt`;
  await writeFile(path.join(dir, file), [`Host: ${host}`, `Requests in capture: ${hits.length}`, `Scripts that call it: ${[...initiators].join(', ') || 'none found'}`, `Payload samples:\n${payloads.join('\n---\n') || 'none'}`, '', JSON.stringify(hints, null, 2), '', ...fetched.map((f) => `--- ${f.url} (HTTP ${f.status ?? f.error}, server ${f.server || '?'}, ${f.contentType || '?'})\n${(f.body || '').slice(0, 3000)}`)].join('\n'));
  const record = { tool: 'host', host, requests: hits.length, pagesSeenOn: uniq(hits.map((h) => h.page), 10), urls, initiators: [...initiators].slice(0, 10), payloadSamples: payloads, file, hints, fetched: fetched.map(({ body, ...f }) => ({ ...f, bytes: body?.length || 0 })) };
  const digest = [
    `Host ${host}: ${hits.length} requests on ${record.pagesSeenOn.length} pages. Fetched ${fetched.length} file(s).`,
    `Scripts that call it: ${record.initiators.join(' | ') || 'none found'}`,
    `Payload samples: ${payloads.map((p) => p.slice(0, 300)).join(' || ') || 'none'}`,
    ...Object.entries(hints).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(' | ')}`),
    `Start of each file and all clues: ${file}`
  ].join('\n');
  await save(record, digest);
}

// ---------- seo: extra DataForSEO queries ----------

async function investigateSeo() {
  const env = await loadEnv(SKILL_DIR);
  const credentials = seoCredentials(env);
  if (!credentials) throw new Error('no DataForSEO credentials (see README)');
  const client = createClient({ credentials, baseUrl: env.DATAFORSEO_BASE_URL });
  const location = collected.seo?.locationCode || 2840;
  const language = collected.seo?.languageCode || 'en';
  const sub = positional[0];
  let record;
  let digest;
  if (sub === 'keywords') {
    const filters = [['ranked_serp_element.serp_item.type', '=', 'organic']];
    if (flags['url-like']) filters.push('and', ['ranked_serp_element.serp_item.relative_url', 'like', flags['url-like']]);
    const res = await client.call('ranked_keywords', { target: siteHost, location_code: location, language_code: language, limit: Number(flags.limit || 50), filters, order_by: ['ranked_serp_element.serp_item.etv,desc'] });
    const keywords = (res?.items || []).map((it) => ({
      keyword: it.keyword_data?.keyword, volume: it.keyword_data?.keyword_info?.search_volume ?? null,
      position: it.ranked_serp_element?.serp_item?.rank_group ?? null, etv: Math.round(it.ranked_serp_element?.serp_item?.etv || 0),
      url: it.ranked_serp_element?.serp_item?.relative_url || null
    }));
    record = { tool: 'seo', query: 'keywords', urlLike: flags['url-like'] || null, total: res?.total_count ?? null, keywords };
    digest = `${keywords.length} of ${record.total ?? '?'} keywords${record.urlLike ? ` on URLs like ${record.urlLike}` : ''}:\n` + keywords.slice(0, 30).map((k) => `${k.keyword} | #${k.position} | vol ${k.volume} | ~${k.etv} visits | ${k.url}`).join('\n');
  } else if (sub === 'competitors') {
    const keywords = (flags.keywords || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (keywords.length < 2) throw new Error('competitors needs --keywords with at least 2 keywords');
    const res = await client.call('serp_competitors', { keywords, location_code: location, language_code: language, item_types: ['organic'], limit: 30, order_by: ['visibility,desc'] });
    const competitors = (res?.items || []).map((c) => ({ domain: c.domain?.replace(/^www\./, ''), keywords: c.keywords_count ?? 0, avgPosition: Math.round((c.avg_position || 0) * 10) / 10, etv: Math.round(c.etv || 0) }))
      .sort((a, b) => b.keywords - a.keywords);
    record = { tool: 'seo', query: 'competitors', keywords, competitors };
    digest = `Domains ranking for ${keywords.length} keywords:\n` + competitors.slice(0, 20).map((c) => `${c.domain} | ranks for ${c.keywords} | avg pos ${c.avgPosition} | ~${c.etv} visits`).join('\n');
  } else {
    throw new Error('seo needs "keywords" or "competitors"');
  }
  record.cost = Math.round(client.cost * 10000) / 10000;
  record.errors = client.errors;
  await save(record, `${digest}\nDataForSEO cost: $${record.cost}${client.errors.length ? `\nErrors: ${client.errors.join('; ')}` : ''}`);
}

// ---------- ads: search an ad library under another advertiser name ----------

async function investigateAds() {
  const platform = flags.platform;
  if (!['google', 'meta', 'linkedin'].includes(platform) || !flags.name) throw new Error('ads needs --platform google|meta|linkedin and --name');
  const browser = await chromium.launch();
  const result = await collectAds({
    browser, userAgent: USER_AGENT, domain: siteHost, homeTitle: '', socials: collected.socials || [], country: flags.country || collected.ads?.country || 'US',
    outDir: dir, brands: [flags.name], platforms: [platform], filePrefix: `${id}-`, log: (m) => console.error('[ads]', m)
  });
  await browser.close();
  const r = result[platform];
  const { creatives, ...brief } = r;
  const record = { tool: 'ads', platform, name: flags.name, country: result.country, result: r };
  const digest = `${platform} ad library searched for "${flags.name}" (${result.country}): ${r.status}${r.note ? `. ${r.note}` : ''}\n` + JSON.stringify(brief, null, 1).slice(0, 2500);
  await save(record, digest);
}

// ---------- content: resample posts from a different blog index ----------

// Replaces the content sample (the old one is kept as contentPrevious), so content claims and
// content_posts labels cite the new posts with type "content" as usual.
async function investigateContent() {
  const indexUrl = positional[0];
  if (!indexUrl) throw new Error('content needs the blog index URL, e.g. https://example.com/news');
  const folder = new URL(indexUrl).pathname.split('/').filter(Boolean)[0];
  if (!folder) throw new Error('give the blog index URL with its folder, e.g. https://example.com/news');
  const sitemap = existsSync(path.join(dir, 'sitemap-urls.json')) ? JSON.parse(await readFile(path.join(dir, 'sitemap-urls.json'), 'utf8')) : [];
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const content = await collectContent({
    context, origin: new URL(indexUrl).origin, siteRoot: registrableDomain(siteHost), homePage: { links: [] }, indexUrl, onlyFolder: folder,
    sitemapUrls: sitemap, seoPages: collected.seo?.pages || [], recent: Number(flags.posts) || 20, log: (m) => console.error('[content]', m)
  });
  await browser.close();
  await savePosts(content, dir, helpers.slugify);
  content.cadence = cadence(content);
  if (collected.content && !collected.contentPrevious) collected.contentPrevious = collected.content;
  collected.content = content;
  const ok = content.posts.filter((p) => !p.error);
  await save({ tool: 'content', indexUrl, posts: ok.length }, `Content sample replaced: ${ok.length} posts from ${indexUrl} (source: ${content.source}). Read them in content/ and cite them with type "content".\n` +
    ok.map((p) => `- ${p.published || '?'} | ${p.title} | ${p.words} words | ${p.file}`).join('\n'));
}

// ---------- jobs: read a job board the collector missed ----------

// Takes a job board URL (jobs.ashbyhq.com/acme, boards.greenhouse.io/acme…) or a careers page to scan.
// Replaces the hiring data (the old result is kept as jobsPrevious).
async function investigateJobs() {
  const url = positional[0];
  if (!url) throw new Error('jobs needs a careers page or job board URL');
  const board = findBoards([url])[0] || null;
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US' });
  const jobs = await collectJobs({
    context, origin: new URL(url).origin, siteRoot: registrableDomain(siteHost), domain: siteHost, brands: [],
    links: board ? [] : [{ href: url, text: 'Careers' }], board, outDir: dir, slugify: helpers.slugify, log: (m) => console.error('[jobs]', m)
  });
  await browser.close();
  if (collected.jobs && !collected.jobsPrevious) collected.jobsPrevious = collected.jobs;
  collected.jobs = jobs;
  const digest = jobs.status === 'found'
    ? `Hiring data replaced: ${jobs.openRoles} open roles on ${jobs.ats} (${jobs.boardUrl}). Marketing ${jobs.byRole.marketing}, sales ${jobs.byRole.sales}, customer ${jobs.byRole.customer}. Posts in jobs/; cite them with type "jobs".`
    : `No job board read: ${jobs.status}. ${jobs.note || jobs.error || ''}`;
  await save({ tool: 'jobs', url, status: jobs.status }, digest);
}

const run = { page: investigatePage, host: investigateHost, seo: investigateSeo, ads: investigateAds, content: investigateContent, jobs: investigateJobs }[command];
if (!run) {
  console.error(`Unknown command "${command}". Use page, host, seo, ads, content or jobs.`);
  process.exit(1);
}
try {
  await run();
} catch (e) {
  console.error(`Investigation failed: ${e.message}`);
  process.exit(1);
}
