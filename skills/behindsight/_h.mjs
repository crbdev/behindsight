import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { collectHistory } from './scripts/history.mjs';
import { siteHelpers, registrableDomain } from './scripts/lib.mjs';
const [host, out, ...urls] = process.argv.slice(2);
const signatures = JSON.parse(await readFile('scripts/signatures.json', 'utf8'));
const { matchVendor, slugify } = siteHelpers({ siteHost: host, siteRoot: registrableDomain(host), signatures });
const b = await chromium.launch();
const t0 = Date.now();
const h = await collectHistory({ browser: b, pages: urls.map((u, i) => ({ kind: i ? 'pricing' : 'home', url: u })), matchVendor, outDir: out, log: console.error, slugify });
await b.close();
for (const p of h.pages) {
  console.log('==', p.kind, p.snapshotsAvailable, p.error || '');
  for (const r of [...(p.rows || []), p.live]) console.log(r.date, r.error || '', r.thin ? 'THIN' : '', r.sameAsPrevious ? 'same' : '', '|', r.h1?.[0]?.slice(0, 70), '|', (r.prices || []).slice(0, 6).join(' '), '|', (r.tools || []).join(', '));
  for (const c of p.changes) console.log('  change', c.from, '→', c.to, Object.keys(c).filter(k => !['from', 'to', 'toUrl'].includes(k)).join(','), c.h1 ? JSON.stringify(c.h1) : '');
}
console.log((Date.now() - t0) / 1000, 's');
