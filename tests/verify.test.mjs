// The citation checker, run as a script against a small hand-written evidence folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERIFY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/behindsight/scripts/verify.mjs');

const collected = {
  domain: 'acme.com',
  pages: [],
  stack: [
    { name: 'React', category: 'JavaScript frameworks', ids: [] },
    { name: 'Google Ads', category: 'Advertising', ids: [{ label: 'Google Ads account', value: 'AW-123456789' }] }
  ],
  otherTechnologies: [{ name: 'AMP', category: 'Miscellaneous' }],
  events: [],
  seo: {
    overview: { organic: { etv: 120000, keywords: 8400 } },
    organicKeywordsTotal: 8400,
    keywords: [
      { keyword: 'scheduling app', volume: 9900, position: 3, etv: 900 },
      { keyword: 'meeting planner', volume: 22000, position: 1, etv: 5000 }
    ],
    pages: [{ url: 'https://acme.com/blog/planning', etv: 3100, keywords: 47 }],
    competitors: [{ domain: 'rival.com', keywords: 12, avgPosition: 4.2, etv: 700 }],
    sections: [{ name: 'blog', etv: 3100, share: 63, pages: 1 }]
  }
};

async function runVerify(claims, files = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'behindsight-verify-'));
  for (const file of files) { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), 'x'); }
  const findings = JSON.stringify({ company: 'Acme', summary: 'x', at_a_glance: [], sections: { acquisition: claims } });
  await writeFile(path.join(dir, 'collected.json'), JSON.stringify(collected));
  await writeFile(path.join(dir, 'findings.json'), findings);
  await new Promise((resolve) => execFile('node', [VERIFY, dir], () => resolve()));
  const report = JSON.parse(await readFile(path.join(dir, 'verify.json'), 'utf8'));
  return { report, findings, results: report.results };
}
const claim = (type, ref, detail = '') => ({ text: 'A claim.', status: 'seen', evidence: [{ type, ref, detail }] });

test('a made-up tool whose name contains a real tool name is a problem', async () => {
  const { results } = await runVerify([claim('stack', 'Totally Invented Reactor Pixel')]);
  assert.match(results[0].problems.join(' '), /not in the detected stack/);
});

test('a one-letter or empty tool reference is a problem', async () => {
  const { results } = await runVerify([claim('stack', 'a'), claim('stack', ' ')]);
  assert.equal(results[0].problems.length, 1);
  assert.equal(results[1].problems.length, 1);
});

test('a tool whose name only starts like a detected one is a problem', async () => {
  const { results } = await runVerify([claim('stack', 'Amplitude')]);
  assert.match(results[0].problems.join(' '), /not in the detected stack/);
});

test('a detected tool passes, with or without extra words around its name', async () => {
  const { results } = await runVerify([claim('stack', 'Google Ads', 'AW-123456789'), claim('stack', 'Google Ads conversion tag'), claim('stack', 'react')]);
  assert.deepEqual(results.map((r) => r.problems), [[], [], []]);
});

test('a search number that belongs to a different keyword is flagged', async () => {
  const { results } = await runVerify([claim('seo', 'scheduling app', 'Ranks #3 with about 5,000 estimated visits')]);
  assert.deepEqual(results[0].problems, []);
  assert.match(results[0].warnings.join(' '), /5,000/);
});

test('a search number that matches the cited keyword passes cleanly', async () => {
  const { results } = await runVerify([claim('seo', 'scheduling app', 'About 900 estimated visits from 9,900 searches')]);
  assert.deepEqual(results[0].problems, []);
  assert.deepEqual(results[0].warnings, []);
});

test('a search number that appears nowhere in the data is a problem', async () => {
  const { results } = await runVerify([claim('seo', 'scheduling app', 'About 777,777 estimated visits')]);
  assert.match(results[0].problems.join(' '), /777,777/);
});

test('a number that only matches a single keyword row is flagged when the reference is generic', async () => {
  const { results } = await runVerify([claim('seo', 'keywords', 'They get 22,000 visits from llama searches')]);
  assert.deepEqual(results[0].problems, []);
  assert.match(results[0].warnings.join(' '), /22,000/);
});

test('an overall search figure passes with a generic reference', async () => {
  const { results } = await runVerify([claim('seo', 'organic overview', 'About 120,000 estimated visits from 8,400 keywords')]);
  assert.deepEqual(results[0].problems, []);
  assert.deepEqual(results[0].warnings, []);
});

test('the check records which version of the findings it ran on', async () => {
  const { report, findings } = await runVerify([claim('stack', 'React')]);
  assert.equal(report.summary.findingsHash, createHash('sha1').update(findings).digest('hex'));
});

test('a claim about something only a screenshot shows can cite the screenshot, and is flagged for a check by eye', async () => {
  const { results } = await runVerify([claim('page', 'screenshots/home.jpg', 'The logo wall reads "Dropbox, Lyft and Zendesk"')], ['screenshots/home.jpg']);
  assert.deepEqual(results[0].problems, []);
  assert.match(results[0].warnings.join(' '), /screenshots\/home\.jpg/);
});

test('citing a screenshot that was not taken is a problem', async () => {
  const { results } = await runVerify([claim('page', 'screenshots/pricing.jpg', 'Three plan cards')]);
  assert.match(results[0].problems.join(' '), /screenshots\/pricing\.jpg/);
});
