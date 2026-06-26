# Quantorus365 — Institutional Intelligence Architecture

**Version:** 2.1.0  
**Last updated:** 2026-06-26

---

## Philosophy

This is an **Institutional Decision Engine**, not a retail signal app.

Five non-negotiable principles:

1. **Risk-first** — Risk is a gatekeeper, not a display number
2. **Portfolio awareness** — Trade quality = stock quality × portfolio fit
3. **Scenario-driven** — Market conditions control which strategies are allowed
4. **Confidence scoring** — Confidence measures decision quality, not prediction certainty
5. **Rejection discipline** — The system earns trust by filtering, not by volume

---

## Architecture Freeze (Priority 0 — authoritative)

The following is the target architecture. Every code path, doc, and env var in this repo converges on these rules. Contradictions are bugs.

| Concern | Truth |
|---|---|
| **Market-data PRIMARY** | IndianAPI (`src/providers/adapters/IndianAPIAdapter.ts`) |
| **Market-data CACHE** | In-memory `Cache` interface (`src/lib/cache.ts`) — Redis-swappable |
| **Market-data FALLBACK** | Yahoo Finance — delayed (~15 min), policy-controlled via `YAHOO_ENABLED` |
| **Market-data STALE tier** | PostgreSQL last-known snapshot (`market.snapshots_current`) |
| **Runtime database (target)** | **PostgreSQL only.** MySQL survives as the one-way migration source for Phase-2 backfill |
| **Runtime database (v2.1 operational)** | **MySQL** via `src/lib/db.ts` for live app state (auth, signals, candles, news, manipulation). PostgreSQL schemas in `migrations/postgres/` are the canonical warehouse path — adoption is in progress |
| **Kite / Zerodha** | Broker / order-execution ONLY. **Never** a market-data truth source |
| **Single provider entry point** | `src/providers/MarketDataProvider.ts`. Every engine/route/service reads through it |
| **Same-app API calls** | **Never** derive fetch origin from `req.url`. Use `internalFetch` (`src/lib/api/internalFetch.ts`) → loopback |

### Canonical fallback chain (strict order)

```
   1. IndianAPI  (PRIMARY, near-live REST)     source='indian'  quality='near-live'
                 │ failure
                 ▼
   2. Cache      (in-memory, 10-min TTL)       source='cache'   quality='cached-fresh'
                 │ miss
                 ▼
   3. Yahoo      (15-min delayed fallback)     source='yahoo'   quality='fallback-delayed'
                 │ failure / disabled
                 ▼
   4. PostgreSQL (last-known snapshot)         source='db'      quality='stale'
```

Signal-critical callers pass `{ signalCritical: true }`; stale (`source='db'`) responses then throw `StaleDataError` rather than silently degrading decisions.

### Canonical response envelope

Every call through `MarketDataProvider` returns a `ProviderResponse<T>` that carries:

- `provider_name` — `'IndianAPI' | 'Cache' | 'Yahoo Finance' | 'PostgreSQL'`
- `source_type` — `'primary' | 'cache' | 'fallback' | 'stale'`
- `fetched_at` — epoch ms the gateway returned
- `vendor_timestamp` — epoch ms the vendor stamped (0 → unknown; equals `fetched_at`)
- `freshness_ms` — `fetched_at - vendor_timestamp`, clamped to ≥ 0
- `fallback_reason` — `null` when primary served, else a short summary of the upstream failures
- `data_quality` — retained legacy field; see quality labels above

---

## Runtime Topology

Production runs as a **single PM2-managed Node process** (`server.js`), not bare `next start`.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    nginx (HTTPS) → dev.quantorus.in                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  server.js  (quantorus365-app, PM2)                                          │
│  ├── Next.js HTTP server              → PORT 5000 (default)                  │
│  ├── WebSocket stream server          → STREAM_WS_PORT 5001                  │
│  │     (tickBus fan-out via instrumentation.ts)                              │
│  └── Child worker processes (supervised, isolated crashes)                   │
│        ├── scheduler.ts              — market data, signal regen, maturity │
│        ├── manipulationScannerCli    — daily manipulation scan (18:30 IST) │
│        └── learningScheduler.ts      — outcome grading / calibration         │
└─────────────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
      MySQL (operational)   Redis (streams)    IndianAPI (primary)
      PostgreSQL (target)   in-memory cache    Yahoo (fallback)
