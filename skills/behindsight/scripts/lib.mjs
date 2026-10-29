// Shared helpers for the collector and the investigation tools: domain and vendor matching,
// event extraction, consent handling, in-page extraction and credentials.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function registrableDomain(host) {
  // Good-enough eTLD+1: handles two-part public suffixes like co.uk and com.au.
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const twoPartSuffix = /^(co|com|net|org|gov|ac|edu)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2;
  return parts.slice(twoPartSuffix ? -3 : -2).join('.');
}

export const hostMatches = (host, h) => h === '*' || host === h || host.endsWith(`.${h}`);

export const LANGS = new Set('ar bg cs da de el en es et fi fr he hi hr hu id it ja ko lt lv ms nb nl no pl pt ro ru sk sl sr sv th tr uk vi zh'.split(' '));
export const isLocale = (seg) => { const m = seg.toLowerCase().match(/^([a-z]{2})([-_][a-z]{2,4})?$/); return !!m && LANGS.has(m[1]); };

// Event names visible in collection requests: GA4, Meta, Pinterest, Reddit, TikTok, Google Ads, Segment.
export function extractEvents(u, postData) {
  const events = [];
  if (/\/g\/collect/.test(u.pathname)) {
    const en = u.searchParams.get('en');
    if (en) events.push({ platform: 'GA4', name: en });
    for (const line of (postData || '').split('\n')) {
      const m = line.match(/(?:^|&)en=([^&]+)/);
      if (m) events.push({ platform: 'GA4', name: decodeURIComponent(m[1]) });
    }
  }
  if (/facebook\.com$/.test(u.hostname) && /^\/tr/.test(u.pathname)) {
    const ev = u.searchParams.get('ev');
    if (ev) events.push({ platform: 'Meta Pixel', name: ev });
  }
  if (/facebook\.com$/.test(u.hostname) && /^\/tr/.test(u.pathname) && postData) {
    const ev = postData.match(/(?:^|&)ev=([^&]+)/)?.[1];
    if (ev) events.push({ platform: 'Meta Pixel', name: decodeURIComponent(ev) });
  }
  if (/pinterest\.com$/.test(u.hostname) && /^\/v3/.test(u.pathname)) {
    const ev = u.searchParams.get('event');
    if (ev) events.push({ platform: 'Pinterest', name: ev });
  }
  if (/reddit\.com$/.test(u.hostname) && /rp\.gif/.test(u.pathname)) {
    const ev = u.searchParams.get('event');
    if (ev) events.push({ platform: 'Reddit', name: ev });
  }
  if (/tiktok/.test(u.hostname) && /pixel/.test(u.pathname) && postData) {
    try { const b = JSON.parse(postData); if (b.event) events.push({ platform: 'TikTok', name: b.event }); } catch {}
  }
  if (/googleadservices\.com$|googleads\.g\.doubleclick\.net$/.test(u.hostname) && /\/pagead\/conversion\//.test(u.pathname)) {
    const label = u.searchParams.get('label');
    events.push({ platform: 'Google Ads', name: label ? `conversion (label ${label})` : 'conversion' });
  }
  if (/segment\.io$/.test(u.hostname) && /\/v1\/(t|track)/.test(u.pathname) && postData) {
    try { const b = JSON.parse(postData); if (b.event) events.push({ platform: 'Segment', name: b.event }); } catch {}
  }
  return events;
}

// Precedence: the environment, then the skill's .env, then the shared DataForSEO
// config the DataForSEO MCP server also reads (~/.config/dataforseo/.env).
export async function loadEnv(skillDir) {
  const files = [
    path.join(skillDir, '.env'),
    process.env.DATAFORSEO_ENV_FILE,
    path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'dataforseo', '.env')
  ].filter(Boolean);
  const env = {};
  for (const file of files.reverse()) {
    if (!existsSync(file)) continue;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { ...env, ...process.env };
}

