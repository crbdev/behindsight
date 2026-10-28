// Public ad libraries: Google Ads Transparency Center, Meta Ad Library and LinkedIn Ad Library.
// Finds the company's own advertiser accounts (not every advertiser linking to the domain),
// then records ad counts, formats, dates, ad copy and a few screenshots.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const GOOGLE_REGIONS = { US: 2840, GB: 2826, CA: 2124, AU: 2036, DE: 2276, FR: 2250, ES: 2724, IT: 2380, NL: 2528, IN: 2356, BR: 2076, JP: 2392 };
const GOOGLE_FORMATS = { 1: 'text', 2: 'image', 3: 'video' };
const DAY = 86400000;

const squash = (s) => String(s || '').toLowerCase().replace(/\.(com|io|co|ai|app|net|org)\b/g, '').replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|limited|gmbh|corp|corporation|co)$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const linkedin = platforms.includes('linkedin') ? await run('LinkedIn', () => linkedinAds({ context, brands, country, outDir, log, filePrefix })) : skipped;
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

  // Candidate advertiser accounts: name suggestions, plus advertisers in the domain results whose name matches the brand.
  const candidates = new Map();
  for (const q of brands) {
    const s = await googleRpc('SearchService/SearchSuggestions', { 1: q, 2: 10, 3: 10, 4: [region], 5: { 1: 1 } });
    for (const item of s['1'] || []) {
      const a = item['1'];
      if (a && brands.some((b) => squash(a['1']).startsWith(squash(b)) || squash(b).startsWith(squash(a['1'])))) {
        candidates.set(a['2'], { id: a['2'], name: a['1'], country: a['3'], adsRange: [a['4']?.['2']?.['1'], a['4']?.['2']?.['2']].filter(Boolean).join('–') });
      }
    }
  }
  const domainResults = await googleRpc('SearchService/SearchCreatives', { 2: 100, 3: filters({ 12: { 1: domain, 2: true } }), 7: { 1: 1, 2: 0, 3: region } });
  const domainAdvertisers = new Map();
  for (const c of domainResults['1'] || []) {
    domainAdvertisers.set(c['1'], c['12']);
    if (brands.some((b) => squash(c['12']).startsWith(squash(b))) && !candidates.has(c['1'])) candidates.set(c['1'], { id: c['1'], name: c['12'] });
  }
  const domainTotal = [domainResults['4'], domainResults['5']].filter(Boolean).join('–') || null;

  // Keep only accounts with at least one ad pointing to the company's domain.
  const verified = [];
  for (const cand of [...candidates.values()].slice(0, 8)) {
    const r = await googleRpc('SearchService/SearchCreatives', { 2: 40, 3: filters({ 12: { 1: domain, 2: true }, 13: { 1: [cand.id] } }), 7: { 1: 1, 2: 0, 3: region } });
    if ((r['1'] || []).length) verified.push({ ...cand, adsToDomain: [r['4'], r['5']].filter(Boolean).join('–') || String(r['1'].length) });
  }
  const others = [...domainAdvertisers.entries()].filter(([id]) => !verified.some((v) => v.id === id)).length;
  if (!verified.length) {
    return { status: 'not found', searched: brands, domainAdsTotal: domainTotal, otherAdvertisersInSample: others, note: 'No advertiser account matching the brand has ads pointing to the domain in this region.' };
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
    otherAdvertisersInSample: others,
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

  // Prefer the page the company links from its own site, then a verified page with the brand's name.
  const fbSlugs = socials.map((s) => s.match(/facebook\.com\/(?:pg\/)?([^/?#]+)/i)?.[1]).filter(Boolean).map((s) => s.toLowerCase());
  const unique = [...new Map(suggestions.map((s) => [s.page_id, s])).values()];
  const pageMatch =
    unique.find((s) => s.page_alias && fbSlugs.includes(s.page_alias.toLowerCase())) ||
    unique.find((s) => brands.some((b) => squash(s.name) === squash(b)) && s.verification === 'BLUE_VERIFIED') ||
    unique.find((s) => brands.some((b) => squash(s.name) === squash(b)));
  if (!pageMatch) {
    await page.close();
    return { status: 'not found', searched: brands, note: 'No Facebook page matching the brand appeared in the Ad Library search.' };
  }

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
  await page.screenshot({ path: path.join(outDir, `ads/${filePrefix}meta.jpg`), type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: top, width: 1400, height: 1100 } }).catch(() => {});
  await page.close();

  if (/No ads match your search criteria/i.test(text)) {
    return { status: 'no active ads', page: { id: pageMatch.page_id, name: pageMatch.name, alias: pageMatch.page_alias, verified: pageMatch.verification === 'BLUE_VERIFIED' }, activeAds: '0', activeAdsAllCountries: '0', adsRead: 0, ads: [], note: `The page ${pageMatch.name} has no active ads in any country.`, url: pageUrl('ALL') };
  }
  const total = text.match(/(~?[\d,]+)\s+results?/)?.[1] || null;
  const ads = text.split('Library ID:').slice(1).map((chunk) => {
    const lines = chunk.split(/\n(?:System status|Ad Library API|About ads and data use)/)[0].split('\n').map((l) => l.replace(/\u200b/g, '').trim()).filter(Boolean);
    const started = chunk.match(/Started running on ([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1] || null;
    const sponsored = lines.indexOf('Sponsored');
    const body = sponsored >= 0 ? lines.slice(sponsored + 1).filter((l) => !/^\d+:\d+ \/ \d+:\d+$/.test(l) && l !== 'Active') : [];
    return {
      id: lines[0],
      started: started ? new Date(`${started} UTC`).toISOString().slice(0, 10) : null,
      video: /\d+:\d+ \/ \d+:\d+/.test(chunk),
      multipleVersions: /multiple versions/.test(chunk),
      text: body.slice(0, -2).join(' ').slice(0, 400) || body.join(' ').slice(0, 400),
      cta: body.at(-1) && body.at(-1).length <= 25 ? body.at(-1) : null,
      headline: body.at(-1) && body.at(-1).length <= 25 ? body.at(-2) || null : null
    };
  }).filter((a) => /^\d+$/.test(a.id));
  const now = Date.now();
  return {
    status: 'found',
    page: { id: pageMatch.page_id, name: pageMatch.name, alias: pageMatch.page_alias, verified: pageMatch.verification === 'BLUE_VERIFIED', likes: pageMatch.likes, igFollowers: pageMatch.ig_followers },
    activeAds: countryActive,
    activeAdsAllCountries: total,
    adsReadFrom: 'all countries',
    adsRead: ads.length,
    startedInLast30Days: ads.filter((a) => a.started && now - new Date(a.started) <= 30 * DAY).length,
    oldestActiveStart: ads.map((a) => a.started).filter(Boolean).sort()[0] || null,
    videoShare: ads.length ? Math.round((ads.filter((a) => a.video).length / ads.length) * 100) : null,
    ads,
    screenshot: `ads/${filePrefix}meta.jpg`,
    url: pageUrl(country)
  };
}

// ---------- LinkedIn Ad Library ----------

async function linkedinAds({ context, brands, country, outDir, log, filePrefix = '' }) {
  log('reading LinkedIn Ad Library');
  const page = await context.newPage();
  let found = null;
  const attempts = brands.slice(0, 2).flatMap((q) => [[q, country], [q, null]]);
  for (const [q, ctry] of attempts) {
    const url = `https://www.linkedin.com/ad-library/search?accountOwner=${encodeURIComponent(q)}${ctry ? `&countries=${ctry}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(5000);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 3000); await sleep(1200); }
    const text = await page.evaluate(() => document.body.innerText);
    const hrefs = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/ad-library/detail/"]')].map((a) => a.href.split('?')[0]))]);
    // Each card reads: advertiser, "Promoted", body, headline, "View details". Cards without "Promoted" are sponsored messages.
    const ads = [];
    text.split('View details').slice(0, -1).forEach((chunk, i) => {
      const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
      const at = lines.lastIndexOf('Promoted');
      if (at < 1) return;
      const advertiser = lines[at - 1];
      if (!brands.some((b) => squash(advertiser) === squash(b) || squash(advertiser).startsWith(squash(b)))) return;
      if (/%FIRSTNAME%|explore relevant opportunities/i.test(chunk)) return; // recruiting messages, not marketing ads
      ads.push({ advertiser, text: (lines[at + 1] || '').slice(0, 300), headline: lines[at + 2] || null, url: hrefs[i] || null });
    });
    if (ads.length) {
      await page.mouse.wheel(0, -20000);
      await sleep(800);
      await page.screenshot({ path: path.join(outDir, `ads/${filePrefix}linkedin.jpg`), type: 'jpeg', quality: 70, clip: { x: 0, y: 200, width: 1400, height: 1000 } }).catch(() => {});
      found = { query: q, url, scope: ctry || 'all countries', matchingAds: text.match(/([\d,]+) ads? match/)?.[1] || null, ads };
      break;
    }
  }
  await page.close();
  if (!found) return { status: 'not found', searched: brands, note: 'No LinkedIn ads from an advertiser matching the brand.' };
  return {
    status: 'found',
    advertiser: found.ads[0].advertiser,
    searchUrl: found.url,
    scope: found.scope,
    adsMatchingSearch: found.matchingAds,
    adsRead: found.ads.length,
    ads: found.ads,
    screenshot: `ads/${filePrefix}linkedin.jpg`
  };
}
