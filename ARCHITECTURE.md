# Quantorus365 — Institutional Intelligence Architecture

**Version:** 2.1.0  
**Last updated:** 2026-07-02  
**Scale:** 277 API routes · 59 App Router pages · 43 service modules · 128 CLI scripts

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

Production may run in one of **three supported layouts**. All use `node-cron` / `setInterval` timers **inside Node processes** — they are not separate OS cron jobs.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    nginx (HTTPS) → quantorus.in                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Layout A — unified (recommended in ecosystem.config.js)                       │
│  server.js  (PM2)                                                              │
│  ├── Next.js HTTP server              → PORT 5000 (default)                  │
│  ├── WebSocket stream server          → STREAM_WS_PORT 5001                  │
│  └── Child: scheduler.ts              — full worker schedule (see below)     │
│                                                                               │
│  Layout B — split (common on VPS)                                              │
│  PM2 #1: npm start / next start       → HTTP only (port 3000 or 5000)        │
│  PM2 #2: tsx src/lib/workers/scheduler.ts → full worker schedule             │
│                                                                               │
│  Layout C — dev / single-process fallback                                      │
│  npm run dev  OR  next start with Q365_INPROC_SCHEDULER=1                     │
│  └── bootInProc.ts (instrumentation.ts) — in-process crons + maturity        │
└─────────────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
      MySQL (operational)   Redis (streams)    IndianAPI (primary)
      PostgreSQL (target)   in-memory cache    Yahoo (fallback)
```

| Mode | Entry | Port | Scheduler owner |
|------|-------|------|-----------------|
| **Production (unified)** | `node server.js` via PM2 (`ecosystem.config.js`) | 5000 / 5001 | `scheduler.ts` child |
| **Production (split)** | `npm start` + separate `quantorus365-scheduler` PM2 app | 3000 or 5000 | `scheduler.ts` process |
| **Production (in-proc)** | `next start` + `Q365_INPROC_SCHEDULER=1` | 3000 or 5000 | `bootInProc.ts` inside Next |
| **Local dev** | `npm run dev` (`next dev`) | 3000 | `bootInProc.ts` (auto in development) |

**Critical:** `next start` alone does **not** register the full worker schedule unless either (a) `bootInProcScheduler()` boots in-process (`Q365_INPROC_SCHEDULER=1` or `Q365_INPROC_REGEN=1`), or (b) a separate `scheduler.ts` PM2 process is running. Without one of these, the **60s maturity worker** never fires and `q365_confirmed_signal_snapshots` stays empty.

`server.js` sets `Q365_INPROC_SCHEDULER=0` by default when unset, to avoid double-firing crons when the `scheduler.ts` child is supervised.

nginx terminates TLS and proxies to the app port (commonly `127.0.0.1:5000` or `:3000`). The Node process **cannot** reliably HTTP-call its own public hostname (hairpin NAT) — see **internalFetch** below.

### Scheduler ownership matrix

| Job | `scheduler.ts` child | `bootInProc.ts` (in-process) |
|-----|----------------------|--------------------------------|
| Daily scan ladder (08:30–18:30 IST) | Yes | Yes |
| Market-data 10-min loop (`src/lib/scheduler.ts`) | Yes | **No** |
| Weekly NSE 1000 universe rebuild | Yes | **No** |
| Maturity worker (60s, 24×7) | Yes | Yes |
| Snapshot lifecycle (30s, 24×7) | Yes | Yes |
| Nightly backtest (19:00 IST) | Yes | **No** |
| News ingestion (5 min) | No | Yes |
| Manipulation one-shot (server.js UTC cron) | Via `server.js` only | No |

Verify scheduler health in PM2 logs:

```bash
# Unified or in-proc
pm2 logs <app> --lines 300 | grep -iE 'worker-scheduler ready|\[INPROC MATURITY\]|\[MATURITY\]|daily scan schedule'

