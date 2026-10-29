# findings.json schema

`render.mjs` reads this file and refuses to render if a required field is missing or a status is invalid. Stack tables, the content footprint and the method section come from `collected.json` automatically, so don't repeat them here.

## Shape

```json
{
  "company": "Acme",
  "summary": "Two to four sentences: what they sell, to whom, how they make money and the core of their marketing motion.",
  "at_a_glance": [
    { "label": "Offer", "value": "Project management software for teams", "status": "seen" },
    { "label": "Motion", "value": "Self-serve trial with a sales assist for larger teams", "status": "inferred" }
  ],
  "sections": {
    "business_model": [ /* claims */ ],
    "positioning": [ /* claims */ ],
    "acquisition": [ /* claims */ ],
    "funnel": [ /* claims */ ],
    "retention": [ /* claims */ ],
    "content_strategy": [ /* claims; include when content/ has posts */ ]
  },
  "section_summaries": {
    "business_model": "One or two sentences: the gist of this section, written last, from its own claims.",
    "positioning": "...", "acquisition": "...", "funnel": "...", "retention": "...", "content_strategy": "...",
    "stack": "...", "ads": "...", "content_footprint": "...", "search": "..."
  },
  "content_posts": [
    { "url": "https://acme.com/blog/how-to-plan-a-sprint", "topic": "Project planning", "format": "how-to", "stage": "awareness", "cta": "free trial" }
  ],
  "host_notes": [
    { "host": "cdn.example-vendor.com", "vendor": "Example Vendor", "category": "Personalisation", "confidence": "high", "note": "Website personalization script loaded on every page" }
  ]
}
```

## Claims

```json
{
  "text": "One plain sentence. Lead with the conclusion.",
  "status": "seen | inferred | unknown",
  "confidence": "high | medium | low",
  "evidence": [
    { "type": "page", "ref": "https://acme.com/pricing", "detail": "Three plans: Free, Pro $12/seat/mo, Enterprise 'Contact us'" }
  ]
}
```

- `confidence` is required for `inferred` and ignored otherwise.
- `evidence` is required for `seen` and `inferred`. It's optional for `unknown`, where it can show what you looked at.
- Evidence `type` is one of:
  - `page`: page text, a CTA or JSON-LD. `ref` is the page URL.
  - `network`: a request the browser made. `ref` is the request URL or host.
  - `stack`: a detected technology. `ref` is the technology name and `detail` the ID, if any.
  - `sitemap`: a sitemap pattern or count. `ref` is a path or section name.
  - `event`: a tracking event name. `ref` is the event, `detail` the platform and page.
  - `ads`: ad library data. `ref` names the platform and item ("meta: 1304008991871792", "google ads", "linkedin ads"), `detail` quotes the ad text or gives the counts.
  - `investigation`: evidence gathered with `investigate.mjs`. `ref` is the investigation ID (`inv-2`), `detail` quotes its text or gives its numbers.
  - `content`: a sampled post. `ref` is the post URL (or "content sample" for the sample as a whole), `detail` quotes it or gives its numbers.
  - `jobs`: a job post or the job board as a whole. `ref` is the post URL (or "job board" for counts across all posts), `detail` quotes the post or gives the numbers.
  - `history`: a Wayback Machine snapshot. `ref` is the snapshot URL (`https://web.archive.org/web/20250101.../https://example.com/`), or "history" for the change list as a whole; `detail` quotes the archived copy.
  - `seo`: DataForSEO search data. `ref` names the item (a keyword, a page URL, "organic overview"), `detail` gives the estimate.
  - `external`: a source outside the site. `ref` must be a URL.

## What each section answers

| Key | Questions to answer |
|---|---|
| `business_model` | What is sold, to whom, and how it's priced (per seat, usage, flat, one-time). Is there a free tier or trial? A rough price band. Self-serve, sales-led or both. |
| `positioning` | The headline promise. Which category they claim. Who the page speaks to. The differentiators they lead with. What proof they use (logos, numbers, reviews). Who they compare themselves to. |
| `acquisition` | Paid channels with tags installed. Organic and content investment from the sitemap. With search data: how big organic is, how much of it is branded, which sections and keywords earn it, and who they compete with in search. With ad library data: which platforms have live ads, how many, how recent, in which formats, and what they say. With hiring data: which marketing and sales roles are open, what the posts say the team does, and where it's growing. Partner, affiliate or review-site programs. Account-based or outbound signals (reverse-IP tools). |
| `funnel` | The primary and secondary CTAs and where they lead. Form tools and fields. Demo scheduling. Checkout. Interactive demos. Experimentation tools and which pages they run on. Conversion events that fire. |
| `content_strategy` | The main topic clusters, with example posts. The mix of formats and funnel stages. Who the content is written for. How often they publish (real dates only). How posts hand readers to the product (CTAs, lead magnets, gated downloads, newsletter). What they publish compared with what earns search traffic. |
| `history` (optional, when archived copies were read) | The story of how the company's pitch and offer moved over the period, as 3 to 6 claims: the positioning eras (what they called themselves when, and the category or audience each era aimed at), pricing and packaging moves (new tiers, price changes, add-ons), shifts between self-serve and sales-led calls to action, and what the direction suggests about strategy. Lead with the arc: one claim per shift that matters, dated between the snapshots that show it. Changes are `seen` when two snapshots show them; what they mean is `inferred`. Shown at the top of the Changes over time section, above the timeline. |
| `retention` | Email and lifecycle tools. In-app messaging and chat. Product analytics. Community, docs, changelog and education content. Customer success and support hiring. |

Aim for 3 to 7 claims per section. Use `unknown` claims for important questions the evidence can't answer instead of leaving a section thin. The report presents data, so there is no separate open-questions or next-steps list.

`host_notes` identifies third-party hosts the collector didn't recognize. `confidence` (high, medium or low) is optional; use low when the identification is a guess from the URL alone.

For e-commerce companies, at-a-glance labels like Offer, Price range, Shipping and returns, Primary CTA, Live ads, Organic search and Stack maturity work better than SaaS labels.

## section_summaries

Every section opens with an "In short" summary, so readers get the gist before the detail. Write one for each claims section you include, and for each data section the report shows: `stack` (marketing stack), `ads` (advertising, when ad libraries were checked), `content_footprint` (sitemap), `search` (organic search, when collected), `jobs` (hiring, when a job board was found) and `history` (changes over time, when archived copies were read). The renderer refuses to build the report without them.

- One or two sentences, at most about 40 words. Lead with the conclusion a marketer would act on, not a list of facts.
- Condense the section's own claims. Don't introduce anything the section doesn't support, and keep the hedges: if the claims are inferred or low confidence, the summary says "likely" or "appears". For data sections, summarize what the data shows and what your claims elsewhere make of it.
- The citation check flags numbers in a summary that don't appear in that section.

Example for a content strategy section: "Gong's blog is a demo-generation engine built on its own call data, publishing weekly thought leadership for revenue leaders. Its search traffic still comes from older generic sales guides, not the new posts."

## content_posts

One entry per sampled post in `content/`. `format` is one of: how-to, listicle, comparison, case study, original research, news or announcement, thought leadership, product update, template or tool, other. `stage` is awareness, consideration, decision or retention. `cta` is the main thing the post asks the reader to do, in a few words ("free trial", "book a demo", "download the guide", "none"). The report tallies these and shows them per post.

## At a glance

4 to 8 items. Recommended labels: Offer, Customer, Pricing, Motion, Primary CTA, Paid channels, Content engine, Stack maturity. Keep values short (under 12 words).
