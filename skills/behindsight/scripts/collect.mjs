#!/usr/bin/env node
// Collects public evidence about a company's marketing from its website:
// key page content, a network grab (pixels, tags, IDs), Wappalyzer detections
// and the sitemap, written to one folder for the agent to read.
//
// Usage: node scripts/collect.mjs <domain-or-url> [--out <dir>] [--pages <url,url>]
//        [--max-pages 7] [--wait 6000] [--no-consent] [--no-wappalyzer]
//        [--no-seo] [--seo-location 2840] [--seo-language en] [--no-ads] [--ads-country US]
//        [--no-content] [--content-posts 20]
//
// Search data is added when DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are set in the
// environment, the skill's .env file or ~/.config/dataforseo/.env.

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { collectSeo, collectSerpCompetitors, createClient, enrichSeo, seoCredentials } from './seo.mjs';
import { collectAds } from './ads.mjs';
import { cadence, collectContent, savePosts } from './content.mjs';
import { acceptConsent, extractEvents, extractPage, hostMatches, isLocale, loadEnv, registrableDomain, siteHelpers, sleep } from './lib.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAPPALYZER_CLI = path.join(SKILL_DIR, 'vendor/wappalyzer/cli.js');
const signatures = JSON.parse(await readFile(path.join(SKILL_DIR, 'scripts/signatures.json'), 'utf8'));

// Wappalyzer categories worth keeping in a marketing report; the rest is
// infrastructure and goes to the "other technologies" list.
const MARKETING_CATEGORIES = new Set([
  'Analytics', 'Tag managers', 'Advertising', 'Retargeting', 'Marketing automation', 'CRM',
  'Live chat', 'A/B Testing', 'Personalisation', 'Customer data platform', 'Affiliate programs',
  'Referral marketing', 'Reviews', 'Surveys', 'Email', 'Cookie compliance', 'Payment processors',
  'Appointment scheduling', 'Segmentation', 'Loyalty & rewards', 'Feature management',
  'User onboarding', 'Form builders', 'Video players', 'CMS', 'Ecommerce', 'Page builders',
  'Buy now pay later', 'Cart abandonment', 'Webinars', 'Session replay', 'Account identification',
  'Interactive demos', 'SEO'
]);

// ---------- arguments ----------

const args = process.argv.slice(2);
const opts = { maxPages: 7, wait: 6000, consent: true, wappalyzer: true, content: true, contentPosts: 20, ads: true, adsCountry: 'US', seo: true, seoLocation: 2840, seoLanguage: 'en', pages: [], out: null };
let target = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opts.out = args[++i];
  else if (a === '--pages') opts.pages = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--max-pages') opts.maxPages = Number(args[++i]);
  else if (a === '--wait') opts.wait = Number(args[++i]);
  else if (a === '--no-consent') opts.consent = false;
  else if (a === '--no-wappalyzer') opts.wappalyzer = false;
  else if (a === '--no-seo') opts.seo = false;
  else if (a === '--no-ads') opts.ads = false;
  else if (a === '--no-content') opts.content = false;
  else if (a === '--content-posts') opts.contentPosts = Number(args[++i]);
  else if (a === '--ads-country') opts.adsCountry = args[++i].toUpperCase();
  else if (a === '--seo-location') opts.seoLocation = Number(args[++i]);
  else if (a === '--seo-language') opts.seoLanguage = args[++i];
  else if (!a.startsWith('--')) target = a;
}
if (!target) {
  console.error('Usage: node scripts/collect.mjs <domain-or-url> [--out dir] [--pages url,url] [--max-pages 7] [--wait 6000] [--no-consent] [--no-wappalyzer] [--no-seo] [--seo-location 2840] [--seo-language en] [--no-ads] [--ads-country US] [--no-content] [--content-posts 20]');
  process.exit(1);
}