```

| Mode | Entry | Port |
|------|-------|------|
| **Production** | `node server.js` via PM2 (`ecosystem.config.js`) | 5000 / 5001 |
| **Local dev** | `npm run dev` (`next dev`) | 3000 |

nginx terminates TLS and proxies to `127.0.0.1:5000`. The Node process **cannot** reliably HTTP-call its own public hostname (hairpin NAT) — see **internalFetch** below.

---

## Server-to-Server API Calls — `internalFetch`

When one API route needs data from another route in the **same deployment**, never build the URL from the inbound request:

```typescript
// ❌ WRONG — fails behind nginx on VPS (fetch status 0, ~10ms)
const origin = `${new URL(req.url).protocol}//${new URL(req.url).host}`;
await fetch(`${origin}/api/signals?...`);

// ✅ CORRECT
import { internalFetch } from '@/lib/api/internalFetch';

const r = await internalFetch(req, '/api/signals?action=all&limit=20', {
  cookieHeader: req.headers.get('cookie') ?? '',
  timeoutMs: 12_000,
});
```

**Origin resolution** (`resolveInternalOrigin`) — never uses `req.url`:

```
INTERNAL_APP_URL  →  loopback APP_URL  →  http://127.0.0.1:${PORT}
```

| Environment | Default loopback |
|-------------|------------------|
| Production | `http://127.0.0.1:5000` |
| Development | `http://127.0.0.1:3000` |

**Recommended production env:**

```env
INTERNAL_APP_URL=http://127.0.0.1:5000
PORT=5000
```

**Routes that use `internalFetch` today:**

| Route | Calls |
|-------|-------|
| `GET /api/dashboard` | signals, engine-health, daily-report, backtest, news-engine, manipulation, options, backtests |
| `GET /api/signals/engine-health` | signals, daily-report, backtest |
| `GET /api/signals/daily-report` | signals, backtest preview |
| `GET /api/signals/backtest` | signals pool |

Browser/client code may use relative paths (`fetch('/api/signals')`) — the browser talks to nginx, which works. Only **server-side** aggregators need loopback.

---

## Application Layer — Command Center & Dashboards

Two dashboard surfaces serve different audiences:

| Surface | Page | API | Data path |
|---------|------|-----|-----------|
| **Command Center** | `/dashboard` | `GET /api/dashboard` | Server-side aggregation via `internalFetch` → all intelligence modules |
| **Engine Health** | `/signals/engine-health` | `GET /api/signals/engine-health` | Same modules, direct loopback fan-out |
| **Admin Dashboard** | `/admin/dashboard` | `GET /api/admin/dashboard` | Direct DB/service reads (`buildAdminDashboard`) — no HTTP self-call |

`/api/dashboard` is a **pure aggregator** — it never runs scoring logic, never fabricates data, and degrades gracefully when any upstream module fails. Failures are classified as `HEALTHY | WARNING | STALE | DEGRADED | TIMEOUT | BROKEN | …` so the UI never surfaces raw `AbortController` strings.

Individual module pages (`/signals`, `/news-intelligence`, `/manipulation`) call their APIs **from the browser** and remain healthy even when an aggregator misconfigured its origin.

---

## Engine Architecture

```
IndianAPI REST (PRIMARY — quotes, historical, movers, corporate intel, fundamentals)
        │
        ▼ MarketDataProvider serves & writes cache
Cache (in-memory, Redis-swappable; 10-min TTL keyed by symbol × type)
        │
        ▼ primary failure
Yahoo Finance (fallback ONLY — ~15-min delayed; disable with YAHOO_ENABLED=false)
        │
        ▼ fallback failure
PostgreSQL market.snapshots_current (stale last-known; signalCritical callers reject)
```

### 5-Engine Intelligence Stack

