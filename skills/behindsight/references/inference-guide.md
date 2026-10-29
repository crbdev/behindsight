# Inference guide

How far common signals can be pushed. Treat each row as a starting point. Several signals that agree beat one strong signal. When signals conflict, say so in the claim.

## Business model and motion

| Signal | Supports | Typical confidence |
|---|---|---|
| Public prices with "Start free trial" or "Sign up", plus Stripe, Paddle or Chargebee | Self-serve purchase | High |
| No public prices, only "Book a demo" or "Contact sales", plus Chili Piper or Calendly | Sales-led, usually mid-market or enterprise deals | High |
| Public prices on lower tiers and "Contact us" on the top tier | Hybrid: self-serve with sales for larger accounts | High |
| Free plan with usage limits | Product-led growth with an upgrade path | High |
| Per-seat pricing | Revenue grows with team size, so expansion matters | Medium |
| Usage-based pricing (events, credits, API calls) | Revenue grows with customer usage, so activation matters | Medium |
| Signup on an `app.` subdomain | Product-led onboarding | Medium |
| Product analytics (Amplitude, Mixpanel, Heap, PostHog) plus a CDP (Segment, RudderStack) | Mature product-led data setup | Medium |

Price bands: use only prices you saw. Don't estimate enterprise prices.

## Acquisition

| Signal | Supports | Caveat |
|---|---|---|
| Google Ads conversion or remarketing tag | Paid search or Google display is set up | Installed is not proof of spend. |
| Meta Pixel with PageView events | Meta retargeting audiences are being built | Installed is not proof of spend. |
| LinkedIn Insight Tag | B2B paid social or retargeting | Same as above. |
| Several ad pixels (3 or more platforms) | Paid acquisition is a real channel | Medium confidence even then. |
| Reverse-IP or intent tools (6sense, Demandbase, Clearbit, ZoomInfo, Koala, Warmly, Dealfront, RB2B) | Sales follows up on companies visiting the site | High that the tool is set up. Medium that it drives an outbound program. |
| G2 buyer-intent or Capterra tracking | Review sites are a paid or tracked channel | |
| Affiliate tools (PartnerStack, Rewardful, Impact, FirstPromoter) | Partner or affiliate program | Look for a /partners or /affiliates page. |
| Hundreds of `/vs/`, `/alternatives/` or `/compare/` URLs | Competitive SEO | |
| Hundreds of `/integrations/` or `/templates/` URLs | Programmatic SEO | |
| A large blog with recent lastmod dates | Content-led organic acquisition | Lastmod is unreliable; check the summary's warning. |
| Glossary or "what is" pages | Top-of-funnel SEO | |
| Many locale folders | International go-to-market | |
| Server-side or first-party tagging | A mature analytics or ads team, and an attempt to keep tracking working with ad blockers and cookie limits | |
| No ad pixels at all | Organic, community or brand-led acquisition | The tags may also wait for consent. Check the consent note. |

## Ad libraries

| Signal | Supports | Caveat |
|---|---|---|
| Active ads in a library | The channel is live right now | Google and Meta mark active ads. LinkedIn's library lists ads from the past year; its detail pages give run dates for some ads, so "ran through the capture date" is evidence of a live campaign for those ads only |
| Many ads first shown in recent months | Active testing or a new campaign push | Count creatives, not budget |
| Ads with "multiple versions" or many near-identical creatives | Systematic creative testing | |
| Video share of ads | Format investment | |
| Ad copy themes (offers, audiences, features) | The messages they pay to put in front of people, often sharper than the website's | Quote the ads; don't summarize a theme from one ad |
| `utm_campaign` names in LinkedIn ad links (`fall_switch_2026_tofu_emea`) | How the company names and segments its campaigns: theme, season, funnel stage, region | The name is the company's own label; describe it, don't over-read abbreviations |
| LinkedIn impressions and top countries | Rough reach and geographic focus of those ads | Shown for some ads only; ranges, not exact counts |
| Tag installed but no ads found in that platform's library | Retargeting audiences only, ads paused, or ads under another account name | Check the brand names searched; mark unknown rather than "not advertising" |
| Many other advertisers' ads point to the domain | Users link to the product in their own ads (booking links, storefronts), or resellers and affiliates promote it | These are not the company's ads. The collector lists them separately |

