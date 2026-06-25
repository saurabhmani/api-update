# Premium News Feed Integration — Readiness Guide

This document describes how to onboard **optional premium integrations** for the News Intelligence engine. These feeds are **disabled by default** until their base URLs are set in the environment. No mock or stub providers ship with the platform.

## Status

| Source ID | Env gate | Adapter | Registered | Mock provider |
|-----------|----------|---------|------------|---------------|
| `corporate_filings` | `CORPORATE_FILINGS_API_URL` | `corporateFilingsAdapter` | Yes (`ingestAll`) | No |
| `deals_feed` | `DEALS_FEED_API_URL` | `dealsFeedAdapter` | Yes (`ingestAll`) | No |
| `social_signals` | `SOCIAL_SIGNALS_API_URL` | `socialSignalsAdapter` | Yes (`ingestAll`) | No |

Health tier: **`optional_integration`** — reported as *unavailable but optional* until configured; no ingestion warnings when URLs are empty.

---

## 1. Configuration hooks (already wired)

### Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CORPORATE_FILINGS_API_URL` | Yes (to enable) | Base URL for corporate filings / disclosures JSON API |
| `DEALS_FEED_API_URL` | Yes (to enable) | Base URL for M&A, fundraising, and major-deal feed |
| `SOCIAL_SIGNALS_API_URL` | Yes (to enable) | Base URL for curated social / newswire signal aggregation |
| `DEALS_FEED_API_KEY` | No | Bearer token sent as `Authorization: Bearer …` when set |
| `SOCIAL_SIGNALS_API_KEY` | No | Bearer token sent as `Authorization: Bearer …` when set |

> **TODO (provider-specific):** `CORPORATE_FILINGS_API_KEY` — add when the chosen filings vendor requires auth. See `corporateFilingsAdapter` in `officialExchangeAdapter.ts`.

### Code touchpoints

| Concern | Location |
|---------|----------|
| Adapter implementations | `src/lib/news-engine/ingestion/officialExchangeAdapter.ts` (`corporateFilingsAdapter`), `dealsFeedAdapter.ts`, `socialSignalsAdapter.ts` |
| Orchestrator registration | `src/lib/news-engine/ingestion/ingestAll.ts` → `ALL_ADAPTERS` |
| Config predicate | `src/lib/news-engine/health/newsSourceHealth.ts` → `isSourceConfigured()` |
| Health / UI reporting | `newsSourceHealth.ts`, `GET /api/news-engine?action=source-status`, `?action=summary` |
| Pipeline entry | `src/lib/news-engine/pipeline/runNewsPipeline.ts` |
| Scheduler (optional) | `src/lib/workers/newsIngestionScheduler.ts` |

---

## 2. Disabled when URLs are empty

Each adapter **short-circuits before any outbound HTTP call** when its URL env var is missing or blank:

```typescript
if (!filingsUrl) return [];   // corporate_filings
if (!DEALS_API_URL) return []; // deals_feed
if (!SOCIAL_API_URL) return []; // social_signals
```

`isSourceConfigured()` returns `false` for all three until the corresponding URL is set. The orchestrator still lists them in `ALL_ADAPTERS` but they contribute **zero items** and emit **no warnings**.

Verify locally:

```bash
npm run validate:premium-news
```

---

## 3. Onboarding requirements

### Operator checklist

1. **Select a vendor** for each feed class (filings, deals, social). Quantorus365 does not bundle vendor credentials.
2. **Obtain API base URL** (and API key if required by the vendor).
3. **Add to `.env.local`** (server-side only — never commit secrets):

   ```env
   # ── Premium news integrations (optional) ─────────────────────
   # See docs/PREMIUM_NEWS_FEEDS.md
   # CORPORATE_FILINGS_API_URL=https://your-vendor.example/v1/filings
   # DEALS_FEED_API_URL=https://your-vendor.example/v1/deals
   # DEALS_FEED_API_KEY=
   # SOCIAL_SIGNALS_API_URL=https://your-vendor.example/v1/signals
   # SOCIAL_SIGNALS_API_KEY=
   ```

4. **Restart** the Next.js process and/or news scheduler so env vars load.
5. **Confirm health**:

   ```bash
   npm run validate:news-health    # Tests 3.2–3.4 → unavailable/optional before enable
   curl -s 'http://localhost:3000/api/news-engine?action=source-status' | jq '.sources[] | select(.tier=="optional_integration")'
   ```

6. **Run pipeline** and confirm `sourceBreakdown` counts:

   ```bash
   npm run verify:news -- --run-pipeline --verbose
   ```

### Expected JSON response shapes

Adapters accept flexible field names. Map your vendor payload to one of these patterns:

#### Corporate filings (`corporate_filings`)

- **Request:** `GET {CORPORATE_FILINGS_API_URL}?q={query}&limit={n}`
- **Response:** `{ "filings": [...] }` or `{ "items": [...] }`
- **Item fields:** `id`, `title` or `subject`, `description` or `body`, `url` or `link`, `publishedAt` or `date`, optional `filingType`, `symbol`

#### Deals feed (`deals_feed`)

- **Request:** `GET {DEALS_FEED_API_URL}?q={query}&limit={n}` (+ optional `Authorization: Bearer`)
- **Response:** `{ "deals": [...] }` or `{ "items": [...] }`
- **Item fields:** `id`, `title` or `headline`, or structured `dealType`/`type`, `acquirer`/`buyer`, `target`/`company`, `description`, `url`, `announcedAt`/`publishedAt`/`date`, optional `symbol`, `value`

#### Social signals (`social_signals`)

- **Request:** `GET {SOCIAL_SIGNALS_API_URL}?q={query}&limit={n}` (+ optional `Authorization: Bearer`)
- **Response:** `{ "signals": [...] }`, `{ "posts": [...] }`, or `{ "items": [...] }`
- **Item fields:** `id`, `title` or `text` or `content`, `body` or `description`, `url`, `publishedAt` or `postedAt` or `date`, optional `platform`, `author`, `engagement`

If your vendor uses POST, custom headers, or a different query contract, extend the corresponding adapter — **do not add a mock layer**.

### Scoring note

`social_signals` uses source class **`social`** with lower default trust and higher manipulation scrutiny (`SOURCE_TRUST_CONFIG`, `newsPumpDetector`). Plan vendor curation accordingly.

---

## 4. Health reporting semantics

| State | When | Warning emitted? |
|-------|------|------------------|
| `unavailable` + `optional_integration` | URL not set | No |
| `active` | URL set and last run fetched items | No |
| `unavailable` | URL set but HTTP error or zero items | Yes |

Exchange announcements (`official_exchange`) are separate and use `BSE_ANNOUNCEMENTS_RSS` / `NSE_ANNOUNCEMENTS_RSS` — see exchange ingestion validation (`npm run validate:exchange-rss`).

---

## 5. TODO / future work

| Item | Location |
|------|----------|
| Corporate filings API key auth | `corporateFilingsAdapter` — `officialExchangeAdapter.ts` |
| Vendor-specific request signing / POST bodies | Per-adapter once vendor is chosen |
| Pagination for large deal/filing catalogs | `dealsFeedAdapter.ts`, `corporateFilingsAdapter` |
| Rate-limit telemetry in `q365_data_feed_health` | Pipeline / adapter layer |

---

## 6. Related commands

```bash
npm run validate:premium-news   # Hook + disabled-state readiness (no vendor calls)
npm run validate:news-health    # Health states for optional integrations
npm run validate:exchange-rss   # BSE/NSE official exchange feeds
npm run verify:news             # End-to-end DB pipeline check
```