```
Market Data → Features → Factor Scores
                                │
                    ┌───────────▼───────────┐
                    │   Scenario Engine      │  What type of market?
                    │   scenarioEngine.ts    │  Controls strategy access
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Market Stance Engine  │  How aggressive today?
                    │  marketStanceEngine.ts │  Adjusts all thresholds
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Portfolio Fit Service │  Does this fit the book?
                    │  portfolioFitService.ts│  Real correlation from DB
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Confidence Engine     │  9-component decision quality
                    │  confidenceEngine.ts   │  Weights from systemConfig
                    └───────────┬───────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Rejection Engine      │  11 sequential hard gates
                    │  rejectionEngine.ts    │  No bypass path
                    └───────────┬───────────┘
                                │
                      APPROVED  │  REJECTED
                         ▼      │      ▼
                    To user      │  signal_rejections
                                 │  + quality_events log
```

### Intelligence Modules (parallel engines)

| Module | Location | API entry |
|--------|----------|-----------|
| Signal Engine (4-phase pipeline) | `src/lib/signal-engine/` | `/api/signals`, `/api/run-signal-engine` |
| Backtesting | `src/lib/backtesting/` | `/api/backtests`, `/api/signals/backtest` |
| Manipulation surveillance | `src/lib/manipulation-engine/` | `/api/manipulation`, `/api/manipulation-engine` |
| News intelligence | `src/lib/news-engine/` | `/api/news-engine` |
| Trust layer | `src/lib/trust-layer/` | `/api/trust/*` |
| Strategy hub / lab | `src/lib/strategy-hub/`, `src/lib/strategy-lab/` | `/api/strategies/*` |
| Paper / live trading | `src/lib/paper-trading/`, `src/lib/broker/` | `/api/paper/*`, `/api/broker/*` |
| Quant platform | `src/lib/quant-platform/` | `/api/quant/*` |

---

## System Config Service (`systemConfigService.ts`)

**Single source of truth for all 25 operational thresholds.**

- Loads from `system_thresholds` table (MySQL operational / PostgreSQL target)
- Caches in Redis (TTL 300s) + in-memory (300s)
- `applyStanceOverrides(cfg, stance)` merges stance adjustments on top
- `invalidateConfig()` flushes all caches after admin update
- No service hardcodes threshold values

Threshold keys:

```
MIN_RR_SWING, MIN_RR_POSITIONAL
MIN_CONFIDENCE, MIN_COMPOSITE_SCORE, MAX_RISK_SCORE
MIN_DATA_QUALITY, MIN_LIQUIDITY_VOLUME, MIN_VOLUME_INTRADAY
MAX_SECTOR_EXPOSURE, MAX_POSITIONS, MAX_STRATEGY_CONCENTRATION
MAX_CORRELATION, MIN_PORTFOLIO_FIT
MAX_DRAWDOWN_BLOCK, CAPITAL_AT_RISK_CAP
MAX_STOP_ATR_MULTIPLE, MIN_STOP_ATR_MULTIPLE
WEIGHT_* (×9 confidence weights)
CORRELATION_LOOKBACK_DAYS
```

---

## Rejection Engine — 11 Gates

All gates run in order. A signal is blocked if ANY gate fails.

| # | Gate | Blocks when |
|---|------|-------------|
| 1 | Data Quality | quality < MIN_DATA_QUALITY |
| 2 | No Strategy | no strategy pattern matched |
| 3 | Scenario | strategy blocked in current scenario |
| 4 | Market Stance | strategy not in stance's allowed list |
| 5 | Regime | BUY in BEAR without MR/event justification |
| 6 | Risk-Reward | R:R < MIN_RR (swing or positional) |
| 7 | Confidence | confidence < stance-adjusted MIN_CONFIDENCE |
| 8 | Risk Score | risk_score > MAX_RISK_SCORE |
| 9 | Liquidity | volume < MIN_VOLUME_INTRADAY |
| 10 | Stop Distance | stop < MIN_STOP_ATR or > MAX_STOP_ATR |
| 11 | Portfolio Fit | portfolio_fit_score < MIN_PORTFOLIO_FIT |

All rejection outcomes logged to `signal_rejections` table.

---

## Confidence Formula

```
confidence_score =
  factor_alignment     × WEIGHT_FACTOR_ALIGNMENT  (default 0.22)
  strategy_clarity     × WEIGHT_STRATEGY_CLARITY  (default 0.14)
  regime_alignment     × WEIGHT_REGIME_ALIGNMENT  (default 0.14)
  liquidity_quality    × WEIGHT_LIQUIDITY         (default 0.10)
  data_quality         × WEIGHT_DATA_QUALITY      (default 0.08)
  portfolio_fit        × WEIGHT_PORTFOLIO_FIT     (default 0.12)
  participation        × WEIGHT_PARTICIPATION     (default 0.06)
  rr_quality           × WEIGHT_RR_QUALITY        (default 0.08)
  volatility_fit       × WEIGHT_VOLATILITY_FIT    (default 0.06)
```

