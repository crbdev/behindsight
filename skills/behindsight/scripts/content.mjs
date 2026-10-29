// A sample of the company's content for the agent to read: the newest posts, preferring the blog's
// feed because it includes real publish dates, plus the posts that earn the most search traffic.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './lib.mjs';

const CONTENT_FOLDER = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?(blogs?|articles|insights|resources|news|learn|guides|stories|library|academy|magazine|journal)(\/|$)/i;
// Folders that aren't articles even when their slugs read like sentences.
const NOT_CONTENT = /^(docs?|help|support|developers?|api|integrations?|apps?|marketplace|templates?|careers|jobs|changelog|releases?|release-notes|legal|customers|case-studies|partners?|products?|features?|solutions?|use-cases|compare|vs|alternatives?|glossary|events?|webinars?|security|status|pricing|terms|privacy|policies|policy|enablement|locations?|tools?|downloads?|shop|collections|products|category|categories|tags?|pages)$/i;
const LOCALE = /^[a-z]{2}(-[a-z]{2,4})?$/i;

// Article folders in the sitemap: known names (blog, articles…) or any folder whose pages mostly have
// sentence-like slugs ("how-we-built-x"), which catches blogs under other names, like Linear's /now.
export function contentFolders(sitemapUrls = []) {
  const byFolder = new Map();
  for (const u of sitemapUrls) {
    let parts;
    try { parts = new URL(u.loc).pathname.split('/').filter(Boolean); } catch { continue; }
    if (parts.length > 1 && LOCALE.test(parts[0])) parts.shift();
    if (parts.length < 2 || LISTING.test('/' + parts.join('/'))) continue;
    const f = parts[0].toLowerCase();
    const slug = parts.at(-1);
    const e = byFolder.get(f) || { folder: f, pages: 0, sentence: 0 };
    e.pages++;
    if (slug.split('-').length >= 3 && !/^\d{4}-\d{2}/.test(slug)) e.sentence++;
    byFolder.set(f, e);
  }
  return [...byFolder.values()]
    .filter((e) => !NOT_CONTENT.test(e.folder) && (CONTENT_FOLDER.test(`/${e.folder}/`) || (e.pages >= 10 && e.sentence / e.pages >= 0.6)))
    .sort((a, b) => b.pages - a.pages);
}

const LISTING = /\/(category|categories|tag|tags|topics?|author|authors|page|search|archive)(\/|$)/i;
const BLOCKED = /error 10\d\d|too many requests|access denied|just a moment|attention required|rate limit/i;
const FEED_PATHS = ['/blog/feed/', '/feed/', '/blog/rss.xml', '/rss.xml', '/blog/feed.xml', '/feed.xml', '/blog/index.xml', '/atom.xml', '/blogs/news.atom', '/blog/rss/', '/rss/'];

