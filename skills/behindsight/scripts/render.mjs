#!/usr/bin/env node
// Renders <dir>/findings.json (written by the agent) plus <dir>/collected.json
// (written by collect.mjs) into a single self-contained <dir>/report.html.
//
// Usage: node scripts/render.mjs <teardown-dir>

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) {
  console.error('Usage: node scripts/render.mjs <teardown-dir>');
  process.exit(1);
}

const collected = JSON.parse(await readFile(path.join(dir, 'collected.json'), 'utf8'));
const findings = JSON.parse(await readFile(path.join(dir, 'findings.json'), 'utf8'));
const css = await readFile(path.join(SKILL_DIR, 'templates/report.css'), 'utf8');
const readOptional = async (f) => { try { return JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { return null; } };
const verify = await readOptional('verify.json');
const review = await readOptional('review.json');

const SECTIONS = [
  { key: 'business_model', id: 'business-model', title: 'Business model' },
  { key: 'positioning', id: 'positioning', title: 'Positioning and messaging' },
  { key: 'acquisition', id: 'acquisition', title: 'Acquisition channels' },
  { key: 'funnel', id: 'funnel', title: 'Conversion funnel' },
  { key: 'retention', id: 'retention', title: 'Retention and lifecycle' },
  { key: 'content_strategy', id: 'content-strategy', title: 'Content strategy', optional: true }
];
const STATUSES = ['seen', 'inferred', 'unknown'];
const EVIDENCE_TYPES = ['page', 'network', 'stack', 'sitemap', 'event', 'seo', 'ads', 'content', 'jobs', 'history', 'investigation', 'external'];

// ---------- validation ----------

const errors = [];
const need = (cond, msg) => { if (!cond) errors.push(msg); };
need(typeof findings.company === 'string' && findings.company, 'company is required');
need(typeof findings.summary === 'string' && findings.summary, 'summary is required');
need(Array.isArray(findings.at_a_glance) && findings.at_a_glance.length, 'at_a_glance needs at least one item');
for (const [i, g] of (findings.at_a_glance || []).entries()) {
  need(g.label && g.value, `at_a_glance[${i}] needs label and value`);
  need(STATUSES.includes(g.status), `at_a_glance[${i}].status must be one of ${STATUSES.join(', ')}`);
}
for (const s of SECTIONS) {
  const claims = findings.sections?.[s.key];
  if (s.optional && !claims) continue;
  need(Array.isArray(claims) && claims.length, `sections.${s.key} needs at least one claim (use status "unknown" when the evidence says nothing)`);
  for (const [i, c] of (claims || []).entries()) {
    const at = `sections.${s.key}[${i}]`;
    need(c.text, `${at}.text is required`);
    need(STATUSES.includes(c.status), `${at}.status must be one of ${STATUSES.join(', ')}`);
    if (c.status !== 'unknown') need(Array.isArray(c.evidence) && c.evidence.length, `${at} is "${c.status}" so it needs evidence`);
    if (c.status === 'inferred') need(['high', 'medium', 'low'].includes(c.confidence), `${at} is inferred so it needs confidence high, medium or low`);
    for (const [j, e] of (c.evidence || []).entries()) {
      need(EVIDENCE_TYPES.includes(e.type), `${at}.evidence[${j}].type must be one of ${EVIDENCE_TYPES.join(', ')}`);
      need(e.ref, `${at}.evidence[${j}].ref is required`);
    }
  }
}
// Every section opens with a short summary so the reader gets the gist before the detail.
const summaries = findings.section_summaries || {};
const dataSections = [
  ['stack', true],
  ['ads', !!(collected.ads && !collected.ads.skipped)],
  ['content_footprint', !!collected.sitemap?.totalUrls],
  ['search', !!(collected.seo && !collected.seo.skipped)],
  ['jobs', collected.jobs?.status === 'found'],
  ['history', !!collected.history?.pages?.some((p) => p.rows?.length)]
];
for (const s of SECTIONS) if (findings.sections?.[s.key] && !summaries[s.key]) errors.push(`section_summaries.${s.key} is required: one or two sentences giving the section's gist`);
for (const [key, shown] of dataSections) if (shown && !summaries[key]) errors.push(`section_summaries.${key} is required: one or two sentences giving the section's gist`);
if (errors.length) {
  console.error(`findings.json has ${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const isUrl = (s) => /^https?:\/\//i.test(String(s));
const shortUrl = (s) => { try { const u = new URL(s); return (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '') + (u.search ? '?…' : ''); } catch { return s; } };
const link = (s, text) => (isUrl(s) ? `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(text ?? shortUrl(s))}</a>` : esc(text ?? s));
const summaryHtml = (key) => (summaries[key] ? `<p class="takeaway"><span>In short</span>${esc(summaries[key])}</p>` : '');
const chip = (status) => `<span class="chip ${esc(status)}">${esc(status)}</span>`;
const fmt = (n) => Number(n).toLocaleString('en-US');

function claimHtml(c) {
  const ev = (c.evidence || []).map((e) => `<li><span class="type">${esc(e.type)}</span><span><span class="ref">${link(e.ref)}</span>${e.detail ? ` <span class="detail">· ${esc(e.detail)}</span>` : ''}</span></li>`).join('');
  return `<li class="claim">${chip(c.status)}<p>${esc(c.text)}</p>${c.status === 'inferred' ? `<span class="conf">${esc(c.confidence)} confidence</span>` : ''}${ev ? `<details><summary>Evidence (${c.evidence.length})</summary><ul class="evidence">${ev}</ul></details>` : ''}</li>`;
}

function sectionHtml({ key, id, title }) {
  const claims = findings.sections[key];
  if (!claims) return '';
  const extra = key === 'content_strategy' ? contentStrategyPanel() : '';
  const counts = STATUSES.map((s) => [s, claims.filter((c) => c.status === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(' · ');
  return `<section id="${id}"><div class="section-head"><h2>${esc(title)}</h2><span class="count">${counts}</span></div>${summaryHtml(key)}<ul class="claims">${claims.map(claimHtml).join('')}</ul>${extra}</section>`;
}

// ---------- stack ----------

function stackHtml() {
  const rows = [];
  const byCat = new Map();
  for (const s of collected.stack) {
    if (!byCat.has(s.category)) byCat.set(s.category, []);
    byCat.get(s.category).push(s);
  }
  for (const note of findings.host_notes || []) {
    const cat = note.category || 'Identified by the agent';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push({ name: note.vendor, host: note.host, note: note.note, confidence: note.confidence, agent: true, ids: [], sources: [] });
  }
  // Tools first seen during an investigation (a page captured after clicks, for example).
  for (const inv of collected.investigations || []) {
    for (const v of inv.vendors || []) {
      if (!v.newToStack || collected.stack.some((s) => s.name === v.name)) continue;
      if (!byCat.has(v.category)) byCat.set(v.category, []);
      if (!byCat.get(v.category).some((x) => x.name === v.name)) byCat.get(v.category).push({ name: v.name, ids: v.ids.map((i) => ({ label: '', value: i })), sources: ['investigation'], investigation: inv.id });
    }
  }
  const confirmed = collected.stack.filter((s) => s.sources.length > 1).length;
  for (const [cat, items] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push(`<tr class="group"><td colspan="4">${esc(cat)}</td></tr>`);
    for (const s of items) {
      let source;
      if (s.agent) source = `<span class="chip inferred">inferred${s.confidence ? ` · ${esc(s.confidence)}` : ''}</span>`;
      else if (s.sources.length > 1) source = '<span class="chip src both">network + code</span>';
      else if (s.sources[0] === 'investigation') source = `<span class="chip src">network (${esc(s.investigation)})</span>`;
      else if (s.sources[0] === 'network') source = '<span class="chip src">network</span>';
      else source = '<span class="chip src">code match</span>';
      const ids = (s.ids || []).map((i) => `<span><span class="weak">${esc(i.label)}</span> <code>${esc(i.value)}</code></span>`).join('');
      const pages = s.agent ? '' : (s.pages?.length || s.wpPages?.length || 0);
      const detail = s.agent ? `<div class="weak mono">${esc(s.host)}</div>${s.note ? `<div class="weak">${esc(s.note)}</div>` : ''}` : (s.version ? ` <span class="weak mono">${esc(s.version)}</span>` : '');
      rows.push(`<tr><td>${esc(s.name)}${detail}</td><td>${source}</td><td><div class="ids">${ids}</div></td><td class="num">${pages}</td></tr>`);
    }
  }
  const fp = collected.firstPartyTagging?.length
    ? `<h3>First-party or server-side tagging</h3><ul class="plain">${collected.firstPartyTagging.map((t) => `<li>${esc(t.name)} on <code>${esc(t.host)}</code></li>`).join('')}</ul>`
    : '';
  const events = eventsHtml();
  const annotated = new Set((findings.host_notes || []).map((n) => n.host));
  const unknown = (collected.unknownHosts || []).filter((h) => !annotated.has(h.host));
  const unknownHtml = unknown.length
    ? `<details><summary>${unknown.length} unidentified third-party hosts</summary><div class="table-wrap"><table><thead><tr><th>Host</th><th>Requests</th><th>Types</th></tr></thead><tbody>${unknown.map((h) => `<tr><td><code>${esc(h.host)}</code></td><td class="num">${h.requests}</td><td class="weak">${esc(h.types.join(', '))}</td></tr>`).join('')}</tbody></table></div></details>`
    : '';
  const wp = collected.wordpress && (collected.wordpress.plugins.length || collected.wordpress.themes.length)
    ? `<h3>WordPress plugins and themes</h3><p class="note">From asset paths on the captured pages. Plugins that load nothing on these pages don't appear.</p><div class="chips">${collected.wordpress.plugins.map((x) => `<span class="stat">${esc(x)}</span>`).join('')}${collected.wordpress.themes.map((x) => `<span class="stat">theme: <b>${esc(x)}</b></span>`).join('')}</div>`
    : '';
  const other = collected.otherTechnologies?.length
    ? `<details><summary>${collected.otherTechnologies.length} infrastructure technologies</summary><p class="note">${collected.otherTechnologies.map((t) => `${esc(t.name)} <span class="weak">(${esc(t.category)})</span>`).join(', ')}</p></details>`
    : '';
  return `<section id="stack"><div class="section-head"><h2>Marketing stack</h2><span class="count">${collected.stack.length} tools · ${confirmed} confirmed by both sources</span></div>${summaryHtml('stack')}
<p class="lede">"Network" means the browser loaded or called the tool during the visit. "Code match" means a Wappalyzer pattern matched the page code, which is weaker evidence. "Network + code" means both agree.</p>
<div class="table-wrap"><table><thead><tr><th>Technology</th><th>Detected by</th><th>Public IDs</th><th>Pages</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>${fp}${events}${wp}${unknownHtml}${other}</section>`;
}

// Each distinct event once. Routine events every tag sends on its own (page views, scrolls, engagement
// pings) collapse into one line; custom and conversion events are the ones that say something.
const ROUTINE_EVENTS = /^(page_view|pageview|page_load|scroll|user_engagement|first_visit|session_start|gtm\.(js|dom|load)|pagevisit|viewcontent|form_start|click|consent_update)$/i;
function eventsHtml() {
  const list = collected.events || [];
  if (!list.length) return '';
  const totalPages = collected.pages.length;
  const groups = new Map();
  for (const e of list) {
    const key = `${e.platform}|${e.name}`;
    const g = groups.get(key) || { platform: e.platform, name: e.name, pages: new Set() };
    g.pages.add(e.page);
    groups.set(key, g);
  }
  const all = [...groups.values()].sort((a, b) => b.pages.size - a.pages.size || a.platform.localeCompare(b.platform));
  const custom = all.filter((g) => !ROUTINE_EVENTS.test(g.name.replace(/\s+/g, '')));
  const routine = all.filter((g) => ROUTINE_EVENTS.test(g.name.replace(/\s+/g, '')));
  const pagesLabel = (g) => `${g.pages.size} of ${totalPages}`;
  const customTable = custom.length
    ? `<div class="table-wrap"><table><thead><tr><th>Event</th><th>Platform</th><th class="num">Pages</th></tr></thead><tbody>${custom.map((g) => `<tr><td><code>${esc(g.name)}</code></td><td>${esc(g.platform)}</td><td class="num">${pagesLabel(g)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="note">No custom or conversion events fired. The capture only loads pages, so events tied to signups or purchases can\'t appear.</p>';
  const routineLine = routine.length
    ? `<p class="note">Routine events: ${routine.map((g) => `<code>${esc(g.name)}</code> (${esc(g.platform)}, ${pagesLabel(g)} pages)`).join(', ')}.</p>`
    : '';
  const detail = `<details><summary>Every event by page (${list.length})</summary><div class="table-wrap"><table><thead><tr><th>Platform</th><th>Event</th><th>Page</th></tr></thead><tbody>${list.map((e) => `<tr><td>${esc(e.platform)}</td><td><code>${esc(e.name)}</code></td><td>${link(e.page)}</td></tr>`).join('')}</tbody></table></div></details>`;
  return `<h3>Tracking events</h3><p class="note">Custom and conversion events show what the company measures beyond page views.</p>${customTable}${routineLine}${detail}`;
}

// ---------- content strategy (sampled posts) ----------

const contentData = collected.content && !collected.content.skipped && collected.content.posts?.length ? collected.content : null;
function contentStrategyPanel() {
  if (!contentData) return '';
  const ok = contentData.posts.filter((p) => !p.error);
  const norm = (u) => String(u).replace(/[?#].*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
  const labels = new Map((findings.content_posts || []).map((c) => [norm(c.url), c]));
  const sourceNote = contentData.source === 'feed' ? 'the blog feed' : contentData.source === 'blog index' ? "the blog's index page" : 'the sitemap (dates are last-modified, not published)';
  const parts = [`<p class="note">${ok.length} posts read: the newest from ${sourceNote}, plus the posts earning the most estimated search traffic.</p>`];
  const tally = (key) => {
    const t = {};
    for (const c of labels.values()) if (c[key]) t[c[key]] = (t[c[key]] || 0) + 1;
    return Object.entries(t).sort((a, b) => b[1] - a[1]);
  };
  // Topics only count when several posts share one; one-off topics are noise next to the claims.
  const chipsFor = (key, label, min = 1) => { const t = tally(key).filter(([, n]) => n >= min); return t.length ? `<div class="chips"><span class="weak mono">${label}</span>${t.map(([k, n]) => `<span class="stat">${esc(k)} <b>${n}</b></span>`).join('')}</div>` : ''; };
  parts.push(chipsFor('format', 'Formats') + chipsFor('stage', 'Funnel stage') + chipsFor('topic', 'Shared topics', 2));
  const cad = contentData.cadence || [];
  if (cad.length >= 2) {
    const max = Math.max(...cad.map((m) => m.count));
    parts.push(`<h3>Recent posts by publish month</h3><p class="note">The recent sample only, not total output.</p><div class="bars">${cad.slice(-12).map((m) => `<div class="bar-row"><span class="label">${esc(m.month)}</span><div class="bar-track"><div class="bar-fill" style="width:${((m.count / max) * 100).toFixed(1)}%"></div></div><span class="value">${m.count}</span></div>`).join('')}</div>`);
  }
  const rows = ok.map((p) => {
    const c = labels.get(norm(p.url)) || {};
    return `<tr><td class="mono weak">${esc(p.published || '?')}</td><td>${link(p.url, p.title || p.url)}${p.reason === 'top traffic' || p.reason === 'recent and top traffic' ? ' <span class="chip src">top traffic</span>' : ''}</td><td>${esc(c.format || '')}</td><td>${esc(c.stage || '')}</td><td>${esc(c.cta || (p.leadForms?.length ? 'lead form' : p.ctas?.[0] || ''))}</td><td class="num">${fmt(p.words)}</td><td class="num">${p.etv ? fmt(p.etv) : ''}</td></tr>`;
  }).join('');
  parts.push(`<details><summary>Posts read (${ok.length})</summary><div class="table-wrap"><table><thead><tr><th>Published</th><th>Post</th><th>Format</th><th>Stage</th><th>Asks readers to</th><th class="num">Words</th><th class="num">Est. visits</th></tr></thead><tbody>${rows}</tbody></table></div></details>`);
  return parts.join('');
}

// ---------- content (sitemap) ----------

function contentHtml() {
  const s = collected.sitemap;
  if (!s || !s.totalUrls) {
    const blocked = Object.values(s?.fetchStatuses || {}).filter((st) => st === 403 || st === 429 || st === 503);
    const why = blocked.length ? `The site refused the sitemap requests (HTTP ${[...new Set(blocked)].join(', ')}), so there is no content footprint for this run.` : 'No readable sitemap was found, so there is no content footprint for this site.';
    return `<section id="content"><div class="section-head"><h2>Content footprint</h2></div><p class="note">${why}</p></section>`;
  }
  const max = Math.max(...s.sections.map((x) => x.count));
  const bars = s.sections.slice(0, 14).map((x) => `<div class="bar-row"><span class="label" title="${esc(x.name)}">${esc(x.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${((x.count / max) * 100).toFixed(1)}%"></div></div><span class="value">${fmt(x.count)}</span></div>`).join('');
  const patterns = Object.entries(s.patterns).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="stat">${esc(k)} <b>${fmt(n)}</b></span>`).join('');
  const locales = s.locales?.length ? `<p class="note">Localized paths: ${s.locales.map((l) => `<code>${esc(l.code)}</code> (${fmt(l.count)})`).join(', ')}</p>` : '';
  let months = '';
  if (s.lastmodByMonth.length && !s.lastmodSuspect) {
    const mmax = Math.max(...s.lastmodByMonth.map((m) => m.count));
    months = `<h3>URLs updated per month</h3><p class="note">From sitemap lastmod dates (${s.lastmodCoverage}% of URLs have one). Tallest bar is ${fmt(mmax)} URLs.</p><div class="months" role="img" aria-label="URLs updated per month">${s.lastmodByMonth.map((m) => `<div style="height:${((m.count / mmax) * 100).toFixed(1)}%" title="${esc(m.month)}: ${m.count}"></div>`).join('')}</div><div class="month-labels">${s.lastmodByMonth.map((m) => `<span>${esc(m.month.slice(2))}</span>`).join('')}</div>`;
  } else if (s.lastmodSuspect) {
    months = `<p class="note warn">Most sitemap URLs share one lastmod date, so the site likely rewrites those dates on every build. Publishing pace can't be read from them.</p>`;
  } else {
    months = `<p class="note">The sitemap has no lastmod dates, so publishing pace can't be read from it.</p>`;
  }
  return `<section id="content"><div class="section-head"><h2>Content footprint</h2><span class="count">${fmt(s.totalUrls)} URLs${s.truncated ? ' (truncated)' : ''}</span></div>${summaryHtml('content_footprint')}
<h3>Largest sections</h3><div class="bars">${bars}</div>
<h3>Page types</h3><div class="chips">${patterns || '<span class="note">No recognized page types.</span>'}</div>${locales}${months}</section>`;
}

// ---------- organic search (optional DataForSEO data) ----------

const seo = collected.seo && !collected.seo.skipped ? collected.seo : null;
const path_ = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') === collected.domain ? '' : x.hostname) + x.pathname; } catch { return u; } };

function searchHtml() {
  if (!seo) return '';
  const o = seo.overview?.organic;
  const stats = [
    o && ['Est. monthly organic visits', fmt(o.etv)],
    o && ['Ranking keywords', fmt(o.keywords)],
    o && ['Ranking #1', fmt(o.pos1)],
    o && ['Ranking #2–10', fmt(o.pos2to3 + o.pos4to10)],
    o && ['Organic traffic value / mo', `$${fmt(o.trafficValue)}`],
    seo.brandedShareOfTopKeywords != null && ['Branded share of top-keyword traffic', `${seo.brandedShareOfTopKeywords}%${seo.brandedShareExcludingBareName != null && seo.brandedShareExcludingBareName !== seo.brandedShareOfTopKeywords ? ` (${seo.brandedShareExcludingBareName}% without the bare brand name)` : ''}`]
  ].filter(Boolean).map(([k, v]) => `<span class="stat">${esc(k)} <b>${esc(v)}</b></span>`).join('');

  const smax = Math.max(1, ...seo.sections.map((x) => x.share));
  const sections = seo.sections.length
    ? `<h3>Where search traffic lands</h3><p class="note">Share of estimated organic visits across the top ${seo.pages.length} pages, grouped by site section. Those pages cover ${seo.sectionsCoverage ?? '?'}% of the domain's estimated traffic. "Not in sitemap" collects pages outside the sitemap's sections, such as user profiles or app URLs.</p><div class="bars">${seo.sections.slice(0, 12).map((x) => `<div class="bar-row"><span class="label" title="${esc(x.name)}">${esc(x.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${((x.share / smax) * 100).toFixed(1)}%"></div></div><span class="value">${x.share}%</span></div>`).join('')}</div>`
    : '';
  const pages = seo.pages.length
    ? `<h3>Top pages</h3><div class="table-wrap"><table><thead><tr><th>Page</th><th>Section</th><th class="num">Est. visits</th><th class="num">Keywords</th></tr></thead><tbody>${seo.pages.slice(0, 15).map((x) => `<tr><td>${link(x.url, path_(x.url))}</td><td class="weak mono">${esc(x.section)}</td><td class="num">${fmt(x.etv)}</td><td class="num">${fmt(x.keywords)}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  const brand = '<span class="chip src">brand</span>';
  const keywords = seo.keywords.length
    ? `<h3>Top organic keywords</h3><div class="table-wrap"><table><thead><tr><th>Keyword</th><th class="num">Position</th><th class="num">Volume</th><th class="num">Est. visits</th><th>Page</th></tr></thead><tbody>${seo.keywords.slice(0, 25).map((k) => `<tr><td>${esc(k.keyword)} ${k.branded ? brand : ''}</td><td class="num">${esc(k.position)}</td><td class="num">${k.volume != null ? fmt(k.volume) : ''}</td><td class="num">${fmt(k.etv)}</td><td>${k.url ? link(k.url, path_(k.url)) : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  const comps = seo.competitors.length
    ? `<h3>Search competitors</h3><p class="note">Domains ranking for ${esc(collected.domain)}'s top ${seo.competitorKeywords.length} non-branded keywords, by visibility. Large platforms are left out.</p><div class="table-wrap"><table><thead><tr><th>Domain</th><th class="num">Keywords ranked</th><th class="num">Avg. position</th><th class="num">Est. visits on these keywords</th></tr></thead><tbody>${seo.competitors.map((c) => `<tr><td>${link(`https://${c.domain}`, c.domain)}</td><td class="num">${fmt(c.keywords)}</td><td class="num">${esc(c.avgPosition)}</td><td class="num">${fmt(c.etv)}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  const problems = seo.errors?.length ? `<p class="note warn">Some search data couldn't be fetched: ${esc(seo.errors.join('; '))}</p>` : '';
  return `<section id="search"><div class="section-head"><h2>Organic search</h2><span class="count">Google ${esc(seo.location)} · ${esc(seo.capturedAt.slice(0, 10))}</span></div>${summaryHtml('search')}
<p class="lede">Estimates from DataForSEO Labs. Visits are modeled from rankings and typical click-through rates, so treat them as directional and compare them within this report.</p>
${problems}<div class="chips">${stats}</div>${sections}${pages}${keywords}${comps}</section>`;
}

// ---------- advertising (public ad libraries) ----------

const adsData = collected.ads && !collected.ads.skipped ? collected.ads : null;
async function embed(file) {
  const f = path.join(dir, file);
  if (!existsSync(f)) return null;
  const ext = path.extname(f).slice(1).replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${(await readFile(f)).toString('base64')}`;
}

async function adsHtml() {
  if (!adsData) return '';
  const statusChip = (st) => `<span class="chip ${st === 'found' || st === 'no active ads' ? 'seen' : 'unknown'}">${st === 'found' ? 'ads found' : st === 'uncertain' ? 'account not confirmed' : esc(st)}</span>`;
  const others = (x) => x.otherAdvertisers?.length && x.otherAdvertisers[0].adsInSample ? `<p class="note">Other advertisers whose ads link to ${esc(collected.domain)} (not counted as the company; often customers, resellers or affiliates): ${x.otherAdvertisers.slice(0, 5).map((o) => esc(o.name)).join(', ')}${x.otherAdvertiserCount > 5 ? ` and ${fmt(x.otherAdvertiserCount - 5)} more` : ''}.</p>` : '';
  const blocks = [];

  const g = adsData.google;
  let gBody;
  if (g.status === 'found') {
    const formats = Object.entries(g.formats).map(([k, v]) => `<span class="stat">${esc(k)} <b>${fmt(v)}</b></span>`).join('');
    const mmax = Math.max(1, ...g.newByMonth.map((m) => m.count));
    const months = g.newByMonth.length ? `<p class="note">New ads first shown per month, last 12 months. Tallest bar is ${fmt(mmax)}.</p><div class="months" role="img" aria-label="New Google ads per month">${g.newByMonth.map((m) => `<div style="height:${((m.count / mmax) * 100).toFixed(1)}%" title="${esc(m.month)}: ${m.count}"></div>`).join('')}</div><div class="month-labels">${g.newByMonth.map((m) => `<span>${esc(m.month.slice(2))}</span>`).join('')}</div>` : '';
    const imgs = [];
    for (const smp of g.samples) { const src = await embed(smp.file); if (src) imgs.push(`<figure><a href="${esc(smp.url)}" target="_blank" rel="noopener noreferrer"><img src="${src}" alt="Google ${esc(smp.format)} ad sample" loading="lazy"></a><figcaption>${esc(smp.format)} · last shown ${esc(smp.lastShown || '?')}</figcaption></figure>`); }
    gBody = `<p class="note">Advertiser accounts: ${g.advertisers.map((a) => `${esc(a.name)} (${esc(a.adsTotal || a.adsRange || '?')} ads)`).join('; ')}. ${fmt(g.creativesFetched)} most recent ads read.</p>
<div class="chips"><span class="stat">Shown in last 30 days <b>${fmt(g.shownInLast30Days)}</b></span>${formats}<span class="stat">Running since <b>${esc(g.firstShown || '?')}</b></span></div>${months}${imgs.length ? `<div class="gallery">${imgs.join('')}</div>` : ''}${others(g)}`;
  } else {
    gBody = `<p class="note">${esc(g.note || g.error || 'Not available.')}</p>`;
  }
  blocks.push(`<div class="adblock"><div class="adhead"><h3>Google</h3>${statusChip(g.status)}</div>${gBody}</div>`);

  const m = adsData.meta;
  let mBody;
  if (m.status === 'found') {
    const shot = await embed(m.screenshot);
    // The same copy often runs in several ads; show each message once with a count.
    const groups = new Map();
    for (const a of m.ads) {
      const k = a.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const g = groups.get(k) || { ...a, count: 0 };
      g.count++;
      if (a.started && (!g.started || a.started < g.started)) g.started = a.started;
      groups.set(k, g);
    }
    const list = [...groups.values()].sort((x, y) => y.count - x.count).slice(0, 8).map((a) => `<li><span class="weak mono">since ${esc(a.started || '?')}${a.video ? ' · video' : ''}${a.count > 1 ? ` · ${a.count} ads` : ''}</span> ${esc(a.text)}${a.headline ? ` <span class="weak">· ${esc(a.headline)}</span>` : ''}${a.cta ? ` <span class="chip src">${esc(a.cta)}</span>` : ''}</li>`).join('');
    mBody = `<p class="note">Page: ${link(m.url, m.page.name)}${m.page.verified ? ' (verified)' : ' (not verified)'}${m.match ? `, matched because: ${esc(m.match)}` : ''}. The library doesn't show which country each ad runs in.</p>
<div class="chips"><span class="stat">Active ads in ${esc(adsData.country)} <b>${esc(m.activeAds ?? '?')}</b></span>${m.activeAdsAllCountries ? `<span class="stat">Active worldwide <b>${esc(m.activeAdsAllCountries)}</b></span>` : ''}<span class="stat">Started in last 30 days <b>${fmt(m.startedInLast30Days)}</b> of ${fmt(m.adsRead)} read${m.adsReadFrom ? ` (${esc(m.adsReadFrom)})` : ''}</span><span class="stat">Video <b>${m.videoShare ?? '?'}%</b></span><span class="stat">Oldest still running <b>${esc(m.oldestActiveStart || '?')}</b></span></div>
<ul class="adlist">${list}</ul>${shot ? `<figure class="wide"><img src="${shot}" alt="Meta Ad Library results" loading="lazy"></figure>` : ''}`;
  } else {
    mBody = `<p class="note">${esc(m.note || m.error || 'Not available.')}${m.url ? ` ${link(m.url, 'Open in the Ad Library')}` : ''}</p>`;
  }
  blocks.push(`<div class="adblock"><div class="adhead"><h3>Meta (Facebook and Instagram)</h3>${statusChip(m.status)}</div>${mBody}</div>`);

  const l = adsData.linkedin;
  let lBody;
  if (l.status === 'found') {
    const shot = await embed(l.screenshot);
    const list = l.ads.slice(0, 8).map((a) => `<li>${a.headline ? `<b>${esc(a.headline)}</b> ` : ''}${esc(a.text)}</li>`).join('');
    const dated = (l.details || []).filter((d) => d.ranFrom);
    const details = dated.length ? `<table class="compact"><thead><tr><th>Ad</th><th>Ran</th><th>Impressions</th><th>Campaign</th><th>Links to</th></tr></thead><tbody>${dated.map((d) => `<tr><td>${esc(d.headline || d.format || '')}</td><td class="mono">${esc(d.ranFrom)} to ${esc(d.ranTo)}</td><td>${esc(d.impressions || '')}</td><td class="mono">${esc(d.utm?.campaign || '')}</td><td>${d.landingUrl ? link(d.landingUrl, new URL(d.landingUrl).pathname) : ''}</td></tr>`).join('')}</tbody></table>` : '';
    lBody = `<p class="note">Advertiser: ${link(l.searchUrl, l.advertiser)}${l.paidFor && l.paidFor !== l.advertiser ? `, paid for by ${esc(l.paidFor)}` : ''}${l.match ? `; matched because: ${esc(l.match)}` : ''}. LinkedIn's library lists ads from the past year; run dates and impressions only show for some ads.</p>
<div class="chips"><span class="stat">Ads in the past year <b>${esc(l.adsMatchingSearch || '?')}</b></span>${l.adsInCountry ? `<span class="stat">Shown in ${esc(adsData.country)} <b>${esc(l.adsInCountry)}</b></span>` : ''}${l.details?.length ? `<span class="stat">Ran through capture date <b>${fmt(l.runningAtCapture)}</b> of ${fmt(l.details.length)} checked</span>` : ''}</div>
${details}<ul class="adlist">${list}</ul>${shot ? `<figure class="wide"><img src="${shot}" alt="LinkedIn Ad Library results" loading="lazy"></figure>` : ''}`;
  } else {
    lBody = `<p class="note">${esc(l.note || l.error || 'Not available.')}</p>`;
  }
  blocks.push(`<div class="adblock"><div class="adhead"><h3>LinkedIn</h3>${statusChip(l.status)}</div>${lBody}</div>`);

  return `<section id="ads"><div class="section-head"><h2>Advertising</h2><span class="count">Public ad libraries · ${esc(adsData.country)} · ${esc(adsData.capturedAt.slice(0, 10))}</span></div>${summaryHtml('ads')}
<p class="lede">Ads the company's own advertiser accounts are running, from Google's Ads Transparency Center, Meta's Ad Library and LinkedIn's Ad Library. Libraries show ads, not spend.</p>${blocks.join('')}</section>`;
}

// ---------- hiring (public job boards) ----------

function jobsHtml() {
  const j = collected.jobs;
  if (!j || j.skipped) return '';
  if (j.status !== 'found') return `<section id="hiring"><div class="section-head"><h2>Hiring</h2></div><p class="note">${esc(j.note || j.error || 'No job board found.')}</p></section>`;
  const bars = (rows) => { const max = Math.max(1, ...rows.map((r) => r.count)); return `<div class="bars">${rows.map((r) => `<div class="bar-row"><span class="label" title="${esc(r.name)}">${esc(r.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${((r.count / max) * 100).toFixed(1)}%"></div></div><span class="value">${fmt(r.count)}</span></div>`).join('')}</div>`; };
  const roles = [['marketing', 'Marketing'], ['sales', 'Sales'], ['customer', 'Customer success'], ['other', 'Everything else']].map(([k, label]) => ({ name: label, count: j.byRole[k] || 0 }));
  const gtm = j.postings.filter((p) => p.role !== 'other');
  const table = gtm.length ? `<details><summary>Marketing, sales and customer roles (${gtm.length})</summary><table><thead><tr><th>Role</th><th>Title</th><th>Team</th><th>Location</th><th>Posted</th><th>Pay</th></tr></thead><tbody>${gtm.map((p) => `<tr><td>${esc(p.role)}</td><td>${link(p.url, p.title)}</td><td>${esc([p.department, p.team].filter(Boolean).join(' / '))}</td><td>${esc(p.location || '')}</td><td class="mono">${esc(p.posted || '')}</td><td>${esc(p.compensation || '')}</td></tr>`).join('')}</tbody></table></details>` : '';
  const tools = j.toolsMentioned.length ? `<h3>Tools named in job posts</h3><p class="note">How many open posts name each tool. A post naming a tool shows the team works with it or wants experience in it; it isn't an inventory of the stack.</p><div class="chips">${j.toolsMentioned.slice(0, 18).map((t) => `<span class="stat">${esc(t.tool)} <b>${fmt(t.posts)}</b></span>`).join('')}</div>` : '';
  return `<section id="hiring"><div class="section-head"><h2>Hiring</h2><span class="count">${esc(j.ats)} job board · ${fmt(j.openRoles)} open roles</span></div>${summaryHtml('jobs')}
<p class="note">Open roles from the company's public ${link(j.boardUrl, `${j.ats} board`)}, matched because: ${esc(j.match)}. Roles are grouped by title, department and team.</p>
<div class="chips"><span class="stat">Open roles <b>${fmt(j.openRoles)}</b></span>${j.datesShown ? `<span class="stat">Posted in last 30 days <b>${fmt(j.postedLast30Days)}</b></span><span class="stat">Last 90 days <b>${fmt(j.postedLast90Days)}</b></span>` : ''}${j.remoteShare !== null ? `<span class="stat">Remote <b>${j.remoteShare}%</b></span>` : ''}</div>
<h3>By role</h3>${bars(roles)}<h3>By department</h3>${bars(j.byDepartment.slice(0, 8))}${tools}${table}</section>`;
}

// ---------- changes over time (Wayback Machine) ----------

function historyHtml() {
  const h = collected.history;
  if (!h || h.skipped || !h.pages?.some((p) => p.rows?.length)) return '';
  const blocks = h.pages.filter((p) => p.rows?.length).map((p) => {
    const rows = [...p.rows, p.live].filter((r) => r && !r.error);
    const table = `<table><thead><tr><th>Date</th><th>Headline</th><th>Prices on the page</th><th>Tools in the HTML</th></tr></thead><tbody>${rows.map((r) => `<tr${r.thin ? ' class="weak"' : ''}><td class="mono">${r.live ? `${esc(r.date)} (live)` : link(r.archiveUrl, r.date)}</td><td>${r.thin ? '<span class="weak">little text in this copy</span>' : esc(r.h1[0] || r.title)}</td><td class="mono">${esc(r.prices.slice(0, 6).join(', '))}</td><td>${esc(r.tools.join(', '))}</td></tr>`).join('')}</tbody></table>`;
    const changes = p.changes.filter((c) => c.title || c.h1 || c.prices || c.ctas || c.tools).map((c) => {
      const bits = [];
      if (c.h1) bits.push(`Headline: <span class="weak">${esc(c.h1.before || '(none)')}</span> → <b>${esc(c.h1.after || '(none)')}</b>`);
      else if (c.title) bits.push(`Title: <span class="weak">${esc(c.title.before)}</span> → <b>${esc(c.title.after)}</b>`);
      const both = (a, b) => [a, b].filter(Boolean).join('; ');
      if (c.prices) bits.push(both(c.prices.added.length && `Prices added ${esc(c.prices.added.join(', '))}`, c.prices.removed.length && `prices removed ${esc(c.prices.removed.join(', '))}`));
      if (c.ctas) bits.push(both(c.ctas.added.length && `CTAs added "${esc(c.ctas.added.join('", "'))}"`, c.ctas.removed.length && `CTAs removed "${esc(c.ctas.removed.join('", "'))}"`));
      if (c.tools) bits.push(both(c.tools.added.length && `Tools added to the HTML: ${esc(c.tools.added.join(', '))}`, c.tools.removed.length && `no longer in the HTML: ${esc(c.tools.removed.join(', '))}`));
      return `<li><span class="weak mono">${esc(c.from)} → ${esc(c.to)}</span> ${bits.join('; ')}</li>`;
    }).join('');
    return `<h3>${esc(p.kind === 'home' ? 'Homepage' : 'Pricing page')}</h3><p class="note">${fmt(p.snapshotsAvailable)} monthly snapshots in the period; ${fmt(p.rows.length)} read.</p>${table}${changes ? `<details open><summary>What changed</summary><ul class="adlist">${changes}</ul></details>` : '<p class="note">No changes between readable copies.</p>'}`;
  }).join('');
  return `<section id="history"><div class="section-head"><h2>Changes over time</h2><span class="count">Wayback Machine · ${esc(h.years)} years</span></div>${summaryHtml('history')}
<p class="lede">Archived copies of the homepage and pricing page, about one per quarter, read as HTML without running scripts. Pages built by JavaScript can archive with little text. Tools are only those written into the page HTML; tags loaded by a tag manager don't show, so a tool leaving the HTML doesn't prove it was removed.</p>${blocks}</section>`;
}

// ---------- remaining sections ----------

function methodHtml() {
  const c = collected.consent || {};
  const consent = c.banner ? `A cookie banner was found and accepted (${esc(c.clicked)}), so tags that wait for consent are included.` : c.attempted === false ? 'Consent was not attempted, so tags that wait for consent may be missing.' : 'No cookie banner was shown in this region; consent tools can still load and grant consent by default.';
  const pages = collected.pages.map((p) => `<tr><td>${esc(p.kind)}</td><td>${link(p.url)}</td><td class="num">${p.error ? `<span class="chip unknown">failed</span>` : esc(p.status ?? '')}</td></tr>`).join('');
  const socials = collected.socials?.length ? `<h3>Social profiles linked from the homepage</h3><ul class="plain">${collected.socials.map((s) => `<li>${link(s)}</li>`).join('')}</ul>` : '';
  return `<section id="method"><div class="section-head"><h2>Method and sources</h2></div>
<p class="note">Captured ${esc(new Date(collected.capturedAt).toUTCString())} with a desktop Chromium browser. ${fmt(collected.requestCount)} network requests were recorded across ${collected.pages.length} pages. ${consent} Tags and consent rules can differ by country, so results reflect the region the capture ran from${collected.captureRegion ? ` (browser time zone ${esc(collected.captureRegion.timezone)}${collected.captureRegion.regionalGoogleDomains?.length ? `; Google served regional domains ${esc(collected.captureRegion.regionalGoogleDomains.join(', '))}` : ''})` : ''}. Everything here comes from what the public site sends to a browser. Server-side systems, ad spend and revenue are not visible, and any statement about them is inferred.</p>
${collected.ads?.skipped ? `<p class="note">Ad libraries were not checked (${esc(collected.ads.skipped)}).</p>` : ''}${collected.seo?.skipped ? `<p class="note">Search data was not collected (${esc(collected.seo.skipped)}). Add DataForSEO credentials to include it.</p>` : ''}${investigationsHtml()}${checksHtml()}<div class="table-wrap"><table><thead><tr><th>Page</th><th>URL</th><th>Status</th></tr></thead><tbody>${pages}</tbody></table></div>${socials}</section>`;
}

function investigationsHtml() {
  const invs = collected.investigations || [];
  if (!invs.length) return '';
  const describe = (i) => {
    if (i.tool === 'page') return `Captured ${link(i.finalUrl || i.url, path_(i.finalUrl || i.url))}${i.actions?.length ? ` after ${i.actions.map((a) => a.click ? `clicking "${esc(a.click)}"` : a.scroll ? 'scrolling' : 'waiting').join(', ')}` : ''}`;
    if (i.tool === 'host') return `Inspected the scripts of <code>${esc(i.host)}</code>`;
    if (i.tool === 'seo') return i.query === 'competitors' ? `Searched for domains ranking for ${i.keywords.length} keywords` : `Pulled keywords${i.urlLike ? ` for URLs like <code>${esc(i.urlLike)}</code>` : ''}`;
    if (i.tool === 'ads') return `Searched the ${esc(i.platform)} ad library for "${esc(i.name)}" (${esc(i.country)})`;
    return esc(i.tool);
  };
  return `<h3>Follow-up investigation</h3><p class="note">After the first pass, the analyst gathered more evidence where the collected data had gaps.</p><ul class="plain">${invs.map((i) => `<li><span class="mono weak">${esc(i.id)}</span> ${describe(i)}${i.label ? ` <span class="weak">(${esc(i.label)})</span>` : ''}</li>`).join('')}</ul>`;
}

function checksHtml() {
  const lines = [];
  if (verify?.summary) {
    const v = verify.summary;
    lines.push(`<li><b>Citation check:</b> ${fmt(v.citations)} citations across ${fmt(v.claims)} claims were matched against the collected evidence${v.problems ? `, with ${v.problems} unresolved problem${v.problems === 1 ? '' : 's'}` : ', with none unresolved'}.</li>`);
  }
  if (review?.items?.length) {
    const changed = review.items.filter((i) => i.verdict && i.verdict !== 'supported').length;
    lines.push(`<li><b>Independent fact-check:</b> a separate reviewer checked ${fmt(review.items.length)} items (the summary, highlights and every claim) against the evidence and flagged ${changed} for correction. Those were fixed before publishing.</li>`);
  }
  return lines.length ? `<h3>Fact-checking</h3><ul class="plain">${lines.join('')}</ul>` : '';
}

// ---------- page ----------

const nav = [
  ...SECTIONS.filter((s) => findings.sections[s.key]).map((s) => [s.id, s.title]),
  ['stack', 'Marketing stack'],
  ...(adsData ? [['ads', 'Advertising']] : []),
  ['content', 'Content footprint'],
  ...(seo ? [['search', 'Organic search']] : []),
  ...(collected.jobs && !collected.jobs.skipped ? [['hiring', 'Hiring']] : []),
  ...(collected.history?.pages?.some((p) => p.rows?.length) ? [['history', 'Changes over time']] : []),
  ['method', 'Method and sources']
];

const glance = findings.at_a_glance.map((g) => `<div><dt>${esc(g.label)} ${chip(g.status)}</dt><dd>${esc(g.value)}</dd></div>`).join('');
const date = collected.capturedAt.slice(0, 10);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(findings.company)} teardown</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="${esc(findings.summary)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,500..800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
${css}
</style>
</head>
<body>
<div class="layout">
<nav class="index" aria-label="Report sections"><p>Contents</p><ol>${nav.map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join('')}</ol></nav>
<main>
<header class="masthead">
<span class="eyebrow">Behindsight · Marketing teardown</span>
<h1>${esc(findings.company)}</h1>
<div class="meta"><span>${link(collected.target, collected.domain)}</span><span>Captured ${esc(date)}</span><span>${collected.pages.length} pages · ${fmt(collected.requestCount)} requests</span></div>
<p class="summary">${esc(findings.summary)}</p>
<div class="legend"><span>${chip('seen')} observed directly on the site</span><span>${chip('inferred')} a conclusion drawn from evidence</span><span>${chip('unknown')} the evidence doesn't say</span></div>
<dl class="glance">${glance}</dl>
</header>
${SECTIONS.map(sectionHtml).join('\n')}
${stackHtml()}
${await adsHtml()}
${contentHtml()}
${searchHtml()}
${jobsHtml()}
${historyHtml()}
${methodHtml()}
<footer>Generated by Behindsight ${esc(collected.version)} from public website evidence. Inferences are an analyst's reading of that evidence and can be wrong.</footer>
</main>
</div>
</body>
</html>
`;

const out = path.join(dir, 'report.html');
await writeFile(out, html);
console.log(out);