const startUrl = new URL(/^https?:\/\//.test(target) ? target : `https://${target}`);
const siteHost = startUrl.hostname.replace(/^www\./, '');
const siteRoot = registrableDomain(startUrl.hostname);
const today = new Date().toISOString().slice(0, 10);
const outDir = path.resolve(opts.out || path.join(process.cwd(), 'teardowns', `${siteHost}-${today}`));
await mkdir(path.join(outDir, 'pages'), { recursive: true });

const log = (...m) => console.error('[collect]', ...m);

const env = await loadEnv(SKILL_DIR);

// ---------- helpers ----------

const { isFirstParty, knownVendorDomains, matchVendor, extractIds, firstPartyTagging, slugify, sectionOf } = siteHelpers({ siteHost, siteRoot, signatures });
const fetchStatuses = {};

// ---------- page discovery ----------

const PAGE_KINDS = [
  { kind: 'pricing', href: /\/(pricing|plans|price)(\/|$|\?)/i, text: /^(pricing|plans( & pricing)?|plans and pricing|see pricing|view pricing)$/i },
  { kind: 'product', href: /^\/(product|products|features|platform|how-it-works|solutions)(\/|$)/i, text: /^(product|features|platform|how it works)$/i },
  { kind: 'signup', href: /\/(signup|sign-up|register|get-started|start|trial|join|create-account)(\/|$|\?)/i, text: /(sign ?up|get started|start (for )?free|try (it )?(for )?free|free trial|create (an |free )?account|start (your )?trial)/i },
  { kind: 'demo', href: /\/(demo|book-a-demo|request-demo|get-a-demo|contact-sales|talk-to-sales)(\/|$|\?)|^\/sales(\/|$)/i, text: /(book a demo|request a demo|get a demo|schedule a demo|talk to sales|contact sales|talk to an expert)/i },
  { kind: 'customers', href: /^\/(customers|case-studies|customer-stories|stories|success-stories)(\/|$)/i, text: /^(customers|case studies|customer stories)$/i },
  { kind: 'about', href: /^\/(about|about-us|company|pages\/(about|about-us|our-story|story|mission))(\/|$)/i, text: /^(about|about us|company|our story|our mission)$/i },
  { kind: 'blog', href: /^\/(blog|resources|insights|articles|learn)\/?$/i, text: /^(blog|resources|insights|learn)$/i },
  { kind: 'collection', href: /^\/(collections|shop|category|categories)\/[^/]+\/?$/i, text: /^(shop|shop all|best ?sellers|new arrivals)$/i }
];

function discoverPages(home) {
  const found = new Map();
  for (const { kind, href, text } of PAGE_KINDS) {
    const candidates = home.links.filter((l) => {
      let u;
      try { u = new URL(l.href); } catch { return false; }
      if (!isFirstParty(u.hostname)) return false;
      return href.test(u.pathname) || text.test(l.text);
    });
    // Prefer index pages (/customers over /customers/acme), then nav links over footer links.
    const depth = (l) => new URL(l.href).pathname.split('/').filter(Boolean).length;
    candidates.sort((a, b) => (depth(a) - depth(b)) || (b.inNav - a.inNav) || (a.inFooter - b.inFooter));
    const pick = candidates[0];
    if (pick) {
      const u = new URL(pick.href);
      u.hash = '';
      if (![...found.values()].includes(u.href) && u.href !== home.url) found.set(kind, u.href);
    }
  }
  return found;
}

// ---------- browser capture ----------

// Search data runs alongside the browser capture.
const seoCreds = seoCredentials(env);
let seoClient = null;
const seoJob = !opts.seo
  ? Promise.resolve({ skipped: 'disabled with --no-seo' })
  : !seoCreds
    ? Promise.resolve({ skipped: 'no DataForSEO credentials' })
    : collectSeo({ client: (seoClient = createClient({ credentials: seoCreds, baseUrl: env.DATAFORSEO_BASE_URL })), domain: siteHost, locationCode: opts.seoLocation, languageCode: opts.seoLanguage })
      .catch((e) => ({ skipped: `failed: ${e.message}` }));
if (seoCreds && opts.seo) log(`fetching search data from DataForSEO (location ${opts.seoLocation})`);

const browser = await chromium.launch({ headless: true });
const major = browser.version().split('.')[0];
const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
const context = await browser.newContext({ userAgent, viewport: { width: 1440, height: 900 }, locale: 'en-US' });

const requests = [];
let phase = 'pre-consent';
let currentPage = null;

async function capture(url, kind) {
  const page = await context.newPage();
  currentPage = url;
  page.on('request', (req) => {
    let post = null;
    try { post = req.postData(); } catch {}
    requests.push({
      page: currentPage, kind, phase, url: req.url().slice(0, 2000), method: req.method(),
      type: req.resourceType(), post: post && post.length < 20000 ? post : null
    });
  });
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    status = resp?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // Scroll to trigger lazy-loaded tags and widgets.
    for (let y = 0; y < 6; y++) {
      await page.mouse.wheel(0, 1200);
      await sleep(400);
    }
    await sleep(opts.wait);
  } catch (e) {
    log(`failed to load ${url}: ${e.message}`);
    await page.close();
    return { url, kind, status, error: e.message };
  }
  let consent = null;
  if (kind === 'home' && opts.consent) {
    consent = await acceptConsent(page);
    phase = consent.banner ? 'post-consent' : 'no-banner';
    if (!consent.banner) for (const r of requests) if (r.phase === 'pre-consent') r.phase = 'no-banner';
    if (consent.banner) {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(opts.wait);
    }
  } else if (kind === 'home') {
    phase = 'consent-not-attempted';
  }
  // Back to the top so above-the-fold positions are measured like a first visit, sticky headers included.
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(500);
  const data = await page.evaluate(extractPage).catch((e) => ({ error: e.message }));
  await page.close();
  // Requests were logged against the requested URL; relabel them with the final one after redirects.
  if (data.url && data.url !== url) for (const r of requests) if (r.page === url) r.page = data.url;
  return { ...data, requestedUrl: url, kind, status, consent };
}

log(`capturing ${startUrl.href}`);
const home = await capture(startUrl.href, 'home');
if (home.error && !home.links) {
  log('homepage failed to load; aborting');
  await browser.close();
  process.exit(2);
}

const pageTargets = new Map();
if (opts.pages.length) opts.pages.forEach((p, i) => pageTargets.set(`page-${i + 1}`, new URL(p, startUrl).href));
else for (const [k, v] of discoverPages(home)) pageTargets.set(k, v);
// Fill unused slots with other top-level pages linked from the homepage nav.
if (!opts.pages.length) {
  const taken = new Set([home.url, ...pageTargets.values()].map((u) => u && u.replace(/\/$/, '')));
  for (const l of (home.links || []).filter((l) => l.inNav)) {
    if (pageTargets.size >= opts.maxPages - 1) break;
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (!isFirstParty(u.hostname) || u.hash || /\.(pdf|zip|png|jpg)$/i.test(u.pathname)) continue;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length !== 1 || /^(login|log-in|signin|sign-in|account|cart|search|careers|jobs|legal|privacy|terms)$/i.test(segs[0]) || /menu|promo|banner|popup|modal/i.test(segs[0])) continue;
    const href = (u.origin + u.pathname).replace(/\/$/, '');
    if (taken.has(href)) continue;
    taken.add(href);
    pageTargets.set(`nav: ${segs[0]}`, u.origin + u.pathname);
  }
}
const targets = [...pageTargets.entries()].slice(0, Math.max(0, opts.maxPages - 1));

