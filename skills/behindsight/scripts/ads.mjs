// Public ad libraries: Google Ads Transparency Center, Meta Ad Library and LinkedIn Ad Library.
// Finds the company's own advertiser accounts (not every advertiser linking to the domain),
// then records ad counts, formats, dates, ad copy and a few screenshots.
// An account counts as the company's only when its name matches the brand AND it links to the
// company's domain (or the company's site links to it). Accounts that link to the domain under
// another name are listed separately: they can be resellers, affiliates or agencies.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { registrableDomain } from './lib.mjs';

const GOOGLE_REGIONS = { US: 2840, GB: 2826, CA: 2124, AU: 2036, DE: 2276, FR: 2250, ES: 2724, IT: 2380, NL: 2528, IN: 2356, BR: 2076, JP: 2392 };
const GOOGLE_FORMATS = { 1: 'text', 2: 'image', 3: 'video' };
const DAY = 86400000;

const squash = (s) => String(s || '').toLowerCase().replace(/\.(com|io|co|ai|app|net|org)\b/g, '').replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|limited|gmbh|corp|corporation|co)$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEGAL = /^(inc|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|sa|ag|bv|pty|sas|srl|oy|ab|nv|kk)$/;
const words = (s) => String(s || '').toLowerCase().replace(/\.(com|io|co|ai|app|net|org)\b/g, '').replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((w) => w && !LEGAL.test(w));

// How an advertiser name relates to the brand: 'exact' ("Linear" or "Linear, Inc."), 'word' (starts
// with the brand as whole words: "Linear Orbit, Inc.") or 'none' ("LinearB", "Linearity").
export function nameMatch(name, brands) {
  const n = words(name);
  let best = 'none';
  for (const b of brands) {
    const w = words(b);
    if (!w.length) continue;
    if (n.join('') === w.join('')) return 'exact';
    if (w.length < n.length && w.every((t, i) => n[i] === t)) best = 'word';
  }
  return best;
}
const onSite = (url, domain) => { try { return registrableDomain(new URL(url).hostname) === registrableDomain(domain); } catch { return false; } };
const isoDay = (s) => (s ? new Date(`${s} UTC`).toISOString().slice(0, 10) : null);

