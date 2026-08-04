# API security inventory

Generated from 332 route handlers and 336 exported HTTP methods. Classification is based on server-side handler code; browser proxy cookie presence is not counted as authorization. Heuristic Unknown entries require owner review.

## Summary

| Classification | Methods |
|---|---:|
| Public | 1 |
| Authenticated user | 212 |
| Role or permission protected | 0 |
| Admin-only | 61 |
| Internal worker | 0 |
| Internal service | 0 |
| Operational monitoring | 1 |
| Development or debug | 7 |
| Deprecated | 13 |
| Disabled | 4 |
| Unknown | 37 |

| Risk | Methods |
|---|---:|
| Critical | 0 |
| High | 19 |
| Medium | 26 |
| Low | 291 |

### Public mutation endpoints (2)

- `POST /api/backtests/seed-data` — None detected; Low
- `POST /api/signals/force-seed` — None detected; Low
### Public expensive-computation endpoints (13)

- `GET /api/backtests/[id]/analytics` — None detected; High
- `GET /api/backtests/[id]/audit` — None detected; High
- `GET /api/backtests/[id]/calibration` — None detected; High
- `GET /api/backtests/[id]/dexter` — None detected; High
- `GET /api/backtests/[id]/performance` — None detected; High
- `GET /api/backtests/[id]/signals` — None detected; High
- `GET /api/backtests/[id]/trades` — None detected; High
- `GET /api/backtests/seed-data` — None detected; Low
- `POST /api/backtests/seed-data` — None detected; Low
- `GET /api/debug/provider-report` — None detected; High
- `GET /api/manipulation-engine/backtest-impact` — None detected; High
- `GET /api/scanner/custom-universe/status` — None detected; High
- `GET /api/signal-engine/insights` — None detected; High
### Public debug endpoints (7)

- `GET /api/debug/env-check` — None detected; High
- `GET /api/debug/provider-report` — None detected; High
- `GET /api/debug/quota` — None detected; High
- `GET /api/debug/signal-maturity-status` — None detected; High
- `GET /api/debug/signal-validation` — None detected; High
- `GET /api/debug/system-health` — None detected; High
- `GET /api/manipulation-engine/backtest-impact` — None detected; High
### Public detailed health endpoints (10)

- `GET /api/debug/signal-maturity-status` — None detected; High
- `GET /api/debug/system-health` — None detected; High
- `GET /api/engine-health/status` — None detected; High
- `GET /api/health` — None detected; Low
- `GET /api/market-data/dual-source/status` — None detected; Medium
- `GET /api/market-data/health` — None detected; Low
- `GET /api/market-data/live-feed-status` — None detected; Medium
- `GET /api/market-status` — None detected; Low
- `GET /api/scanner/custom-universe/status` — None detected; High
- `GET /api/system/institutional-health` — None detected; High
### Public metrics endpoints (1)

- `GET /api/metrics` — None detected; High
### Queue-processing endpoints (2)

- `POST /api/backtests/process-queue` — requireAdmin; Low
- `GET /api/backtests/process-queue` — requireAdmin; Low
### Scheduler-trigger endpoints (2)

- `GET /api/admin/cron` — requireAdmin; Low
- `GET /api/strategies/operations/scheduler` — requireSession; Low
### Backtest execution endpoints (9)

- `POST /api/backtest` — requireSession; Low
- `POST /api/backtests/[id]/cancel` — requireSession; Low
- `DELETE /api/backtests/[id]` — requireSession; Low
- `POST /api/backtests/process-queue` — requireAdmin; Low
- `POST /api/backtests` — requireSession; Low
- `POST /api/backtests/seed-data` — None detected; Low
- `POST /api/strategies/lab/[id]/backtest/confirm` — requireSession; Low
- `POST /api/strategies/lab/[id]/backtest` — requireSession; Low
- `POST /api/strategy-builder/backtest` — requireSession; Low
### Manipulation scan endpoints (3)

- `GET /api/manipulation-engine/scan` — requireAdmin; Low
- `POST /api/manipulation-engine/scan` — requireAdmin; Low
- `POST /api/manipulation/daily-scan` — requireSession; Low
### Market-data maintenance endpoints (1)

