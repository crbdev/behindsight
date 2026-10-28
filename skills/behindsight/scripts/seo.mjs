// Optional search data from DataForSEO Labs: domain overview, top organic keywords,
// top pages by estimated traffic, and the domains competing for the company's own
// non-branded keywords. Paid-search data is left out: its keyword coverage is too
// thin to report.
// All numbers are DataForSEO's modeled estimates.

// Platforms that share keywords with almost every site; they aren't useful competitors.
const PLATFORMS = /(^|\.)(youtube|facebook|reddit|instagram|apple|google|wikipedia|amazon|linkedin|microsoft|quora|pinterest|x|twitter|tiktok|medium|github|yahoo|bing|wikihow|forbes|nytimes)\.[a-z.]+$/;

const LOCATIONS = {
  2840: 'United States', 2826: 'United Kingdom', 2124: 'Canada', 2036: 'Australia', 2276: 'Germany',
  2250: 'France', 2724: 'Spain', 2380: 'Italy', 2528: 'Netherlands', 2356: 'India', 2076: 'Brazil', 2392: 'Japan'
};

export function seoCredentials(env) {
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;
  return login && password ? { login, password } : null;
}

// One client per run, so cost and errors add up across every call.
export function createClient({ credentials, baseUrl, fetchImpl = fetch }) {
  const base = baseUrl || process.env.DATAFORSEO_BASE_URL || 'https://api.dataforseo.com';
  const auth = 'Basic ' + Buffer.from(`${credentials.login}:${credentials.password}`).toString('base64');
  const client = { cost: 0, errors: [] };
  client.call = async (endpoint, task) => {
    try {
      const r = await fetchImpl(`${base}/v3/dataforseo_labs/google/${endpoint}/live`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify([task]),
        signal: AbortSignal.timeout(60000)
      });
      const body = await r.json();
      client.cost += Number(body.cost || 0);
      const t = body.tasks?.[0];
      if (!r.ok || body.status_code !== 20000 || !t || t.status_code !== 20000) {
        client.errors.push(`${endpoint}: ${t?.status_message || body.status_message || `HTTP ${r.status}`}`);
        return null;
      }
      return t.result?.[0] || null;
    } catch (e) {
      client.errors.push(`${endpoint}: ${e.message}`);
      return null;
    }
  };
  return client;
}

export async function collectSeo({ client, domain, locationCode = 2840, languageCode = 'en', limits = {} }) {
  const lim = { keywords: 100, pages: 100, ...limits };
  const common = { target: domain, location_code: locationCode, language_code: languageCode };
  const call = (endpoint, task) => client.call(endpoint, { ...common, ...task });

  const [overview, organic, pages] = await Promise.all([
    call('domain_rank_overview', {}),
    call('ranked_keywords', {
      limit: lim.keywords,
      filters: [['ranked_serp_element.serp_item.type', '=', 'organic']],
      order_by: ['ranked_serp_element.serp_item.etv,desc']
    }),
    call('relevant_pages', { limit: lim.pages, order_by: ['metrics.organic.etv,desc'] })
  ]);

  const metrics = (m) => m && {
    etv: round(m.etv), keywords: m.count ?? 0, pos1: m.pos_1 ?? 0, pos2to3: m.pos_2_3 ?? 0, pos4to10: m.pos_4_10 ?? 0,
    trafficValue: round(m.estimated_paid_traffic_cost), isNew: m.is_new ?? 0, isLost: m.is_lost ?? 0
  };
  const ov = overview?.items?.[0]?.metrics;
  const keyword = (it) => ({
    keyword: it.keyword_data?.keyword,
    volume: it.keyword_data?.keyword_info?.search_volume ?? null,
    intent: it.keyword_data?.search_intent_info?.main_intent ?? null,
    position: it.ranked_serp_element?.serp_item?.rank_group ?? null,
    etv: round(it.ranked_serp_element?.serp_item?.etv),
    url: it.ranked_serp_element?.serp_item?.url ?? null
  });

  return {
    source: 'DataForSEO Labs',
    capturedAt: new Date().toISOString(),
    locationCode,
    location: LOCATIONS[locationCode] || `location ${locationCode}`,
    languageCode,
    overview: ov ? { organic: metrics(ov.organic) } : null,
    organicKeywordsTotal: organic?.total_count ?? null,
    keywords: (organic?.items || []).map(keyword).filter((k) => k.keyword),
    pages: (pages?.items || []).map((p) => ({
      url: p.page_address,
      etv: round(p.metrics?.organic?.etv),
      keywords: p.metrics?.organic?.count ?? 0,
      top3: (p.metrics?.organic?.pos_1 ?? 0) + (p.metrics?.organic?.pos_2_3 ?? 0)
    })).filter((p) => p.url),
    competitors: [],
    cost: round(client.cost, 4),
    errors: client.errors
  };
}