# Split layout — check both processes
pm2 logs quantorus365-scheduler --lines 100 | grep 'worker-scheduler ready'
```

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

## Environment Configuration

Env resolution is centralized in `src/lib/envPath.ts` (`resolveEnvFilePath`).

| Priority | Source | When |
|----------|--------|------|
| 1 | `DOTENV_CONFIG_PATH` | Explicit PM2 / CLI override |
| 2 | `.env` | `NODE_ENV=production` (VPS convention) |
| 3 | `.env.local` | Local dev when present |
| 4 | `.env` | Fallback |

**Next.js** also loads `.env`, `.env.local`, `.env.production` at `next start` / `next dev` — but CLI scripts and `server.js` use `resolveEnvFilePath()` unless `DOTENV_CONFIG_PATH` is set.

**Production operators using `.env.local` only** should either:

```bash
ln -sf .env.local .env
# or
DOTENV_CONFIG_PATH=/var/www/api-update/.env.local
```

Scripts (`backfillCandles.ts`, `weeklyNse1000UniverseRebuild.ts`, etc.) load `.env.local` first, then `.env` (first value wins for duplicate keys).

### Key scheduler env vars

| Variable | Effect |
|----------|--------|
| `Q365_INPROC_SCHEDULER=1` | Force in-process crons inside Next (`bootInProc.ts`) |
| `Q365_INPROC_SCHEDULER=0` | Suppress in-proc (use when `scheduler.ts` child runs) |
| `Q365_INPROC_REGEN=1` | Also boots in-proc if scheduler flag unset |
| `DAILY_SCAN_SCHEDULE_ENABLED` | Weekday scan ladder (default `true`) |
| `SIGNAL_INTRADAY_REGEN_ENABLED` | Legacy 5/10-min regen loops (default `false`) |
| `UNIVERSE_WEEKLY_REBUILD_ENABLED` | Sunday universe rebuild cron |
| `UNIVERSE_WEEKLY_REBUILD_CRON` | Default `0 22 * * 0` (Sun 22:00 IST) |

---

## NSE 1000 Tradeable Universe

As of v2.1, the production universe is **liquidity-ranked NSE EQ symbols** (~1000 target), not the legacy static Nifty 500 CSV.

| Concern | Truth |
|---------|-------|
| **Mode** | `UNIVERSE_MODE=NSE1000` (default); legacy `NIFTY500` still supported |
| **Source of truth** | `q365_universe WHERE is_active=1` |
| **Boot gate** | `initOnce()` in `nifty500Universe.ts` refuses boot if active count `< UNIVERSE_MIN_SIZE` |
| **Default band** | min 950 / target 1000 / max 1050 |
| **Master list** | `securities_master` (active EQ from `EQUITY_L.csv`) |
| **Ranking input** | `candles` EOD traded value (≥ `UNIVERSE_MIN_ELIGIBLE_BARS` bars, default 80) |
| **Auto-seed** | `UNIVERSE_AUTO_SEED_FROM_CSV=false` in prod — universe must be built deliberately |

### Universe pipeline

```
EQUITY_L.csv  →  securities_master (active EQ)
                      │
                      ▼
              candle backfill (IndianAPI, resume-capable)
                      │
                      ▼
              nseUniverseRanker (liquidity sort + churn control)
                      │
                      ▼
              q365_universe (is_active=1) + universe snapshot audit
