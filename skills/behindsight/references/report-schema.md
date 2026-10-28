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
    "retention": [ /* claims */ ]
  },
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
  - `seo`: DataForSEO search data. `ref` names the item (a keyword, a page URL, "organic overview"), `detail` gives the estimate.
  - `external`: a source outside the site. `ref` must be a URL.

## What each section answers

| Key | Questions to answer |
|---|---|
| `business_model` | What is sold, to whom, and how it's priced (per seat, usage, flat, one-time). Is there a free tier or trial? A rough price band. Self-serve, sales-led or both. |
| `positioning` | The headline promise. Which category they claim. Who the page speaks to. The differentiators they lead with. What proof they use (logos, numbers, reviews). Who they compare themselves to. |
| `acquisition` | Paid channels with tags installed. Organic and content investment from the sitemap. With search data: how big organic is, how much of it is branded, which sections and keywords earn it, and who they compete with in search. With ad library data: which platforms have live ads, how many, how recent, in which formats, and what they say. Partner, affiliate or review-site programs. Account-based or outbound signals (reverse-IP tools). |
| `funnel` | The primary and secondary CTAs and where they lead. Form tools and fields. Demo scheduling. Checkout. Interactive demos. Experimentation tools and which pages they run on. Conversion events that fire. |
| `retention` | Email and lifecycle tools. In-app messaging and chat. Product analytics. Community, docs, changelog and education content. |

Aim for 3 to 7 claims per section. Use `unknown` claims for important questions the evidence can't answer instead of leaving a section thin. The report presents data, so there is no separate open-questions or next-steps list.

`host_notes` identifies third-party hosts the collector didn't recognize. `confidence` (high, medium or low) is optional; use low when the identification is a guess from the URL alone.

For e-commerce companies, at-a-glance labels like Offer, Price range, Shipping and returns, Primary CTA, Live ads, Organic search and Stack maturity work better than SaaS labels.

## At a glance

4 to 8 items. Recommended labels: Offer, Customer, Pricing, Motion, Primary CTA, Paid channels, Content engine, Stack maturity. Keep values short (under 12 words).
