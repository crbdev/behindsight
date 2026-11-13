// Pure-function tests: no browser and no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { blockReason, extractEvents, reserveInvestigationId, updateCollected } from '../skills/behindsight/scripts/lib.mjs';
import { countRange, metaNoMatch } from '../skills/behindsight/scripts/ads.mjs';
import { isOwnDomain } from '../skills/behindsight/scripts/seo.mjs';
import { extractPrices } from '../skills/behindsight/scripts/history.mjs';
import { isListing, listingUrls, pickPublished, postLinksFirst } from '../skills/behindsight/scripts/content.mjs';
import { careersUrl } from '../skills/behindsight/scripts/jobs.mjs';

// ---------- tracking events ----------

test('an event name with a stray % is kept as written instead of throwing', () => {
  const events = extractEvents(new URL('https://www.google-analytics.com/g/collect?v=2'), 'en=50%_off_click&x=1');
  assert.deepEqual(events, [{ platform: 'GA4', name: '50%_off_click' }]);
});

test('an encoded event name is still decoded', () => {
  const events = extractEvents(new URL('https://www.google-analytics.com/g/collect?v=2'), 'en=sign%20up');
  assert.deepEqual(events, [{ platform: 'GA4', name: 'sign up' }]);
});

// ---------- blocked pages ----------

test('an HTTP error status counts as a blocked page', () => {
  assert.equal(blockReason({ status: 403, title: 'Acme', text: 'Welcome to Acme. '.repeat(200) }), 'HTTP 403');
  assert.equal(blockReason({ status: 503, title: '', text: '' }), 'HTTP 503');
});

test('a bot-challenge page served with status 200 counts as blocked', () => {
  assert.equal(blockReason({ status: 200, title: 'Just a moment...', text: 'Verifying you are human. This may take a few seconds.' }), 'bot-challenge page');
  assert.equal(blockReason({ status: 200, title: 'acme.com', text: 'Checking your browser before accessing acme.com.' }), 'bot-challenge page');
});

test('a normal page is not blocked, even when it talks about rate limits', () => {
  assert.equal(blockReason({ status: 200, title: 'Acme: widgets for teams', text: 'Widgets for teams. Start free.' }), null);
  assert.equal(blockReason({ status: 200, title: 'How we rate limit our API', text: 'A long engineering post about rate limits. '.repeat(100) }), null);
});

// ---------- investigation IDs ----------

test('investigations reserved at the same time get different IDs, after the highest saved one', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'behindsight-ids-'));
  const reserved = await Promise.all(Array.from({ length: 5 }, () => reserveInvestigationId(dir, [{ id: 'inv-1' }, { id: 'inv-7' }])));
  assert.deepEqual(reserved.map((r) => r.id).sort(), ['inv-10', 'inv-11', 'inv-12', 'inv-8', 'inv-9']);
});

test('a released ID that was never saved can be reserved again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'behindsight-ids-'));
  const first = await reserveInvestigationId(dir, []);
  await first.release();
  assert.equal((await reserveInvestigationId(dir, [])).id, 'inv-1');
});

test('updates to collected.json made at the same time are all kept', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'behindsight-lock-'));
  await writeFile(path.join(dir, 'collected.json'), JSON.stringify({ investigations: [] }));
  await Promise.all(Array.from({ length: 8 }, (_, i) => updateCollected(dir, (c) => { c.investigations.push({ id: `inv-${i + 1}` }); })));
  const saved = JSON.parse(await readFile(path.join(dir, 'collected.json'), 'utf8'));
  assert.equal(saved.investigations.length, 8);
});

// ---------- ad counts ----------

test('an ad count range with equal ends prints once', () => {
  assert.equal(countRange('38', '38'), '38');
  assert.equal(countRange('30', '40'), '30–40');
  assert.equal(countRange(null, '5'), '5');
  assert.equal(countRange(undefined, undefined), '');
});

test("a Meta search that answered with no matching page is 'not found'", () => {
  assert.equal(metaNoMatch({ answered: true, searched: ['acme'] }).status, 'not found');
});