```

| Script / npm command | Purpose |
|---------------------|---------|
| `npm run load:securities-master` | Import `EQUITY_L.csv` → `securities_master` |
| `npm run candles:backfill:securities` | Backfill candles for securities_master pool |
| `npm run build:nse1000-universe` | Rank + apply to `q365_universe` |
| `npm run rebuild:nse1000-universe` | Full pipeline (import → backfill → rank → apply) |
| `npm run rebuild:nse1000-universe:bootstrap` | Rank + apply only (skip backfill; first deploy) |
| `npm run validate:nse1000-universe` | Acceptance checks (count band, bar depth, rank order) |

Weekly rebuild runs via `startWeeklyUniverseSchedule()` in `scheduler.ts` when `UNIVERSE_WEEKLY_REBUILD_ENABLED=true`. Churn bands: add ≤ rank 900, keep ≤ 1100, remove > rank 1200 (env-tunable).

Boot logs to grep: `[UNIVERSE_INIT_START]`, `[UNIVERSE_FINAL] count=…`, `[UNIVERSE READY]`.

---

## Application Layer — Command Center & Dashboards

Two dashboard surfaces serve different audiences (admin ops surfaces are listed below):

| Surface | Page | API | Data path |
|---------|------|-----|-----------|
| **Command Center** | `/dashboard` | `GET /api/dashboard` | Server-side aggregation via `internalFetch` → all intelligence modules |
| **Engine Health** | `/signals/engine-health` | `GET /api/signals/engine-health` | Same modules, direct loopback fan-out |

`/api/dashboard` is a **pure aggregator** — it never runs scoring logic, never fabricates data, and degrades gracefully when any upstream module fails. Failures are classified as `HEALTHY | WARNING | STALE | DEGRADED | TIMEOUT | BROKEN | …` so the UI never surfaces raw `AbortController` strings.

Individual module pages (`/signals`, `/news-intelligence`, `/manipulation`) call their APIs **from the browser** and remain healthy even when an aggregator misconfigured its origin.

### Admin surfaces

| Surface | Page | API | Scope |
|---------|------|-----|-------|
| **Admin Dashboard** | `/admin/dashboard` | `GET /api/admin/dashboard` | Ops KPIs, pipeline health |
| **User Management** | `/admin/users` | `GET/POST/PUT/DELETE /api/admin?resource=user` | Create, edit, disable, delete users |
| **Role Management** | `/admin/roles` | `GET /api/security/rbac` | RBAC matrix + role assignment UI |
| **Reliability** | `/admin/reliability` | `GET /api/reliability/*` | Cron health, alerts, audit |
| **Thresholds / Pipeline** | `/admin/pipeline`, `/admin/signal-rules` | `POST /api/admin` actions | `set_threshold`, `recompute_signals`, … |
| **Audit** | `/admin/audit`, `/admin/audit-logs` | `GET /api/admin?resource=audit` | Admin action trail |

---

## Identity, Auth & Access Control

### Session model

| Concern | Implementation |
|---------|----------------|
| **Session cookie** | `q200_session` (httpOnly, `sameSite=lax`, `Secure` in production) |
| **Session store** | `user_sessions` table + Redis cache (`session:{token}`, TTL 300s) |
| **Middleware** | `src/middleware.ts` — cookie-presence gate; unauthenticated API → 401 JSON, pages → `/login` redirect |
| **Route guards** | `getSession()`, `requireSession()`, `requireAdmin()`, `requirePermission()` in `src/lib/session.ts` |
| **Auth API** | `POST/GET /api/auth` — login, register, 2FA verify, logout (`src/services/auth.ts`) |

Public paths bypass middleware: `/`, `/login`, `/register`, `/api/auth`, `/api/health`, and a small set of market-data health/bot routes.

### Login hardening

- bcrypt password hashing (cost 12)
- Account lockout after 5 failed attempts (`LOCK_MINUTES=30`)
- Optional TOTP 2FA (`totp_enabled`, encrypted `totp_secret` via `src/lib/encryption.ts`)
- Auth rate limit: 5 req/min per IP (`authLimiter`)
- Security audit events on login (`logSecurityEvent` → `security_audit_logs`)
- Session cap enforced via `enforceSessionLimit` (`src/lib/security/sessionManager.ts`)

### Account roles (operational)

The `users.role` column stores **two operational roles**:

| Role | Created by | Access |
|------|-----------|--------|
| `user` | Self-registration (`registerUser`) or admin create | Standard platform features, plan-gated |
| `admin` | Admin create only (`createUserByAdmin`) | Full admin APIs, enterprise-equivalent entitlements |

Admin user lifecycle (`src/services/auth.ts`):

- `POST /api/admin?resource=user` — create (email, password, name, role)
- `PUT /api/admin?resource=user&id={id}` — update name, email, role, `is_active`, password
- `DELETE /api/admin?resource=user&id={id}` — delete (blocks self-delete, last-admin guard)
- `GET /api/admin?resource=users` — list all users

Safeguards: admins cannot demote/disable themselves; last active admin cannot be deleted or demoted.

### RBAC (extended permissions layer)

`src/lib/security/rbac.ts` defines a **four-role permission matrix** seeded into `roles` / `permissions` / `role_permissions` tables:

| RBAC role | Key permissions beyond `user` |
|-----------|------------------------------|
| `user` | signals:read, portfolio, paper trading, billing:read |
| `trader` | + signals:write, trading:live |
| `analyst` | + signals:write (no live trading) |
| `admin` | `*` (wildcard) |

**Note:** Admin create/update APIs currently coerce roles to `user` or `admin` only. The Role Management UI (`/admin/roles`) lists all four RBAC roles, but assigning `trader`/`analyst` via the admin API requires widening the role validation in `updateUserByAdmin` — the RBAC tables and `normalizeRole()` already support them.

### Onboarding preferences (not account roles)

Stored in `user_preferences` (via `POST /api/user/onboarding`):

- `trader_type`: `beginner` | `active_trader` | `options_trader`
- `risk_profile`: `low` | `medium` | `high`
- `alert_mode`: `instant` | `digest` | `limited`

---

## Billing & Entitlements

Subscription billing lives in `src/lib/billing/` with the entitlement facade in `src/services/entitlement.ts`.

### Plans

| Plan | Price (INR/mo) | Notes |
|------|----------------|-------|
| `free` | 0 | Daily signal cap (`FREE_DAILY_SIGNAL_LIMIT`), basic features |
| `pro` | 2,999 | Advanced signals, trade setups, option intelligence |
| `premium` | 7,999 | Top opportunities, trader analytics, market explanation |
| `enterprise` | 24,999 | `__all` features; admins receive this tier automatically |

Plan catalog: `src/lib/billing/constants/plans.ts` (`PLAN_CATALOG`).

### Credit wallets

Four credit types: `ai_builder`, `backtests`, `research_reports`, `premium_signals`.  
Debit/consume via `checkPremiumAccess` / `consumePremiumAccess`; balances in `user_wallets`.

### Key tables (auto-created by `ensureBillingTables`)

`subscriptions`, `user_wallets`, `credit_transactions`, `billing_usage_events`, `invoices`, `invoice_items`, `payment_transactions`, `billing_admin_overrides`, `user_plans`

### API entry points

| Route | Purpose |
|-------|---------|
| `GET /api/billing/subscription` | Current plan |
| `POST /api/billing/subscribe`, `/upgrade` | Plan changes |
| `GET /api/billing/usage` | Usage logs |
| `GET /api/user/features` | Full feature map for logged-in user |
| `POST /api/billing/admin/override` | Admin plan/credit override |

Feature gates in UI use `FeatureGate` (`src/components/intelligence/FeatureGate.tsx`) backed by `getAllUserFeatures()`.

---

## Security & Compliance

Module root: `src/lib/security/`.

| Component | File | Purpose |
|-----------|------|---------|
| RBAC | `rbac.ts` | Role → permission mapping, `hasPermission`, `requirePermission` |
| Audit | `audit.ts` | `logSecurityEvent`, auth/admin action trail |
| MFA | `mfaService.ts` | TOTP setup/verify helpers |
| Compliance | `compliance.ts` | Consent tracking (`user_consents`, `consent_logs`) |
| Rate limiting | `rateLimiter.ts` | Per-route IP limits (auth, security, admin) |
| Validation | `validation.ts` | Email/password sanitization |
| Session manager | `sessionManager.ts` | Concurrent session limits, revocation |
| Secrets | `secretManager.ts` | Encrypted secret storage (`encrypted_secrets`) |

### Consent types

`terms_of_service`, `privacy_policy`, `trading_disclaimer`, `live_trading_risk`, `data_processing`, `marketing`

### Security API routes

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /api/security/status` | Session | MFA status, sessions, consents, permissions |
| `GET /api/security/rbac` | Admin | Full roles/permissions matrix |
| `GET/POST /api/security/compliance` | Session | Consent accept/revoke |
| `GET /api/security/sessions` | Session | Active sessions, revoke |
| `GET /api/security/events` | Admin + permission | Security event log |

---

## Reliability & Operations

Module root: `src/lib/reliability/`.

Aggregates production health across cron jobs, data loaders, broker connectivity, signal validation, and user management into a single dashboard (`collectReliabilityDashboard`).

| Component | Purpose |
|-----------|---------|
| `healthAggregator.ts` | Roll up subsystem health → `ReliabilityDashboard` |
| `alertDispatcher.ts` | Evaluate SLO thresholds, dispatch alerts |
| `alertDelivery.ts` | Channel delivery (email/webhook hooks) |
| `auditLogger.ts` | Reliability action audit trail |
| `cronRegistry.ts` | Canonical cron job metadata |

### API entry points

| Route | Auth | Purpose |
|-------|------|---------|
| `GET /api/reliability/status` | Admin | Full reliability dashboard |
| `GET /api/reliability/health` | Admin | Health metrics snapshot |
| `GET /api/reliability/alerts` | Admin | Alert history |
| `GET /api/reliability/audit` | Admin | Reliability audit log |

Admin UI: `/admin/reliability`.

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
| Strategy hub / lab / builder | `src/lib/strategy-hub/`, `strategy-lab/`, `strategy-builder/` | `/api/strategies/*` |
| Paper / live trading | `src/lib/paper-trading/`, `src/lib/broker/`, `src/lib/execution/` | `/api/paper/*`, `/api/broker/*`, `/api/live-trading/*` |
| Quant platform | `src/lib/quant-platform/` | `/api/quant/*` |
| Billing & entitlements | `src/lib/billing/`, `src/services/entitlement.ts` | `/api/billing/*`, `/api/user/features` |
| Security & compliance | `src/lib/security/` | `/api/security/*` |
| Reliability / SLO | `src/lib/reliability/` | `/api/reliability/*` |
| Pre-trade gateway | `src/services/preTradeGatewayService.ts` | `/api/pretrade/evaluate` |
| Governance | `src/services/governanceService.ts` | `/api/governance/*` |
| Public API | `src/app/api/public/v1/` | `/api/public/v1/signals` (versioned external surface) |

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

### Confirmed signals — two-layer architecture

The `/signals` UI **Confirmed** tab reads only from `q365_confirmed_signal_snapshots` (`status='ACTIVE'`). Scanner output in `q365_signals` alone is **not** confirmed.

```
q365_signals (scanner)
       │
       ▼ upsert on detection
q365_signal_maturity_tracker  ──60s worker──►  q365_confirmed_signal_snapshots
       │              (signalMaturity.ts)              │
       │                                               ▼
       │                                    30s lifecycle worker
       │                              (confirmedSnapshotLifecycle.ts)
       │                                               │
       └──────────────────────────────────► EXPIRED / TARGET_HIT / STOP_LOSS_HIT
```

| Layer | Table | Worker | Cadence |
|-------|-------|--------|---------|
| Scanner | `q365_signals` | Daily scans + optional intraday regen | IST schedule |
| Maturity | `q365_signal_maturity_tracker` | `runSignalMaturityWorker()` | 60s, 24×7 |
| Confirmed | `q365_confirmed_signal_snapshots` | `insertConfirmedSnapshotIfEligible()` | On promotion only |
| Lifecycle | same | `runConfirmedSnapshotLifecycle()` | 30s, 24×7 |

Promotion requires `signal_status=APPROVED_SIGNAL`, main-table `classification`, score/cycle/maturity floors, and passing the data-quality gate (`evaluateMaturityDqGate`). Rows with `DEVELOPING_SETUP` / `WATCHLIST_ONLY` appear in Watchlist tiers but **cannot promote**.

Diagnostics: `GET /api/signals/diagnostics`, `npx tsx scripts/diagnoseApprovalFunnel.ts`.  
Greppable logs: `[INPROC MATURITY]`, `[PROMOTION_BLOCK]`, `[PROMOTION_SUCCESS]`, `[MATURITY_FUNNEL]`.

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

Scheduled jobs register inside **`src/lib/workers/scheduler.ts`** (standalone PM2 process or `server.js` child) and/or **`src/lib/workers/bootInProc.ts`** (in-process via `instrumentation.ts`). Full IST schedule: [`docs/DAILY_SCAN_SCHEDULE.md`](docs/DAILY_SCAN_SCHEDULE.md).

### Weekday scan ladder (IST, Mon–Fri)

| Time | Cron | Job |
|------|------|-----|
| 08:30 | `30 8 * * 1-5` | Readiness check (DB probes — no signals) |
| 09:20 | `20 9 * * 1-5` | First morning scan (DB-only Phase 4) |
| 09:45 | `45 9 * * 1-5` | Main morning scan (DB-only Phase 4) |
| 12:30 | `30 12 * * 1-5` | Midday rescore |
| 14:45 | `45 14 * * 1-5` | Late rescore |
| 16:00 | `0 16 * * 1-5` | Evening candle update (IndianAPI EOD) |
| 16:30 | `30 16 * * 1-5` | Evening scan (DB-only Phase 4) |
| 18:30 | `30 18 * * 1-5` | Manipulation scan (scan-only) |

### Market-data cadence (`src/lib/scheduler.ts`, scheduler child only)

| Time | Job |
|------|-----|
| 09:20 IST | Pre-open warmup |
| 09:30–15:30 every 10m | Intraday batch refresh |
| 09:30–15:30 every 1m | Pipeline heartbeat |
| 15:35 IST | Post-close reconciliation |

### Always-on (24×7)

| Interval | Job |
|----------|-----|
| 30s | Confirmed snapshot lifecycle |
| 60s | Signal maturity / promotion |
| 60s | Backtest queue drain (if enabled) |

### Nightly / weekly (scheduler child)

| Time | Job |
|------|-----|
| 19:00 IST (Mon–Fri) | Nightly backtest |
| 19:30 IST (Mon–Fri) | EOD bhavcopy + manipulation ingest |
| Sun 22:00 IST (default) | NSE 1000 weekly universe rebuild |

### `server.js` UTC crons (unified layout only)

- **13:00 UTC** (18:30 IST) — manipulation scan one-shot child
- **15:00 UTC** (20:30 IST) — learning scheduler one-shot child

Legacy paths off by default: `SIGNAL_INTRADAY_REGEN_ENABLED`, `PREOPEN_CANDLE_WARMUP_ENABLED`, `SIGNALS_AUTO_RECOVERY_ENABLED`.

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
| Auth | `users`, `user_sessions`, `password_resets`, `user_preferences` |
| Billing | `subscriptions`, `user_wallets`, `credit_transactions`, `invoices`, `billing_admin_overrides` |
| Security | `roles`, `permissions`, `role_permissions`, `security_audit_logs`, `user_consents`, `consent_logs` |
| Universe | `securities_master`, `q365_universe`, universe rebuild audit snapshots |
| Signals | `q365_signals`, `q365_signal_maturity_tracker`, `q365_confirmed_signal_snapshots` |
| Signal meta | `q365_signal_lifecycle`, `q365_strategy_breakdowns`, `q365_signal_explanations` |
| Market warehouse | `candles`, `market_data_daily` (view), EOD ingestion logs |
| News | `q365_news_events`, `q365_news_scores` |
| Manipulation | `q365_manipulation_events`, `q365_manipulation_snapshots` |
| Backtest | `q365_backtest_runs` |
| Ops | `system_thresholds`, `signal_rejections`, `q365_data_feed_health`, `audit_logs` |

Access: `import { db } from '@/lib/db'` — parameterized SQL, no ORM.

### Canonical PostgreSQL (target warehouse)

Versioned migrations: `migrations/postgres/001` – `032` (auth, master, market, intel, app, ops, trust, strategy, billing, broker, security, quant platform, universe snapshots, …).

| Schema | Purpose |
|--------|---------|
| `auth.*` | users, sessions, audit |
| `master.*` | instruments, aliases, sectors |
| `market.*` | snapshots_current, snapshots_intraday, candles, historical_stats |
| `intel.*` | news, corporate_events, forecasts, target_prices |
| `app.*` | watchlists, portfolios, alerts, reports |
| `ops.*` | scheduler_runs, provider_health_logs, dead_letter_events |
| `billing.*` | subscriptions, wallets, invoices, usage (migrations `025`, `026`) |
| `security.*` | RBAC, consents, audit, retention (migrations `029`, `030`) |

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
├── app/              # Next.js App Router — 59 pages + 277 API route handlers
├── components/       # React UI (dashboard, signals, stock detail, layout, intelligence)
├── lib/              # Core engines (signal, backtest, manipulation, news, market data)
│   ├── api/
│   │   └── internalFetch.ts   # ← mandatory for same-app server-side fetch
│   ├── billing/      # Subscriptions, wallets, premium access
│   ├── security/     # RBAC, audit, MFA, compliance, rate limits
│   ├── reliability/  # SLO dashboard, alert dispatch, cron registry
│   ├── signal-engine/
│   ├── backtesting/
│   ├── manipulation-engine/
│   ├── news-engine/
│   ├── paper-trading/
│   ├── broker/
│   └── quant-platform/
├── services/         # Application service layer (43 modules — auth, entitlement, engines)
├── providers/        # Market data adapters (IndianAPI, Yahoo)
├── hooks/            # React hooks (auth, features, onboarding, trust)
├── types/            # Shared TypeScript types
├── instrumentation.ts
└── middleware.ts     # Cookie-presence auth gate (q200_session)

services/             # Microservice scaffolds (identity, market-ingestion, …)
packages/             # Shared contracts, eventbus, RPC
scripts/              # 128 CLI ops, validation, backfill scripts
migrations/postgres/  # Versioned PostgreSQL DDL (001–032)
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
| [`docs/strategy-flow.md`](docs/strategy-flow.md) | Strategy registry, evaluators, scoring |
| [`docs/DAILY_SCAN_SCHEDULE.md`](docs/DAILY_SCAN_SCHEDULE.md) | IST cron jobs, dependency graph |
| [`docs/PROVIDER_REQUEST_POLICY.md`](docs/PROVIDER_REQUEST_POLICY.md) | IndianAPI budget policy |
| [`docs/PERFORMANCE_DAILY_REPORT_BACKTEST.md`](docs/PERFORMANCE_DAILY_REPORT_BACKTEST.md) | Daily report / backtest API perf notes |
| [`docs/security-review.md`](docs/security-review.md) | Secret exposure, auth gaps, risk register |
| [`docs/SLO_RUNBOOK.md`](docs/SLO_RUNBOOK.md) | Reliability SLOs and alert runbook |
| [`docs/PREMIUM_NEWS_FEEDS.md`](docs/PREMIUM_NEWS_FEEDS.md) | Premium news feed validation |

---

## Setup

```bash
npm install
cp .env.example .env.local          # fill in MYSQL + IndianAPI + session secrets
npm run db:ensure                     # boot-time MySQL DDL (or db:migrate-all)
npm run db:migrate:pg                 # PostgreSQL canonical migrations
npm run db:seed-users                 # optional: seed admin + demo users (reads SEED_*_PASSWORD from .env.local)
npm run build
```

### Production PM2 — choose one layout

**Unified (recommended):**

```bash
ln -sf .env.local .env                # or set DOTENV_CONFIG_PATH in ecosystem
pm2 start ecosystem.config.js --env production
pm2 save && pm2 startup
```

**Split (`next start` + scheduler):**

```bash
DOTENV_CONFIG_PATH=/var/www/api-update/.env.local NODE_ENV=production \
  pm2 start npm --name quantorus365-prod -- start

DOTENV_CONFIG_PATH=/var/www/api-update/.env.local NODE_ENV=production \
  pm2 start npx --name quantorus365-scheduler -- tsx src/lib/workers/scheduler.ts

# Prevent double crons in Next process:
# Q365_INPROC_SCHEDULER=0

pm2 save
```

### NSE 1000 first deploy (production)

```bash
npm run load:securities-master
npm run candles:backfill:securities    # repeat until dry-run shows sufficient bars
npm run rebuild:nse1000-universe:bootstrap
npm run validate:nse1000-universe      # must pass before app boot (min 950 active)
pm2 restart quantorus365-prod
```

### Production env (minimum)

```env
NODE_ENV=production
PORT=5000                             # or 3000 if nginx proxies there
STREAM_WS_PORT=5001
INTERNAL_APP_URL=http://127.0.0.1:5000
DOTENV_CONFIG_PATH=/var/www/api-update/.env.local   # optional explicit override

MYSQL_HOST=...
MYSQL_DATABASE=...
MYSQL_USER=...
MYSQL_PASSWORD=...

SESSION_SECRET=...                    # 32+ chars
SESSION_MAX_AGE=86400                 # cookie TTL seconds (default 24h)
INDIAN_API_KEY=...
NEXT_PUBLIC_APP_URL=https://quantorus.in

# Auth seed passwords (local/dev only — npm run db:seed-users)
SEED_ADMIN_PASSWORD=...
SEED_JOHN_PASSWORD=...
SEED_PRIYA_PASSWORD=...

# Universe (NSE 1000)
UNIVERSE_MODE=NSE1000
UNIVERSE_MIN_SIZE=950
UNIVERSE_MAX_SIZE=1050
UNIVERSE_TARGET_SIZE=1000
UNIVERSE_AUTO_SEED_FROM_CSV=false

# Scheduler — pick ONE owner (in-proc OR separate worker)
Q365_INPROC_SCHEDULER=0               # when scheduler.ts PM2 process runs
# Q365_INPROC_SCHEDULER=1             # when using next start only, no scheduler child
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
- [ ] `INTERNAL_APP_URL` set on VPS (or defaults to `127.0.0.1:5000` / `:3000`)
- [ ] `grep -rn "from '@/providers/adapters/\(Yahoo\|IndianAPI\|Kite\)Adapter'" src/ --include="*.ts"` → only inside `src/providers/`
- [ ] `system_thresholds` table has 25 rows after migration
- [ ] All engines import from `systemConfigService`, not hardcoding values
- [ ] `signal_rejections.approved=0` rows accumulate during market hours
- [ ] Command Center `/dashboard` module statuses match `/signals/engine-health`
- [ ] `ops.scheduler_runs` shows a row per 10-minute cycle during 09:30–15:30 IST (scheduler child running)
- [ ] Provider response envelope includes `provider_name`, `source_type`, `vendor_timestamp`, `freshness_ms`, and `fallback_reason` on every return path
- [ ] `npm run validate:nse1000-universe` passes (`active` in [950, 1050], liquidity-ranked, not CSV order)
- [ ] Boot logs show `[UNIVERSE_FINAL] count=…` ≥ `UNIVERSE_MIN_SIZE` and no degraded-universe crash
- [ ] PM2 logs show `[INPROC MATURITY]` or `[MATURITY]` every ~60s (maturity worker alive)
- [ ] `q365_confirmed_signal_snapshots` has `ACTIVE` rows after market-hours scans (or `diagnoseApprovalFunnel.ts` shows promotion path clear)
- [ ] Scheduler owner is explicit: `Q365_INPROC_SCHEDULER=0` when `quantorus365-scheduler` PM2 app runs; never both firing duplicate crons unintentionally
- [ ] `users` table has at least one active `admin` row (`npm run db:seed-users` or manual insert)
- [ ] Admin user CRUD works: `GET /api/admin?resource=users`, create via `POST ?resource=user`
- [ ] Billing tables exist after first billing API call (`ensureBillingTables`) or PG migration `025_billing.sql`
- [ ] `GET /api/user/features` returns plan + feature map for logged-in non-admin user
- [ ] RBAC matrix loads at `GET /api/security/rbac` (admin session required)
- [ ] Reliability dashboard responds at `GET /api/reliability/status` (admin session required)

## Verifying IndianAPI connectivity

```bash
# Replace $INDIAN_API_KEY with your key (do NOT commit the key).
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/stock?name=RELIANCE"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/trending"
curl -H "X-Api-Key: $INDIAN_API_KEY" "https://stock.indianapi.in/NSE_most_active"
```

Keys must never land in source control. See `.env.example` for the full list of env vars read by the provider and adapters.