// Wappalyzer runs in its own processes while Playwright captures pages.
const wappalyzerJob = opts.wappalyzer ? runWappalyzer([home.url || startUrl.href, ...targets.map(([, u]) => u)]) : Promise.resolve(null);

const pages = [home];
for (const [kind, url] of targets) {
  log(`capturing ${kind}: ${url}`);
  pages.push(await capture(url, kind));
}

// Sitemaps are fetched through the same browser session, since many sites rate-limit or block plain HTTP clients.
log('reading sitemap');
const sitemapRaw = await collectSitemap();
const sitemap = summariseSitemap(sitemapRaw);

const socialHosts = /(^|\.)(x\.com|twitter\.com|linkedin\.com|youtube\.com|facebook\.com|instagram\.com|tiktok\.com|github\.com|discord\.(gg|com)|threads\.net|bsky\.app|reddit\.com|medium\.com|pinterest\.com)$/;
const socials = [...new Set((home.links || []).filter((l) => { try { const u = new URL(l.href); return socialHosts.test(u.hostname) && u.pathname.length > 1 && !/\/(share|intent|sharer)/.test(u.pathname); } catch { return false; } }).map((l) => l.href.replace(/\?.*$/, '')))];

// Content sample: newest posts plus top search-traffic posts (search data arrives in parallel).
const seoForContent = await seoJob;
const content = opts.content
  ? await collectContent({ context, origin: new URL(home.url || startUrl.href).origin, siteRoot, homePage: home, sitemapUrls: sitemapRaw.urls, seoPages: seoForContent.pages || [], recent: opts.contentPosts, log }).catch((e) => ({ source: 'error', error: e.message, posts: [] }))
  : { skipped: 'disabled with --no-content', posts: [] };
if (!content.skipped) {
  await savePosts(content, outDir, slugify);
  content.cadence = cadence(content);
}

const ads = opts.ads
  ? await collectAds({ browser, userAgent, domain: siteHost, homeTitle: home.title, socials, country: opts.adsCountry, outDir, log })
  : { skipped: 'disabled with --no-ads' };
await browser.close();

// ---------- Wappalyzer ----------

async function runWappalyzer(urls) {
  if (!existsSync(WAPPALYZER_CLI)) {
    log('Wappalyzer not installed (run scripts/setup.sh); skipping');
    return { error: 'not installed' };
  }
  const env = { ...process.env, CHROMIUM_BIN: chromium.executablePath() };
  const results = [];
  const queue = [...urls];
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      const dataDir = await mkdtemp(path.join(tmpdir(), 'wappalyzer-'));
      const out = await new Promise((resolve) => {
        execFile('node', [WAPPALYZER_CLI, url, '-w', '15000'], { env: { ...env, CHROMIUM_DATA_DIR: dataDir }, timeout: 90000, maxBuffer: 20e6 },
          (err, stdout) => resolve(err && !stdout ? { error: err.message } : stdout));
      });
      await rm(dataDir, { recursive: true, force: true });
      try { results.push({ url, ...(typeof out === 'string' ? JSON.parse(out) : out) }); }
      catch { results.push({ url, error: 'unparseable output' }); }
    }
  }
  await Promise.all([worker(), worker()]);
  return results;
}

const wappalyzer = await wappalyzerJob;

// ---------- sitemap ----------

async function fetchText(url) {
  try {
    let r = await context.request.get(url, { timeout: 20000, maxRedirects: 5 });
    if (r.status() === 403 || r.status() === 429) {
      // Bot protection often lets a real page load through where a bare request fails.
      const page = await context.newPage();
      const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
      fetchStatuses[url] = nav?.status() ?? r.status();
      const body = nav?.ok() ? await nav.body().catch(() => null) : null;
      await page.close();
      if (!body) return null;
      return body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body).toString('utf8') : body.toString('utf8');
    }
    fetchStatuses[url] = r.status();
    if (!r.ok()) return null;
    const buf = await r.body();
    if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
    return buf.toString('utf8');
  } catch (e) {
    fetchStatuses[url] = e.message.split('\n')[0];
    return null;
  }
}