// Brand names to search for: the brand in the homepage title, then the domain name.
export function brandCandidates({ domain, homeTitle }) {
  const fromTitle = (homeTitle || '').split(/\s[|–—-]\s/).map((s) => s.trim()).filter((s) => s && s.length <= 30);
  const label = domain.split('.')[0];
  const names = [...fromTitle.filter((s) => squash(s).includes(squash(label)) || squash(label).includes(squash(s))), label, domain];
  const seen = new Set();
  return names.filter((n) => { const k = squash(n); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

export async function collectAds({ browser, userAgent, domain, homeTitle, socials = [], country = 'US', outDir, log = () => {}, brands: brandOverride, platforms = ['google', 'meta', 'linkedin'], filePrefix = '' }) {
  const brands = brandOverride?.length ? brandOverride : brandCandidates({ domain, homeTitle });
  await mkdir(path.join(outDir, 'ads'), { recursive: true });
  const context = await browser.newContext({ userAgent, locale: 'en-US', viewport: { width: 1400, height: 1000 } });
  const run = async (name, fn) => {
    try { return await fn(); } catch (e) { log(`${name} ad library failed: ${e.message.split('\n')[0]}`); return { status: 'error', error: e.message.split('\n')[0] }; }
  };
  const skipped = { status: 'not checked' };
  const google = platforms.includes('google') ? await run('Google', () => googleAds({ context, domain, brands, country, outDir, log, filePrefix })) : skipped;
  const meta = platforms.includes('meta') ? await run('Meta', () => metaAds({ context, domain, brands, socials, country, outDir, log, filePrefix })) : skipped;
    // Legal names Google confirmed ("Linear Orbit, Inc.") make LinkedIn's payer search exact.
  const legalNames = (google.advertisers || []).map((a) => a.name).filter((n) => nameMatch(n, brands) !== 'exact');
  const linkedin = platforms.includes('linkedin') ? await run('LinkedIn', () => linkedinAds({ context, domain, brands, legalNames, socials, country, outDir, log, filePrefix })) : skipped;
  await context.close();
  return { country, brands, capturedAt: new Date().toISOString(), google, meta, linkedin };
}

// ---------- Google Ads Transparency Center ----------

// Requests go through a browser page on Google's own site when one is open, which is
// rate-limited far less than a bare HTTP client. They're spaced out and retried with backoff.
let googlePage = null;
async function googleRpc(service, req) {
  if (googlePage) {
    for (const wait of [0, 8000, 20000]) {
      if (wait) await sleep(wait);
      await sleep(400);
      const res = await googlePage.evaluate(async ({ service, body }) => {
        const r = await fetch(`/anji/_/rpc/${service}?authuser=`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        return { status: r.status, text: await r.text() };
      }, { service, body: 'f.req=' + encodeURIComponent(JSON.stringify(req)) });
      if (res.status === 429 || res.status >= 500) continue;
      if (res.status !== 200) throw new Error(`${service} HTTP ${res.status}`);
      return JSON.parse(res.text);
    }
    throw new Error(`${service} rate-limited (HTTP 429) after retries`);
  }
  for (const wait of [0, 8000, 20000, 45000]) {
    if (wait) await sleep(wait);
    await sleep(600);
    const r = await fetch(`https://adstransparency.google.com/anji/_/rpc/${service}?authuser=`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' },
      body: 'f.req=' + encodeURIComponent(JSON.stringify(req)),
      signal: AbortSignal.timeout(30000)
    });
    if (r.status === 429 || r.status >= 500) continue;
    if (!r.ok) throw new Error(`${service} HTTP ${r.status}`);
    return JSON.parse(await r.text());
  }
  throw new Error(`${service} rate-limited (HTTP 429) after retries`);
}

async function googleAds({ context, domain, brands, country, outDir, log, filePrefix = '' }) {
  const region = GOOGLE_REGIONS[country] || 2840;
  const filters = (extra) => ({ 8: [region], ...extra });
  log('reading Google Ads Transparency Center');
  googlePage = await context.newPage();
  await googlePage.goto(`https://adstransparency.google.com/?region=${country}&hl=en`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);
  try { return await googleAdsInner({ context, domain, brands, country, outDir, region, filters, filePrefix }); }
  finally { await googlePage.close().catch(() => {}); googlePage = null; }
}

async function googleAdsInner({ context, domain, brands, country, outDir, region, filters, filePrefix }) {

  // The domain search lists ads from every advertiser whose ads link to the domain: the company,
  // but also resellers, affiliates and agencies. Only accounts whose name matches the brand count.
  const domainResults = await googleRpc('SearchService/SearchCreatives', { 2: 100, 3: filters({ 12: { 1: domain, 2: true } }), 7: { 1: 1, 2: 0, 3: region } });
  const onDomain = new Map();
  for (const c of domainResults['1'] || []) {
    const a = onDomain.get(c['1']) || { id: c['1'], name: c['12'], adsInSample: 0 };
    a.adsInSample++;
    onDomain.set(c['1'], a);
  }
  const domainTotal = [domainResults['4'], domainResults['5']].filter(Boolean).join('–') || null;
  const candidates = [...onDomain.values()].filter((a) => nameMatch(a.name, brands) !== 'none');

  // Accounts named exactly like the brand, in case the company's ads were crowded out of the domain sample.
  for (const q of brands) {
    if (candidates.length >= 6) break;
    const s = await googleRpc('SearchService/SearchSuggestions', { 1: q, 2: 10, 3: 10, 4: [region], 5: { 1: 1 } });
    for (const item of s['1'] || []) {
      const a = item['1'];
      if (a && nameMatch(a['1'], brands) === 'exact' && !candidates.some((c) => c.id === a['2'])) candidates.push({ id: a['2'], name: a['1'], country: a['3'], adsRange: [a['4']?.['2']?.['1'], a['4']?.['2']?.['2']].filter(Boolean).join('–') });
    }
  }

  // Keep only accounts with at least one ad pointing to the company's domain.
  const verified = [];
  for (const cand of candidates.slice(0, 6)) {
    const r = await googleRpc('SearchService/SearchCreatives', { 2: 40, 3: filters({ 12: { 1: domain, 2: true }, 13: { 1: [cand.id] } }), 7: { 1: 1, 2: 0, 3: region } });
    if ((r['1'] || []).length) verified.push({ ...cand, match: `name ${nameMatch(cand.name, brands) === 'exact' ? 'matches' : 'starts with'} the brand; ads link to ${domain}`, adsToDomain: [r['4'], r['5']].filter(Boolean).join('–') || String(r['1'].length) });
  }
  // Other accounts linking to the domain, biggest first. On platforms that host customer pages
  // (booking links, storefronts) these are mostly customers.
  const otherAdvertisers = [...onDomain.values()].filter((a) => !verified.some((v) => v.id === a.id)).sort((x, y) => y.adsInSample - x.adsInSample);
  const otherCount = otherAdvertisers.length;
  otherAdvertisers.splice(10);
  if (!verified.length) {
    const sampled = (domainResults['1'] || []).length;
    if (otherAdvertisers[0] && otherAdvertisers[0].adsInSample >= sampled / 2) {
      return { status: 'uncertain', searched: brands, domainAdsTotal: domainTotal, otherAdvertisers, note: `Ads link to ${domain}, but only from advertiser accounts whose names don't match the brand: ${otherAdvertisers.map((a) => a.name).join(', ')}. One may be the company under its legal name; others can be resellers, affiliates or agencies. Check a name with investigate.mjs ads --platform google --name "<advertiser>".` };
    }
    return { status: 'not found', searched: brands, domainAdsTotal: domainTotal, otherAdvertisers, otherAdvertiserCount: otherCount, note: `No advertiser account matching the brand has ads pointing to the domain in this region.${otherCount ? ` ${otherCount} other advertisers' ads link to it (customers, resellers or affiliates); none is named like the brand or dominates.` : ''}` };
  }

  // Creatives from the verified accounts.
  const creatives = [];
  for (const adv of verified) {
    let token = null;
    for (let page = 0; page < 3; page++) {
      const req = { 2: 100, 3: filters({ 13: { 1: [adv.id] } }), 7: { 1: 1, 2: 0, 3: region } };
      if (token) req[4] = token;
      const r = await googleRpc('SearchService/SearchCreatives', req);
      if (page === 0) adv.adsTotal = [r['4'], r['5']].filter(Boolean).join('–') || null;
      for (const c of r['1'] || []) {
        creatives.push({
          advertiser: adv.name, advertiserId: c['1'], creativeId: c['2'], format: GOOGLE_FORMATS[c['4']] || `format ${c['4']}`,
          firstShown: c['6']?.['1'] ? new Date(Number(c['6']['1']) * 1000).toISOString().slice(0, 10) : null,
          lastShown: c['7']?.['1'] ? new Date(Number(c['7']['1']) * 1000).toISOString().slice(0, 10) : null,
          image: (c['3']?.['3']?.['2'] || '').match(/src="([^"]+)"/)?.[1] || null,
          preview: c['3']?.['1']?.['4'] || null,
          url: `https://adstransparency.google.com/advertiser/${c['1']}/creative/${c['2']}?region=${country}&hl=en`
        });
      }
      token = r['2'];
      if (!token) break;
    }
  }
  const now = Date.now();
  const formats = {};
  const byMonth = {};
  for (const c of creatives) {
    formats[c.format] = (formats[c.format] || 0) + 1;
    if (c.firstShown && now - new Date(c.firstShown) < 365 * DAY) byMonth[c.firstShown.slice(0, 7)] = (byMonth[c.firstShown.slice(0, 7)] || 0) + 1;
  }
  const recent = [...creatives].sort((a, b) => (b.lastShown || '').localeCompare(a.lastShown || ''));
  const samples = await googleSamples({ context, creatives: recent, outDir, filePrefix });
  return {
    status: 'found',
    region: country,
    advertisers: verified,
    creativesFetched: creatives.length,
    formats,
    shownInLast30Days: creatives.filter((c) => c.lastShown && now - new Date(c.lastShown) <= 30 * DAY).length,
    firstShown: creatives.map((c) => c.firstShown).filter(Boolean).sort()[0] || null,
    lastShown: recent[0]?.lastShown || null,
    newByMonth: Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11 + i); const k = d.toISOString().slice(0, 7); return { month: k, count: byMonth[k] || 0 }; }),
    domainAdsTotal: domainTotal,
    otherAdvertisers,
    otherAdvertiserCount: otherCount,
    samples,
    samplesFailed: samples.failed,
    creatives: recent.slice(0, 60).map(({ preview, ...c }) => c)
  };
}

