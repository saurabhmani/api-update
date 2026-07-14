# API Inventory — Quantorus365

**Version:** 2.1.0  
**Audit Date:** 2025-06-25  
**Total Routes:** 174  
**Parent Document:** [architecture-audit.md](./architecture-audit.md)

---

## Summary

| Metric | Value |
|--------|-------|
| Total route handlers | 174 |
| Routes with `requireSession` | ~88 |
| Public middleware bypass | 9 |
| Admin-gated routes | 7 |
| Disabled (410 Gone) | 2 |

### Auth Legend

| Symbol | Meaning |
|--------|---------|
| `PUBLIC` | No cookie required (middleware bypass) |
| `COOKIE` | Non-empty `q200_session` cookie only (not validated) |
| `SESSION` | `requireSession()` — DB-validated session |
| `ADMIN` | `requireAdmin()` after session |
| `DISABLED` | Returns 410 Gone |

---

## Admin (7)

| Path | Methods | Auth | Handler |
|------|---------|------|---------|
| `/api/admin` | GET, POST | SESSION + ADMIN | `src/app/api/admin/route.ts` |
| `/api/admin/alert-rules` | GET, POST, DELETE | ADMIN | `admin/alert-rules/route.ts` |
| `/api/admin/cleanup-confirmed` | POST | SESSION | `admin/cleanup-confirmed/route.ts` |
| `/api/admin/performance` | GET | ADMIN | `admin/performance/route.ts` |
| `/api/admin/recompute` | POST | ADMIN | `admin/recompute/route.ts` |
| `/api/admin/rescore` | POST | ADMIN | `admin/rescore/route.ts` |
| `/api/admin/signal-rules` | GET, PUT | ADMIN | `admin/signal-rules/route.ts` |

## AI (3)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/ai/explain-opportunity` | POST | COOKIE | AI opportunity explanation |
| `/api/ai/explain-risk` | POST | SESSION | AI risk explanation |
| `/api/ai/summarize-scenario` | POST | SESSION | Scenario summary |

## Alerts & Audit (4)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/alerts` | GET, POST, DELETE | SESSION | User alerts CRUD |
| `/api/alerts/breaches` | GET, POST | SESSION | Breach alerts |
| `/api/audit/log-event` | POST | SESSION | Client audit events |
| `/api/audit/logs` | GET | COOKIE | Audit log query |

## Auth & User (4)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/auth` | POST | PUBLIC | Login, register, logout, TOTP |
| `/api/user` | GET, PATCH | SESSION | User profile |
| `/api/user/features` | GET | SESSION | Feature entitlements |
| `/api/user/onboarding` | GET, POST | SESSION | Onboarding state |

## Backtests (13)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/backtests` | GET, POST | COOKIE | List / queue backtest |
| `/api/backtests/process-queue` | POST | COOKIE | Drain backtest queue |
| `/api/backtests/seed-data` | POST | DISABLED | Legacy Yahoo seeder |
| `/api/backtests/[id]` | GET, DELETE | COOKIE | Run detail / delete |
| `/api/backtests/[id]/analytics` | GET | COOKIE | Strategy/regime analytics |
| `/api/backtests/[id]/audit` | GET | COOKIE | Audit trail |
| `/api/backtests/[id]/calibration` | GET | COOKIE | Calibration metrics |
| `/api/backtests/[id]/cancel` | POST | COOKIE | Cancel run |
| `/api/backtests/[id]/dexter` | GET | COOKIE | Dexter narrative |
| `/api/backtests/[id]/performance` | GET | COOKIE | Performance summary |
| `/api/backtests/[id]/signals` | GET | COOKIE | Signals in run |
| `/api/backtests/[id]/trades` | GET | COOKIE | Simulated trades |

