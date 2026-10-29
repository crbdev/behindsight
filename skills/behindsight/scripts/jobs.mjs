// Hiring signals from public job boards: finds the company's applicant tracking system (Greenhouse,
// Lever, Ashby, Workable, SmartRecruiters, Recruitee) from its careers page, reads open roles from the
// board's public JSON feed, and pulls out marketing and sales roles and the tools job posts name.
// A board counts as the company's when the careers page links or embeds it. Without that, a board
// found by guessing the brand's slug counts only when its posts mention the company's domain.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registrableDomain, sleep } from './lib.mjs';

const BOARDS = [
  { ats: 'greenhouse', patterns: [/greenhouse\.io\/embed\/job_board(?:\/js)?\?(?:[^"'\s]*&)?for=([\w-]+)/i, /boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/i, /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w-]+)/i] },
  { ats: 'lever', patterns: [/api\.(?:eu\.)?lever\.co\/v0\/postings\/([\w.-]+)/i, /jobs\.(?:eu\.)?lever\.co\/([\w.-]+)/i] },
  { ats: 'ashby', patterns: [/api\.ashbyhq\.com\/posting-api\/job-board\/([\w.%-]+)/i, /jobs\.ashbyhq\.com\/([\w.%-]+)/i] },
  { ats: 'workable', patterns: [/apply\.workable\.com\/(?:api\/v\d\/(?:widget\/)?accounts\/)?([\w-]+)/i] },
  { ats: 'smartrecruiters', patterns: [/api\.smartrecruiters\.com\/v1\/companies\/([\w-]+)/i, /(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i] },
  { ats: 'recruitee', patterns: [/([\w-]+)\.recruitee\.com/i] }
];
const NOT_SLUG = /^(embed|api|v\d|js|jobs|careers|static|assets|www|app|apply|widget)$/i;

// Tools that show up in job posts but often not on websites (CRM, sales tools, data stack).
const JOB_TOOLS = ['Salesforce', 'HubSpot', 'Marketo', 'Pardot', 'Eloqua', 'Outreach', 'Salesloft', 'Gong', 'Clay', 'Apollo', 'ZoomInfo', '6sense', 'Demandbase', 'Clearbit', 'Segment', 'Amplitude', 'Mixpanel', 'Heap', 'PostHog', 'Looker', 'Tableau', 'Metabase', 'dbt', 'Snowflake', 'BigQuery', 'Figma', 'Webflow', 'WordPress', 'Contentful', 'Sanity', 'Google Ads', 'Google Analytics', 'GA4', 'Meta Ads', 'LinkedIn Ads', 'Braze', 'Iterable', 'Customer.io', 'Klaviyo', 'Mailchimp', 'Intercom', 'Zendesk', 'Gainsight', 'ChurnZero', 'Notion', 'Asana', 'Jira', 'Ahrefs', 'Semrush', 'Airtable', 'Zapier', 'Canva', 'Adobe Creative', 'Hightouch', 'Mutiny', 'Qualified', 'Chili Piper', 'Drift', 'Clari', 'Common Room', 'Optimizely', 'Hotjar', 'Unbounce', 'Hootsuite', 'Sprout Social', 'Partnerstack', 'Impact.com', 'Rewardful', 'Power BI', 'Claude', 'ChatGPT', 'Cursor'];

const MARKETING = /\b(marketing|marketer|growth|demand gen|brand|content|seo|sem|social media|communications|comms|public relations|pr manager|lifecycle|community|events?|creative|copywriter|writer|editor|partnerships?|developer relations|devrel|evangelist|advocate|video|web(site)? (manager|producer))\b/i;
const SALES = /\b(sales|account executive|sdr|bdr|business development|solutions? (engineer|consultant|architect)|revenue operations|revops|partner manager)\b/i;
const CUSTOMER = /\b(customer success|customer experience|support|implementation|onboarding|account manager)\b/i;
// marketing, sales, customer (success and support) or other. Titles decide first; department and team
// break ties, since some companies file everything customer-facing under one "GTM" department.
const roleOf = (p) => {
  const group = `${p.department || ''} ${p.team || ''}`;
  if (!/marketing|solutions|sales|developer (relations|advocate)/i.test(p.title) && (/\b(engineer|engineering|developer|scientist|researcher)\b/i.test(p.title) || /\b(product|data|ml|security|platform) (designer|manager)\b/i.test(p.title) || /^engineering$/i.test(p.department || ''))) return 'other';
  if (SALES.test(p.title)) return 'sales';
  if (MARKETING.test(p.title)) return 'marketing';
  if (CUSTOMER.test(p.title)) return 'customer';
  if (MARKETING.test(group)) return 'marketing';
  if (CUSTOMER.test(group)) return 'customer';
  if (/\bsales\b/i.test(group)) return 'sales';
  return 'other';
};

const text = (html) => String(html || '').replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const unescape = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const day = (v) => { if (!v) return null; const d = new Date(typeof v === 'number' ? v : String(v)); return isNaN(d) ? null : d.toISOString().slice(0, 10); };

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Each reader returns { company, postings } with postings normalized to one shape.
const READERS = {
  async greenhouse(slug) {
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return {
      company: d.jobs?.[0]?.company_name || null,
      boardUrl: `https://job-boards.greenhouse.io/${slug}`,
      postings: (d.jobs || []).map((j) => ({ title: j.title, department: j.departments?.[0]?.name || null, team: null, location: j.location?.name || null, remote: /remote/i.test(j.location?.name || '') || null, posted: day(j.first_published || j.updated_at), url: j.absolute_url, text: text(unescape(j.content)) }))
    };
  },
  async lever(slug) {
    let d;
    try { d = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`); } catch { d = await getJson(`https://api.eu.lever.co/v0/postings/${slug}?mode=json`); }
    if (!Array.isArray(d)) throw new Error('not a Lever board');
    return {
      company: null,
      boardUrl: `https://jobs.lever.co/${slug}`,
      postings: d.map((j) => ({ title: j.text, department: j.categories?.department || null, team: j.categories?.team || null, location: j.categories?.location || null, remote: j.workplaceType ? j.workplaceType === 'remote' : null, posted: day(j.createdAt), url: j.hostedUrl, compensation: j.salaryRange ? `${j.salaryRange.currency || ''} ${j.salaryRange.min}–${j.salaryRange.max}${j.salaryRange.interval ? ` ${j.salaryRange.interval}` : ''}`.trim() : null, text: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${text(l.content)}`), j.additionalPlain].filter(Boolean).join('\n\n') }))
    };
  },
  async ashby(slug) {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
    return {
      company: null,
      boardUrl: `https://jobs.ashbyhq.com/${slug}`,
      postings: (d.jobs || []).filter((j) => j.isListed !== false).map((j) => ({ title: j.title, department: j.department || null, team: j.team || null, location: j.location || null, remote: j.isRemote ?? null, posted: day(j.publishedAt), url: j.jobUrl, compensation: j.compensation?.compensationTierSummary || null, text: j.descriptionPlain || text(j.descriptionHtml) }))
    };
  },
  async workable(slug) {
    const d = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
    return {
      company: d.name || null,
      boardUrl: `https://apply.workable.com/${slug}`,
      postings: (d.jobs || []).map((j) => ({ title: j.title, department: j.department || null, team: null, location: [j.city, j.country].filter(Boolean).join(', ') || null, remote: j.telecommuting ?? null, posted: day(j.published_on || j.created_at), url: j.url || j.shortlink, text: text(j.description) }))
    };
  },
  async smartrecruiters(slug) {
    const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
    return {
      company: d.content?.[0]?.company?.name || null,
      boardUrl: `https://careers.smartrecruiters.com/${slug}`,
      postings: (d.content || []).map((j) => ({ title: j.name, department: j.department?.label || null, team: j.function?.label || null, location: [j.location?.city, j.location?.country?.toUpperCase()].filter(Boolean).join(', ') || null, remote: j.location?.remote ?? null, posted: day(j.releasedDate), url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, text: '' })),
      total: d.totalFound
    };
  },
  async recruitee(slug) {
    const d = await getJson(`https://${slug}.recruitee.com/api/offers/`);
    return {
      company: d.offers?.[0]?.company_name || null,
      boardUrl: `https://${slug}.recruitee.com`,
      postings: (d.offers || []).map((j) => ({ title: j.title, department: j.department || null, team: null, location: j.location || null, remote: j.remote ?? null, posted: day(j.published_at || j.created_at), url: j.careers_url, text: text([j.description, j.requirements].filter(Boolean).join('\n')) }))
    };
  }
};

// Job boards referenced in a list of URLs or HTML.
export function findBoards(blobs) {
  const found = [];
  for (const blob of blobs) {
    for (const { ats, patterns } of BOARDS) {
      for (const re of patterns) {
        const slug = String(blob).match(re)?.[1];
        if (slug && !NOT_SLUG.test(slug) && !found.some((f) => f.ats === ats && f.slug.toLowerCase() === slug.toLowerCase())) found.push({ ats, slug: decodeURIComponent(slug) });
        if (slug) break;
      }
    }
  }
  return found;
}

// The careers page: a link from the homepage, else a careers URL in the sitemap.
function careersUrl({ links, sitemapUrls, siteRoot }) {
  const own = (u) => { try { return registrableDomain(new URL(u).hostname) === siteRoot; } catch { return false; } };
  const fromLinks = links.find((l) => own(l.href) && (/\/(careers|jobs|join-us|join|work-with-us|hiring|open-roles|open-positions)\/?$/i.test(new URL(l.href).pathname) || /^(careers|jobs|we['’]re hiring|join us|open roles)$/i.test((l.text || '').trim())));
  if (fromLinks) return fromLinks.href;
  return sitemapUrls.map((u) => u.loc).find((u) => /\/(careers|jobs)\/?$/i.test(new URL(u).pathname)) || null;
}

export async function collectJobs({ context, origin, siteRoot, domain, brands, links = [], sitemapUrls = [], outDir, log = () => {}, board: forced = null, slugify }) {
  // 1. The board, from links on the homepage or the careers page (links, embeds and network requests).
  let careers = careersUrl({ links, sitemapUrls, siteRoot });
  let boards = forced ? [forced] : findBoards(links.map((l) => l.href));
  let basis = forced ? 'given by the analyst' : boards.length ? 'linked from the homepage' : null;
  if (!boards.length && careers) {
    log(`reading careers page ${careers}`);
    const page = await context.newPage();
    const seen = [];
    page.on('request', (r) => seen.push(r.url()));
    try {
      await page.goto(careers, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(2500);
      careers = page.url();
      seen.push(...await page.evaluate(() => [...document.querySelectorAll('a[href], iframe[src], script[src]')].map((e) => e.href || e.src)), await page.content());
    } catch (e) { log(`careers page failed: ${e.message.split('\n')[0]}`); }
    await page.close();
    boards = findBoards(seen);
    if (boards.length) basis = 'linked or embedded on the careers page';
  }

  // 2. No board linked: try the brand as a slug on the biggest boards. It counts only if the posts
  // mention the company's domain, since another company can hold the same slug.
  if (!boards.length) {
    const slugs = [...new Set(brands.map((b) => b.toLowerCase().replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]+/g, '')).filter(Boolean))].slice(0, 2);
    for (const slug of slugs) {
      for (const ats of ['greenhouse', 'ashby', 'lever']) {
        try {
          const r = await READERS[ats](slug);
          if (r.postings.length && r.postings.some((p) => p.text.toLowerCase().includes(siteRoot))) { boards = [{ ats, slug }]; basis = `found by trying "${slug}" on ${ats}; its posts mention ${siteRoot}`; break; }
        } catch {}
      }
      if (boards.length) break;
    }
  }
  if (!boards.length) return { status: 'not found', careersPage: careers, note: careers ? 'The careers page links no supported job board (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee). It may use another system, such as Workday, or list roles on the page itself.' : 'No careers page or job board found.' };

  // 3. Read the first board that answers.
  let board = null;
  let data = null;
  const errors = [];
  for (const b of boards.slice(0, 3)) {
    try { data = await READERS[b.ats](b.slug); board = b; break; } catch (e) { errors.push(`${b.ats}/${b.slug}: ${e.message}`); }
  }
  if (!data) return { status: 'error', careersPage: careers, boards, error: errors.join('; ') };

  const postings = data.postings.map((p) => ({ ...p, role: roleOf(p) }));
  const now = Date.now();
  const within = (d, days) => d && now - new Date(d) <= days * 86400000;
  const count = (key) => Object.entries(postings.reduce((m, p) => { const k = p[key] || '(none)'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, count: n }));

  // Tools named in posts: the curated list plus nothing fuzzy; case-sensitive whole words.
  // The company's own product name isn't a tool it uses.
  const own = new Set([...brands, siteRoot.split('.')[0]].map((b) => b.toLowerCase().replace(/[^a-z0-9]/g, '')));
  const tools = JOB_TOOLS.filter((t) => !own.has(t.toLowerCase().replace(/[^a-z0-9]/g, ''))).map((t) => {
    const re = new RegExp(`(^|[^A-Za-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`);
    const hits = postings.filter((p) => re.test(p.text));
    return { tool: t, posts: hits.length, marketingPosts: hits.filter((p) => p.role !== 'other').length };
  }).filter((t) => t.posts).sort((a, b) => b.marketingPosts - a.marketingPosts || b.posts - a.posts);

  // Marketing and sales posts in full, for reading.
  await mkdir(path.join(outDir, 'jobs'), { recursive: true });
  const order = { marketing: 0, sales: 1, customer: 2 };
  for (const p of postings.filter((x) => x.role !== 'other').sort((x, y) => order[x.role] - order[y.role]).slice(0, 25)) {
    p.file = `jobs/${slugify(p.url || p.title)}.md`;
    await writeFile(path.join(outDir, p.file), `# ${p.title}\n\n${[p.department, p.team, p.location, p.compensation, p.posted && `posted ${p.posted}`].filter(Boolean).join(' · ')}\n${p.url}\n\n${p.text}\n`);
  }

  return {
    status: 'found',
    ats: board.ats,
    slug: board.slug,
    boardUrl: data.boardUrl,
    companyOnBoard: data.company,
    match: basis,
    careersPage: careers,
    openRoles: data.total || postings.length,
    postingsRead: postings.length,
    postedLast30Days: postings.filter((p) => within(p.posted, 30)).length,
    postedLast90Days: postings.filter((p) => within(p.posted, 90)).length,
    datesShown: postings.some((p) => p.posted),
    oldestPosting: postings.map((p) => p.posted).filter(Boolean).sort()[0] || null,
    remoteShare: postings.some((p) => p.remote !== null) ? Math.round((postings.filter((p) => p.remote).length / postings.length) * 100) : null,
    byDepartment: count('department').slice(0, 12),
    byLocation: count('location').slice(0, 10),
    byRole: Object.fromEntries(['marketing', 'sales', 'customer', 'other'].map((r) => [r, postings.filter((p) => p.role === r).length])),
    toolsMentioned: tools.slice(0, 30),
    postings: postings.sort((x, y) => (order[x.role] ?? 3) - (order[y.role] ?? 3)).map(({ text: t, ...p }) => ({ ...p, words: t.split(/\s+/).filter(Boolean).length })),
    texts: Object.fromEntries(postings.filter((p) => p.role !== 'other').map((p) => [p.url, p.text.slice(0, 20000)]))
  };
}