Weights are DB-configurable via `system_thresholds` table.

Conviction bands:

- `high_conviction` — score ≥ 85
- `actionable`      — score 70–84
- `watchlist`       — score 55–69
- `reject`          — score < 55

---

## Market Stance Effects

| Stance | MIN_CONFIDENCE | MIN_RR | MAX_POSITIONS | Alert volume |
|--------|---------------|--------|---------------|--------------|
| aggressive | –10 | –0.3 | +3 | 100% |
| selective | (base) | (base) | (base) | 60% |
| defensive | +8 | +0.3 | –4 | 30% |
| capital_preservation | +20 | +0.8 | –8 | 10% |

Adjustments applied on top of DB base values via `applyStanceOverrides()`.

---

## Portfolio Fit Scoring

Portfolio fit score (0–100) deducts for:

| Factor | Max deduction |
|--------|--------------|
| Sector overexposure (≥30%) | 50 pts |
| Portfolio at capacity (12 pos) | 40 pts |
| Strategy concentration (≥50%) | 20 pts |
| Active drawdown (≥15%) | 25 pts |
| Capital at risk (≥20%) | 15 pts |
| High correlation (avg >0.75) | 20 pts |

Correlation is computed from **rolling 60-day returns in the `candles` table** — not approximated.

---

## Signal Pipeline — 4-Phase Architecture

The signal engine runs as a single sequential pipeline: Phase 1 → 2 → 3 → 4.

| Phase | Responsibility | Key File | Tables |
|-------|---------------|----------|--------|
| **Phase 1** | Multi-strategy setup detection | `generatePhase1Signals.ts` | — |
| **Phase 2** | Conflict resolution, sector context, strategy-specific scoring | `generatePhase2Signals.ts` | `q365_strategy_breakdowns` |
| **Phase 3** | Trade plan, position sizing, portfolio fit, **canonical rejection engine**, manipulation penalty, execution readiness | `generatePhase3Signals.ts` | `q365_signal_lifecycle`, position sizing |
| **Phase 4** | AI explanation, news enrichment, Dexter narratives, feedback loop | `generatePhase4Signals.ts` | `q365_signal_explanations`, `q365_decision_memory` |

**Phase 3 is the single authoritative approval gate.** It runs:

- R:R and stop-width checks
- Position sizing with exposure limits
- Portfolio fit with real correlation from DB
- Canonical rejection engine (`core/runRejectionEngine.ts`) — scenario, stance, confidence, risk, manipulation
- Execution readiness evaluation
- Lifecycle state assignment

**Phase 4 enriches but does not override approval decisions.**

### Canonical Rejection Engine (`core/runRejectionEngine.ts`)

Runs 8 sequential gates, each producing a traced result:

1. Strategy match
2. Scenario gating (strategy blocked in current scenario)
3. Market stance restriction
4. Risk-reward threshold (stance-adjusted)
5. Confidence threshold (stance-adjusted)
6. Risk score cap
7. Portfolio fit (fit score threshold)
8. Manipulation penalty/rejection

Every gate produces a `RejectionGateResult` with audit snapshots.

### Canonical Signal Type (`types/canonicalSignal.ts`)

Central type definitions for persistence and API responses:

- `CanonicalSignalRecord` — DB schema shape
- `CanonicalSignalApiResponse` — API output shape
- `CanonicalSignalDecisionTrace` — full gate audit

---

## News Intelligence Pipeline

```
Adapters (9 sources: official, media, deals, social)
    → Normalization → Entity Linking → 7-Dimension Scoring
    → Symbol/Sector/Market Impact → Signal Integration (0-1 normalized)
    → Phase 4 enrichment → Dexter AI narratives
```

All news enriched fields use **0-1 scale** (no mixed scales). Real scorecard dimensions from DB — no heuristic fallbacks.

---

## Workers & Daily Scan Schedule