## Canonical Data (8)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/canonical/benchmarks` | GET | COOKIE | Benchmark instruments |
| `/api/canonical/factors` | GET | COOKIE | Factor definitions |
| `/api/canonical/instruments` | GET | COOKIE | Instrument registry |
| `/api/canonical/portfolios` | GET, POST | COOKIE | Portfolio entities |
| `/api/canonical/positions` | GET | COOKIE | Position snapshots |
| `/api/canonical/prices` | GET | COOKIE | Canonical prices |
| `/api/canonical/resolve` | GET | COOKIE | Symbol resolution |
| `/api/canonical/sectors` | GET | COOKIE | Sector taxonomy |

## Charts & Dashboard (3)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/chart-data` | GET | SESSION | Chart OHLCV |
| `/api/charts` | GET | SESSION | Chart config |
| `/api/dashboard` | GET | SESSION | Dashboard aggregation |

## Debug (5)

| Path | Methods | Auth | Risk |
|------|---------|------|------|
| `/api/debug/env-check` | GET | COOKIE | **HIGH** — key metadata |
| `/api/debug/provider-report` | GET | COOKIE | **HIGH** — provider internals |
| `/api/debug/quota` | GET | COOKIE | **HIGH** — quota state |
| `/api/debug/signal-validation` | GET | COOKIE | **MED** — signal diagnostics |
| `/api/debug/system-health` | GET | COOKIE | **HIGH** — full operator telemetry |

## Decisions & Explainability (5)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/decisions/evaluate` | POST | SESSION | Decision evaluation |
| `/api/decisions/traces` | GET | COOKIE | Decision trace list |
| `/api/decisions/trace/[id]` | GET | COOKIE | Single trace |
| `/api/explainability/decision/[id]` | GET | COOKIE | Decision explainability |
| `/api/explanations` | GET | SESSION | Signal explanations |

## Governance (3)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/governance/evaluate` | POST | SESSION | Governance check |
| `/api/governance/restrictions` | GET, POST | SESSION | Trading restrictions |
| `/api/governance/rules` | GET | COOKIE | Governance rules |

## Health & Monitoring (7)

| Path | Methods | Auth | Purpose |
|------|---------|------|---------|
| `/api/health` | GET | PUBLIC | Liveness + internals |
| `/api/engine-health/status` | GET | PUBLIC | Engine status |
| `/api/data-feed/health` | GET | COOKIE | Feed health |
| `/api/monitor/run-checks` | POST | SESSION | Run health checks |
| `/api/metrics` | GET | COOKIE | Prometheus export |
| `/api/system/alerts` | GET | COOKIE | System alerts |
| `/api/system/institutional-health` | GET | COOKIE | Institutional health |

## Manipulation — Legacy (12)

Thin re-exports of `manipulation-engine/*` handlers.

| Path | Auth |
|------|------|
| `/api/manipulation` | SESSION |
| `/api/manipulation/[symbol]` | COOKIE |
| `/api/manipulation/analytics` | COOKIE |
| `/api/manipulation/backtest-impact` | COOKIE |
| `/api/manipulation/daily-scan` | SESSION |
| `/api/manipulation/detectors` | COOKIE |
| `/api/manipulation/eod-ingest` | SESSION |
| `/api/manipulation/penalties` | COOKIE |
| `/api/manipulation/run` | SESSION |
| `/api/manipulation/trend` | COOKIE |
| `/api/manipulation/watchlists` | COOKIE |

## Manipulation Engine (12)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/manipulation-engine` | COOKIE | Dashboard summary |
| `/api/manipulation-engine/analytics` | COOKIE | Analytics |
| `/api/manipulation-engine/backtest-impact` | COOKIE | Backtest impact |
| `/api/manipulation-engine/clusters` | COOKIE | Event clusters |
| `/api/manipulation-engine/dashboard` | COOKIE | Dashboard data |
| `/api/manipulation-engine/detectors` | COOKIE | Detector list |
| `/api/manipulation-engine/events` | COOKIE | Event feed |
| `/api/manipulation-engine/penalties` | COOKIE | Penalty lookup |
| `/api/manipulation-engine/scan` | COOKIE | **Unauthenticated scan trigger** |
| `/api/manipulation-engine/symbol-history` | COOKIE | Symbol history |
| `/api/manipulation-engine/trend` | COOKIE | Trend data |
| `/api/manipulation-engine/watchlists` | COOKIE | Watchlist CRUD |

