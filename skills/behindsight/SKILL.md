---
name: behindsight
description: Reverse-engineer a company's marketing strategy, business model and marketing tech stack from its public website, and deliver an evidence-labeled HTML report. Captures key pages, records every pixel and tag the site loads (with public account IDs and tracking events), runs Wappalyzer, reads the sitemap, checks the public ad libraries (Google Ads Transparency Center, Meta Ad Library, LinkedIn Ad Library) for the company's own ads and, with optional DataForSEO credentials, adds organic search data (top keywords, top pages, traffic by site section, search competitors), then labels each conclusion as seen, inferred or unknown. Use when someone asks to "tear down", "reverse-engineer", "analyze the marketing of" or "figure out the strategy behind" a company or domain, or asks what marketing stack, pixels or funnel a site uses.
---

# Behindsight

Turn one domain into a report that explains how the company makes money and how it markets, with every claim tied to evidence.

The scripts collect evidence the same way on every run. Your job is the reading: connecting signals into a business model and strategy, and being strict about what the evidence shows versus what you infer.

## Workflow

### 1. Check setup

From this skill's folder, check that `node_modules/playwright` and `vendor/wappalyzer` exist. If either is missing, tell the user that setup downloads Playwright's Chromium (about 100 MB) and clones HTTP Archive's Wappalyzer fork, and ask before running:

```sh
sh scripts/setup.sh
```

