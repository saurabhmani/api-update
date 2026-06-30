# Public Signals API

**Endpoint:** `GET /api/public/v1/signals`  
**Version:** v1  
**Auth:** None required (optional Bearer API key for higher rate limits)

---

## Overview

Read-only public REST API returning approved trading signals joined with resolved outcomes from `q365_signals` and `q365_signal_outcomes`. Unpublished or internal signals are excluded. No user-identifying fields are returned.

---

## Authentication

| Mode | Header | Rate limit |
|------|--------|------------|
| Anonymous | *(none)* | 30 requests / minute / IP |
| API key (optional) | `Authorization: Bearer q365_<hex>` | 120 req/min (pro) or 300 req/min (enterprise) |

Invalid API keys return `401`. Rate limit exceeded returns `429`.

---

## Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number (1-based) |
| `limit` | integer | `50` | Page size (max `100`) |
| `strategy` | string | — | Filter by `strategy_id` / `signal_type` |
| `symbol` | string | — | NSE symbol (uppercased) |
| `outcome` | string | — | `T1_HIT`, `SL_HIT`, `EXPIRED`, `ACTIVE`, `WIN`, `LOSS`, … |
| `from_date` | `YYYY-MM-DD` | — | `created_at` lower bound (inclusive) |
| `to_date` | `YYYY-MM-DD` | — | `created_at` upper bound (inclusive) |
| `sort` | string | `created_at:desc` | `created_at` or `confidence_score`, optional `:asc`/`:desc` |

---

## Response

**Success (200)** — wrapped by `withApiHandler`:

```json
{
  "success": true,
  "requestId": "abc-1",
  "version": "v1",
  "data": [
    {
      "id": 1,
      "symbol": "RELIANCE",
      "strategy_id": "fibonacci_pullback",
      "direction": "BUY",
      "entry_price": 2500,
      "stop_loss": 2400,
      "target_1": 2700,
      "target_2": 2800,
      "target_3": 2900,
      "confidence_score": 72,
      "created_at": "2026-06-01T10:00:00.000Z",
      "outcome": "T1_HIT",
      "outcome_at": "2026-06-10T10:00:00.000Z",
      "days_held": 7,
      "max_gain_pct": 8.5
    }
  ],
  "page": 1,
  "total": 42,
  "summary": {
    "win_rate": 62.5,
    "total_signals": 42,
    "active_signals": 8,
    "signals_this_month": 12,
    "best_strategy": "fibonacci_pullback",
    "average_confidence": 71.2
  },
  "win_rate": 62.5,
  "cached": false
}
```

### Summary metrics

| Field | SQL basis |
|-------|-----------|
| `win_rate` | Wins (`T1_HIT`, `WIN`) / resolved (`T1_HIT`, `SL_HIT`, `WIN`, `LOSS`) × 100 |
| `total_signals` | Count of published signals matching filters |
| `active_signals` | `outcome = 'ACTIVE'` or no outcome row |
| `signals_this_month` | `created_at` in current calendar month |
| `best_strategy` | Highest win-rate strategy (min 5 samples) |
| `average_confidence` | `AVG(confidence_score)` |

---

## Errors

| Status | Code | When |
|--------|------|------|
| 200 | — | Success (empty `data` allowed) |
| 400 | `VALIDATION_ERROR` | Invalid dates, outcome, or params |
| 401 | `AUTHENTICATION_ERROR` | Malformed or invalid API key |
| 404 | `NOT_FOUND` | Page beyond available results |
| 429 | `RATE_LIMIT` | Rate limit exceeded |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Caching

- **Application cache:** Redis key `public:signals:page:…:filters:…`, TTL **300 seconds**
- **HTTP header:** `Cache-Control: public, max-age=300`
- Cached requests skip database queries; target response time **< 1 second**

---

## Security

- Only `signal_status = 'APPROVED_SIGNAL'` with approved classifications
- Excludes invalidated / watchlist-only / developing setups
- Never returns: `user_id`, `batch_id`, `requested_by`, session fields

---

## Examples

```bash
# Anonymous — first page
curl "https://your-host/api/public/v1/signals?page=1&limit=10"

# Filter by symbol and outcome
curl "https://your-host/api/public/v1/signals?symbol=RELIANCE&outcome=ACTIVE"

# Date range + strategy
curl "https://your-host/api/public/v1/signals?strategy=fibonacci_pullback&from_date=2026-01-01&to_date=2026-06-30"

# Optional API key (higher limits)
curl -H "Authorization: Bearer q365_..." "https://your-host/api/public/v1/signals"
```

---

## Verification

```bash
npm run verify:public-signals-api
npx vitest run src/__tests__/publicSignalsApi.vitest.ts
```

Implementation: `src/lib/signals/public/`, route: `src/app/api/public/v1/signals/route.ts`