export async function collectContent({ context, origin, siteRoot, homePage, sitemapUrls = [], seoPages = [], recent = 20, topTraffic = 8, log = () => {}, indexUrl = null, onlyFolder = null }) {
  // Which folders hold articles: from the sitemap when it has any, else the known folder names.
  const folders = contentFolders(sitemapUrls);
  const folderSet = new Set(onlyFolder ? [onlyFolder.toLowerCase()] : folders.map((f) => f.folder));
  const isContent = (pathname) => {
    if (!folderSet.size) return CONTENT_FOLDER.test(pathname);
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length > 1 && LOCALE.test(parts[0])) parts.shift();
    return folderSet.has((parts[0] || '').toLowerCase());
  };
  // A chosen folder skips the site-wide feed, which may cover a different section.
  const feedCandidates = onlyFolder ? [] : [...new Set([...(homePage.feeds || []), ...FEED_PATHS.map((p) => origin + p)])];
  let feed = null;
  for (const url of feedCandidates) {
    const items = await readFeed(context, url);
    if (items.length >= 3) { feed = { url, items }; break; }
  }

  // Newest posts: the feed if found, then the blog's index page (usually newest first),
  // then blog-like sitemap URLs by lastmod (weakest: lastmod often reflects rebuilds).
  let source;
  let candidates;
  const indexPosts = feed ? [] : await readIndex(context, origin, siteRoot, homePage, indexUrl || (folders[0] ? `${origin}/${folders[0].folder}` : null), isContent);
  if (feed) {
    source = 'feed';
    candidates = feed.items.filter((i) => isOwn(i.link, siteRoot)).slice(0, recent).map((i) => ({ url: i.link, feedTitle: i.title, published: i.date, dateSource: 'feed', categories: i.categories, reason: 'recent' }));
  } else if (indexPosts.length >= 5) {
    source = 'blog index';
    candidates = indexPosts.slice(0, recent * 2).map((url) => ({ url, reason: 'recent' }));
    // Index pages often mix in category links; sitemap posts top up the sample if needed.
    const have = new Set(candidates.map((c) => norm(c.url)));
    candidates.push(...sitemapUrls
      .filter((u) => { try { const p = new URL(u.loc); return isContent(p.pathname) && !LISTING.test(p.pathname) && p.pathname.split('/').filter(Boolean).length >= 2 && !have.has(norm(u.loc)); } catch { return false; } })
      .sort((a, b) => String(b.lastmod || '').localeCompare(String(a.lastmod || '')))
      .slice(0, recent)
      .map((u) => ({ url: u.loc, reason: 'recent' })));
  } else {
    source = 'sitemap';
    candidates = sitemapUrls
      .filter((u) => { try { const p = new URL(u.loc); return isContent(p.pathname) && !LISTING.test(p.pathname) && p.pathname.split('/').filter(Boolean).length >= 2; } catch { return false; } })
      .sort((a, b) => String(b.lastmod || '').localeCompare(String(a.lastmod || '')))
      .slice(0, recent * 2)
      .map((u) => ({ url: u.loc, published: u.lastmod?.slice(0, 10) || null, dateSource: 'sitemap lastmod', reason: 'recent' }));
  }
  const seen = new Set(candidates.map((c) => norm(c.url)));
  const traffic = seoPages
    .filter((p) => { try { const path = new URL(p.url).pathname; return isContent(path) && path.split('/').filter(Boolean).length >= 2 && !LISTING.test(path) && isOwn(p.url, siteRoot); } catch { return false; } })
    .sort((a, b) => b.etv - a.etv)
    .slice(0, topTraffic);
  for (const p of traffic) {
    const existing = candidates.find((c) => norm(c.url) === norm(p.url));
    if (existing) { existing.etv = p.etv; existing.reason = 'recent and top traffic'; continue; }
    if (seen.has(norm(p.url))) continue;
    seen.add(norm(p.url));
    candidates.push({ url: p.url, etv: p.etv, reason: 'top traffic' });
  }
  if (!candidates.length) {
    log('no blog or article content found');
    return { source: 'none', feed: null, folders, posts: [] };
  }

  log(`reading up to ${recent} recent and ${traffic.length} top-traffic posts (${source === 'feed' ? `feed ${feed.url}` : source})`);
  // One post at a time with a pause; sites rate-limit bursts. A block page triggers one long wait and a retry.
  const posts = [];
  const listings = [];
  let backedOff = false;
  let recentRead = 0;
  for (const c of candidates) {
    if (c.reason === 'recent' && recentRead >= recent) continue;
    let post;
    try { post = await readPost(context, c.url); }
    catch (e) { posts.push({ ...c, error: e.message.split('\n')[0] }); continue; }
    if (BLOCKED.test(post.title || '') || (post.status === 429)) {
      if (backedOff) { posts.push({ ...c, error: 'blocked by the site (rate limit)' }); break; }
      backedOff = true;
      log('content: rate-limited, waiting 30s');
      await sleep(30000);
      try { post = await readPost(context, c.url); } catch (e) { posts.push({ ...c, error: e.message.split('\n')[0] }); continue; }
      if (BLOCKED.test(post.title || '')) { posts.push({ ...c, error: 'blocked by the site (rate limit)' }); break; }
    }
    // Category and tag pages look like posts by URL; they're short, undated and mostly links to posts.
    if (!post.published && post.words < 700 && post.contentLinks >= 12) {
      listings.push(c.url);
    } else {
      posts.push({ ...c, ...post });
      if (c.reason === 'recent') recentRead++;
    }
    await sleep(1500);
  }
  posts.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  // The whole feed, not just the sample: its size and the categories it uses.
  const feedSummary = feed ? (() => {
    const cats = {};
    for (const i of feed.items) for (const c of i.categories || []) cats[c] = (cats[c] || 0) + 1;
    const dates = feed.items.map((i) => i.date).filter(Boolean).sort();
    return { items: feed.items.length, oldest: dates[0] || null, newest: dates.at(-1) || null, categories: Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })) };
  })() : null;
  // Section pages share one title ("Now", "Blog"): undated pages with a repeated title are listings too.
  const undatedTitles = {};
  for (const p of posts) if (!p.error && !p.published && p.title) undatedTitles[p.title] = (undatedTitles[p.title] || 0) + 1;
  const kept = posts.filter((p) => {
    if (p.error || p.published || !p.title || undatedTitles[p.title] < 2) return true;
    listings.push(p.url);
    return false;
  });
  return { source, feed: feed ? feed.url : null, feedSummary, folders, posts: kept, listingPagesSkipped: listings };
}

