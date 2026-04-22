# Quantorus365 — Institutional Intelligence Architecture

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

The following is the target architecture. Every code path, doc, and
env var in this repo converges on these rules. Contradictions are
bugs.

| Concern | Truth |
|---|---|
| **Market-data PRIMARY** | IndianAPI (`src/providers/adapters/IndianAPIAdapter.ts`) |
| **Market-data CACHE**   | In-memory `Cache` interface (`src/lib/cache.ts`) — Redis-swappable |
| **Market-data FALLBACK** | Yahoo Finance — delayed (~15 min), policy-controlled via `YAHOO_ENABLED` |
| **Market-data STALE tier** | PostgreSQL last-known snapshot (`market.snapshots_current`) |
| **Runtime database** | **PostgreSQL only.** MySQL survives only as a one-way migration source for the Phase-2 backfill |
| **Kite / Zerodha** | Broker / order-execution ONLY. **Never** a market-data truth source |
| **Single provider entry point** | `src/providers/MarketDataProvider.ts`. Every engine/route/service reads through it |

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

Signal-critical callers pass `{ signalCritical: true }`; stale
(`source='db'`) responses then throw `StaleDataError` rather than
silently degrading decisions.

### Canonical response envelope

Every call through `MarketDataProvider` returns a `ProviderResponse<T>`
that carries:

- `provider_name` — `'IndianAPI' | 'Cache' | 'Yahoo Finance' | 'PostgreSQL'`
- `source_type` — `'primary' | 'cache' | 'fallback' | 'stale'`
- `fetched_at` — epoch ms the gateway returned
- `vendor_timestamp` — epoch ms the vendor stamped (0 → unknown; equals `fetched_at`)
- `freshness_ms` — `fetched_at - vendor_timestamp`, clamped to ≥ 0
- `fallback_reason` — `null` when primary served, else a short summary of the upstream failures
- `data_quality` — retained legacy field; see quality labels above

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

---

## System Config Service (`systemConfigService.ts`)

**Single source of truth for all 25 operational thresholds.**

- Loads from `system_thresholds` PostgreSQL table
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

Correlation is computed from **rolling 60-day returns in `candles` table** — not approximated.

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

All news enriched fields use **0-1 scale** (no mixed scales).
Real scorecard dimensions from DB — no heuristic fallbacks.

---

## Data Sources

| Source | Role | Used for | Auth |
|--------|------|----------|------|
| IndianAPI | PRIMARY | Live quotes, historical OHLCV, movers, corporate intel, fundamentals | `X-Api-Key` header (`INDIAN_API_KEY`) |
| Cache     | CACHE   | Hot reads between primary fetches | In-memory (Redis-swappable) |
| Yahoo Finance | FALLBACK | Delayed quotes + historical candles when primary fails | None |
| PostgreSQL | STALE tier | Last-known snapshots, candles, and all app state | Internal |
| Kite / Zerodha | BROKER | Order placement, order status, broker callbacks | API key + session (execution only) |

**Kite is deliberately excluded from market-data truth.** The
`KiteAdapter` file remains in the repo for the execution module but
is not referenced by `MarketDataProvider`.

---

## PostgreSQL Tables

### Quantorus365 operational tables
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

### Canonical schemas (migrations 001–008 under `migrations/postgres/`)
- `auth.*` — users, sessions, audit
- `master.*` — instruments, aliases, sectors
- `market.*` — snapshots_current, snapshots_intraday (partitioned), candles, historical_stats
- `intel.*` — news, corporate_events, forecasts, target_prices
- `app.*` — watchlists, portfolios, alerts, reports
- `ops.*` — scheduler_runs, provider_health_logs, dead_letter_events

---

## Setup

```bash
npm install
cp .env.example .env.local          # fill in PG + IndianAPI + session secrets
npm run db:migrate:pg               # authoritative PostgreSQL migrations 001–008
npm run db:check:pg:insert          # UPSERT + JSONB + TIMESTAMPTZ smoke test
npm run build
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
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

- [ ] `grep -rn "from '@/providers/adapters/\(Yahoo\|IndianAPI\|Kite\)Adapter'" src/ --include="*.ts"`
      → only results are inside `src/providers/` itself
- [ ] `grep -rn "from '@/lib/db'" src/ --include="*.ts"` → zero runtime imports
      (migration tooling under `scripts/` may keep it temporarily)
- [ ] `system_thresholds` table has 25 rows after migration
- [ ] All engines import from `systemConfigService`, not hardcoding values
- [ ] `signal_rejections.approved=0` rows accumulate during market hours
- [ ] Dashboard shows `market_stance`, `scenario_tag`, `conviction_band`
- [ ] `ops.scheduler_runs` shows a row per 10-minute cycle during 09:30–15:30 IST
- [ ] Provider response envelope includes `provider_name`, `source_type`,
      `vendor_timestamp`, `freshness_ms`, and `fallback_reason` on every return path

## Verifying IndianAPI connectivity

```bash
# Replace $INDIAN_API_KEY with your key (do NOT commit the key).
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/stock?name=RELIANCE"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/trending"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/NSE_most_active"
```

Keys must never land in source control. See `.env.example` for the full
list of env vars read by the provider and adapters.