- `GET /api/market-data/reseed` — None detected; Low

## Method inventory

| Method | Route | Handler path | Current protection | Intended classification | Risk | Required action |
|---|---|---|---|---|---|---|
| GET | `/api/admin/alert-rules` | `src/app/api/admin/alert-rules/route.ts` | requireAdmin | Admin-only | Low | None |
| PUT | `/api/admin/alert-rules` | `src/app/api/admin/alert-rules/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/admin/cleanup-confirmed` | `src/app/api/admin/cleanup-confirmed/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/admin/cron` | `src/app/api/admin/cron/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/admin/dashboard` | `src/app/api/admin/dashboard/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/admin/performance` | `src/app/api/admin/performance/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/admin/recompute` | `src/app/api/admin/recompute/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/admin/rescore` | `src/app/api/admin/rescore/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/admin` | `src/app/api/admin/route.ts` | requireAdmin | Admin-only | Low | None |
| PUT | `/api/admin` | `src/app/api/admin/route.ts` | requireAdmin | Admin-only | Low | None |
| DELETE | `/api/admin` | `src/app/api/admin/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/admin` | `src/app/api/admin/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/admin/signal-rules` | `src/app/api/admin/signal-rules/route.ts` | requireAdmin | Admin-only | Low | None |
| PUT | `/api/admin/signal-rules` | `src/app/api/admin/signal-rules/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/admin/signals` | `src/app/api/admin/signals/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/admin/system-health` | `src/app/api/admin/system-health/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/alerts` | `src/app/api/alerts/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/alerts` | `src/app/api/alerts/route.ts` | requireSession | Authenticated user | Low | None |
| PATCH | `/api/alerts` | `src/app/api/alerts/route.ts` | requireSession | Authenticated user | Low | None |
| DELETE | `/api/alerts` | `src/app/api/alerts/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/analytics` | `src/app/api/analytics/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/audit` | `src/app/api/audit/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/audit` | `src/app/api/audit/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/auth/mfa` | `src/app/api/auth/mfa/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/auth/mfa` | `src/app/api/auth/mfa/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/auth/post-login-destination` | `src/app/api/auth/post-login-destination/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/auth` | `src/app/api/auth/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/auth` | `src/app/api/auth/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/backtest/[id]/export` | `src/app/api/backtest/[id]/export/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtest/[id]` | `src/app/api/backtest/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtest/compare` | `src/app/api/backtest/compare/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/backtest` | `src/app/api/backtest/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtest` | `src/app/api/backtest/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtests/[id]/analytics` | `src/app/api/backtests/[id]/analytics/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/backtests/[id]/audit` | `src/app/api/backtests/[id]/audit/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/backtests/[id]/calibration` | `src/app/api/backtests/[id]/calibration/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| POST | `/api/backtests/[id]/cancel` | `src/app/api/backtests/[id]/cancel/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtests/[id]/dexter` | `src/app/api/backtests/[id]/dexter/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/backtests/[id]/export` | `src/app/api/backtests/[id]/export/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtests/[id]/performance` | `src/app/api/backtests/[id]/performance/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/backtests/[id]` | `src/app/api/backtests/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| DELETE | `/api/backtests/[id]` | `src/app/api/backtests/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtests/[id]/signals` | `src/app/api/backtests/[id]/signals/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/backtests/[id]/trades` | `src/app/api/backtests/[id]/trades/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/backtests/compare` | `src/app/api/backtests/compare/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/backtests/process-queue` | `src/app/api/backtests/process-queue/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/backtests/process-queue` | `src/app/api/backtests/process-queue/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/backtests` | `src/app/api/backtests/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtests` | `src/app/api/backtests/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/backtests/seed-data` | `src/app/api/backtests/seed-data/route.ts` | None detected | Deprecated | Low | None |
| POST | `/api/backtests/seed-data` | `src/app/api/backtests/seed-data/route.ts` | None detected | Deprecated | Low | None |
| POST | `/api/billing/admin/override` | `src/app/api/billing/admin/override/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/billing/invoices/[id]` | `src/app/api/billing/invoices/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/billing/invoices` | `src/app/api/billing/invoices/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/billing/plans` | `src/app/api/billing/plans/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| POST | `/api/billing/subscribe` | `src/app/api/billing/subscribe/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/billing/subscription` | `src/app/api/billing/subscription/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/billing/upgrade` | `src/app/api/billing/upgrade/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/billing/usage/analytics` | `src/app/api/billing/usage/analytics/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/billing/usage` | `src/app/api/billing/usage/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/billing/wallet/recharge` | `src/app/api/billing/wallet/recharge/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/billing/wallet` | `src/app/api/billing/wallet/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/bootstrap-nse` | `src/app/api/bootstrap-nse/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/bootstrap-nse` | `src/app/api/bootstrap-nse/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/auth/connect` | `src/app/api/broker/auth/connect/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/auth/connect` | `src/app/api/broker/auth/connect/route.ts` | requireSession | Authenticated user | Low | None |
| PUT | `/api/broker/auth/connect` | `src/app/api/broker/auth/connect/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/connect` | `src/app/api/broker/connect/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/connect` | `src/app/api/broker/connect/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/disclaimer` | `src/app/api/broker/disclaimer/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/disconnect` | `src/app/api/broker/disconnect/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/health` | `src/app/api/broker/health/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/kill-switch` | `src/app/api/broker/kill-switch/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/kill-switch` | `src/app/api/broker/kill-switch/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/live/readiness` | `src/app/api/broker/live/readiness/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/live/readiness` | `src/app/api/broker/live/readiness/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/order` | `src/app/api/broker/order/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/orders` | `src/app/api/broker/orders/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/broker/positions` | `src/app/api/broker/positions/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/sync/orders` | `src/app/api/broker/sync/orders/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/broker/sync/positions` | `src/app/api/broker/sync/positions/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/brokers/[broker]/disconnect` | `src/app/api/brokers/[broker]/disconnect/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/brokers/active` | `src/app/api/brokers/active/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/brokers/shoonya/callback` | `src/app/api/brokers/shoonya/callback/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/brokers/shoonya/connect` | `src/app/api/brokers/shoonya/connect/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/brokers/status` | `src/app/api/brokers/status/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/brokers/zerodha/connect` | `src/app/api/brokers/zerodha/connect/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/chart-data` | `src/app/api/chart-data/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/charts` | `src/app/api/charts/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/contact` | `src/app/api/contact/route.ts` | Route-specific internal authorization | Deprecated | Low | None |
| GET | `/api/data-feed/health` | `src/app/api/data-feed/health/route.ts` | Equivalent session validation | Deprecated | Low | None |
| GET | `/api/debug/env-check` | `src/app/api/debug/env-check/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/debug/provider-report` | `src/app/api/debug/provider-report/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/debug/quota` | `src/app/api/debug/quota/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/debug/signal-maturity-status` | `src/app/api/debug/signal-maturity-status/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/debug/signal-validation` | `src/app/api/debug/signal-validation/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/debug/system-health` | `src/app/api/debug/system-health/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/engine-health/status` | `src/app/api/engine-health/status/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/events` | `src/app/api/events/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/explanations` | `src/app/api/explanations/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/health` | `src/app/api/health/route.ts` | None detected | Deprecated | Low | None |
| GET | `/api/instruments` | `src/app/api/instruments/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/intelligence` | `src/app/api/intelligence/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/kite/auth/callback` | `src/app/api/kite/auth/callback/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/kite/auth/complete` | `src/app/api/kite/auth/complete/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/kite/auth/start` | `src/app/api/kite/auth/start/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/kite/profile` | `src/app/api/kite/profile/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/kite/session` | `src/app/api/kite/session/route.ts` | requireSession | Disabled | Low | None |
| DELETE | `/api/kite/session` | `src/app/api/kite/session/route.ts` | requireSession | Disabled | Low | None |
| POST | `/api/live-trading/deploy` | `src/app/api/live-trading/deploy/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/live-trading/order` | `src/app/api/live-trading/order/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/live-trading/positions` | `src/app/api/live-trading/positions/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/manipulation-engine/analytics` | `src/app/api/manipulation-engine/analytics/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/backtest-impact` | `src/app/api/manipulation-engine/backtest-impact/route.ts` | None detected | Development or debug | High | Review intended exposure; protect or minimize detail |
| GET | `/api/manipulation-engine/clusters` | `src/app/api/manipulation-engine/clusters/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/dashboard` | `src/app/api/manipulation-engine/dashboard/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/detectors` | `src/app/api/manipulation-engine/detectors/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/events` | `src/app/api/manipulation-engine/events/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/penalties` | `src/app/api/manipulation-engine/penalties/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine` | `src/app/api/manipulation-engine/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/scan` | `src/app/api/manipulation-engine/scan/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/manipulation-engine/scan` | `src/app/api/manipulation-engine/scan/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/manipulation-engine/symbol-history` | `src/app/api/manipulation-engine/symbol-history/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/trend` | `src/app/api/manipulation-engine/trend/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/manipulation-engine/watchlists` | `src/app/api/manipulation-engine/watchlists/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/manipulation-engine/watchlists` | `src/app/api/manipulation-engine/watchlists/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/manipulation/[symbol]` | `src/app/api/manipulation/[symbol]/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| POST | `/api/manipulation/daily-scan` | `src/app/api/manipulation/daily-scan/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/manipulation/eod-ingest` | `src/app/api/manipulation/eod-ingest/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/manipulation` | `src/app/api/manipulation/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/manipulation` | `src/app/api/manipulation/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| PATCH | `/api/manipulation` | `src/app/api/manipulation/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/manipulation/run` | `src/app/api/manipulation/run/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/market-data/bot` | `src/app/api/market-data/bot/route.ts` | None detected | Deprecated | Low | None |
| GET | `/api/market-data/dual-source/status` | `src/app/api/market-data/dual-source/status/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/market-data/health` | `src/app/api/market-data/health/route.ts` | None detected | Deprecated | Low | None |
| GET | `/api/market-data/live-feed-status` | `src/app/api/market-data/live-feed-status/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/market-data/reseed` | `src/app/api/market-data/reseed/route.ts` | None detected | Deprecated | Low | None |
| GET | `/api/market-data` | `src/app/api/market-data/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/market-data` | `src/app/api/market-data/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/market-data/subscribe` | `src/app/api/market-data/subscribe/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/market-data/usage` | `src/app/api/market-data/usage/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/market-data/validate` | `src/app/api/market-data/validate/route.ts` | None detected | Deprecated | Low | None |
| GET | `/api/market-intelligence` | `src/app/api/market-intelligence/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/market-regime` | `src/app/api/market-regime/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/market-status` | `src/app/api/market-status/route.ts` | None detected | Public | Low | None |
| GET | `/api/market/historical` | `src/app/api/market/historical/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/market/movers` | `src/app/api/market/movers/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/market/quote` | `src/app/api/market/quote/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/market` | `src/app/api/market/route.ts` | requireSession | Deprecated | Low | None |
| GET | `/api/market/snapshot-db` | `src/app/api/market/snapshot-db/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/market/stream` | `src/app/api/market/stream/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/market/v2/quote` | `src/app/api/market/v2/quote/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/metrics` | `src/app/api/metrics/route.ts` | None detected | Operational monitoring | High | Review intended exposure; protect or minimize detail |
| GET | `/api/news-engine` | `src/app/api/news-engine/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/news-engine` | `src/app/api/news-engine/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/news/categories` | `src/app/api/news/categories/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/news` | `src/app/api/news/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/news` | `src/app/api/news/route.ts` | requireAdmin | Admin-only | Low | None |
| PATCH | `/api/news` | `src/app/api/news/route.ts` | requireAdmin | Admin-only | Low | None |
| DELETE | `/api/news` | `src/app/api/news/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/notifications` | `src/app/api/notifications/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/notifications` | `src/app/api/notifications/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/openapi` | `src/app/api/openapi/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/operations/alerts` | `src/app/api/operations/alerts/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/operations/dashboard` | `src/app/api/operations/dashboard/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/operations/health` | `src/app/api/operations/health/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/operations/release` | `src/app/api/operations/release/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/options/intelligence` | `src/app/api/options/intelligence/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/options` | `src/app/api/options/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/paper-trading/account` | `src/app/api/paper-trading/account/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper-trading/account` | `src/app/api/paper-trading/account/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/paper-trading/kill-switch` | `src/app/api/paper-trading/kill-switch/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper-trading/kill-switch` | `src/app/api/paper-trading/kill-switch/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper-trading/mtm` | `src/app/api/paper-trading/mtm/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/paper-trading/orders` | `src/app/api/paper-trading/orders/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper-trading/orders` | `src/app/api/paper-trading/orders/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper-trading/positions/[id]/close` | `src/app/api/paper-trading/positions/[id]/close/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/paper-trading/positions` | `src/app/api/paper-trading/positions/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper/deploy` | `src/app/api/paper/deploy/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/paper/order` | `src/app/api/paper/order/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/paper/orders` | `src/app/api/paper/orders/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/paper/positions` | `src/app/api/paper/positions/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/performance` | `src/app/api/performance/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/pipeline/portfolio` | `src/app/api/pipeline/portfolio/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/pipeline/stats` | `src/app/api/pipeline/stats/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/portfolio` | `src/app/api/portfolio/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/portfolio` | `src/app/api/portfolio/route.ts` | requireSession | Authenticated user | Low | None |
| PATCH | `/api/portfolio` | `src/app/api/portfolio/route.ts` | requireSession | Authenticated user | Low | None |
| DELETE | `/api/portfolio` | `src/app/api/portfolio/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/price` | `src/app/api/price/route.ts` | None detected | Deprecated | Low | None |
| GET | `/api/rankings/opportunities` | `src/app/api/rankings/opportunities/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/reliability/alerts` | `src/app/api/reliability/alerts/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/reliability/alerts` | `src/app/api/reliability/alerts/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/reliability/audit` | `src/app/api/reliability/audit/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/reliability/audit` | `src/app/api/reliability/audit/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/reliability/health` | `src/app/api/reliability/health/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/reliability/status` | `src/app/api/reliability/status/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/reports` | `src/app/api/reports/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/reports` | `src/app/api/reports/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/risk/settings` | `src/app/api/risk/settings/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/risk/settings` | `src/app/api/risk/settings/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/run-signal-engine` | `src/app/api/run-signal-engine/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/run-signal-engine` | `src/app/api/run-signal-engine/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/scanner/custom-universe/run` | `src/app/api/scanner/custom-universe/run/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/scanner/custom-universe/status` | `src/app/api/scanner/custom-universe/status/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/security/audit` | `src/app/api/security/audit/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/security/compliance` | `src/app/api/security/compliance/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/security/compliance` | `src/app/api/security/compliance/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/security/events` | `src/app/api/security/events/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/security/mfa` | `src/app/api/security/mfa/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| POST | `/api/security/mfa` | `src/app/api/security/mfa/route.ts` | Equivalent session validation | Authenticated user | Low | None |
| GET | `/api/security/rbac` | `src/app/api/security/rbac/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/security/sessions` | `src/app/api/security/sessions/route.ts` | requireSession | Authenticated user | Low | None |
| DELETE | `/api/security/sessions` | `src/app/api/security/sessions/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/security/status` | `src/app/api/security/status/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signal-engine/calibration` | `src/app/api/signal-engine/calibration/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/signal-engine/calibration` | `src/app/api/signal-engine/calibration/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signal-engine/debug/conflicts` | `src/app/api/signal-engine/debug/conflicts/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/signal-engine/feedback/evaluate` | `src/app/api/signal-engine/feedback/evaluate/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signal-engine/insights` | `src/app/api/signal-engine/insights/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/signal-engine` | `src/app/api/signal-engine/route.ts` | requireSession | Deprecated | Low | None |
| POST | `/api/signals/[id]/lifecycle` | `src/app/api/signals/[id]/lifecycle/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/[id]` | `src/app/api/signals/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/backtest` | `src/app/api/signals/backtest/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/signals/bootstrap` | `src/app/api/signals/bootstrap/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/bootstrap` | `src/app/api/signals/bootstrap/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/confirmation` | `src/app/api/signals/confirmation/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/daily-report` | `src/app/api/signals/daily-report/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/diagnostics` | `src/app/api/signals/diagnostics/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/engine-health` | `src/app/api/signals/engine-health/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/explain` | `src/app/api/signals/explain/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/signals/force-seed` | `src/app/api/signals/force-seed/route.ts` | None detected | Disabled | Low | None |
| GET | `/api/signals/force-seed` | `src/app/api/signals/force-seed/route.ts` | None detected | Disabled | Low | None |
| GET | `/api/signals/freshness` | `src/app/api/signals/freshness/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/signals/health-report` | `src/app/api/signals/health-report/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/manual-actions` | `src/app/api/signals/manual-actions/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/signals/manual-actions` | `src/app/api/signals/manual-actions/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/rotation` | `src/app/api/signals/rotation/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/signals/stream` | `src/app/api/signals/stream/route.ts` | requireSession | Deprecated | Low | None |
| GET | `/api/stocks/[symbol]` | `src/app/api/stocks/[symbol]/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/stocks` | `src/app/api/stocks/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/strategies/[id]/ai/insights` | `src/app/api/strategies/[id]/ai/insights/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/[id]/ai/recommendations` | `src/app/api/strategies/[id]/ai/recommendations/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/[id]/ai/recommendations` | `src/app/api/strategies/[id]/ai/recommendations/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/[id]/ai/simulate` | `src/app/api/strategies/[id]/ai/simulate/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/[id]/analytics` | `src/app/api/strategies/[id]/analytics/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/[id]/config/history` | `src/app/api/strategies/[id]/config/history/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/[id]/config/preview` | `src/app/api/strategies/[id]/config/preview/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/[id]/config/restore` | `src/app/api/strategies/[id]/config/restore/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/[id]/config` | `src/app/api/strategies/[id]/config/route.ts` | requireAdmin | Admin-only | Low | None |
| PATCH | `/api/strategies/[id]/config` | `src/app/api/strategies/[id]/config/route.ts` | requireAdmin | Admin-only | Low | None |
| DELETE | `/api/strategies/[id]/config` | `src/app/api/strategies/[id]/config/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/[id]` | `src/app/api/strategies/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/[id]/validation/export` | `src/app/api/strategies/[id]/validation/export/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/[id]/validation` | `src/app/api/strategies/[id]/validation/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/[id]/validation` | `src/app/api/strategies/[id]/validation/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/ai/analysis` | `src/app/api/strategies/ai/analysis/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/ai/recommendations` | `src/app/api/strategies/ai/recommendations/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/ai/summary` | `src/app/api/strategies/ai/summary/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/analytics/compare` | `src/app/api/strategies/analytics/compare/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/analytics/rankings` | `src/app/api/strategies/analytics/rankings/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/backfill` | `src/app/api/strategies/backfill/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/backfill` | `src/app/api/strategies/backfill/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/categories` | `src/app/api/strategies/categories/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/deployments` | `src/app/api/strategies/deployments/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab/[id]/backtest/confirm` | `src/app/api/strategies/lab/[id]/backtest/confirm/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab/[id]/backtest` | `src/app/api/strategies/lab/[id]/backtest/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab/[id]/deploy` | `src/app/api/strategies/lab/[id]/deploy/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/lab/[id]` | `src/app/api/strategies/lab/[id]/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab/preview` | `src/app/api/strategies/lab/preview/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab` | `src/app/api/strategies/lab/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/lab` | `src/app/api/strategies/lab/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab/save` | `src/app/api/strategies/lab/save/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/lab/validate` | `src/app/api/strategies/lab/validate/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/learning` | `src/app/api/strategies/learning/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/management/bulk` | `src/app/api/strategies/management/bulk/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/management` | `src/app/api/strategies/management/route.ts` | requireAdmin | Admin-only | Low | None |
| PATCH | `/api/strategies/management` | `src/app/api/strategies/management/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/metrics` | `src/app/api/strategies/metrics/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/operations/alerts` | `src/app/api/strategies/operations/alerts/route.ts` | requireAdmin | Admin-only | Low | None |
| PATCH | `/api/strategies/operations/alerts` | `src/app/api/strategies/operations/alerts/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/operations/automation` | `src/app/api/strategies/operations/automation/route.ts` | requireAdmin | Admin-only | Low | None |
| PATCH | `/api/strategies/operations/automation` | `src/app/api/strategies/operations/automation/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/operations/automation` | `src/app/api/strategies/operations/automation/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/operations/engine` | `src/app/api/strategies/operations/engine/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/operations/health` | `src/app/api/strategies/operations/health/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/operations` | `src/app/api/strategies/operations/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/operations/scheduler` | `src/app/api/strategies/operations/scheduler/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/operations/timeline` | `src/app/api/strategies/operations/timeline/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/performance` | `src/app/api/strategies/performance/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/portfolio/alerts` | `src/app/api/strategies/portfolio/alerts/route.ts` | requireAdmin | Admin-only | Low | None |
| POST | `/api/strategies/portfolio/alerts` | `src/app/api/strategies/portfolio/alerts/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/portfolio/allocation` | `src/app/api/strategies/portfolio/allocation/route.ts` | requireAdmin | Admin-only | Low | None |
| PATCH | `/api/strategies/portfolio/allocation` | `src/app/api/strategies/portfolio/allocation/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/portfolio/diversification` | `src/app/api/strategies/portfolio/diversification/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/portfolio/optimize` | `src/app/api/strategies/portfolio/optimize/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/portfolio/risk` | `src/app/api/strategies/portfolio/risk/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/portfolio/simulate` | `src/app/api/strategies/portfolio/simulate/route.ts` | requireAdmin | Admin-only | Low | None |
| GET | `/api/strategies/portfolio/summary` | `src/app/api/strategies/portfolio/summary/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/regime-router` | `src/app/api/strategies/regime-router/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/strategies/registry` | `src/app/api/strategies/registry/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategies/registry` | `src/app/api/strategies/registry/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategy-builder/ai` | `src/app/api/strategy-builder/ai/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategy-builder/backtest` | `src/app/api/strategy-builder/backtest/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategy-builder/save` | `src/app/api/strategy-builder/save/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/strategy-builder/validate` | `src/app/api/strategy-builder/validate/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/subscription` | `src/app/api/subscription/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/subscription/upgrade` | `src/app/api/subscription/upgrade/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/system/alerts` | `src/app/api/system/alerts/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/system/institutional-health` | `src/app/api/system/institutional-health/route.ts` | None detected | Unknown | High | Review intended exposure; protect or minimize detail |
| GET | `/api/trade-journal` | `src/app/api/trade-journal/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/trade-journal` | `src/app/api/trade-journal/route.ts` | requireSession | Authenticated user | Low | None |
| PATCH | `/api/trade-journal` | `src/app/api/trade-journal/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trader-analytics` | `src/app/api/trader-analytics/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/dashboard` | `src/app/api/trust/dashboard/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/regime` | `src/app/api/trust/regime/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/signals/[id]/reasons` | `src/app/api/trust/signals/[id]/reasons/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/signals/[id]/warnings` | `src/app/api/trust/signals/[id]/warnings/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/signals` | `src/app/api/trust/signals/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/strategies/performance` | `src/app/api/trust/strategies/performance/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/trust/watchlist` | `src/app/api/trust/watchlist/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/usage` | `src/app/api/usage/route.ts` | None detected | Unknown | Medium | Owner approval required to classify intent |
| GET | `/api/user/features` | `src/app/api/user/features/route.ts` | requireSession | Authenticated user | Low | None |
| PUT | `/api/user/features` | `src/app/api/user/features/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/user/onboarding` | `src/app/api/user/onboarding/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/user/onboarding` | `src/app/api/user/onboarding/route.ts` | requireSession | Authenticated user | Low | None |
| PUT | `/api/user/onboarding` | `src/app/api/user/onboarding/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/user` | `src/app/api/user/route.ts` | requireSession | Authenticated user | Low | None |
| PUT | `/api/user` | `src/app/api/user/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/wallet/recharge` | `src/app/api/wallet/recharge/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/wallet` | `src/app/api/wallet/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/watchlist/intelligence` | `src/app/api/watchlist/intelligence/route.ts` | requireSession | Authenticated user | Low | None |
| GET | `/api/watchlist` | `src/app/api/watchlist/route.ts` | requireSession | Authenticated user | Low | None |
| POST | `/api/watchlist` | `src/app/api/watchlist/route.ts` | requireSession | Authenticated user | Low | None |
| DELETE | `/api/watchlist` | `src/app/api/watchlist/route.ts` | requireSession | Authenticated user | Low | None |