export async function savePosts(content, outDir, slugify) {
  await mkdir(path.join(outDir, 'content'), { recursive: true });
  for (const p of content.posts) {
    if (!p.text) continue;
    p.file = `content/${slugify(p.url)}.md`;
    const head = [`# ${p.title || p.feedTitle || p.url}`, '', `URL: ${p.url}`, `Published: ${p.published || 'unknown'} (${p.dateSource || 'no date found'})`, `Author: ${p.author || 'unknown'}`, `Words: ${p.words}${p.truncated ? ' (text cut off at 40,000 characters)' : ''}`, `Sampled because: ${p.reason}${p.etv ? ` (~${p.etv} est. monthly search visits)` : ''}`, ''];
    await writeFile(path.join(outDir, p.file), head.join('\n') + p.text);
    delete p.text;
  }
}

// Posts per month from real publish dates, last 12 months.
export function cadence(content) {
  // Only the recent sample: top-traffic posts are old by design and would stretch the timeline.
  const dated = content.posts.filter((p) => p.published && p.dateSource !== 'sitemap lastmod' && /recent/.test(p.reason || ''));
  const byMonth = {};
  for (const p of dated) byMonth[p.published.slice(0, 7)] = (byMonth[p.published.slice(0, 7)] || 0) + 1;
  return Object.entries(byMonth).sort().map(([month, count]) => ({ month, count }));
}