## Market Data (18)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/market` | SESSION | Market overview |
| `/api/market/historical` | COOKIE | Historical OHLCV |
| `/api/market/movers` | COOKIE | Top movers |
| `/api/market/quote` | COOKIE | Single quote |
| `/api/market/snapshot-db` | COOKIE | DB snapshot |
| `/api/market/stream` | COOKIE | Market SSE stream |
| `/api/market/v2/quote` | COOKIE | V2 quote envelope |
| `/api/market-data` | SESSION | Market data ops |
| `/api/market-data/bot` | PUBLIC | Bot price cross-check |
| `/api/market-data/health` | PUBLIC | Provider health |
| `/api/market-data/reseed` | PUBLIC | **DB/cache mutation** |
| `/api/market-data/subscribe` | COOKIE | Symbol subscription |
| `/api/market-data/unified` | COOKIE | Unified quote |
| `/api/market-data/usage` | SESSION | Provider usage |
| `/api/market-data/validate` | PUBLIC | Signal LTP validation |
| `/api/market-intelligence` | SESSION | Intelligence bundle |
| `/api/market-status` | COOKIE | Market open/close |
| `/api/bootstrap-nse` | SESSION | NSE universe bootstrap |

## News (3)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/news` | SESSION | News feed |
| `/api/news/categories` | SESSION | News categories |
| `/api/news-engine` | SESSION | News engine ops |

## Opportunities & Pre-trade (5)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/opportunities` | COOKIE | Opportunity list |
| `/api/opportunities/evaluate` | SESSION | Evaluate opportunity |
| `/api/opportunities/ranked` | COOKIE | Ranked opportunities |
| `/api/pretrade/evaluate` | SESSION | Pre-trade gateway |

## Options (3)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/options` | SESSION | Options data |
| `/api/options/intelligence` | SESSION | Options intelligence |

## Pipeline & Portfolio (11)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/pipeline/portfolio` | COOKIE | Pipeline portfolio |
| `/api/pipeline/stats` | COOKIE | Pipeline stats |
| `/api/portfolio` | SESSION | Portfolio CRUD |
| `/api/portfolio/history` | SESSION | Portfolio history |
| `/api/portfolio/holdings` | SESSION | Holdings |
| `/api/portfolio/ledger` | SESSION | Trade ledger |
| `/api/portfolio/overview` | SESSION | Overview |
| `/api/portfolio/pnl` | SESSION | P&L |
| `/api/portfolio-fit/evaluate` | SESSION | Portfolio fit score |
| `/api/portfolio-fit/institutional` | SESSION | Institutional fit |
| `/api/portfolio-fit/size-trade` | SESSION | Position sizing |

## Risk (4)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/risk/concentration` | SESSION | Concentration metrics |
| `/api/risk/exposures` | SESSION | Exposure breakdown |
| `/api/risk/liquidity` | SESSION | Liquidity risk |
| `/api/risk/summary` | SESSION | Risk summary |

## Scanner & Signal Engine (9)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/scanner/custom-universe/run` | COOKIE | **Expensive scan — no SESSION** |
| `/api/run-signal-engine` | SESSION | Manual signal engine run |
| `/api/signal-engine` | SESSION | Signal engine status/run |
| `/api/signal-engine/calibration` | SESSION | Calibration data |
| `/api/signal-engine/debug/conflicts` | SESSION | Conflict debug |
| `/api/signal-engine/dexter` | SESSION | Dexter narrative |
| `/api/signal-engine/feedback/evaluate` | SESSION | Feedback loop |
| `/api/signal-engine/insights` | COOKIE | Engine insights |

