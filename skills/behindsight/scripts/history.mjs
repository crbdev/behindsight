// Changes over time from the Wayback Machine: archived copies of the homepage and pricing page, about
// one per quarter, compared on title, headline, CTAs, prices and the tags written into their HTML.
// Archived pages are read as HTML without running their scripts (which would call the live site), so
// pages built in the browser can come back thin, and tags loaded by a tag manager don't show.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './lib.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(3000 * (i + 1));
    }
  }
  throw new Error('Wayback Machine unavailable');
}

// One snapshot per quarter (the first in each), plus the most recent, newest last.
async function snapshots(url, years, perPage) {
  const from = new Date(Date.now() - years * 365 * 86400000).toISOString().slice(0, 7).replace('-', '');
  const rows = JSON.parse(await get(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url.replace(/^https?:\/\//, ''))}&output=json&fl=timestamp,original,digest&filter=statuscode:200&collapse=timestamp:6&from=${from}`)).slice(1);
  const byQuarter = new Map();
  for (const [ts, original, digest] of rows) {
    const q = `${ts.slice(0, 4)}-Q${Math.ceil(Number(ts.slice(4, 6)) / 3)}`;
    if (!byQuarter.has(q)) byQuarter.set(q, { ts, original, digest, quarter: q });
  }
  const picked = [...byQuarter.values()].slice(-perPage);
  const last = rows.at(-1);
  if (last && picked.at(-1)?.ts !== last[0]) picked.push({ ts: last[0], original: last[1], digest: last[2], quarter: 'latest' });
  return { available: rows.length, picked };
}

// Page facts from raw HTML, read in a page with scripts and subresources off.
async function extract(page, html, matchVendor) {
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const d = await page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Without CSS every responsive copy of a heading shows, and words split across elements run
    // together. Join text nodes with a space (except single letters, from letter-by-letter
    // animations), drop scripts, then keep one copy when the words repeat.
    const words = (el) => {
      const parts = [];
      const walk = (n) => {
        if (n.nodeType === 3) { if (n.textContent.trim()) parts.push(n.textContent); return; }
        if (n.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG)$/i.test(n.tagName)) return;
        if (n.tagName === 'BR') parts.push(' ');
        n.childNodes.forEach(walk);
      };
      walk(el);
      const text = clean(parts.reduce((acc, t) => acc + (acc && t.trim().length > 1 && acc.trim().slice(-2).length > 1 && !/\s$/.test(acc) && !/^\s/.test(t) ? ' ' : '') + t, ''));
      // Drop any run that repeats right after itself ("A A B B" → "A B"). Copies can differ in
      // spacing ("is a" vs "isa"), so runs are compared without spaces.
      const pos = [];
      for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) pos.push(i);
      const sq = pos.map((i) => text[i].toLowerCase()).join('');
      const keep = new Array(sq.length).fill(true);
      let live = sq;
      let map = sq.split('').map((_, i) => i);
      for (let i = 0; i < live.length; i++) {
        for (let p = Math.floor((live.length - i) / 2); p >= 8; p--) {
          if (live.substr(i, p) !== live.substr(i + p, p)) continue;
          // Keep the better-spaced copy.
          const gaps = (from) => { let n = 0; for (let k = from + 1; k < from + p; k++) if (pos[map[k]] > pos[map[k - 1]] + 1) n++; return n; };
          const drop = gaps(i + p) > gaps(i) ? i : i + p;
          for (let k = drop; k < drop + p; k++) keep[map[k]] = false;
          live = live.slice(0, drop) + live.slice(drop + p);
          map = map.slice(0, drop).concat(map.slice(drop + p));
          p = Math.floor((live.length - i) / 2) + 1;
        }
      }
      if (keep.every(Boolean)) return text;
      let out = '';
      for (let k = 0; k < pos.length; k++) {
        if (!keep[k]) continue;
        if (out && pos[k] > pos[k - 1] + 1 && keep[k - 1]) out += ' ';
        else if (out && !keep[k - 1]) out += ' ';
        out += text[pos[k]];
      }
      return clean(out);
    };
    const heads = (sel, max) => [...new Set([...document.querySelectorAll(sel)].map(words).filter(Boolean))].slice(0, max);
    const body = document.body ? document.body.innerText || document.body.textContent : '';
    const ctas = [...new Set([...document.querySelectorAll('a, button')].map(words).filter((t) => t.length >= 3 && t.length <= 32 && /\b(get|start|try|sign|book|request|contact|buy|join|download|see|watch|talk|schedule|demo|free|create|shop)\b/i.test(t)))].slice(0, 10);
    return { title: clean(document.title), description: clean(document.querySelector('meta[name="description"]')?.content), h1: heads('h1', 3), h2: heads('h2', 8), ctas, text: body };
  }).catch(() => ({ title: '', description: '', h1: [], h2: [], ctas: [], text: '' }));
  const flat = d.text.replace(/\s+/g, ' ');
  const prices = [...new Set((flat.match(/(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP))(?:\s?(?:\/|per)\s?(?:mo|month|yr|year|user|seat|member)\b(?:\s?(?:\/|per)\s?(?:mo|month|yr|year)\b)?)?/gi) || []).map(normPrice))].slice(0, 20);
  const tools = new Set();
  const ids = new Set(html.match(/\bGTM-[A-Z0-9]{4,9}\b/g) || []);
  for (const m of html.matchAll(/(?:https?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^"'\s<>)\\]*)?/gi)) {
    try { const v = matchVendor(new URL(`https://${m[1]}${m[2] || '/'}`)); if (v) tools.add(v.name); } catch {}
  }
  return { ...d, prices, tools: [...tools].sort(), tagIds: [...ids], words: flat.split(' ').filter(Boolean).length };
}

// One spelling per price, so "$ 69 /mo" and "$69/month" don't count as a change.
const normPrice = (x) => x.replace(/[.,]+$/, '').replace(/\s+/g, ' ').replace(/([$€£]) /, '$1').replace(/\s?(\/|per)\s?/gi, '/').replace(/\/mo\b/i, '/month').replace(/\/yr\b/i, '/year').toLowerCase();

const diff = (a = [], b = []) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) });