Scheduled jobs run inside the worker process (`npm run scheduler` / `scheduler.ts` child). Full IST schedule: [`docs/DAILY_SCAN_SCHEDULE.md`](docs/DAILY_SCAN_SCHEDULE.md).

| Job (IST) | Purpose |
|-----------|---------|
| 08:30 Morning Scan | Pre-market signals from last EOD candle (DB-only) |
| 16:00 Evening Update | IndianAPI EOD refresh → `candles` warehouse |
| 16:30 Evening Scan | Fresh EOD signals after candle update |
| 18:30 Manipulation Scan | Surveillance scan (reads candles; no duplicate ingestion) |

Additional cron children from `server.js`:

- **Learning scheduler** — outcome grading, calibration (~20:30 IST)
- **Manipulation scanner CLI** — standalone daily scan path

---

## Data Sources

| Source | Role | Used for | Auth |
|--------|------|----------|------|
| IndianAPI | PRIMARY | Live quotes, historical OHLCV, movers, corporate intel, fundamentals | `X-Api-Key` header (`INDIAN_API_KEY`) |
| Cache | CACHE | Hot reads between primary fetches | In-memory (Redis-swappable) |
| Yahoo Finance | FALLBACK | Delayed quotes + historical candles when primary fails | None |
| PostgreSQL | STALE tier | Last-known snapshots, canonical warehouse schemas | Internal |
| MySQL | OPERATIONAL | Live app tables (auth, signals, candles, news, ops) | Internal |
| Kite / Zerodha | BROKER | Order placement, order status, broker callbacks | API key + session (execution only) |

**Kite is deliberately excluded from market-data truth.** The `KiteAdapter` file remains in the repo for the execution module but is not referenced by `MarketDataProvider`.

---

## Database

### Operational (MySQL — v2.1 runtime)

Boot-time DDL: `src/lib/db/ensureAllSchemas.ts` (idempotent `CREATE TABLE IF NOT EXISTS`).

| Area | Key tables |
|------|------------|
| Auth | `users`, `user_sessions` |
| Signals | `q365_signals`, `q365_signal_lifecycle`, `q365_strategy_breakdowns` |
| Market warehouse | `candles`, `market_data_daily`, EOD ingestion logs |
| News | `news_events`, `news_scores` |
| Manipulation | manipulation events, scan snapshots |
| Ops | `system_thresholds`, `signal_rejections`, scheduler run logs |

Access: `import { db } from '@/lib/db'` — parameterized SQL, no ORM.

### Canonical PostgreSQL (target warehouse)

Versioned migrations: `migrations/postgres/001` – `031` (auth, master, market, intel, app, ops, trust, strategy, billing, broker, security, quant platform, …).

| Schema | Purpose |
|--------|---------|
| `auth.*` | users, sessions, audit |
| `master.*` | instruments, aliases, sectors |
| `market.*` | snapshots_current, snapshots_intraday, candles, historical_stats |
| `intel.*` | news, corporate_events, forecasts, target_prices |
| `app.*` | watchlists, portfolios, alerts, reports |
| `ops.*` | scheduler_runs, provider_health_logs, dead_letter_events |

Run: `npm run db:migrate:pg`  
Validate: `npm run db:check:pg:insert`  
Backfill from MySQL: `npm run db:backfill:pg`

Full inventory: [`docs/database-inventory.md`](docs/database-inventory.md)

### Quantorus365 operational tables (threshold / audit)

| Table | Purpose |
|-------|---------|
| `system_thresholds` | All 25 configurable gate values |
| `signal_rejections` | Every candidate logged with gate outcome |
| `market_scenarios` | Historical scenario log |
| `market_stance_logs` | Historical stance log |
| `confidence_logs` | Per-signal 9-component breakdown |
| `portfolio_exposure_snapshots` | Daily sector/strategy exposure history |
| `portfolio_position_correlations` | Rolling correlation cache |
| `portfolio_fit_logs` | Per-signal fit audit trail |
| `strategy_performance` | Win rate by strategy × regime × conviction |
| `signal_quality_events` | Rejection event log |

---

## Code Organization

