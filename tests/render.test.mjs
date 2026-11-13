// The renderer, run as a script against copies of the published example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = path.join(ROOT, 'skills/behindsight/scripts/render.mjs');
const EXAMPLE = path.join(ROOT, 'examples/calendly.com');

// A copy of the example, optionally with changed collected.json or verify.json, rendered.
async function render({ collected, verify, args = [] } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'behindsight-render-'));
  await cp(EXAMPLE, dir, { recursive: true });
  const edit = async (file, change) => {
    const data = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    await writeFile(path.join(dir, file), JSON.stringify(change(data) || data, null, 2));
  };
  if (collected) await edit('collected.json', collected);
  if (verify) await edit('verify.json', (v) => verify(v, dir));
  const run = await new Promise((resolve) => execFile('node', [RENDER, dir, ...args], (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stderr })));
  return { ...run, dir, html: await readFile(path.join(dir, 'report.html'), 'utf8') };
}
const methodSection = (html) => html.slice(html.indexOf('<section id="method">'));

test('the published example renders to exactly the report in the repo', async () => {
  const { html } = await render();
  assert.equal(html === await readFile(path.join(EXAMPLE, 'report.html'), 'utf8'), true, 'run render.mjs on examples/calendly.com and commit the result if this change was intended');
});

test('the report does not claim that flagged items were fixed', async () => {
  const { html } = await render();
  assert.doesNotMatch(methodSection(html), /were fixed before publishing/);
  assert.match(methodSection(html), /flagged 32 for correction/);
});

test('a citation check run on older findings is called out in the report and on stderr', async () => {
  const { html, stderr } = await render({ verify: (v) => { v.summary.findingsHash = 'a'.repeat(40); } });
  assert.match(methodSection(html), /findings changed after/);
  assert.match(stderr, /verify\.mjs/);
});

test('a citation check run on the current findings is not called out', async () => {
  const hash = createHash('sha1').update(await readFile(path.join(EXAMPLE, 'findings.json'))).digest('hex');
  const { html, stderr } = await render({ verify: (v) => { v.summary.findingsHash = hash; } });
  assert.doesNotMatch(methodSection(html), /findings changed after/);
  assert.equal(stderr, '');
});

test('where the capture ran from stays out of the report unless asked for', async () => {
  const withRegion = (c) => { c.captureRegion = { timezone: 'Europe/Lisbon', regionalGoogleDomains: ['www.google.pt'] }; };
  assert.doesNotMatch((await render({ collected: withRegion })).html, /Europe\/Lisbon|google\.pt/);
  const shown = (await render({ collected: withRegion, args: ['--show-region'] })).html;
  assert.match(shown, /Europe\/Lisbon/);
  assert.match(shown, /google\.pt/);
});

test('layers skipped in a quick run are listed in the method section', async () => {
  const quick = (c) => {
    c.mode = 'quick';
    for (const key of ['content', 'jobs', 'history']) c[key] = { skipped: 'skipped in quick mode (--quick)', posts: [] };
  };
  const method = methodSection((await render({ collected: quick })).html);
  assert.match(method, /quick run/i);
  assert.match(method, /content sample/);
  assert.match(method, /hiring/);
  assert.match(method, /changes over time/);
});