async function collectSitemap() {
  const origin = new URL(home.url || startUrl.href).origin;
  const robots = await fetchText(`${origin}/robots.txt`);
  let roots = robots ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
  if (!roots.length) roots = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];
  const urls = [];
  const fetched = [];
  const queue = [...new Set(roots)];
  // Sections like /blog/ often run as separate installs with their own sitemap, missing from the root index.
  const folders = [...new Set((home.links || []).map((l) => { try { const u = new URL(l.href); return u.origin === origin ? u.pathname.split('/').filter(Boolean)[0] : null; } catch { return null; } }).filter((f) => f && /^[a-z0-9-]{2,30}$/i.test(f)))];
  const subfolderCandidates = folders.filter((f) => /^(blog|resources|learn|academy|help|docs|support|news|insights|library|guides|community|stories)$/i.test(f)).slice(0, 6)
    .flatMap((f) => [`${origin}/${f}/sitemap_index.xml`, `${origin}/${f}/sitemap.xml`]);
  let subfoldersQueued = false;
  while ((queue.length || !subfoldersQueued) && fetched.length < 60 && urls.length < 50000) {
    if (!queue.length) {
      subfoldersQueued = true;
      const covered = new Set(urls.map((x) => { try { return new URL(x.loc).pathname.split('/').filter(Boolean)[0]; } catch { return null; } }));
      queue.push(...subfolderCandidates.filter((u) => !covered.has(new URL(u).pathname.split('/')[1])));
      if (!queue.length) break;
    }
    const sm = queue.shift();
    const xml = await fetchText(sm);
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    fetched.push(sm);
    if (/<sitemapindex/i.test(xml)) {
      for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi)) queue.push(m[1].trim());
    } else {
      for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
        const loc = m[1].match(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/i)?.[1]?.trim();
        const lastmod = m[1].match(/<lastmod>\s*(.*?)\s*<\/lastmod>/i)?.[1] || null;
        if (loc) urls.push({ loc, lastmod });
      }
    }
  }
  // Sitemap indexes often list the same URL more than once; count each URL once.
  const unique = [...new Map(urls.map((x) => [x.loc.replace(/\/$/, ''), x])).values()];
  return { robotsFound: !!robots, sitemaps: fetched, truncated: queue.length > 0 || urls.length >= 50000, urls: unique, duplicatesRemoved: urls.length - unique.length, fetchStatuses };
}

function summariseSitemap(sm) {
  const sections = {};
  const locales = {};
  const months = {};
  const patterns = {
    comparison: /^(?!\/(blog|resources|insights|articles|news|learn)\/).*(\/vs\/|-vs-|versus|alternative|compare)/i,
    'comparison posts': /^\/(blog|resources|insights|articles|news|learn)\/.*(\/vs\/|-vs-|versus|alternative|compare)/i, integrations: /\/integrations?\//i,
    templates: /\/templates?\//i, customers: /\/(customers|case-studies|customer-stories|stories)\//i,
    glossary: /\/(glossary|dictionary|terms)\//i, docs: /\/(docs|documentation|help|support|kb|knowledge-base)\//i,
    blog: /\/(blogs?|articles|insights|news)\//i, resources: /\/resources\//i, careers: /\/(careers|jobs)\//i,
    changelog: /\/(changelog|releases|whats-new|updates)\//i, events: /\/(webinars?|events?)\//i,
    'use-cases': /\/(use-cases|solutions|industries|for)\//i, tools: /\/(tools|calculators?|generators?)\//i
  };
  const patternCounts = Object.fromEntries(Object.keys(patterns).map((k) => [k, 0]));
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  for (const { loc, lastmod } of sm.urls) {
    let u;
    try { u = new URL(loc); } catch { continue; }
    const segs = u.pathname.split('/').filter(Boolean);
    const localeSeg = segs[0] && isLocale(segs[0]) && segs.length > 1 ? segs[0] : segs[1] && isLocale(segs[1]) && segs.length > 2 ? segs[1] : null;
    if (localeSeg) locales[localeSeg.toLowerCase()] = (locales[localeSeg.toLowerCase()] || 0) + 1;
    const section = sectionOf(u);
    sections[section] = (sections[section] || 0) + 1;
    for (const [k, re] of Object.entries(patterns)) if (re.test(u.pathname.replace(/^\/[a-z]{2}(-[a-z]{2,4})?(?=\/)/i, '') + '/')) patternCounts[k]++;
    const d = lastmod ? new Date(lastmod) : null;
    if (d && !isNaN(d) && d >= cutoff) {
      const key = d.toISOString().slice(0, 7);
      months[key] = (months[key] || 0) + 1;
    }
  }
  const withDates = sm.urls.filter((x) => x.lastmod && !isNaN(new Date(x.lastmod)));
  const recent = withDates.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod)).slice(0, 25);
  // When most URLs share one lastmod day, the CMS likely regenerates the dates on every build.
  const dayCounts = {};
  for (const x of withDates) { const d = x.lastmod.slice(0, 10); dayCounts[d] = (dayCounts[d] || 0) + 1; }
  const topDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];
  return {
    totalUrls: sm.urls.length,
    fetchStatuses: sm.urls.length ? undefined : sm.fetchStatuses,
    sitemapsRead: sm.sitemaps.length,
    truncated: sm.truncated,
    sections: Object.entries(sections).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
    allSections: Object.keys(sections),
    locales: Object.entries(locales).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    patterns: patternCounts,
    lastmodByMonth: Object.entries(months).sort().map(([month, count]) => ({ month, count })),
    lastmodCoverage: sm.urls.length ? Math.round((withDates.length / sm.urls.length) * 100) : 0,
    lastmodSuspect: !!(topDay && withDates.length > 50 && topDay[1] / withDates.length > 0.4),
    lastmodTopDayShare: topDay && withDates.length ? Math.round((topDay[1] / withDates.length) * 100) : null,
    recent: recent.map((x) => ({ url: x.loc, lastmod: x.lastmod }))
  };
}

// ---------- classify network requests ----------