```
src/
├── app/              # Next.js App Router — pages + ~174 API routes
├── components/       # React UI (dashboard, signals, stock detail, layout)
├── lib/              # Core engines (signal, backtest, manipulation, news, market data)
│   └── api/
│       └── internalFetch.ts   # ← mandatory for same-app server-side fetch
├── services/         # Application service layer
├── providers/        # Market data adapters (IndianAPI, Yahoo)
├── hooks/            # React hooks
├── types/            # Shared TypeScript types
├── instrumentation.ts
└── middleware.ts     # Cookie-presence auth gate (q200_session)

services/             # Microservice scaffolds (identity, market-ingestion, …)
packages/             # Shared contracts, eventbus, RPC
scripts/              # CLI ops, validation, backfill
migrations/postgres/  # Versioned PostgreSQL DDL
docs/                 # Detailed inventories and runbooks
server.js             # Production unified entry (HTTP + WS + workers)
ecosystem.config.js   # PM2 config
```

---

## Document Suite

| Document | Scope |
|----------|-------|
| [`docs/architecture-audit.md`](docs/architecture-audit.md) | Full enterprise audit, module map, gaps |
| [`docs/api-inventory.md`](docs/api-inventory.md) | All API routes with auth classification |
| [`docs/database-inventory.md`](docs/database-inventory.md) | Schemas, tables, migrations |
| [`docs/signal-engine-flow.md`](docs/signal-engine-flow.md) | 4-phase pipeline, lifecycle |
| [`docs/DAILY_SCAN_SCHEDULE.md`](docs/DAILY_SCAN_SCHEDULE.md) | IST cron jobs, dependency graph |
| [`docs/PROVIDER_REQUEST_POLICY.md`](docs/PROVIDER_REQUEST_POLICY.md) | IndianAPI budget policy |

---

## Setup

```bash
npm install
cp .env.example .env.local          # fill in MYSQL + IndianAPI + session secrets
npm run db:ensure                     # boot-time MySQL DDL (or db:migrate-all)
npm run db:migrate:pg                 # PostgreSQL canonical migrations
npm run build
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

### Production env (minimum)

```env
NODE_ENV=production
PORT=5000
STREAM_WS_PORT=5001
INTERNAL_APP_URL=http://127.0.0.1:5000

MYSQL_HOST=...
MYSQL_DATABASE=...
MYSQL_USER=...
MYSQL_PASSWORD=...

SESSION_SECRET=...                    # 32+ chars
INDIAN_API_KEY=...
NEXT_PUBLIC_APP_URL=https://dev.quantorus.in
```

### First-run after deploy

```bash
# 1. Seed thresholds (if db:migrate-q365 ran, already done)
POST /api/admin  body: { action: "seed_thresholds" }

# 2. Sync instrument master
POST /api/admin  body: { action: "sync_instruments_nse" }

# 3. Sync rankings
POST /api/admin  body: { action: "sync_rankings" }

# 4. Recompute signals
POST /api/admin  body: { action: "recompute_signals", limit: 100 }

# 5. Check quality
GET /api/admin?action=rejection_analysis
GET /api/admin?action=get_stance
```

---

## Final Validation Checklist

- [ ] No server route builds internal fetch origin from `req.url` — all use `internalFetch`
- [ ] `INTERNAL_APP_URL` set on VPS (or defaults to `127.0.0.1:5000`)
- [ ] `grep -rn "from '@/providers/adapters/\(Yahoo\|IndianAPI\|Kite\)Adapter'" src/ --include="*.ts"` → only inside `src/providers/`
- [ ] `system_thresholds` table has 25 rows after migration
- [ ] All engines import from `systemConfigService`, not hardcoding values
- [ ] `signal_rejections.approved=0` rows accumulate during market hours
- [ ] Command Center `/dashboard` module statuses match `/signals/engine-health`
- [ ] `ops.scheduler_runs` shows a row per 10-minute cycle during 09:30–15:30 IST
- [ ] Provider response envelope includes `provider_name`, `source_type`, `vendor_timestamp`, `freshness_ms`, and `fallback_reason` on every return path

## Verifying IndianAPI connectivity

```bash
# Replace $INDIAN_API_KEY with your key (do NOT commit the key).
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/stock?name=RELIANCE"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/trending"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/NSE_most_active"
```

Keys must never land in source control. See `.env.example` for the full list of env vars read by the provider and adapters.