export async function collectHistory({ browser, pages, matchVendor, years = 2, perPage = 8, outDir, log = () => {}, slugify }) {
  const context = await browser.newContext({ javaScriptEnabled: false, userAgent: UA });
  const page = await context.newPage();
  await page.route('**/*', (r) => (r.request().resourceType() === 'document' ? r.continue() : r.abort()));
  await mkdir(path.join(outDir, 'history'), { recursive: true });
  const results = [];

  for (const target of pages) {
    log(`reading Wayback Machine snapshots of ${target.url}`);
    let snaps;
    try { snaps = await snapshots(target.url, years, perPage); }
    catch (e) { results.push({ kind: target.kind, url: target.url, error: `snapshot list failed: ${e.message}` }); continue; }
    const rows = [];
    let prev = null;
    for (const s of snaps.picked) {
      const archiveUrl = `https://web.archive.org/web/${s.ts}/${s.original}`;
      const date = `${s.ts.slice(0, 4)}-${s.ts.slice(4, 6)}-${s.ts.slice(6, 8)}`;
      // Identical captures (same digest) need no second read.
      if (prev && prev.digest === s.digest) { rows.push({ ...prev.row, date, archiveUrl, sameAsPrevious: true }); continue; }
      try {
        const html = await get(`https://web.archive.org/web/${s.ts}id_/${s.original}`);
        const x = await extract(page, html, matchVendor);
        const file = `history/${target.kind}-${date}.md`;
        await writeFile(path.join(outDir, file), `# ${target.kind} on ${date}\n\n${archiveUrl}\n\nTitle: ${x.title}\nH1: ${x.h1.join(' | ')}\n\n${x.text.replace(/\n{3,}/g, '\n\n').slice(0, 40000)}\n`);
        const { text, ...row } = x;
        const r = { date, archiveUrl, ...row, thin: x.words < 120, file };
        rows.push(r);
        prev = { digest: s.digest, row: r };
      } catch (e) {
        rows.push({ date, archiveUrl, error: e.message.split('\n')[0] });
      }
      await sleep(1200);
    }

    // The live page, read the same way so the comparison is like for like.
    let live = null;
    try {
      const x = await extract(page, await get(target.url), matchVendor);
      const { text, ...row } = x;
      live = { date: new Date().toISOString().slice(0, 10), archiveUrl: target.url, live: true, ...row, thin: x.words < 120 };
    } catch (e) { live = { live: true, error: e.message.split('\n')[0] }; }

    // What changed between consecutive readable snapshots. Thin ones are skipped so missing text doesn't count as a change.
    const usable = [...rows, live].filter((r) => r && !r.error && !r.thin);
    const changes = [];
    for (let i = 1; i < usable.length; i++) {
      const a = usable[i - 1];
      const b = usable[i];
      const c = { from: a.date, to: b.date, toUrl: b.archiveUrl };
      if (a.title !== b.title) c.title = { before: a.title, after: b.title };
      if (a.h1[0] !== b.h1[0]) c.h1 = { before: a.h1[0] || null, after: b.h1[0] || null };
      if (a.description !== b.description) c.description = { before: a.description, after: b.description };
      const ctas = diff(a.ctas, b.ctas);
      if (ctas.added.length || ctas.removed.length) c.ctas = ctas;
      const prices = diff(a.prices, b.prices);
      if (prices.added.length || prices.removed.length) c.prices = prices;
      const tools = diff(a.tools, b.tools);
      if (tools.added.length || tools.removed.length) c.tools = tools;
      if (Object.keys(c).length > 3) changes.push(c);
    }
    results.push({ kind: target.kind, url: target.url, snapshotsAvailable: snaps.available, rows, live, changes });
  }
  await context.close();
  return { source: 'Wayback Machine (web.archive.org)', years, pages: results };
}
