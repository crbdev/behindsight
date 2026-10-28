#!/usr/bin/env node
// Checks every citation in findings.json against the collected evidence (pages, quotes,
// tools, IDs, events, keywords, numbers). Writes verify.json; exits 1 on any problem.
//
// Usage: node scripts/verify.mjs <teardown-dir>

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/verify.mjs <teardown-dir>');
  process.exit(1);
}

const collected = JSON.parse(await readFile(path.join(dir, 'collected.json'), 'utf8'));
const findings = JSON.parse(await readFile(path.join(dir, 'findings.json'), 'utf8'));
const network = existsSync(path.join(dir, 'network.json')) ? JSON.parse(await readFile(path.join(dir, 'network.json'), 'utf8')) : [];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
// For quote matching: letters, digits, $ and % only, so punctuation and line breaks don't matter.
const loose = (s) => norm(s).replace(/[^a-z0-9$%]+/g, ' ').replace(/\$ (?=\d)/g, '$').trim();
const normUrl = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').toLowerCase(); } catch { return null; } };

const sitemapUrls = existsSync(path.join(dir, 'sitemap-urls.json')) ? JSON.parse(await readFile(path.join(dir, 'sitemap-urls.json'), 'utf8')).map((x) => normUrl(x.loc)) : [];

// Page text by normalized URL, including structured data and form fields.
const pageText = new Map();
for (const p of collected.pages) {
  let text = '';
  if (p.file && existsSync(path.join(dir, p.file))) text = await readFile(path.join(dir, p.file), 'utf8');
  const extra = JSON.stringify({ title: p.title, description: p.description, h1: p.h1, h2: p.h2, ctas: p.ctas, forms: p.forms, jsonLd: p.jsonLd });
  pageText.set(normUrl(p.url), loose(text + ' ' + extra));
}