// Up to 6 recent creatives: archived images as-is, videos as their YouTube thumbnail, the rest as a screenshot of the creative page.
async function googleSamples({ context, creatives, outDir, filePrefix = '' }) {
  const picked = [];
  const byFormat = {};
  for (const c of creatives) {
    if (picked.length >= 10) break;
    if ((byFormat[c.format] || 0) >= 4) continue;
    byFormat[c.format] = (byFormat[c.format] || 0) + 1;
    picked.push(c);
  }
  const samples = [];
  const failed = [];
  const usedImages = new Set();
  for (const [i, c] of picked.entries()) {
    const file = `ads/${filePrefix}google-${i + 1}.jpg`;
    try {
      let imageUrl = c.image;
      if (!imageUrl && c.preview && c.format === 'video') {
        const js = await (await fetch(c.preview, { signal: AbortSignal.timeout(20000) })).text();
        const yt = js.match(/ytimg\.com\/vi\/([A-Za-z0-9_-]{11})/);
        if (yt) imageUrl = `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`;
      }
      if (imageUrl && usedImages.has(imageUrl)) continue;
      if (imageUrl) {
        usedImages.add(imageUrl);
        const r = await fetch(imageUrl, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        await writeFile(path.join(outDir, file), Buffer.from(await r.arrayBuffer()));
      } else {
        const page = await context.newPage();
        const resp = await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!resp || resp.status() >= 400) { await page.close(); throw new Error(`creative page HTTP ${resp?.status()}`); }
        await sleep(6000);
        const el = page.locator('creative-preview, .creative-preview, html-renderer, iframe').first();
        if (await el.isVisible().catch(() => false)) await el.screenshot({ path: path.join(outDir, file), type: 'jpeg', quality: 75 });
        else await page.screenshot({ path: path.join(outDir, file), type: 'jpeg', quality: 70, clip: { x: 0, y: 150, width: 1400, height: 700 } });
        await page.close();
      }
      const bytes = await readFile(path.join(outDir, file));
      const hash = createHash('sha1').update(bytes).digest('hex');
      if (usedImages.has(hash)) continue;
      usedImages.add(hash);
      samples.push({ file, format: c.format, lastShown: c.lastShown, url: c.url });
      if (samples.length >= 6) break;
    } catch (e) {
      failed.push({ creative: c.creativeId, format: c.format, error: e.message.split('\n')[0] });
    }
  }
  samples.failed = failed;
  return samples;
}