Search data is optional. It needs a [DataForSEO](https://dataforseo.com) account. If the user wants it, have them copy `.env.example` to `.env` in the skill folder and fill in `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`, or set both as environment variables. Never ask the user to paste credentials into the chat. Each run makes four DataForSEO Labs calls and is billed to their account. The collector prints the cost DataForSEO reports.

### 2. Collect

```sh
node scripts/collect.mjs <domain> [--out <dir>]
```

It takes 1 to 3 minutes. It prints the output folder, by default `./teardowns/<domain>-<date>/`. Useful flags:

- `--pages <url,url>` overrides page discovery when the defaults miss the pricing or signup page.
- `--max-pages <n>` changes how many pages are captured (default 7, including the homepage).
- `--no-consent` skips clicking the cookie banner, to see what fires before consent.
- `--no-wappalyzer` runs the network grab only, which is faster.
- `--no-ads` skips the ad libraries. `--ads-country <code>` picks the country they report on (default `US`).
- `--no-seo` skips DataForSEO even when credentials are set.
- `--seo-location <code>` and `--seo-language <code>` pick the Google market (default `2840` United States, `en`). Use the company's main market.

If the homepage fails to load (bot protection, a geo block), say so and stop. Don't write a report from guesses.

### 3. Read the evidence

Read in this order:

1. `summary.md`: the digest. Pages, CTAs, the merged stack, IDs, events, unidentified hosts, sitemap stats, ad library results and, when collected, search data.
2. `ads/*.jpg`: look at the ad samples and library screenshots. They show messaging the digest can't.
3. `content/*.md`: the sampled blog and article posts (the newest, plus the top search-traffic posts). Read the top-traffic posts and at least 5 recent ones in full, and skim the rest. For each, note its topic, format (how-to, listicle, comparison, case study, original research, news or announcement, thought leadership, product update, template or tool), funnel stage (awareness, consideration, decision, retention) and what it asks the reader to do.
4. `pages/*.md`: full page text. Always read the homepage and pricing pages in full. Skim the rest.
5. `collected.json`: when you need detail the digest drops (JSON-LD offers, form fields, every CTA).

Then read [references/inference-guide.md](references/inference-guide.md). Note what's missing as you read; step 4 is where you fill it. It maps common signals to conclusions and says how far each one can be pushed.

If page discovery missed something important (the pricing page is linked from a dropdown, or signup lives on a different domain), rerun with `--pages` before writing.

### 4. Investigate the gaps

The collector captures the same things on every site. Now use judgment: list what the evidence doesn't answer or gets wrong, then gather more with `scripts/investigate.mjs`. Everything it finds is saved in the evidence folder as an investigation (`inv-1`, `inv-2`, ...), which you cite with evidence type `investigation`.

| When you see | Run |
|---|---|
| Prices behind a toggle (monthly/yearly, plan tiers, seat counts, currency) | `node scripts/investigate.mjs page <dir> <pricing-url> --label "<what>" --click "<toggle text>"` (repeat `--click` for several toggles; use `--select "<dropdown label>=<option>"` for dropdowns) |
| An important page wasn't captured (enterprise, agency, returns, shipping, a key product, a comparison page) | `node scripts/investigate.mjs page <dir> <url> --label "<what>"` |
| Content that loads on scroll or after a delay (animated counters, lazy sections) | add `--scroll` or `--wait 5000` to `page` |
| An unrecognized host that loads on most pages | `node scripts/investigate.mjs host <dir> <host>`. It fetches the host's scripts, finds which script on the page calls it and samples what it sends; read the clues file it writes |
| Search competitors or keywords look wrong, or you need keywords for one section | `node scripts/investigate.mjs seo <dir> keywords --url-like "%/pricing%"` or `seo <dir> competitors --keywords "kw1, kw2, kw3"` |
| An ad library result looks wrong (the advertiser uses a different name, or another country matters) | `node scripts/investigate.mjs ads <dir> --platform google\|meta\|linkedin --name "<advertiser name>" [--country GB]` |

Rules:
- Each `page` run reports what changed after every click. "No visible change" means the click hit the wrong element: try different text, or drop it.
- "Not found" for a control you saw in a screenshot usually means the site is A/B testing and this visit got a variant without it (check the stack for Statsig, VWO, Optimizely and similar). Rerun the same command up to twice. If it appears, say in the claim that it shows in some variants only.
- The tool refuses clicks that could submit a form, buy, sign up or book. Don't work around that, and don't fill in forms.
- Spend effort where it changes a conclusion. Around 3 to 8 investigations is typical; stop when new runs stop adding evidence.
- `seo` runs cost a few cents each on the user's DataForSEO account.
- Look at the screenshot each `page` run saves in `investigations/`.

### 5. Write findings.json

Write `findings.json` in the output folder, following [references/report-schema.md](references/report-schema.md). The rules that matter most:

- **Seen** is only for facts visible in the collected evidence: text on a page, a request in the network log, a price in JSON-LD. Quote or point to it.
- **Inferred** is a conclusion from one or more facts. Say which facts, and give a confidence level.
- **Unknown** is a correct answer. Use it when the evidence doesn't cover a question the reader will ask (revenue, ad spend, churn). Never fill a gap with general knowledge about the company and label it seen.
- A pixel on a page proves the tag is installed. It does not prove active ad spend. Say "installed" or "set up for", and mark spend as inferred or unknown. The ad libraries are the evidence for running ads: cite them with type `ads`, and use them to describe what the ads say (offers, audiences, CTAs, formats).
- Keep `seen` claims free of interpretation. If a sentence states a fact and then what it means ("so", "which suggests", "aimed at"), split it into a seen claim and an inferred claim.
- Count, don't generalize. Say "on 6 of the 7 captured pages", never "on every page".
- Claims that something is absent are weak. The capture only loads pages: it never submits a form or signs up, so conversion events can't fire, and tags can vary by region and consent. Mark absence claims inferred with low confidence, or unknown.
- Check the billing period on pricing pages. Prices shown with "save X%" or a yearly toggle are often annual prices per month; JSON-LD `billingDuration` confirms it.
- An installed tool is not an active program. A survey or chat snippet loading doesn't mean surveys are running.
- An experimentation tool on the site means content can vary between visits. If pages differ between runs, say so instead of treating one version as the site.
- A claim that only restates a data point ("DataForSEO estimates about 361,000 monthly visits") is `seen`: the estimate is in the data. A conclusion drawn from such numbers is `inferred`.
- When a claim contains a number you calculated, show the calculation in the evidence `detail` ("6,173 blog + 1,224 help of 7,664 URLs"). The checker can match a computed number by coincidence, so the reviewer relies on the working.
- A tool found only during an investigation isn't in the stack table data; cite it with type `investigation` and the investigation ID.
- Search numbers are DataForSEO estimates. Use evidence type `seo`, call them estimates in the claim text, and mark conclusions built on them as inferred. Tie them to the content footprint: which sections earn the traffic compared with which sections have the most pages.
- Ad copy you read from a screenshot in `ads/` can't be checked by the script. Cite it with type `ads` and the image path as `ref` (for example `ads/google-3.jpg`), and quote it exactly; the reviewer checks it by eye.
- Finish with `section_summaries`: an "In short" of one or two sentences for every section in the report, written after the claims and condensing them (see the schema). They're what most readers will read first, so make each one say what the section means, not what it contains.
- Content strategy: when posts were collected, write a `content_strategy` section and label every sampled post in `content_posts` (see the schema). Answer what they publish, for whom, how often, how posts turn readers into leads or customers, and how what they publish compares with what earns search traffic. Base themes on several posts each, cite the posts with type `content`, and say how many posts were read. If the company publishes little, say that in one claim; don't pad.
- For e-commerce companies, the business model is products, price points, shipping, returns and financing rather than plans. Read a product page and a collection page instead of a pricing page, and look for review, loyalty, buy-now-pay-later and returns apps in the stack.
- Identify unrecognized third-party hosts you are confident about in `host_notes`. Leave the others alone.
- Only use outside knowledge (press, funding, the company's own blog posts) when you have a source URL. Use evidence type `external` and keep the claim inferred unless the source states it outright.

### 6. Check the citations

```sh
node scripts/verify.mjs <output-folder>
```

The script checks every citation against the collected evidence and writes the results to `verify.json` in the output folder: cited pages were captured, quoted text is on them, cited tools, IDs, events, keywords and sections exist, and numbers match the data. Fix every problem it reports by correcting the claim or its evidence, then run it again until it reports none. Warnings are for your judgment: a `[claim]` warning means a number in the claim text isn't in the data, which is fine for figures you computed (say how in the claim) but not for figures you remembered.

### 7. Independent fact-check

A second reviewer who didn't write the findings checks every claim for support, status labels, overreach and confidence. Its instructions are in [references/review-prompt.md](references/review-prompt.md).

- In Claude Code, start a fresh subagent with that file, the output folder and the skill folder. Tell it to write only `review.json`. Don't share your reasoning with it; it should judge the evidence on its own.
- Without subagents, do the review yourself in a separate pass, following the same file, after re-reading the evidence rather than your own notes.

Apply every fix it marks as overstated, mislabeled, unsupported or contradicted, or keep the claim and add evidence that answers the objection. Then rerun `verify.mjs`. The report's method section shows both checks.

### 8. Render and hand over

```sh
node scripts/render.mjs <output-folder>
```

The renderer validates `findings.json` and lists every problem if it fails. Fix them and rerun. It writes `report.html`, a single self-contained file. Open it for the user (`open` on macOS, `xdg-open` on Linux) and give them the path.

In your reply, give the two or three most interesting conclusions in plain sentences, plus anything that limited the run (failed pages, a consent wall, a missing sitemap).

## Scope

Behindsight reads public sources only: the company's website, the public ad libraries (Google, Meta, LinkedIn) and, with credentials, DataForSEO. Social accounts, job posts, review sites and the Pinterest, Reddit and TikTok ad libraries are not collected yet.

Only public pages are captured. Don't log in, submit forms, or start trials or checkouts.