// Every number in a JSON value, for checking figures quoted in evidence.
// Handles numbers stored as text too: "2,114" and "180K+".
function numbersIn(value) {
  const out = [];
  const text = JSON.stringify(value).replace(/(\d),(?=\d{3}\b)/g, '$1');
  text.replace(/(-?\d+(?:\.\d+)?)\s*([kKmM])?(?![a-zA-Z])/g, (m, n, suffix) => {
    out.push(Number(n));
    if (suffix) out.push(Number(n) * (/k/i.test(suffix) ? 1e3 : 1e6));
    return m;
  });
  return out;
}
// Numbers written in evidence text: 276,489 · ~12k · 3.5M · $15k · 69%. Dates, IDs and ranges like #2-3 are skipped.
function numbersWritten(text) {
  const cleaned = String(text).replace(/\b(last|past|next|first|within)\s+\d+\s+(days?|weeks?|months?|years?)\b/gi, ' ').replace(/\b(19|20)\d{2}(-\d{2}){0,2}\b/g, ' ').replace(/\b[A-Z]{1,4}-[A-Z0-9-]+\b/g, ' ').replace(/#\d+(-\d+)?/g, ' ').replace(/\bpos(ition)?s? ?\d+(-\d+)?/gi, ' ');
  const out = [];
  for (const m of cleaned.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?(?![\w-])/g)) {
    let n = Number(m[1].replace(/,/g, ''));
    if (m[2]) n *= /k/i.test(m[2]) ? 1e3 : 1e6;
    if (n >= 10) out.push({ raw: m[0].trim(), n, approx: !!m[2] });
  }
  return out;
}
const close = (a, b, approx) => (approx ? Math.abs(a - b) / Math.max(b, 1) <= 0.05 : Math.abs(a - b) <= Math.max(1, b * 0.01));
function unmatchedNumbers(detail, source) {
  const pool = numbersIn(source);
  return numbersWritten(detail).filter(({ n, approx }) => !pool.some((p) => close(n, p, approx))).map((x) => x.raw);
}
// Percentages are often computed from the data, so a missing one is a warning, not a problem.
const splitPercent = (raws, detail) => ({
  hard: raws.filter((r) => !new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*%`).test(detail)),
  soft: raws.filter((r) => new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*%`).test(detail))
});
// Quoted snippets in evidence detail ('...' or "..."), long enough to be meaningful.
function quotes(detail) {
  const out = [];
  for (const m of String(detail).matchAll(/(?:^|[\s(:;,])['"‘“](.{3,}?)['"’”](?=$|[\s.,;:)])/g)) if (m[1].length >= 8) out.push(m[1]);
  return out;
}

const stackNames = [...collected.stack, ...(collected.otherTechnologies || [])].map((s) => norm(s.name));
const agentVendors = (findings.host_notes || []).map((n) => norm(n.vendor));
const allIds = collected.stack.flatMap((s) => (s.ids || []).map((i) => i.value));
const seo = collected.seo && !collected.seo.skipped ? collected.seo : null;

function checkEvidence(e) {
  const problems = [];
  const warnings = [];
  const ref = String(e.ref || '');
  const detail = String(e.detail || '');
  switch (e.type) {
    case 'page': {
      const text = pageText.get(normUrl(ref));
      if (!text) { problems.push(`page ${ref} was not captured`); break; }
      for (const q of quotes(detail)) {
        const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((x) => x.length >= 8);
        if (!parts.every((part) => text.includes(loose(part)))) problems.push(`quote not found on ${ref}: "${q.slice(0, 80)}"`);
      }
      const nums = numbersWritten(detail).filter((x) => !text.includes(loose(x.raw)) && !text.includes(String(x.n)));
      if (nums.length) warnings.push(`numbers not found on the page: ${nums.map((x) => x.raw).join(', ')}`);
      break;
    }
    case 'network': {
      const host = ref.match(/^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s?]*)?/i);
      if (host) {
        const [, h, p] = host;
        const hit = network.some((r) => r.url.includes(h) && (!p || p.length < 2 || r.url.includes(p.split('…')[0])));
        if (!hit) problems.push(`no captured request matches ${ref}`);
      } else {
        warnings.push(`network ref "${ref}" is descriptive, so it can't be checked automatically`);
      }
      break;
    }
    case 'stack': {
      const name = norm(ref);
      if (!stackNames.some((s) => s === name || s.includes(name) || name.includes(s)) && !agentVendors.includes(name)) problems.push(`technology "${ref}" is not in the detected stack`);
      for (const id of detail.match(/\b(?:GTM|G|AW|DC|GT)-[A-Z0-9]+\b|\b\d{3}-[A-Z]{3}-\d{3}\b/g) || []) {
        if (!allIds.includes(id) && !network.some((r) => r.url.includes(id.replace(/^AW-/, '')))) problems.push(`ID ${id} was not seen`);
      }
      break;
    }
    case 'sitemap': {
      const sm = collected.sitemap || {};
      if (ref.startsWith('/') && sitemapUrls.length && !sitemapUrls.some((u) => u && u.slice(u.indexOf('/')).startsWith(ref.replace(/\/$/, '').toLowerCase()))) problems.push(`no sitemap URL starts with ${ref}`);
      const { hard, soft } = splitPercent(unmatchedNumbers(detail, sm), detail);
      if (hard.length) problems.push(`sitemap numbers don't match: ${hard.join(', ')}`);
      if (soft.length) warnings.push(`percentages not in the data (may be computed): ${soft.join(', ')}`);
      break;
    }
    case 'event': {
      const found = (collected.events || []).some((ev) => norm(ev.name) === norm(ref));
      if (!found) problems.push(`event "${ref}" was not captured`);
      break;
    }
    case 'seo': {
      if (!seo) { problems.push('cites search data, but none was collected'); break; }
      const r = norm(ref);
      const known = r.includes('overview') || r.includes('section') || r.includes('competitor') || r.includes('top 100') || r.includes('keywords') ||
        seo.keywords.some((k) => norm(k.keyword) === r) ||
        seo.pages.some((p) => normUrl(p.url) === normUrl(ref)) ||
        seo.competitors.some((c) => norm(c.domain) === r);
      if (!known) problems.push(`search item "${ref}" is not in the search data`);
      const { hard, soft } = splitPercent(unmatchedNumbers(detail, seo), detail);
      if (hard.length) problems.push(`search numbers don't match: ${hard.join(', ')}`);
      if (soft.length) warnings.push(`percentages not in the data (may be computed): ${soft.join(', ')}`);
      break;
    }
    case 'ads': {
      const ads = collected.ads && !collected.ads.skipped ? collected.ads : null;
      if (!ads) { problems.push('cites ad library data, but none was collected'); break; }
      // Ad copy read from a saved screenshot: the file must exist; its text can only be checked by eye.
      const image = ref.match(/\bads\/[\w.-]+\.(?:jpg|jpeg|png)\b/i)?.[0];
      if (image) {
        if (!existsSync(path.join(dir, image))) problems.push(`image ${image} doesn't exist`);
        else if (quotes(detail).length) warnings.push(`text quoted from ${image} can't be checked automatically`);
        break;
      }
      const blob = JSON.stringify(ads);
      if (!blob.toLowerCase().includes(norm(ref).replace(/^(google|meta|linkedin)[: ]+/, '').slice(0, 40)) && !/^(google|meta|linkedin)( ads| ad library)?$/i.test(ref)) problems.push(`ad library item "${ref}" is not in the collected ads`);
      for (const q of quotes(detail)) if (!loose(blob).includes(loose(q))) problems.push(`quoted ad text not found: "${q.slice(0, 80)}"`);
      const { hard, soft } = splitPercent(unmatchedNumbers(detail, ads), detail);
      if (hard.length) problems.push(`ad numbers don't match: ${hard.join(', ')}`);
      if (soft.length) warnings.push(`percentages not in the data (may be computed): ${soft.join(', ')}`);
      break;
    }
    case 'content': {
      const posts = collected.content?.posts || [];
      const post = posts.find((x) => normUrl(x.url) === normUrl(ref));
      if (!post) {
        if (!/sample|posts|content|feed/i.test(ref)) problems.push(`post ${ref} isn't in the content sample`);
        // Sample-level figures are usually tallies across posts, so a missing number is a warning.
        const missing = unmatchedNumbers(detail, collected.content || {});
        if (missing.length) warnings.push(`content numbers not in the data (tallies should show their working): ${missing.join(', ')}`);
        break;
      }
      let text = loose(JSON.stringify(post));
      if (post.file && existsSync(path.join(dir, post.file))) text += ' ' + loose(readFileSync(path.join(dir, post.file), 'utf8'));
      for (const q of quotes(detail)) {
        const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((x) => x.length >= 8);
        if (!parts.every((part) => text.includes(loose(part)))) problems.push(`quote not found in post ${ref}: "${q.slice(0, 80)}"`);
      }
      break;
    }
    case 'investigation': {
      const inv = (collected.investigations || []).find((x) => x.id === ref.trim().split(/\s/)[0]);
      if (!inv) { problems.push(`investigation ${ref} doesn't exist`); break; }
      let text = loose(JSON.stringify(inv));
      if (inv.file && existsSync(path.join(dir, inv.file))) text += ' ' + loose(readFileSync(path.join(dir, inv.file), 'utf8'));
      for (const q of quotes(detail)) {
        const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((x) => x.length >= 8);
        if (!parts.every((part) => text.includes(loose(part)))) problems.push(`quote not found in ${inv.id}: "${q.slice(0, 80)}"`);
      }
      const nums = numbersWritten(detail).filter((x) => !text.includes(loose(x.raw)) && !text.includes(String(x.n)) && !numbersIn(inv).some((p) => close(x.n, p, x.approx)));
      if (nums.length) problems.push(`numbers not found in ${inv.id}: ${nums.map((x) => x.raw).join(', ')}`);
      break;
    }
    case 'external':
      warnings.push(`external source ${ref} can't be checked automatically`);
      break;
  }
  return { problems, warnings };
}

const results = [];
let problemCount = 0;
let warningCount = 0;
for (const [key, claims] of Object.entries(findings.sections || {})) {
  claims.forEach((c, i) => {
    const out = { section: key, index: i, text: c.text, status: c.status, problems: [], warnings: [] };
    // Numbers in the claim itself should appear in the collected data or in the claim's own evidence.
    const pool = numbersIn([collected, (c.evidence || []).map((e) => e.detail)]);
    const loose_ = numbersWritten(c.text).filter(({ n, approx }) => n >= 100 && !pool.some((p) => close(n, p, approx)));
    if (loose_.length) out.warnings.push(`[claim] numbers not found in the data or the cited evidence: ${loose_.map((x) => x.raw).join(', ')}`);
    for (const e of c.evidence || []) {
      const { problems, warnings } = checkEvidence(e);
      out.problems.push(...problems.map((p) => `[${e.type}] ${p}`));
      out.warnings.push(...warnings.map((w) => `[${e.type}] ${w}`));
    }
    problemCount += out.problems.length;
    warningCount += out.warnings.length;
    results.push(out);
  });
}

for (const [i, c] of (findings.content_posts || []).entries()) {
  if (!(collected.content?.posts || []).some((x) => normUrl(x.url) === normUrl(c.url))) {
    results.push({ section: 'content_posts', index: i, text: c.url, status: 'label', problems: [`post ${c.url} isn't in the content sample`], warnings: [] });
    problemCount++;
  }
}

const summary = {
  checkedAt: new Date().toISOString(),
  claims: results.length,
  citations: results.reduce((n, r) => n + (findings.sections[r.section]?.[r.index]?.evidence || []).length, 0),
  problems: problemCount,
  warnings: warningCount
};
await writeFile(path.join(dir, 'verify.json'), JSON.stringify({ summary, results }, null, 2));

console.log(`Checked ${summary.citations} citations across ${summary.claims} claims: ${problemCount} problem(s), ${warningCount} warning(s).`);
for (const r of results.filter((x) => x.problems.length || x.warnings.length)) {
  console.log(`\n${r.section}[${r.index}] (${r.status}): ${r.text.slice(0, 90)}`);
  for (const p of r.problems) console.log(`  PROBLEM  ${p}`);
  for (const w of r.warnings) console.log(`  warning  ${w}`);
}
process.exit(problemCount ? 1 : 0);