// The blog's index page: a nav link into an article folder, else the biggest article folder, else /blog/.
async function readIndex(context, origin, siteRoot, homePage, folderIndex, isContent) {
  const fromNav = (homePage.links || []).map((l) => { try { return new URL(l.href); } catch { return null; } })
    .find((u) => u && u.hostname.endsWith(siteRoot) && isContent(u.pathname) && u.pathname.split('/').filter(Boolean).length <= 2);
  const indexUrl = fromNav ? fromNav.origin + fromNav.pathname : folderIndex || `${origin}/blog/`;
  const page = await context.newPage();
  try {
    await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    const base = new URL(page.url()).pathname.replace(/\/$/, '');
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('main a[href], article a[href], a[href]')].map((a) => a.href));
    const out = [];
    for (const h of hrefs) {
      let u;
      try { u = new URL(h); } catch { continue; }
      const p = u.pathname.replace(/\/$/, '');
      if (!u.hostname.endsWith(siteRoot) || !p.startsWith(base + '/') || LISTING.test(p) || p.split('/').length < base.split('/').length + 1) continue;
      const clean = u.origin + u.pathname;
      if (!out.includes(clean)) out.push(clean);
    }
    return out;
  } catch {
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function readFeed(context, url) {
  try {
    const r = await context.request.get(url, { timeout: 15000 });
    if (!r.ok()) return [];
    const xml = await r.text();
    if (!/<(rss|feed|channel)[\s>]/i.test(xml)) return [];
    const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    const tag = (b, t) => b.match(new RegExp(`<${t}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${t}>`, 'i'))?.[1]?.trim() || null;
    return blocks.map((b) => {
      const link = tag(b, 'link') || b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || null;
      const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
      const d = date ? new Date(date) : null;
      return {
        title: decode(tag(b, 'title') || ''),
        link,
        date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : null,
        categories: [...b.matchAll(/<category[^>]*?(?:term="([^"]+)"[^>]*\/?>|>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/category>)/gi)].map((m) => decode(m[1] || m[2] || '').trim()).filter(Boolean).slice(0, 8)
      };
    }).filter((i) => i.link);
  } catch {
    return [];
  }
}

async function readPost(context, url) {
  const page = await context.newPage();
  await page.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1200);
    const data = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
      const ld = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { try { ld.push(JSON.parse(s.textContent)); } catch {} }
      const flat = ld.flatMap((x) => (Array.isArray(x) ? x : x['@graph'] || [x]));
      const article = flat.find((x) => /Article|BlogPosting|NewsArticle|TechArticle/.test(String(x['@type'])));
      const body = document.querySelector('article') || document.querySelector('main') || document.body;
      const text = (body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      const links = [...body.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: clean(a.innerText).slice(0, 80) }));
      const author = article?.author ? [].concat(article.author).map((a) => a?.name || a).filter(Boolean).join(', ') : meta('meta[name="author"]');
      return {
        title: document.querySelector('h1')?.innerText?.trim() || document.title,
        published: article?.datePublished || meta('meta[property="article:published_time"]') || document.querySelector('time[datetime]')?.getAttribute('datetime') || null,
        modified: article?.dateModified || meta('meta[property="article:modified_time"]') || null,
        author: author ? String(author).slice(0, 80) : null,
        tags: [...document.querySelectorAll('meta[property="article:tag"], meta[property="article:section"]')].map((m) => m.content).concat(article?.keywords ? [].concat(article.keywords).join(',').split(',') : []).map((t) => t.trim()).filter(Boolean).slice(0, 10),
        h2: [...body.querySelectorAll('h2')].map((h) => clean(h.innerText)).filter(Boolean).slice(0, 15),
        words: text.split(/\s+/).filter(Boolean).length,
        ctas: [...body.querySelectorAll('a, button')].map((el) => clean(el.innerText)).filter((t) => t && t.length <= 60 && /(start|try|get started|sign ?up|book|demo|download|subscribe|join|request|free|trial|watch|register|get the|get your)/i.test(t)).filter((t, i, arr) => arr.indexOf(t) === i).slice(0, 10),
        forms: [...body.querySelectorAll('form')].map((f) => [...f.querySelectorAll('input, select, textarea')].filter((i) => i.type !== 'hidden' && i.type !== 'submit').map((i) => i.name || i.type)).filter((f) => f.length).slice(0, 4),
        links,
        text: text.slice(0, 40000),
        truncated: text.length > 40000
      };
    });
    await page.close();
    const host = new URL(url).hostname;
    const own = data.links.filter((l) => { try { return new URL(l.href).hostname.endsWith(host.replace(/^www\./, '')); } catch { return false; } });
    const contentLinks = new Set(own.map((l) => new URL(l.href).pathname).filter((p) => CONTENT_FOLDER.test(p) && p.split('/').filter(Boolean).length >= 2)).size;
    const productLinks = [...new Set(own.map((l) => new URL(l.href).pathname).filter((p) => /\/(pricing|plans|signup|sign-up|register|demo|trial|get-started|start|contact|products?|collections|shop|features|platform|download|app\b)/i.test(p) && !CONTENT_FOLDER.test(p)))].slice(0, 10);
    const pub = data.published ? new Date(data.published) : null;
    return {
      status: resp?.status() ?? null,
      title: data.title,
      published: pub && !isNaN(pub) ? pub.toISOString().slice(0, 10) : undefined,
      dateSource: pub && !isNaN(pub) ? 'page' : undefined,
      author: data.author,
      tags: data.tags,
      words: data.words,
      h2: data.h2,
      ctas: data.ctas,
      leadForms: data.forms,
      productLinks,
      internalLinks: own.length,
      contentLinks,
      text: data.text,
      truncated: data.truncated || undefined
    };
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
}

const norm = (u) => String(u).replace(/[?#].*$/, '').replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
const isOwn = (u, root) => { try { return new URL(u).hostname.endsWith(root); } catch { return false; } };
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#8217;/g, "'").replace(/&#8211;|&#8212;/g, '-').replace(/<[^>]+>/g, '');