test("a Meta search that never answered is an error, not 'not found'", () => {
  const result = metaNoMatch({ answered: false, searched: ['acme'] });
  assert.equal(result.status, 'error');
  assert.match(result.note, /can't say/);
});

// ---------- search competitors ----------

test('a competitor whose domain merely contains the brand is kept', () => {
  assert.equal(isOwnDomain('dropbox.com', 'box.com'), false);
  assert.equal(isOwnDomain('www.zoominfo.com', 'zoom.us'), false);
});

test("the company's own domains are recognized", () => {
  assert.equal(isOwnDomain('support.box.com', 'box.com'), true);
  assert.equal(isOwnDomain('www.box.com', 'box.com'), true);
  assert.equal(isOwnDomain('box.net', 'box.com'), true);
  assert.equal(isOwnDomain('calendly.co.uk', 'calendly.com'), true);
});

// ---------- prices in archived pages ----------

test('a company figure like "$21.5M" is not read as a price', () => {
  assert.deepEqual(extractPrices('Trusted by creators. We crossed $21.5M in annual revenue and $3 billion in payments.'), []);
});

test('plan prices are read, with one spelling per price', () => {
  assert.deepEqual(extractPrices('Essentials $ 5 /mo. Team $10 per month. Pro €12/user/month.'), ['$5/month', '$10/month', '€12/user/month']);
});

test('a price with a magnitude and a billing period is kept whole', () => {
  assert.deepEqual(extractPrices('Enterprise from $25k/year'), ['$25k/year']);
});

test('cents split into their own element are joined back', () => {
  assert.deepEqual(extractPrices('$19 99 /mo'), ['$19.99/month']);
});

// ---------- content sample ----------

test('a category page that is mostly links to posts is a listing, even with a date', () => {
  assert.equal(isListing({ words: 1228, contentLinks: 62, published: '2026-11-12' }), true);
  assert.equal(isListing({ words: 296, contentLinks: 39, published: '2026-11-09' }), true);
});

test('a long post that links to other posts is not a listing', () => {
  assert.equal(isListing({ words: 5104, contentLinks: 42, published: '2026-11-12' }), false);
  assert.equal(isListing({ words: 3693, contentLinks: 19 }), false);
});

test('a short undated page full of post links is a listing', () => {
  assert.equal(isListing({ words: 600, contentLinks: 14 }), true);
});

test('a page marked up as an article is never a listing', () => {
  assert.equal(isListing({ isArticle: true, words: 400, contentLinks: 30 }), false);
});

test('a page with few post links is not a listing', () => {
  assert.equal(isListing({ words: 200, contentLinks: 3 }), false);
});

test('the publish date comes from article markup first', () => {
  assert.equal(pickPublished({ ldDate: '2026-01-05T10:00:00Z', metaDate: '2025-01-01', firstTime: '2024-01-01', timeCount: 1 }), '2026-01-05T10:00:00Z');
  assert.equal(pickPublished({ metaDate: '2025-01-01', firstTime: '2024-01-01', timeCount: 1 }), '2025-01-01');
});

test('a lone <time> element is used as the publish date', () => {
  assert.equal(pickPublished({ firstTime: '2026-11-04', timeCount: 3 }), '2026-11-04');
});

test('a page with many <time> elements (one per listed post) has no publish date of its own', () => {
  assert.equal(pickPublished({ firstTime: '2026-11-12', timeCount: 24 }), null);
});

test('URLs from tag, category and author sitemaps are known listings; URLs from post sitemaps are not', () => {
  const from = (file, loc) => ({ loc, source: `https://acme.com/${file}` });
  const known = listingUrls([
    from('blog/sitemap-tags.xml', 'https://acme.com/blog/news/'),
    from('category-sitemap.xml', 'https://www.acme.com/blog/category/guides'),
    from('post_tag-sitemap.xml', 'https://acme.com/blog/tag/widgets/'),
    from('author-sitemap.xml', 'https://acme.com/blog/author/sam/'),
    from('wp-sitemap-taxonomies-category-1.xml', 'https://acme.com/blog/tips/'),
    from('wp-sitemap-users-1.xml', 'https://acme.com/blog/people/sam/'),
    from('blog/sitemap-posts.xml', 'https://acme.com/blog/how-we-build-widgets/'),
    from('post-sitemap.xml', 'https://acme.com/blog/widget-pricing-guide/'),
    from('wp-sitemap-posts-post-1.xml', 'https://acme.com/blog/tagging-your-widgets/'),
    { loc: 'https://acme.com/blog/no-source-recorded/' }
  ]);
  assert.deepEqual([...known].sort(), ['acme.com/blog/author/sam', 'acme.com/blog/category/guides', 'acme.com/blog/news', 'acme.com/blog/people/sam', 'acme.com/blog/tag/widgets', 'acme.com/blog/tips']);
});

test('on a blog index, links that carry a heading (post cards) come before plain links (menus)', () => {
  const links = [{ url: '/blog/news/', card: false }, { url: '/blog/post-a/', card: true }, { url: '/blog/guides/', card: false }, { url: '/blog/post-b/', card: true }];
  assert.deepEqual(postLinksFirst(links), ['/blog/post-a/', '/blog/post-b/', '/blog/news/', '/blog/guides/']);
});

// ---------- careers page ----------

test('a malformed sitemap URL does not stop the careers page search', () => {
  const sitemapUrls = [{ loc: '/relative/page' }, { loc: 'not a url' }, { loc: 'https://acme.com/careers' }];
  assert.equal(careersUrl({ links: [], sitemapUrls, siteRoot: 'acme.com' }), 'https://acme.com/careers');
});

test('a malformed homepage link does not stop the careers page search', () => {
  const links = [{ href: 'mailto:', text: 'Careers' }, { href: 'https://acme.com/jobs', text: 'Jobs' }];
  assert.equal(careersUrl({ links, sitemapUrls: [], siteRoot: 'acme.com' }), 'https://acme.com/jobs');
});