// Domains ranking for the company's own non-branded keywords. This finds the sites they
// actually compete with in search, even on domains with lots of user-generated pages.
export async function collectSerpCompetitors({ client, seo, domain, limit = 15 }) {
  const eligible = seo.keywords.filter((k) => !k.branded && k.section !== '(not in sitemap)' && k.intent !== 'navigational' && !/\b(log ?in|sign ?in|login|signin)\b/i.test(k.keyword));
  // Keywords that land on content sections (blog, glossary, tools) pull in publishers, not competitors; prefer the rest.
  const CONTENT = /^(blogs?|resources|learn|academy|glossary|help|docs|news|articles|insights|community|support|tools|hc)$|^(help|community|support|docs|academy)\./i;
  const commercial = eligible.filter((k) => !CONTENT.test(k.section || ''));
  // Best seeds: keywords that land on pages that sell (homepage, product, pricing, features, collections).
  const SELLING = /^(homepage|\(top-level pages\)|products?|features?|solutions?|platform|pricing|plans|integrations?|collections|shop|apps?)$/i;
  const selling = commercial.filter((k) => SELLING.test(k.section || '') && (k.volume ?? 0) >= 50);
  let seeds = selling.length >= 5 ? selling : null;
  seo.competitorSeedType = 'keywords landing on selling pages';
  if (!seeds) {
    // The top keywords are mostly content; ask for the best keywords outside content folders instead.
    const isBranded = brandMatcher(domain);
    const res = await client.call('ranked_keywords', {
      target: domain, location_code: seo.locationCode, language_code: seo.languageCode, limit: 100,
      filters: [['ranked_serp_element.serp_item.type', '=', 'organic'], 'and', ['ranked_serp_element.serp_item.relative_url', 'not_like', '%/blog%'], 'and', ['ranked_serp_element.serp_item.relative_url', 'not_like', '%/resources%'], 'and', ['keyword_data.keyword_info.search_volume', '>=', 50]],
      order_by: ['ranked_serp_element.serp_item.etv,desc']
    });
    const extra = (res?.items || []).map((it) => ({ keyword: it.keyword_data?.keyword, intent: it.keyword_data?.search_intent_info?.main_intent, url: it.ranked_serp_element?.serp_item?.relative_url || '' }))
      .filter((k) => k.keyword && !isBranded(k.keyword) && k.intent !== 'navigational' && !/\b(log ?in|sign ?in|login|signin)\b/i.test(k.keyword) && !/^\/(help|docs|support|academy|glossary|tools|community|hc)\b/i.test(k.url));
    if (extra.length >= 5) seeds = extra;
    else { seeds = commercial.length >= 5 ? commercial : eligible; seo.competitorSeedType = commercial.length >= 5 ? 'non-content keywords' : 'all non-branded keywords'; }
    if (extra.length >= 5) seo.competitorSeedType = 'top keywords outside blog and resources pages';
  }
  const keywords = seeds.slice(0, 20).map((k) => k.keyword);
  seo.competitorKeywords = keywords;
  if (keywords.length < 5) return seo;
  const res = await client.call('serp_competitors', {
    keywords, location_code: seo.locationCode, language_code: seo.languageCode,
    item_types: ['organic'], limit: limit * 2 + 5, order_by: ['visibility,desc']
  });
  seo.competitors = (res?.items || [])
    .filter((c) => c.domain && !c.domain.replace(/^www\./, '').endsWith(domain) && !c.domain.includes(domain.split('.')[0]) && !PLATFORMS.test(c.domain) && (c.keywords_count ?? 0) >= 2)
    .sort((a, b) => (b.keywords_count ?? 0) - (a.keywords_count ?? 0) || (b.visibility ?? 0) - (a.visibility ?? 0))
    .slice(0, limit)
    .map((c) => ({
      domain: c.domain.replace(/^www\./, ''),
      keywords: c.keywords_count ?? 0,
      avgPosition: round(c.avg_position, 1),
      etv: round(c.etv),
      visibility: round(c.visibility, 2)
    }));
  seo.cost = round(client.cost, 4);
  seo.errors = client.errors;
  return seo;
}