const vendorHits = new Map();
const unknownHosts = new Map();
const fpTagging = new Map();
const events = [];
for (const r of requests) {
  let u;
  try { u = new URL(r.url); } catch { continue; }
  if (!/^https?:$/.test(u.protocol)) continue;
  for (const t of firstPartyTagging(u)) {
    const key = `${t.name}|${u.hostname}`;
    if (!fpTagging.has(key)) fpTagging.set(key, { name: t.name, host: u.hostname, example: r.url.slice(0, 300) });
  }
  for (const ev of extractEvents(u, r.post)) events.push({ ...ev, page: r.page, phase: r.phase });
  const v = matchVendor(u);
  if (v) {
    const hit = vendorHits.get(v.name) || { name: v.name, category: v.category, aliases: v.aliases || [], requests: 0, hosts: new Set(), pages: new Set(), phases: new Set(), ids: new Map(), example: r.url.slice(0, 300) };
    hit.requests++;
    hit.hosts.add(u.hostname);
    hit.pages.add(r.page);
    hit.phases.add(r.phase);
    for (const id of extractIds(v, r.url)) hit.ids.set(`${id.label}:${id.value}`, id);
    vendorHits.set(v.name, hit);
  } else if (!isFirstParty(u.hostname) && !knownVendorDomains.has(registrableDomain(u.hostname)) && !signatures.ignore_hosts.some((h) => hostMatches(u.hostname, h))) {
    const h = unknownHosts.get(u.hostname) || { host: u.hostname, requests: 0, types: new Set(), pages: new Set(), example: r.url.slice(0, 300) };
    h.requests++;
    h.types.add(r.type);
    h.pages.add(r.page);
    unknownHosts.set(u.hostname, h);
  }
}