// Matchers bound to one site: what counts as first party, which vendor a request belongs to.
export function siteHelpers({ siteHost, siteRoot, signatures }) {
  const isFirstParty = (host) => registrableDomain(host) === siteRoot;
  // Domains that belong to a known vendor, even when a particular path isn't a signature match.
  const knownVendorDomains = new Set(signatures.vendors.flatMap((v) => [...(v.hosts || []), ...(v.rules || []).map((r) => r.host).filter((h) => h && h !== '*')]).map((h) => registrableDomain(h)));

  function matchVendor(u) {
    // The company's own domain never matches a vendor by host (a scheduling company's site isn't "using" itself).
    const own = isFirstParty(u.hostname);
    for (const v of signatures.vendors) {
      if (own) {
        if ((v.rules || []).some((r) => r.host === '*' && new RegExp(r.path).test(u.pathname))) return v;
        continue;
      }
      if ((v.hosts || []).some((h) => hostMatches(u.hostname, h))) return v;
      if ((v.rules || []).some((r) => (r.hostPattern ? new RegExp(r.hostPattern).test(u.hostname) : hostMatches(u.hostname, r.host)) && new RegExp(r.path).test(u.pathname))) return v;
    }
    // Tools proxied through or bundled on the company's own domain only show up by name in the URL.
    for (const v of signatures.vendors) {
      if (v.urlPattern && new RegExp(v.urlPattern, 'i').test(u.pathname)) return v;
      if (v.queryPattern && new RegExp(v.queryPattern, 'i').test(u.search)) return v;
    }
    return null;
  }

  function extractIds(vendor, url) {
    const ids = [];
    for (const rule of vendor.ids || []) {
      const m = url.match(new RegExp(rule.pattern));
      // Real account IDs always contain a digit; this drops template placeholders like AW-AW.
      if (m && /\d/.test(m[1])) ids.push({ label: rule.label, value: `${rule.prefix || ''}${m[1]}` });
    }
    return ids;
  }

  function firstPartyTagging(u) {
    if (!isFirstParty(u.hostname)) return [];
    return signatures.first_party_tagging.filter(
      (t) => new RegExp(t.path).test(u.pathname + u.search) && !t.excludeHosts.some((h) => hostMatches(u.hostname, h))
    );
  }

  const slugify = (url) => {
    const u = new URL(url);
    const p = (u.hostname.replace(/^www\./, '') === siteHost ? '' : u.hostname + '-') + u.pathname.replace(/\/+$/, '');
    return (p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home').toLowerCase().slice(0, 80);
  };

  // The site section a URL belongs to: its first path folder, skipping a locale folder.
  // Other subdomains (help.example.com) count as their own section.
  function sectionOf(u) {
    const host = u.hostname.replace(/^www\./, '');
    if (host !== siteHost) return host;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs[0] && isLocale(segs[0]) && segs.length > 1) segs.shift();
    if (!segs.length) return 'homepage';
    return segs.length === 1 ? '(top-level pages)' : segs[0];
  }

  return { isFirstParty, knownVendorDomains, matchVendor, extractIds, firstPartyTagging, slugify, sectionOf };
}

// ---------- consent ----------

export const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept', '.osano-cm-accept-all', '#truste-consent-button',
  '[data-cky-tag="accept-button"]', '.cky-btn-accept', '#didomi-notice-agree-button',
  'button[data-testid="uc-accept-all-button"]', '.iubenda-cs-accept-btn', '#hs-eu-confirmation-button',
  '.cmplz-accept', '#wt-cli-accept-all-btn', '.cc-allow', '[data-tid="banner-accept"]', '.ch2-allow-all-btn'
];
export const CONSENT_TEXT = /^\s*(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree( and close)?|got it|ok(ay)?|i accept)\s*$/i;

export async function acceptConsent(page) {
  for (const frame of page.frames()) {
    for (const sel of CONSENT_SELECTORS) {
      const el = frame.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click({ timeout: 3000 }).catch(() => {});
        return { banner: true, clicked: sel };
      }
    }
  }
  for (const frame of page.frames()) {
    const btn = frame.getByRole('button', { name: CONSENT_TEXT }).first();
    if (await btn.isVisible().catch(() => false)) {
      const text = (await btn.innerText().catch(() => '')).trim();
      await btn.click({ timeout: 3000 }).catch(() => {});
      return { banner: true, clicked: `button "${text}"` };
    }
  }
  return { banner: false, clicked: null };
}

// ---------- page extraction (runs in the browser) ----------

export function extractPage() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const CTA = /(start|try|get started|sign ?up|book|demo|tour|contact|talk to|buy|shop|add to (cart|bag)|pricing|free|trial|subscribe|download|join|request|get access|install|create account|see plans|watch)/i;
  const ctas = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a, button')) {
    const text = clean(el.innerText);
    if (!text || text.length > 60 || !CTA.test(text) || !visible(el)) continue;
    const href = el.tagName === 'A' ? el.href : null;
    const key = text + '|' + href;
    if (seen.has(key)) continue;
    seen.add(key);
    const top = el.getBoundingClientRect().top;
    ctas.push({ text, href, inNav: !!el.closest('nav, header'), aboveFold: top < 900 });
  }
  const jsonLd = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { jsonLd.push(JSON.parse(s.textContent)); } catch {}
  }
  const forms = [...document.querySelectorAll('form')].map((f) => ({
    action: f.action || null,
    id: f.id || null,
    classes: f.className || null,
    fields: [...f.querySelectorAll('input, select, textarea')]
      .filter((i) => i.type !== 'hidden')
      .map((i) => i.name || i.id || i.type)
      .slice(0, 25)
  }));
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => ({ href: a.href, text: clean(a.innerText).slice(0, 80), inNav: !!a.closest('nav, header'), inFooter: !!a.closest('footer') }))
    .filter((l) => /^https?:/.test(l.href));
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    description: meta('meta[name="description"]'),
    ogTitle: meta('meta[property="og:title"]'),
    ogDescription: meta('meta[property="og:description"]'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    // Responsive layouts often render a heading twice (one copy per breakpoint): keep one copy.
    h1: [...document.querySelectorAll('h1')].map((h) => { const t = clean(h.innerText); const half = t.slice(0, (t.length - 1) / 2); return t === `${half} ${half}` ? half : t; }).filter(Boolean).slice(0, 5),
    h2: [...document.querySelectorAll('h2')].map((h) => clean(h.innerText)).filter(Boolean).slice(0, 25),
    ctas: ctas.slice(0, 40),
    forms,
    feeds: [...document.querySelectorAll('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')].map((l) => l.href).filter(Boolean),
    iframes: [...document.querySelectorAll('iframe[src]')].map((f) => f.src).filter((s) => /^https?:/.test(s)).slice(0, 30),
    jsonLd,
    links,
    text: (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 25000)
  };
}