// Branded: the brand as a whole word, the domain written out, or a near spelling (one letter off) for longer brands.
export function brandMatcher(domain) {
  const brand = domain.split('.')[0].toLowerCase();
  const near = (w) => w.length >= 6 && brand.length >= 6 && Math.abs(w.length - brand.length) <= 1 && [...brand].filter((ch, i) => w[i] === ch).length >= brand.length - 1;
  return (kw) => {
    const k = kw.toLowerCase();
    if (k.replace(/[\s.]+/g, '').includes(brand + 'com') || new RegExp(`\\b${brand}\\b`).test(k)) return true;
    const joined = k.replace(/\s+/g, '');
    return k.split(/\s+/).some(near) || (joined.startsWith(brand.slice(0, -1)) && joined.length <= brand.length + 1);
  };
}

// Adds what needs the site's own structure: traffic by sitemap section and the branded share.
// Main-domain pages outside the sitemap's sections (user profiles, app URLs) are grouped
// together, since they usually aren't content the company published.
export function enrichSeo(seo, { domain, sectionOf, sitemapSections = [] }) {
  const known = new Set(sitemapSections);
  const brand = domain.split('.')[0].toLowerCase();
  const isBranded = brandMatcher(domain);
  for (const k of seo.keywords) k.branded = isBranded(k.keyword);
  const topEtv = seo.keywords.reduce((s, k) => s + k.etv, 0);
  const brandedEtv = seo.keywords.filter((k) => k.branded).reduce((s, k) => s + k.etv, 0);
  seo.brandedShareOfTopKeywords = topEtv ? Math.round((brandedEtv / topEtv) * 100) : null;
  // The bare brand name can be a common word (gong, monday), so also report the share without it.
  const bare = seo.keywords.filter((k) => k.keyword.toLowerCase().replace(/\s+/g, '') === brand);
  const bareEtv = bare.reduce((s, k) => s + k.etv, 0);
  seo.brandedShareExcludingBareName = topEtv - bareEtv > 0 ? Math.round(((brandedEtv - bareEtv) / (topEtv - bareEtv)) * 100) : null;

  const sectionFor = (url) => {
    try {
      const u = new URL(url);
      const section = sectionOf(u);
      const mainHost = u.hostname.replace(/^www\./, '') === domain;
      return mainHost && known.size && !known.has(section) && section !== 'homepage' ? '(not in sitemap)' : section;
    } catch { return '(other)'; }
  };
  // If most top pages fall outside the sitemap's sections, the sitemap is incomplete; don't group them.
  const mainPages = seo.pages.filter((p) => { try { return new URL(p.url).hostname.replace(/^www\./, '') === domain; } catch { return false; } });
  const outside = mainPages.filter((p) => sectionFor(p.url) === '(not in sitemap)').length;
  if (known.size && mainPages.length && outside / mainPages.length > 0.4) {
    known.clear();
    seo.sitemapIncomplete = true;
  }
  for (const k of seo.keywords) k.section = k.url ? sectionFor(k.url) : null;

  const sections = {};
  const pagesEtv = seo.pages.reduce((s, p) => s + p.etv, 0);
  for (const p of seo.pages) {
    const section = sectionFor(p.url);
    p.section = section;
    const s = (sections[section] ||= { name: section, etv: 0, pages: 0 });
    s.etv += p.etv;
    s.pages++;
  }
  seo.sections = Object.values(sections)
    .map((s) => ({ ...s, etv: round(s.etv), share: pagesEtv ? Math.round((s.etv / pagesEtv) * 100) : 0 }))
    .sort((a, b) => b.etv - a.etv);
  seo.sectionsCoverage = seo.overview?.organic?.etv ? Math.round((pagesEtv / seo.overview.organic.etv) * 100) : null;
  return seo;
}

function round(n, digits = 0) {
  if (n == null || isNaN(n)) return 0;
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}