// ---------- Meta Ad Library ----------

async function metaAds({ context, domain, brands, socials, country, outDir, log, filePrefix = '' }) {
  log('reading Meta Ad Library');
  const page = await context.newPage();
  const suggestions = [];
  page.on('response', async (r) => {
    if (!/api\/graphql/.test(r.url())) return;
    if (!/AdLibraryTypeaheadSuggestion/.test(r.request().postData() || '')) return;
    try { suggestions.push(...(JSON.parse(await r.text())?.data?.ad_library_main?.typeahead_suggestions?.page_results || [])); } catch {}
  });
  await page.goto(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${encodeURIComponent(brands[0])}&search_type=keyword_unordered&media_type=all`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  const box = page.locator('input[type=search]').first();
  for (const q of brands.slice(0, 2)) {
    await box.click({ timeout: 10000 });
    await box.fill('');
    await box.type(q, { delay: 90 });
    await sleep(3500);
  }

  // Candidate pages, strongest first: linked from the company's site, then verified with the brand's
  // exact name, then unverified with the exact name. A page with only the name (anyone can name a page
  // "Linear") counts only when its ads link to the company's domain.
  const fbSlugs = socials.map((s) => s.match(/facebook\.com\/(?:pg\/)?([^/?#]+)/i)?.[1]).filter(Boolean).map((s) => s.toLowerCase());
  const unique = [...new Map(suggestions.map((s) => [s.page_id, s])).values()];
  const exact = unique.filter((s) => nameMatch(s.name, brands) === 'exact');
  const seen = new Set();
  const candidates = [
    ...unique.filter((s) => s.page_alias && fbSlugs.includes(s.page_alias.toLowerCase())).map((s) => ({ s, basis: 'linked from the company site' })),
    ...exact.filter((s) => s.verification === 'BLUE_VERIFIED').map((s) => ({ s, basis: 'verified page with the brand name' })),
    ...exact.filter((s) => s.verification !== 'BLUE_VERIFIED').map((s) => ({ s, basis: 'page with the brand name (not verified, not linked from the site)', weak: true }))
  ].filter(({ s }) => !seen.has(s.page_id) && seen.add(s.page_id)).slice(0, 3);
  if (!candidates.length) {
    await page.close();
    return { status: 'not found', searched: brands, note: 'No Facebook page matching the brand appeared in the Ad Library search.' };
  }

  const rejected = [];
  for (const { s: pageMatch, basis, weak } of candidates) {
    const r = await metaPage({ page, pageMatch, domain, country, outDir, filePrefix });
    if (!weak || r.adsLinkingToDomain > 0) {
      await page.close();
      return { ...r, match: weak ? `${basis}; its ads link to ${domain}` : basis };
    }
    await unlink(path.join(outDir, r.screenshot)).catch(() => {});
    rejected.push({ name: pageMatch.name, alias: pageMatch.page_alias, id: pageMatch.page_id, category: pageMatch.category || null, activeAds: r.activeAdsAllCountries, url: r.url });
  }
  await page.close();
  return { status: 'uncertain', searched: brands, candidates: rejected, note: `Facebook pages named like the brand exist (${rejected.map((c) => `${c.name}${c.alias ? ` /${c.alias}` : ''}`).join(', ')}), but none is verified, linked from the company's site, or running ads that link to ${domain}. They may belong to someone else. The company may have no Meta presence, or a page under another name.` };
}

async function metaPage({ page, pageMatch, domain, country, outDir, filePrefix }) {
  const pageUrl = (ctry) => `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${ctry}&is_targeted_country=false&media_type=all&search_type=page&view_all_page_id=${pageMatch.page_id}`;
  // Count for the chosen country, then read the ads from all countries so smaller markets still show the messaging.
  await page.goto(pageUrl(country), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);
  const countryText = await page.evaluate(() => document.body.innerText);
  const countryActive = /No ads match your search criteria/i.test(countryText) ? '0' : countryText.match(/(~?[\d,]+)\s+results?/)?.[1] || null;
  await page.goto(pageUrl('ALL'), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(7000);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await sleep(1500); }
  await page.mouse.wheel(0, -20000);
  await sleep(1000);
  const text = await page.evaluate(() => document.body.innerText);
  const firstCard = await page.getByText(/^Library ID:/).first().boundingBox().catch(() => null);
  const top = firstCard ? Math.max(0, firstCard.y - 70) : 250;
  const screenshot = `ads/${filePrefix}meta.jpg`;
  await page.screenshot({ path: path.join(outDir, screenshot), type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: top, width: 1400, height: 1100 } }).catch(() => {});
  const pageInfo = { id: pageMatch.page_id, name: pageMatch.name, alias: pageMatch.page_alias, verified: pageMatch.verification === 'BLUE_VERIFIED', likes: pageMatch.likes, igFollowers: pageMatch.ig_followers };

  if (/No ads match your search criteria/i.test(text)) {
    return { status: 'no active ads', page: pageInfo, activeAds: '0', activeAdsAllCountries: '0', adsRead: 0, adsLinkingToDomain: 0, ads: [], note: `The page ${pageMatch.name} has no active ads in any country.`, url: pageUrl('ALL'), screenshot };
  }
  const total = text.match(/(~?[\d,]+)\s+results?/)?.[1] || null;
  const site = registrableDomain(domain);
  const ads = text.split('Library ID:').slice(1).map((chunk) => {
    const lines = chunk.split(/\n(?:System status|Ad Library API|About ads and data use)/)[0].split('\n').map((l) => l.replace(/\u200b/g, '').trim()).filter(Boolean);
    const started = chunk.match(/Started running on ([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1] || null;
    const sponsored = lines.indexOf('Sponsored');
    const body = sponsored >= 0 ? lines.slice(sponsored + 1).filter((l) => !/^\d+:\d+ \/ \d+:\d+$/.test(l) && l !== 'Active') : [];
    return {
      id: lines[0],
      started: isoDay(started),
      video: /\d+:\d+ \/ \d+:\d+/.test(chunk),
      multipleVersions: /multiple versions/.test(chunk),
      // The card shows the destination as an upper-case display link, e.g. "LINEAR.APP".
      linksToDomain: lines.some((l) => l.toLowerCase() === site || l.toLowerCase().endsWith(`.${site}`)),
      text: body.slice(0, -2).join(' ').slice(0, 400) || body.join(' ').slice(0, 400),
      cta: body.at(-1) && body.at(-1).length <= 25 ? body.at(-1) : null,
      headline: body.at(-1) && body.at(-1).length <= 25 ? body.at(-2) || null : null
    };
  }).filter((a) => /^\d+$/.test(a.id));
  const now = Date.now();
  return {
    status: 'found',
    page: pageInfo,
    activeAds: countryActive,
    activeAdsAllCountries: total,
    adsReadFrom: 'all countries',
    adsRead: ads.length,
    adsLinkingToDomain: ads.filter((a) => a.linksToDomain).length,
    startedInLast30Days: ads.filter((a) => a.started && now - new Date(a.started) <= 30 * DAY).length,
    oldestActiveStart: ads.map((a) => a.started).filter(Boolean).sort()[0] || null,
    videoShare: ads.length ? Math.round((ads.filter((a) => a.video).length / ads.length) * 100) : null,
    ads,
    screenshot,
    url: pageUrl(country)
  };
}

// ---------- LinkedIn Ad Library ----------

// Each card on a search page reads: advertiser, "Promoted", body, headline, "View details".
// Cards without "Promoted" are sponsored messages, and recruiting ones aren't marketing.
async function linkedinCards(page, scrolls = 3) {
  await sleep(5000);
  for (let i = 0; i < scrolls; i++) { await page.mouse.wheel(0, 3000); await sleep(1200); }
  const text = await page.evaluate(() => document.body.innerText);
  const hrefs = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/ad-library/detail/"]')].map((a) => a.href.split('?')[0]))]);
  const cards = [];
  text.split('View details').slice(0, -1).forEach((chunk, i) => {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    const at = lines.lastIndexOf('Promoted');
    if (at < 1 || /%FIRSTNAME%|explore relevant opportunities/i.test(chunk)) return;
    cards.push({ advertiser: lines[at - 1], text: (lines[at + 1] || '').slice(0, 300), headline: lines[at + 2] || null, url: hrefs[i] || null });
  });
  return { text, cards, total: text.match(/([\d,]+) ads? match/)?.[1] || null };
}

// An ad's detail page: who paid, where it links (with campaign tags), when it ran, impressions, top countries.
async function linkedinDetail(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);
  const text = await page.evaluate(() => document.body.innerText);
  if (!/Ad Details/.test(text)) return null;
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
  // The ad's own destination carries a trk tag; other links can sit in the ad's body text.
  const landing = links.find((h) => /trk=ad_library_ad_preview_(headline|cta)/.test(h) && !/(^|\.)(linkedin\.com|lnkd\.in)$/.test(new URL(h).hostname)) || null;
  const utm = {};
  if (landing) for (const [k, v] of new URL(landing).searchParams) if (/^utm_(campaign|source|medium|content)$/.test(k)) utm[k.slice(4)] = v;
  const ran = text.match(/Ran from ([A-Z][a-z]{2} \d{1,2}, \d{4}) to ([A-Z][a-z]{2} \d{1,2}, \d{4})/);
  const countryBlock = text.split(/\nCountry\n/)[1]?.split(/Show more|Ad Targeting/)[0] || '';
  return {
    url,
    paidFor: text.match(/Paid for by ([^\n]+)/)?.[1]?.trim() || null,
    companyId: links.map((h) => h.match(/linkedin\.com\/company\/(\d+)/)?.[1]).find(Boolean) || null,
    format: text.match(/\n([A-Z][a-z]+(?: [A-Z][a-z]+)* Ad)\n/)?.[1] || null,
    landingUrl: landing ? landing.split('?')[0] : null,
    utm,
    ranFrom: isoDay(ran?.[1]),
    ranTo: isoDay(ran?.[2]),
    impressions: text.match(/Total Impressions\s*\n+\s*([^\n]+)/)?.[1]?.trim() || null,
    topCountries: [...countryBlock.matchAll(/([A-Z][A-Za-z .'()-]+?)\s*\n+\s*(<?\s*\d+%)/g)].slice(0, 3).map((m) => `${m[1].trim()} ${m[2].replace(/\s/g, '')}`)
  };
}

// The numeric ID of the LinkedIn company page the company's site links to, when the public page shows it.
async function linkedinCompanyId(context, socials) {
  const slug = socials.map((s) => s.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1]).find(Boolean);
  if (!slug) return null;
  if (/^\d+$/.test(slug)) return slug;
  try {
    const r = await context.request.get(`https://www.linkedin.com/company/${slug}`, { timeout: 20000 });
    return r.ok() ? (await r.text()).match(/organization:(\d{4,})/)?.[1] || null : null;
  } catch { return null; }
}

async function linkedinAds({ context, domain, brands, legalNames = [], socials = [], country, outDir, log, filePrefix = '' }) {
  log('reading LinkedIn Ad Library');
  const siteCompanyId = await linkedinCompanyId(context, socials);
  const page = await context.newPage();

  // 1. Find accounts named like the brand: by the company page the site links to, then by legal name
  // (payer), then by name. A name search for "Linear" also returns LinearB and Linear Air, newest first.
  const searches = [
    ...(siteCompanyId ? [{ q: `companyIds=${siteCompanyId}`, linked: true }] : []),
    ...legalNames.map((n) => ({ q: `payer=${encodeURIComponent(n)}` })),
    ...brands.slice(0, 2).flatMap((b) => [{ q: `accountOwner=${encodeURIComponent(b)}&countries=${country}`, scrolls: 6 }, { q: `accountOwner=${encodeURIComponent(b)}`, scrolls: 6 }])
  ];
  const accounts = new Map();
  for (const { q, linked, scrolls } of searches) {
    await page.goto(`https://www.linkedin.com/ad-library/search?${q}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    for (const c of (await linkedinCards(page, scrolls)).cards) {
      const match = nameMatch(c.advertiser, [...brands, ...legalNames]) === 'none' ? (linked ? 'linked' : 'none') : nameMatch(c.advertiser, brands) === 'exact' ? 'exact' : 'word';
      if (match === 'none') continue;
      const acc = accounts.get(c.advertiser) || { name: c.advertiser, match, urls: [] };
      if (c.url && acc.urls.length < 3) acc.urls.push(c.url);
      accounts.set(c.advertiser, acc);
    }
    if ([...accounts.values()].some((a) => a.match === 'exact' || a.match === 'linked')) break;
  }
  if (!accounts.size) {
    await page.close();
    return { status: 'not found', searched: brands, note: 'No LinkedIn advertiser with a name matching the brand.' };
  }

  // 2. Confirm an account from its ads' detail pages: an ad links to the company's domain, or the
  // account is the LinkedIn company page the company's own site links to.
  const rejected = [];
  let chosen = null;
  const rank = { linked: 0, exact: 1, word: 2 };
  for (const acc of [...accounts.values()].sort((x, y) => rank[x.match] - rank[y.match]).slice(0, 3)) {
    for (const u of acc.urls) {
      const d = await linkedinDetail(page, u).catch(() => null);
      await sleep(1500);
      if (!d) continue;
      acc.detail = acc.detail?.landingUrl ? acc.detail : d;
      if (d.landingUrl || (siteCompanyId && d.companyId)) break;
    }
    const d = acc.detail;
    if (d?.landingUrl && onSite(d.landingUrl, domain)) acc.confirmedBy = `its ads link to ${domain}`;
    else if (siteCompanyId && d?.companyId === siteCompanyId) acc.confirmedBy = 'it is the LinkedIn page linked from the company site';
    if (acc.confirmedBy) { chosen = acc; break; }
    rejected.push({ advertiser: acc.name, linksTo: d?.landingUrl ? new URL(d.landingUrl).hostname : null, paidFor: d?.paidFor || null, companyId: d?.companyId || null });
  }
  if (!chosen) {
    await page.close();
    const unchecked = rejected.filter((r) => !r.linksTo && !(siteCompanyId && r.companyId));
    return {
      status: unchecked.length ? 'uncertain' : 'not found', searched: brands, candidates: rejected,
      note: `LinkedIn advertisers named like the brand were found (${rejected.map((r) => `${r.advertiser}${r.linksTo ? ` → ${r.linksTo}` : ''}`).join(', ')}), but none could be confirmed: ${unchecked.length ? 'some ad detail pages could not be read' : `their ads link elsewhere, not to ${domain}`}.`
    };
  }

  // 3. All of that account's ads, by company ID when the detail page gives one.
  const { companyId, paidFor } = chosen.detail;
  const listUrl = companyId ? `https://www.linkedin.com/ad-library/search?companyIds=${companyId}` : `https://www.linkedin.com/ad-library/search?accountOwner=${encodeURIComponent(chosen.name)}`;
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const all = await linkedinCards(page);
  const ads = all.cards.filter((c) => c.advertiser === chosen.name);
  await page.mouse.wheel(0, -20000);
  await sleep(800);
  const screenshot = `ads/${filePrefix}linkedin.jpg`;
  await page.screenshot({ path: path.join(outDir, screenshot), type: 'jpeg', quality: 70, clip: { x: 0, y: 200, width: 1400, height: 1000 } }).catch(() => {});
  await page.goto(`${listUrl}&countries=${country}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);
  const inCountry = (await page.evaluate(() => document.body.innerText)).match(/([\d,]+) ads? match/)?.[1] || null;

  // 4. Detail pages for the newest few ads.
  const details = [];
  for (const ad of ads.slice(0, 6)) {
    if (!ad.url) continue;
    const d = ad.url === chosen.detail.url ? chosen.detail : await linkedinDetail(page, ad.url).catch(() => null);
    if (d) details.push({ headline: ad.headline, ...d });
    await sleep(1500);
  }
  await page.close();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  return {
    status: 'found',
    advertiser: chosen.name,
    paidFor,
    companyId,
    match: `${chosen.match === 'linked' ? 'found through the company page' : `name ${chosen.match === 'exact' ? 'matches' : 'starts with'} the brand`}; ${chosen.confirmedBy}`,
    searchUrl: listUrl,
    scope: 'all countries',
    adsMatchingSearch: all.total,
    adsInCountry: inCountry,
    adsRead: ads.length,
    ads,
    details,
    runningAtCapture: details.filter((d) => d.ranTo === today || d.ranTo === yesterday).length,
    campaigns: [...new Set(details.map((d) => d.utm.campaign).filter(Boolean))],
    otherAdvertisers: rejected,
    screenshot
  };
}