How an account is matched to the company: its name must match the brand (exactly, or starting with it as whole words, so "Linear Orbit, Inc." counts and "LinearB" doesn't) and it must be tied to the company by evidence: its ads link to the company's domain, or the company's site links to it (Facebook page, LinkedIn company page), or the platform verified it. Each result says why it matched. A status of `uncertain` means accounts named like the brand exist but none could be tied to the company; don't describe their ads as the company's. Name collisions are common for short brand names.

## Hiring

| Signal | Supports | Caveat |
|---|---|---|
| Several open marketing roles in one area (field, lifecycle, content, developer relations) | The company is building that function now | Open roles show growth, not team size |
| Sales roles by segment (startups, mid-market, enterprise) and region | Where the sales motion is aimed and expanding | Titles vary; read the post |
| Solutions engineers, implementation or customer success roles | A sales-assisted motion with onboarding for larger accounts | |
| Tools named in marketing and sales posts | The tools the team works with or plans to | A post can list a tool as "nice to have"; quote it |
| Reporting lines ("reports to the VP of Growth") | How marketing is organized | One post isn't the whole org chart |
| Many roles posted in the last 30 days | Hiring is active now | Boards drop filled roles, so old posts may be evergreen |
| No supported job board | Nothing about hiring | Many companies use Workday or their own careers pages; mark hiring unknown, not "not hiring" |

## Search data (when DataForSEO is enabled)

All of these are modeled estimates. Compare them within a report; don't quote them as the company's real traffic.

| Signal | Supports | Caveat |
|---|---|---|
| High branded share of top-keyword traffic (over 50%) | Demand comes from brand awareness more than from search discovery | Only measured across the top keywords returned |
| Blog, glossary or template sections earn most of the traffic | Content-led SEO is a working acquisition channel | |
| Traffic concentrated on a few pages | Fragile organic channel; a ranking change on those pages matters | |
| A section has many pages but little traffic | Content investment that isn't paying off in search, or content made for other reasons (support, sales) | Help centers often rank for long-tail queries that DataForSEO undercounts |
| Pages "not in sitemap" earn a real share of traffic | User-generated pages (profiles, booking pages, listings) rank, which is a product-led SEO loop | Check a few of the URLs before calling it a strategy |
| Organic competitors differ from the companies named on comparison pages | The search competitors are not the ones they position against | |
| Many new keywords and few lost ones | Growing organic footprint | |

## Other stack signals

| Signal | Supports | Caveat |
|---|---|---|
| GA4 or tag events named like `*_capi`, `fb_capi`, `open_ai_capi` | Conversions are also forwarded server-side (Conversions API) | The event name suggests it; the server side isn't visible |
| First-party subdomains serving `/g/collect`, `/gtm.js`, `/sst` or `/events` | Server-side or first-party tagging | |
| WordPress plugin list (from asset paths) | The site's CMS setup, including marketing plugins (forms, SEO, popups, translation) | Only plugins that load assets on the captured pages appear |
| Shopify apps (reviews, loyalty, BNPL, returns, SMS) | The e-commerce marketing stack | |

## Content

| Signal | Supports | Caveat |
|---|---|---|
| Most sampled posts are how-tos and listicles on broad topics | Top-of-funnel SEO content | Check whether they link to the product |
| Many comparison and "alternatives" posts | Bottom-of-funnel content aimed at buyers who are already comparing | |
| Posts end in a demo or trial CTA, or carry a gated download form | Content is built to generate leads | A sitewide footer CTA isn't the same as a post-specific one |
| Mostly announcements and press releases | The blog is a newsroom, not an acquisition channel | |
| Many authors, or authors outside marketing (founders, engineers, customers) | A content program with contributors | Author fields can be missing or generic |
| Regular publish dates in the feed | A steady cadence | Only the sample is counted; don't state total output |
| Top-traffic posts are off-topic for the product | Traffic that's unlikely to convert | Compare with what the recent posts cover: a shift in strategy shows up here |

## Funnel

| Signal | Supports |
|---|---|
| The CTA in the nav and the hero CTA | The primary conversion the company wants |
| Different CTAs on the pricing page vs the homepage | Different paths by segment |
| Experimentation tools (Optimizely, VWO, AB Tasty, Convert, Statsig, GrowthBook, LaunchDarkly) | An active testing program. Note which pages load the tool. |
| Personalization (Mutiny) | Content changes by visitor segment, often account-based |
| Session replay (Hotjar, Clarity, FullStory) | Conversion research on the marketing site |
| Interactive demos (Navattic, Storylane, Arcade) | A "see it before talking to sales" step |
| Form fields like company size, role and phone | Lead qualification before sales contact |
| HubSpot or Marketo forms | Leads go into marketing automation |
| GA4 or Meta events beyond PageView (`sign_up`, `generate_lead`, `Lead`, `ViewContent`) | The conversion events they optimize ads toward |

## Retention and lifecycle

| Signal | Supports |
|---|---|
| HubSpot, Marketo, Pardot or Eloqua | B2B lead nurturing. HubSpot leans SMB and mid-market. Marketo, Pardot and Eloqua lean mid-market and enterprise. |
| Customer.io, Braze or Iterable | Product-triggered lifecycle messaging |
| Klaviyo, Attentive or Postscript | Ecommerce email and SMS |
| Intercom, Drift or Qualified on marketing pages | Chat used for sales conversations |
| Zendesk or Help Scout on marketing pages | Chat used mainly for support |
| Large docs, changelog, community or academy sections | Education and community investment, which supports retention and expansion |
| A Pendo snippet | In-app onboarding guidance |

## Things you can't read from a website

Say these are unknown unless an external source states them:

- revenue, customer counts, growth rate
- ad spend and which campaigns are live
- churn and retention rates
- the CRM, when no form or script exposes it
- server-side automation, and what happens after a lead is captured