## Signals (17)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/signals` | SESSION | Signal board (primary) |
| `/api/signals/[id]` | SESSION | Signal detail |
| `/api/signals/[id]/lifecycle` | SESSION | Lifecycle events |
| `/api/signals/backtest` | SESSION | Daily outcome backtest |
| `/api/signals/bootstrap` | SESSION | Bootstrap signals |
| `/api/signals/confirmation` | SESSION | Confirmation state |
| `/api/signals/daily-report` | SESSION | Daily report |
| `/api/signals/diagnostics` | SESSION | Funnel diagnostics |
| `/api/signals/engine-health` | SESSION | Engine health |
| `/api/signals/explain` | SESSION | Signal explanation |
| `/api/signals/force-seed` | DISABLED | Legacy seeder |
| `/api/signals/freshness` | COOKIE | Freshness metrics |
| `/api/signals/health-report` | SESSION | Health report |
| `/api/signals/rotation` | SESSION | Rotation policy |
| `/api/signals/stream` | SESSION | Signal SSE stream |

## Scenarios & Strategies (7)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/scenarios/run` | SESSION | Run scenario |
| `/api/scenarios/library` | COOKIE | Scenario library |
| `/api/scenarios/evaluate-trade` | SESSION | Trade scenario eval |
| `/api/strategies/backfill` | SESSION | Strategy backfill |
| `/api/strategies/learning` | SESSION | Learning metrics |
| `/api/strategies/performance` | SESSION | Performance snapshots |
| `/api/strategies/regime-router` | SESSION | Regime routing |

## Stocks, Trade, Misc (16)

| Path | Auth | Purpose |
|------|------|---------|
| `/api/stocks` | COOKIE | Stock list |
| `/api/stocks/[symbol]` | SESSION | Stock detail |
| `/api/trade-journal` | SESSION | Trade journal CRUD |
| `/api/trade-setups` | SESSION | Trade setups |
| `/api/trader-analytics` | SESSION | Trader analytics |
| `/api/watchlist` | SESSION | Watchlist CRUD |
| `/api/watchlist/intelligence` | SESSION | Watchlist intelligence |
| `/api/analytics` | SESSION | Analytics |
| `/api/events` | PUBLIC | **SSE event broadcast** |
| `/api/instruments` | SESSION | Instruments |
| `/api/intelligence` | SESSION | Intelligence |
| `/api/metrics` | COOKIE | Prometheus |
| `/api/notifications` | SESSION | Notifications |
| `/api/openapi` | SESSION | OpenAPI spec |
| `/api/price` | COOKIE | Legacy price |
| `/api/rankings` | SESSION | Rankings |
| `/api/reports` | SESSION | Reports |
| `/api/ticker` | SESSION | Ticker strip |
| `/api/usage` | COOKIE | API usage stats |

---

## Public Endpoints (No Cookie)

These bypass `src/middleware.ts` auth entirely:

1. `/api/auth`
2. `/api/health`
3. `/api/engine-health/status`
4. `/api/events`
5. `/api/market-data/health`
6. `/api/market-data/reseed`
7. `/api/market-data/bot`
8. `/api/market-data/validate`

---

## Expensive / Sensitive Operations (Priority Hardening)

| Path | Risk | Recommendation |
|------|------|----------------|
| `/api/run-signal-engine` | removed vendor quota burn | `requireSession` + `pipelineLimiter` |
| `/api/scanner/custom-universe/run` | Full universe scan | `requireSession` + `requireAdmin` |
| `/api/backtests` POST | CPU/DB intensive | `requireSession` |
| `/api/backtests/process-queue` | Queue drain | `requireSession` + admin |
| `/api/manipulation-engine/scan` | Full manipulation scan | `requireAdmin` |
| `/api/debug/*` | Operator internals | `requireAdmin` |
| `/api/metrics` | Infra telemetry | `requireAdmin` or IP allowlist |

---

## API Handler Patterns

| Pattern | Adoption | File |
|---------|----------|------|
| `withApiHandler` | ~30 routes | `src/lib/apiHandler.ts` |
| `requireSession` | ~88 routes | `src/lib/session.ts` |
| `requireAdmin` | 7 admin routes | `src/app/api/admin/route.ts` |
| Raw handler | ~56 routes | Various |

---

*See [security-review.md](./security-review.md) for auth gap remediation.*
