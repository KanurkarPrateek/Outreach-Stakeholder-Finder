# Outreach Stakeholder Finder

Sales/outreach prospecting in two forms — a **Next.js web app** and a **Python CLI**
([`outreach.py`](#python-cli-outreachpy)). Give a **company name** and it finds senior
stakeholders — **CEO, CFO, COO, CTO, CMO, President, Founder, VP, Director, Head** (plus any
custom title tags) — from **public search-engine results** and exports a **CSV** with name,
title, seniority, company, and LinkedIn URL. Both share the same search/classify/dedupe logic.

> **How it gets data (read this):** the app only reads *public search-engine results*. It does
> **not** log into LinkedIn or crawl profile pages, so it stays clear of LinkedIn's anti-scraping
> Terms of Service. Coverage depends on what search engines have publicly indexed — it's
> best-effort, not a guaranteed full org chart. Use responsibly and within applicable
> privacy/outreach laws (GDPR, CAN-SPAM, etc.).

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000
```

Type a company (use the full legal name for best results, e.g. `Stripe`, `Datadog`), click
**Find stakeholders**, then **Download CSV**.

## Python CLI (`outreach.py`)

A self-contained command-line twin of the app — **standard library only, no `pip install`**.
Same engine: free-tier-safe Serper queries, seniority classification, company-match filter,
dedupe, and CSV output.

```bash
# Key via flag…
python3 outreach.py "Datadog" --key YOUR_SERPER_KEY

# …or via env var
export SERPER_API_KEY=...
python3 outreach.py "Stripe"

# Add custom title tags to also search & label, and pick the output path
python3 outreach.py "Stripe" --tags "Head of Sales" "Chief Revenue Officer" -o stripe.csv
```

| Argument | Description |
|----------|-------------|
| `company` (positional) | Company name. Use the full legal name for best results. |
| `--key` | Serper.dev API key. Falls back to `SERPER_API_KEY` env var. |
| `--tags ...` | Extra title tags to search for and label (space-separated, quote multi-word tags). Up to 12. |
| `-o, --out` | Output CSV path. Defaults to `stakeholders-<company>.csv`. |

Without a key it falls back to keyless DuckDuckGo/Bing, which are usually bot-blocked and may
return nothing (it prints a warning). The query groups run in parallel via a thread pool.

Example output:

```
Provider: serper  |  Results: 12
  [CEO      ] Patrick Collison  —  Stripe CEO  —  https://www.linkedin.com/in/patrickcollison
  [President] John Collison  —  President at Stripe  —  https://www.linkedin.com/in/johnbcollison
  ...
Wrote 12 rows to stripe.csv
```

## Search providers

| Provider | Key needed? | Quality | Notes |
|----------|-------------|---------|-------|
| **DuckDuckGo HTML** (default) | No | OK | Keyless. Can rate-limit or return sparse results under heavy use. |
| **Serper.dev (Google)** | Yes (free tier) | Best | Auto-used if `SERPER_API_KEY` is set. Far higher hit-rate. |

To enable Google-quality results, supply a key one of two ways:

- **In the UI (easiest):** click **"+ Add Serper API key"** under the search box and paste your key.
  It's stored only in your browser's `localStorage` and sent solely to this app's own
  `/api/search` route.
- **Via env var (for deployments / shared default):**
  ```bash
  cp .env.example .env.local
  # set SERPER_API_KEY=... (free key from https://serper.dev), then restart
  npm run dev
  ```

A key entered in the UI takes precedence over the env var. The results header shows which
provider actually ran.

## How it works

1. `lib/serp.js` builds `site:linkedin.com/in/ "<Company>" (CEO OR CFO OR VP OR Director …)`
   queries (split into two seniority groups for wider coverage).
2. It fetches them server-side (Serper if a key is set, else DuckDuckGo) and parses the public
   result links/titles/snippets.
3. Keeps only `linkedin.com/in/` URLs, classifies seniority, loosely matches the company name to
   cut noise, and dedupes by profile slug.
4. `app/api/search/route.js` returns JSON; `app/page.js` renders the table and builds the CSV
   client-side.

## Files

```
app/page.js              UI: input, results table, CSV download
app/api/search/route.js  POST /api/search  -> { provider, count, results, errors }
lib/serp.js              query builder, providers, HTML parser, role filter, dedupe
```

## Limitations & next steps

- **No emails.** Search results don't expose them. To add emails later, enrich each profile
  through a provider (Hunter.io, Apollo.io, Snov.io) keyed off name + company domain.
- **Coverage** is bounded by public indexing. The Serper key noticeably improves it.
- For larger volumes, add caching and respect provider rate limits.
```