// WordPress plugins and themes show up in asset paths on the company's own domain.
const wordpress = { plugins: new Set(), themes: new Set() };
for (const r of requests) {
  let u;
  try { u = new URL(r.url); } catch { continue; }
  if (!isFirstParty(u.hostname)) continue;
  const plugin = u.pathname.match(/\/wp-content\/plugins\/([a-z0-9_-]+)\//i)?.[1];
  const theme = u.pathname.match(/\/wp-content\/themes\/([a-z0-9_-]+)\//i)?.[1];
  if (plugin) wordpress.plugins.add(plugin.toLowerCase());
  if (theme) wordpress.themes.add(theme.toLowerCase());
}

// ---------- merge stack ----------

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const stack = [];
for (const hit of vendorHits.values()) {
  stack.push({
    name: hit.name, category: hit.category, sources: ['network'], marketing: true,
    requests: hit.requests, hosts: [...hit.hosts], pages: [...hit.pages], phases: [...hit.phases],
    ids: [...hit.ids.values()], example: hit.example, aliases: hit.aliases, version: null
  });
}
const otherTech = [];
for (const res of Array.isArray(wappalyzer) ? wappalyzer : []) {
  for (const t of res.technologies || []) {
    const cats = (t.categories || []).map((c) => c.name);
    const existing = stack.find((s) => norm(s.name) === norm(t.name) || s.aliases.some((a) => norm(a) === norm(t.name)));
    if (existing) {
      if (!existing.sources.includes('wappalyzer')) existing.sources.push('wappalyzer');
      existing.wappalyzerName = t.name;
      if (t.version) existing.version = t.version;
      if (!existing.wpPages) existing.wpPages = [];
      existing.wpPages.push(res.url);
      continue;
    }
    const marketing = cats.some((c) => MARKETING_CATEGORIES.has(c));
    const list = marketing ? stack : otherTech;
    const dup = list.find((s) => s.name === t.name);
    if (dup) { dup.wpPages.push(res.url); continue; }
    list.push({
      name: t.name, category: cats[0] || 'Miscellaneous', categories: cats, sources: ['wappalyzer'], marketing,
      version: t.version || null, website: t.website || null, wpPages: [res.url], ids: [], pages: [], aliases: []
    });
  }
}
stack.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
otherTech.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
for (const s of [...stack, ...otherTech]) delete s.aliases;

const uniqueEvents = [];
const evSeen = new Set();
for (const e of events) {
  const k = `${e.platform}|${e.name}|${e.page}`;
  if (!evSeen.has(k)) { evSeen.add(k); uniqueEvents.push(e); }
}

// ---------- write outputs ----------


const pageRecords = [];
for (const p of pages) {
  const slug = slugify(p.url || p.requestedUrl);
  if (p.text) {
    const md = [`# ${p.title || p.url}`, '', `URL: ${p.url}`, `Kind: ${p.kind}`, '', p.text].join('\n');
    await writeFile(path.join(outDir, 'pages', `${slug}.md`), md);
  }
  pageRecords.push({
    kind: p.kind, url: p.url || p.requestedUrl, status: p.status, error: p.error || null, file: p.text ? `pages/${slug}.md` : null,
    title: p.title, description: p.description, ogTitle: p.ogTitle, ogDescription: p.ogDescription, lang: p.lang,
    h1: p.h1, h2: p.h2, ctas: p.ctas, forms: p.forms, iframes: p.iframes, jsonLd: p.jsonLd
  });
}

const seoRaw = await seoJob;
const seo = seoRaw.skipped ? seoRaw : enrichSeo(seoRaw, { domain: siteHost, sectionOf, sitemapSections: sitemap.allSections || [] });
if (!seo.skipped) await collectSerpCompetitors({ client: seoClient, seo, domain: siteHost }).catch((e) => seo.errors.push(`serp_competitors: ${e.message}`));
if (seo.errors?.length) log(`DataForSEO problems: ${seo.errors.join('; ')}`);
if (seo.cost != null && !seo.skipped) log(`DataForSEO cost for this run: $${seo.cost}`);

// Where the capture ran from matters: tags and consent rules vary by country.
const regionalGoogle = [...new Set(requests.map((r) => { try { return new URL(r.url).hostname; } catch { return ''; } }).filter((h) => /^(www\.)?google\.(com?\.)?[a-z]{2}$/.test(h) && !/google\.com$/.test(h)))];
const captureRegion = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, regionalGoogleDomains: regionalGoogle };

const collected = {
  tool: 'behindsight',
  version: '0.1.0',
  target: startUrl.href,
  domain: siteHost,
  capturedAt: new Date().toISOString(),
  userAgent,
  consent: home.consent || { banner: false, clicked: null, attempted: opts.consent },
  pages: pageRecords,
  stack,
  otherTechnologies: otherTech,
  firstPartyTagging: [...fpTagging.values()],
  events: uniqueEvents,
  unknownHosts: [...unknownHosts.values()].map((h) => ({ ...h, types: [...h.types], pages: [...h.pages] })).sort((a, b) => b.requests - a.requests),
  socials,
  sitemap,
  seo,
  ads,
  content,
  captureRegion,
  wordpress: { plugins: [...wordpress.plugins].sort(), themes: [...wordpress.themes].sort() },
  wappalyzer: Array.isArray(wappalyzer) ? wappalyzer.map((w) => ({ url: w.url, error: w.error || null, count: (w.technologies || []).length })) : wappalyzer,
  requestCount: requests.length
};

await writeFile(path.join(outDir, 'collected.json'), JSON.stringify(collected, null, 2));
await writeFile(path.join(outDir, 'network.json'), JSON.stringify(requests.map(({ post, ...r }) => r), null, 1));
await writeFile(path.join(outDir, 'sitemap-urls.json'), JSON.stringify(sitemapRaw.urls));
await writeFile(path.join(outDir, 'summary.md'), buildSummary(collected));

log(`done: ${pages.length} pages, ${requests.length} requests, ${stack.length} marketing technologies`);
console.log(outDir);

// ---------- digest for the agent ----------

function buildSummary(c) {
  const L = [];
  L.push(`# Collected evidence: ${c.domain}`, '', `Capture region: browser time zone ${c.captureRegion?.timezone || '?'}${c.captureRegion?.regionalGoogleDomains?.length ? `, Google served ${c.captureRegion.regionalGoogleDomains.join(', ')}` : ''}. Ad libraries report ${c.ads?.country || 'n/a'}; search data is for ${c.seo?.location || 'n/a'}. Tags and consent can differ by region.`, '', `Captured ${c.capturedAt} · ${c.requestCount} network requests · consent banner: ${c.consent.banner ? `yes, clicked ${c.consent.clicked}` : 'none shown in this region (consent tools may still load and grant consent by default)'}`, '');
  L.push('## Pages captured', '');
  for (const p of c.pages) {
    L.push(`### ${p.kind}: ${p.url}${p.error ? ` (FAILED: ${p.error})` : ''}`);
    if (p.title) L.push(`- Title: ${p.title}`);
    if (p.description) L.push(`- Meta description: ${p.description}`);
    if (p.h1?.length) L.push(`- H1: ${p.h1.join(' | ')}`);
    if (p.h2?.length) L.push(`- H2s: ${p.h2.slice(0, 12).join(' | ')}`);
    const above = (p.ctas || []).filter((x) => x.aboveFold).map((x) => `"${x.text}"${x.href ? ` → ${x.href}` : ''}${x.inNav ? ' (nav)' : ''}`);
    if (above.length) L.push(`- CTAs above the fold: ${above.slice(0, 10).join('; ')}`);
    if (p.forms?.length) L.push(`- Forms: ${p.forms.map((f) => `${f.action || '(no action)'} [${f.fields.join(', ')}]`).slice(0, 5).join('; ')}`);
    const offers = JSON.stringify(p.jsonLd || []).match(/"@type":"(Offer|AggregateOffer|Product|SoftwareApplication|Organization)"/g);
    if (offers) L.push(`- JSON-LD types: ${[...new Set(offers)].join(', ')} (see collected.json)`);
    if (p.file) L.push(`- Full text: ${p.file}`);
    L.push('');
  }
  L.push('## Marketing stack', '', '| Technology | Category | Seen by | IDs | Pages |', '|---|---|---|---|---|');
  for (const s of c.stack) {
    L.push(`| ${s.name}${s.version ? ` ${s.version}` : ''} | ${s.category} | ${s.sources.join(' + ')} | ${s.ids.map((i) => `${i.label} ${i.value}`).join(', ')} | ${(s.pages.length ? s.pages : s.wpPages || []).length} |`);
  }
  L.push('', 'Wappalyzer-only detections are pattern matches on page code; treat them as weaker than network hits.', '');
  if (c.firstPartyTagging.length) {
    L.push('## First-party / server-side tagging', '');
    for (const t of c.firstPartyTagging) L.push(`- ${t.name} on ${t.host} (e.g. ${t.example})`);
    L.push('');
  }
  if (c.events.length) {
    L.push('## Tracking events seen', '');
    for (const e of c.events) L.push(`- ${e.platform}: \`${e.name}\` on ${e.page} (${e.phase})`);
    L.push('');
  }
  L.push('## Unrecognized third-party hosts (identify these if you can; mark as inferred)', '');
  for (const h of c.unknownHosts.slice(0, 40)) L.push(`- ${h.host}: ${h.requests} requests (${h.types.join(', ')}), e.g. ${h.example.slice(0, 160)}`);
  L.push('', '## Other technologies (infrastructure, from Wappalyzer)', '', c.otherTechnologies.map((t) => `${t.name} (${t.category})`).join(', ') || 'none', '');
  if (c.wordpress.plugins.length || c.wordpress.themes.length) {
    L.push('## WordPress plugins and themes (from asset paths)', '', `- Plugins: ${c.wordpress.plugins.join(', ') || 'none seen'}`, `- Themes: ${c.wordpress.themes.join(', ') || 'none seen'}`, '');
  }
  L.push('## Social profiles linked from the homepage', '', c.socials.join('\n') || 'none found', '');
  const s = c.sitemap;
  if (!s.totalUrls) L.push('## Sitemap', '', `No sitemap URLs collected. Fetch results: ${Object.entries(s.fetchStatuses || {}).map(([u, st]) => `${u} → ${st}`).join('; ')}`, '');
  else L.push('## Sitemap', '', `${s.totalUrls} URLs from ${s.sitemapsRead} sitemap files${s.truncated ? ' (truncated)' : ''}. lastmod present on ${s.lastmodCoverage}% of URLs${s.lastmodSuspect ? ` WARNING: ${s.lastmodTopDayShare}% of dated URLs share one date, so the CMS likely rewrites lastmod on every build.` : ''}.`, '');
  L.push(`- Top sections: ${s.sections.map((x) => `${x.name} (${x.count})`).join(', ')}`);
  if (s.locales.length) L.push(`- Locales: ${s.locales.map((x) => `${x.code} (${x.count})`).join(', ')}`);
  L.push(`- Page patterns: ${Object.entries(s.patterns).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  if (s.lastmodByMonth.length) L.push(`- URLs modified per month (last 12): ${s.lastmodByMonth.map((x) => `${x.month}: ${x.count}`).join(', ')}`);
  if (s.recent.length) L.push(`- Most recently modified: ${s.recent.slice(0, 10).map((x) => `${new URL(x.url).pathname} (${x.lastmod.slice(0, 10)})`).join(', ')}`);
  L.push('');
  L.push(...contentSummary(c.content));
  L.push(...adsSummary(c.ads));
  if (c.seo.skipped) {
    L.push('## Search data', '', `Not collected (${c.seo.skipped}).`, '');
  } else {
    const o = c.seo.overview;
    L.push(`## Search data (DataForSEO estimates, ${c.seo.location}, ${c.seo.languageCode})`, '');
    if (c.seo.errors.length) L.push(`Problems: ${c.seo.errors.join('; ')}`, '');
    if (o?.organic) L.push(`- Organic: ~${o.organic.etv} est. monthly visits from ${o.organic.keywords} ranking keywords; ${o.organic.pos1} at #1, ${o.organic.pos2to3} at #2-3, ${o.organic.pos4to10} at #4-10; traffic value ~$${o.organic.trafficValue}/mo; ${o.organic.isNew} new and ${o.organic.isLost} lost keywords recently`);
    if (c.seo.brandedShareOfTopKeywords != null) L.push(`- Branded keywords drive ${c.seo.brandedShareOfTopKeywords}% of traffic among the top ${c.seo.keywords.length} keywords (${c.seo.brandedShareExcludingBareName ?? '?'}% when the bare brand name, which can be a common word, is left out). Branded = the brand name as a whole word, or a near spelling.`);
    if (c.seo.sitemapIncomplete) L.push('- The sitemap looks incomplete (most top pages fall outside its sections), so pages are grouped by folder only.');
    if (c.seo.sections.length) L.push(`- Traffic by site section (top ${c.seo.pages.length} pages, ${c.seo.sectionsCoverage ?? '?'}% of total est. traffic): ${c.seo.sections.slice(0, 10).map((x) => `${x.name} ${x.share}%`).join(', ')}`);
    L.push('', '### Top organic keywords', '', '| Keyword | Pos | Volume | Est. visits | Page |', '|---|---|---|---|---|');
    for (const k of c.seo.keywords.slice(0, 30)) L.push(`| ${k.keyword}${k.branded ? ' (brand)' : ''} | ${k.position} | ${k.volume ?? ''} | ${k.etv} | ${k.url ? (() => { const u = new URL(k.url); return (u.hostname.replace(/^www\./, '') === c.domain ? '' : u.hostname) + u.pathname; })() : ''} |`);
    L.push('', '### Top pages by est. organic traffic', '');
    for (const p of c.seo.pages.slice(0, 20)) L.push(`- ${p.url}: ~${p.etv} visits, ${p.keywords} keywords`);
    if (c.seo.competitors.length) {
      L.push('', `### Search competitors (domains ranking for their top ${c.seo.competitorKeywords.length} non-branded keywords)`, '');
      L.push(c.seo.competitors.map((x) => `${x.domain} (ranks for ${x.keywords} of them, avg pos ${x.avgPosition}, ~${x.etv} est. visits to that domain from these keywords)`).join(', '));
    }
    L.push('');
  }
  return L.join('\n');
}

function adsSummary(a) {
  if (!a || a.skipped) return ['## Ad libraries', '', `Not collected (${a?.skipped || 'unknown'}).`, ''];
  const L = [`## Ad libraries (${a.country}; brand names searched: ${a.brands.join(', ')})`, ''];
  const g = a.google;
  if (g.status === 'found') {
    L.push(`### Google Ads Transparency Center: ${g.advertisers.map((x) => `${x.name} (${x.id}, ${x.adsTotal || x.adsRange || '?'} ads)`).join('; ')}`);
    L.push(`- ${g.creativesFetched} creatives read. Formats: ${Object.entries(g.formats).map(([k, v]) => `${k} ${v}`).join(', ')}. Shown in the last 30 days: ${g.shownInLast30Days}. First shown ${g.firstShown}, last shown ${g.lastShown}.`);
    if (g.newByMonth.length) L.push(`- New creatives by month (first shown): ${g.newByMonth.map((m) => `${m.month}: ${m.count}`).join(', ')}`);
    L.push(`- Samples to look at: ${g.samples.map((x) => `${x.file} (${x.format})`).join(', ')}`);
  } else L.push(`### Google: ${g.status}${g.error ? ` (${g.error})` : ''}. ${g.note || ''}${g.domainAdsTotal ? ` Ads from any advertiser pointing to the domain: ${g.domainAdsTotal}.` : ''}`);
  const m = a.meta;
  if (m.status === 'found') {
    L.push('', `### Meta Ad Library: ${m.page.name} (page ${m.page.id}${m.page.verified ? ', verified' : ''})`);
    L.push(`- Page verified: ${m.page.verified ? 'yes' : 'no'}. Active ads in ${a.country}: ${m.activeAds}; worldwide: ${m.activeAdsAllCountries}. Read ${m.adsRead} (${m.adsReadFrom}; the library doesn't show each ad's country); ${m.startedInLast30Days} started in the last 30 days; oldest still running since ${m.oldestActiveStart}; ${m.videoShare}% video. Screenshot: ${m.screenshot}`);
    for (const ad of m.ads.slice(0, 12)) L.push(`- [${ad.started}${ad.video ? ', video' : ''}] ${ad.text}${ad.headline ? ` | Headline: ${ad.headline}` : ''}${ad.cta ? ` | CTA: ${ad.cta}` : ''}`);
  } else L.push('', `### Meta: ${m.status}${m.error ? ` (${m.error})` : ''}. ${m.note || ''}`);
  const l = a.linkedin;
  if (l.status === 'found') {
    L.push('', `### LinkedIn Ad Library: ${l.advertiser}`, `- Ads matching the advertiser search (${l.scope}): ${l.adsMatchingSearch}. Read ${l.adsRead}. Screenshot: ${l.screenshot}`);
    for (const ad of l.ads.slice(0, 12)) L.push(`- ${ad.text}${ad.headline ? ` | Headline: ${ad.headline}` : ''}`);
  } else L.push('', `### LinkedIn: ${l.status}${l.error ? ` (${l.error})` : ''}. ${l.note || ''}`);
  L.push('');
  return L;
}

function contentSummary(ct) {
  if (!ct || ct.skipped) return ['## Content sample', '', `Not collected (${ct?.skipped || 'unknown'}).`, ''];
  if (!ct.posts.length) return ['## Content sample', '', `No blog or article content found${ct.error ? ` (${ct.error})` : ''}.`, ''];
  const ok = ct.posts.filter((p) => !p.error);
  const L = ['## Content sample', '', `${ok.length} posts read (source: ${ct.source === 'feed' ? `feed ${ct.feed}` : 'sitemap, so dates are last-modified, not published'}). Full text in content/.`];
  if (ct.feedSummary) L.push(`- The feed lists ${ct.feedSummary.items} posts (${ct.feedSummary.oldest} to ${ct.feedSummary.newest})${ct.feedSummary.categories.length ? `; categories: ${ct.feedSummary.categories.map((c) => `${c.name} (${c.count})`).join(', ')}` : ''}`);
  if (ct.cadence?.length) L.push(`- Posts per month by publish date (sample only): ${ct.cadence.map((m) => `${m.month}: ${m.count}`).join(', ')}`);
  const authors = {};
  for (const p of ok) if (p.author) authors[p.author] = (authors[p.author] || 0) + 1;
  if (Object.keys(authors).length) L.push(`- Authors: ${Object.entries(authors).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} (${n})`).join(', ')}`);
  L.push('', '| Published | Title | Words | Search visits | CTAs | Lead form | Product links | File |', '|---|---|---|---|---|---|---|---|');
  for (const p of ct.posts) {
    if (p.error) { L.push(`| | ${p.url} (FAILED: ${p.error}) | | | | | | |`); continue; }
    L.push(`| ${p.published || '?'} | ${(p.title || '').replace(/\|/g, '/').slice(0, 80)} | ${p.words} | ${p.etv ? `~${p.etv}` : ''} | ${(p.ctas || []).slice(0, 3).join('; ')} | ${p.leadForms?.length ? 'yes' : ''} | ${(p.productLinks || []).slice(0, 3).join(' ')} | ${p.file || ''} |`);
  }
  L.push('');
  return L;
}

