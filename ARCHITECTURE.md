# System Architecture

## 1. Document Purpose

This document is the operational architecture map for Quantorus365. It is for developers, operators, reviewers, and AI coding agents who need to understand the repository before changing it. It describes implemented code and committed configuration; the current codebase is authoritative whenever another document disagrees.

**Last reviewed:** 2026-07-29

Labels used here:

- **Not verified**: the repository does not provide enough evidence.
- **Inferred from code**: behavior is strongly indicated but was not exercised against live infrastructure.
- **Legacy or potentially unused**: code/configuration exists, but the active production path is not established.

No environment values or credentials are reproduced.

## 2. System Overview

Quantorus365 is a web-based Indian-market intelligence and trading-support platform. It provides market data, ranked opportunities, signals, backtesting, portfolio/risk tools, manipulation surveillance, news intelligence, paper trading, broker connectivity, administration, and a public corporate site. Primary consumers are authenticated users, administrators, operators, public API clients, and browser visitors.

The main implementation is a full-stack Next.js application:

- 75 App Router pages under `src/app/`.
- 331 App Router API route files under `src/app/api/`.
- A custom production Node entry, `server.js`, that hosts Next.js and supervises workers.
- Domain code in `src/lib/` and orchestration/services in `src/services/`.
- MySQL as the dominant application database, Redis as an optional cache/live-data store, and PostgreSQL migration/service infrastructure alongside it.
- Separate HTTP services and shared packages under `services/` and `packages/`. Docker Compose wires these to PostgreSQL, but the committed PM2 production path runs the Next.js monolith. Therefore these are **Legacy or potentially unused** in the primary deployment.

```mermaid
flowchart LR
  U["Browser / API consumer"] --> N["Nginx"]
  N --> A["Next.js app via server.js"]
  N --> W["WebSocket stream"]
  A --> M["MySQL"]
  A --> R["Redis (optional)"]
  A --> K["Kite / broker integrations"]
  A --> X["Market, news, email and alert providers"]
  S["Scheduler and one-shot workers"] --> M
  S --> X
  A --> S
  D["Docker Compose services (legacy or alternate topology)"] --> P["PostgreSQL"]
```

Main runtime environments are local Next development, built Node/PM2 behind Nginx, CI on Node 20, and alternate Docker Compose development/production stacks.

## 3. Technology Stack

| Area | Technology or library | Purpose | Configuration/source |
|---|---|---|---|
| Languages | TypeScript, JavaScript, SQL, SCSS | Application, runtime entry, migrations, styling | `tsconfig.json`, `server.js`, `migrations/`, `src/styles/` |
| Runtime | Node.js 20 in CI | Server, workers, scripts | `.github/workflows/ci.yml` |
| Web framework | Next.js 16.2.9, App Router; React 18.3 | SSR/client UI and route handlers | `src/app/`, `next.config.js` |
| Client data | TanStack React Query 5 | Server-state fetching/caching | `src/providers/QueryProvider.tsx`, `src/hooks/` |
| Local/global UI state | React hooks and context | Auth and component state | `src/hooks/useAuth.tsx`, components |
| Styling | Sass/SCSS, CSS modules, global SCSS | UI styling | `src/styles/`, `*.module.scss` |
| Charts/UI | Recharts, Framer Motion, Lucide, React Icons | Visualization and interaction | `src/components/` |
| Main database | MySQL 8-compatible via `mysql2` | Runtime persistence | `src/lib/db.ts`, `src/lib/db/` |
| Secondary database | PostgreSQL via `pg` | Migration target and service topology | `migrations/postgres/`, `src/lib/db/postgres/`, Compose |
| Cache/stream state | Redis via `ioredis` | Optional cache, quotes, sessions, coordination | `src/lib/redis.ts` |
| Authentication | DB sessions, `bcryptjs`, `speakeasy`, AES utilities | Password login, cookie sessions, TOTP MFA | `src/services/auth.ts`, `src/lib/session.ts` |
| WebSocket | `ws` | Live tick fan-out | `src/lib/ws/`, `src/instrumentation.ts` |
| Scheduling | `node-cron`, worker processes | Scans, learning, manipulation and maintenance | `server.js`, `src/lib/workers/`, `src/lib/cron/` |
| Email/alerts | Mailjet API, Resend API, Nodemailer, Slack webhook | Contact mail and operational alerts | `src/app/api/contact/route.ts`, `src/lib/reliability/alertDelivery.ts` |
| Market/broker | Kite Connect, Shoonya HTTP/WebSocket code, Yahoo/NSE fallback | Quotes, history, streaming, order/broker paths | `src/lib/kite/`, `src/lib/broker/`, `src/providers/` |
| Testing | Vitest 4, Testing Library, direct `tsx` suites | Unit, integration, component and contract tests | `vitest.config.ts`, `src/__tests__/` |
| Build/tooling | Next build/webpack, TypeScript 6, ESLint 8, `tsx`, `ts-node` | Build, checks, CLIs | `package.json`, `next.config.js` |
| Package management | npm, lockfile v3 | Reproducible dependencies | `package-lock.json` |
| Process/deployment | PM2, Nginx, Docker Compose, Docker | VPS and alternate container topology | `ecosystem.config.js`, `nginx.conf`, Docker files |
| CI | GitHub Actions | Blocking and non-blocking gates | `.github/workflows/ci.yml` |
| Logging/monitoring | Custom JSON logger and internal monitors | Structured logs, performance and health | `src/lib/logger.ts`, `src/lib/monitor/`, `src/lib/reliability/` |

Dependencies present but not proven as primary abstractions include `winston`, `axios`, `nodemailer`, and `node-mailjet`; direct `fetch` and the custom logger are common.

## 4. Repository Structure

Generated `.next/`, `node_modules/`, caches, local environment files, and data artifacts are omitted.

```text
.
├── .github/workflows/ci.yml       # CI gates
├── docs/                          # Runbooks, audits and domain documentation; may lag code
├── migrations/
│   ├── mysql/                     # Numbered MySQL migrations
│   └── postgres/                  # Schema-oriented PostgreSQL migrations/proposals
├── packages/
│   ├── contracts/                 # Shared API/event/correlation contracts
│   ├── eventbus/                  # In-process event bus package
│   └── rpc/                       # Internal HTTP/RPC client package
├── public/                        # Static web assets
├── scripts/                       # 144 operational, migration, validation and benchmark CLIs
├── services/                      # Alternate/decoupled Node HTTP services
│   ├── _shared/                   # Service HTTP and environment helpers
│   ├── identity/                  # PostgreSQL-backed identity service
│   ├── market-ingestion/          # Ingestion service
│   ├── market-intelligence/       # News/intelligence service
│   ├── alerting/                  # Alert rule service
│   ├── signal-engine/             # Signal service
│   ├── portfolio/                 # Portfolio service
│   └── reporting/                 # Reporting service
├── src/
│   ├── app/                       # App Router pages, layouts and API handlers
│   ├── components/                # Presentation grouped by feature
│   ├── content/                   # Corporate-site content
│   ├── data/                      # Bundled universe/reference datasets
│   ├── hooks/                     # React Query and UI hooks
│   ├── lib/                       # Domain, persistence and infrastructure modules
│   ├── pages/                     # Pages Router `_document` and `_error` compatibility files
│   ├── providers/                 # React provider plus market-provider interfaces/adapters
│   ├── scripts/                   # Source-level data validation/backfill scripts
│   ├── services/                  # Application orchestration/service modules
│   ├── styles/                    # Global and module SCSS
│   ├── types/                     # Shared domain/view types
│   ├── __tests__/                 # Main test suites and diagnostic test scripts
│   ├── instrumentation.ts         # Node boot instrumentation
│   └── proxy.ts                   # Next request proxy/route-presence gate
├── server.js                      # Production HTTP + worker supervisor entry
├── package.json                   # Scripts and dependency manifest
├── next.config.js                 # Next/webpack server bundling
├── tsconfig.json                  # TypeScript and aliases
├── vitest.config.ts               # Test discovery/runtime
├── Dockerfile.nextjs
├── docker-compose.*.yml
├── ecosystem.config.js
└── nginx.conf
```

`src/lib/` is organized by domains (`signal-engine`, `signals`, `marketData`, `portfolio`, `backtesting`, `manipulation-engine`, `news-engine`, `billing`, `broker`, `security`, `reliability`) plus infrastructure (`db`, `ws`, `workers`, `cron`, `monitor`, `startup`). UI/API consumers should use these domain entry points rather than duplicating their SQL or rules.

## 5. Application Entry Points

| Entry | Exact path/command | Role |
|---|---|---|
| Browser root | `src/app/layout.tsx`, `src/app/page.tsx` | Root metadata, global providers/styles and landing page |
| Nested browser layouts | `src/app/dashboard/layout.tsx`, `src/app/login/layout.tsx`, `src/app/data-source/layout.tsx`, `src/app/settings/data-sources/layout.tsx` | Route-specific layout boundaries |
| API | `src/app/api/**/route.ts` | Next Route Handlers exporting HTTP methods |
| Production server | `server.js` via `npm run start:server` | Loads env, starts Next HTTP, supervises workers |
| Standard Next server | `npm start` | `next start -p 3000`; does not use the custom supervisor |
| Boot instrumentation | `src/instrumentation.ts` | Environment/safety checks, schema/provider/live-stream initialization |
| Long-running scheduler | `src/lib/workers/scheduler.ts` | Scheduled domain work |
| One-shot workers | `src/lib/workers/manipulationScannerCli.ts`, `src/lib/workers/learningScheduler.ts` | Daily supervised jobs |
| Other worker CLIs | `src/lib/workers/newsIngestionScheduler.ts`, `src/lib/ws/streamServerCli.ts` | Standalone news and WebSocket processes |
| Operational CLIs | `scripts/*.ts`, `src/scripts/*.ts` | Backfill, verification, reports, repair and migration |
| Alternate services | `services/*/src/server.ts` | Docker/service topology HTTP entries |
| Test entry | `vitest.config.ts`, `src/__tests__/` | Vitest discovery; some `.test.ts` files run through `tsx` scripts |
| Build entry | `npm run build` | Next production build with webpack |

## 6. Core Architecture and Module Boundaries

### Presentation and client data

`src/app/` owns URL composition and server/client rendering. Interactive components declare `"use client"` and generally use hooks from `src/hooks/`. `src/providers/QueryProvider.tsx` creates the React Query client; `src/hooks/useAuth.tsx` owns the browser auth context. Components in `src/components/` should not access MySQL or server-only integration code.

### Route/API layer

`src/app/api/**/route.ts` parses HTTP input, performs per-handler auth, calls services/domain modules, and serializes a response. `withApiHandler` in `src/lib/apiHandler.ts` supplies request IDs, logging, normalized errors and monitoring, but adoption is not universal. Many handlers retain local `try/catch` and `NextResponse.json`.

### Application services

`src/services/` coordinates multi-module use cases such as decisions, portfolios, rankings, market intelligence, alerts and broker/data synchronization. Consumers are API routes and workers. Services may cause database writes and provider calls.

### Domain and persistence

`src/lib/` contains both business rules and infrastructure; the repository is not strictly layered. Important boundaries include:

| Module | Responsibility/public entry | Data/side effects | Constraints |
|---|---|---|---|
| Signals read path | `buildSignalsResponsePayload` in `src/lib/signals/responseAssembly.ts` | Reads signal/snapshot and market state | Do not make `/api/signals` an implicit full scan |
| Signal write path | `src/lib/signal-engine/`, `src/app/api/run-signal-engine/route.ts` | Reads candles; writes candidates, runs and diagnostics | Promotion is a separate maturity step |
| Promotion | `runSignalMaturityWorker` in `src/lib/cron/signalMaturity.ts` | Scores maturity and writes confirmed snapshots | Preserve stability/data-quality gates |
| Market resolver | `resolveBatch`, `resolveSingle`, `resolvePrice` in `src/lib/marketData/resolver/marketDataResolver.ts` | Cache/provider/network reads; quality metadata | Use resolver instead of bypassing provider policy |
| Database | `db.query`/`getDb` in `src/lib/db.ts` | MySQL pool and compatibility SQL conversion | Server-only; parameterize values |
| Cache | `cacheGet`, `cacheSet`, quote helpers in `src/lib/redis.ts` | Redis or no-cache fallback | Redis may be disabled/unavailable |
| Auth/security | `src/services/auth.ts`, `src/lib/session.ts`, `src/lib/security/` | Users, sessions, MFA, audit/security events | Route handlers must explicitly guard sensitive work |
| Broker/execution | `src/lib/broker/`, `src/lib/execution/`, `src/lib/kite/` | Token storage, provider calls, orders | Encryption keys, kill switches and user scoping are security boundaries |
| Portfolio/paper/billing | corresponding `src/lib/*` directories | Positions, orders, risk, subscriptions, wallet | Maintain account/user ownership checks |
| Reliability | `src/lib/reliability/`, `src/lib/monitor/` | Health snapshots, audit, alerts, outbound notifications | External failures must not leak secrets |

### Shared packages and alternate services

`packages/contracts`, `packages/eventbus`, and `packages/rpc` support the `services/` topology and path aliases in `tsconfig.json`. Docker Compose starts several service entries against PostgreSQL. The PM2 configuration only starts `server.js`, so using these as the primary runtime is **Not verified**.

## 7. Request and Execution Flows

### Production startup

1. PM2 starts `server.js` using `ecosystem.config.js`.
2. `server.js` loads the selected dotenv file and a secondary `.env.production` source without overriding existing values.
3. It forces production mode unless `Q365_CUSTOM_SERVER_DEV=1`, disables duplicate in-process scheduler ownership, prepares Next, and binds the HTTP server.
4. Next invokes `register` in `src/instrumentation.ts` for Node-only boot work: safety/env checks, schema/provider setup, and live market/stream initialization.
5. After HTTP bind succeeds, `server.js` starts the long-running scheduler and registers daily manipulation and learning jobs.
6. PM2 restarts the parent on failure; `server.js` supervises its worker children and handles shutdown.

Failure behavior is logged to stdout/stderr and PM2 files. Some instrumentation boot steps are budgeted or warn/fallback; critical environment/safety failures can abort boot.

### Authentication

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as /api/auth
  participant S as auth service
  participant DB as MySQL
  participant C as Redis (optional)
  B->>A: POST email/password
  A->>S: loginUser(...)
  S->>DB: read user, compare bcrypt hash
  alt TOTP enabled
    A-->>B: MFA challenge
    B->>A: POST MFA token
  end
  S->>DB: insert user_sessions
  A-->>B: HttpOnly q200_session cookie
  B->>A: protected request
  A->>C: session cache lookup
  A->>DB: session/user lookup on miss
```

`src/proxy.ts` checks cookie presence for configured protected browser paths and redirects to login, but it does not replace authorization. API handlers use `requireSession`, `requireAdmin`, or `requirePermission` from `src/lib/session.ts`. Session lookups cache the resolved user for 300 seconds. Logout invalidates the DB session and deletes the cookie.

### Signals

The write flow is triggered by scheduled/manual scan entry points. The signal engine reads universe/candles/provider data, evaluates strategies and gates, and persists run/candidate state. `runSignalMaturityWorker` later re-evaluates stability and promotes eligible records to confirmed snapshots. `/api/signals` calls read-path assembly and returns filtered confirmed/displayable data; it should not own scan work. Failures are exposed through health/recovery metadata and API errors.

### Contact form

`src/components/corporate/ContactForm.tsx` validates browser fields and posts JSON to `src/app/api/contact/route.ts`. The handler trims/validates input, silently accepts honeypot submissions, requires Mailjet configuration, escapes user text, and sends both the internal enquiry and submitter acknowledgement in one Mailjet API request. Provider/configuration failures return 5xx JSON; the component displays the returned error or success state. No contact record is persisted.

### Broker and trading

Browser/API requests enter `src/app/api/kite/`, `src/app/api/brokers/`, `src/app/api/broker/`, `src/app/api/paper*`, or `src/app/api/live-trading/`. Route guards identify the user, broker modules load encrypted connection tokens, risk/kill-switch checks gate execution, and adapters call external broker APIs. Orders/positions and audit state are persisted. Exact behavior differs by route; inspect the handler and its `src/lib/broker/` or `src/lib/paper-trading/` dependency before changes.

### Background jobs

`server.js` owns the long-running scheduler and UTC cron triggers for manipulation (13:00 UTC) and learning (15:00 UTC). `src/lib/workers/scheduler.ts` owns domain schedules including scans and data maintenance. Other scripts can run the same work manually; avoid duplicate production ownership. Worker failures are logged; long-running workers are restarted, while daily one-shot jobs are not retried by `server.js`.

## 8. Routing

Next App Router file-system routing is used. Dynamic segments include `[id]`, `[key]`, `[symbol]`, `[slug]`, and `[broker]`. Root and four nested layouts are listed in section 5. `src/proxy.ts` implements browser-route cookie gating and security/header behavior; API authorization remains handler-local.

### Browser route groups

| Group | Examples/source |
|---|---|
| Public corporate | `/`, `/about`, `/services/[slug]`, `/industries/[slug]`, `/technologies/[slug]`, `/insights/[slug]`, `/contact`, `/careers`, `/privacy`, `/terms` in `src/app/` |
| Identity/settings | `/login`, `/register`, `/settings`, `/settings/security`, `/settings/data-sources` |
| Market/intelligence | `/dashboard`, `/market/[key]`, `/stocks/[symbol]`, `/signals/[key]`, `/rankings`, `/news-intelligence`, `/dexter`, `/engines` |
| Trading/research | `/strategies/[id]`, `/strategies/lab`, `/backtesting`, `/paper`, `/portfolio`, `/trade-journal`, `/options/chain` |
| Operations/admin | `/admin/*`, `/debug/system-health`, `/signals/engine-health`, `/surveillance`, `/manipulation` |

### API inventory by boundary

| Cluster | Representative endpoints | Main implementation |
|---|---|---|
| Auth/user/security | `/api/auth`, `/api/auth/mfa`, `/api/user`, `/api/security/*`, `/api/admin/*` | route files plus `src/services/auth.ts`, `src/lib/security/` |
| Signals/engine | `/api/signals/*`, `/api/signal-engine/*`, `/api/run-signal-engine` | `src/lib/signals/`, `src/lib/signal-engine/` |
| Market/data | `/api/market/*`, `/api/market-data/*`, `/api/kite/*`, `/api/stocks/*`, `/api/canonical/*` | resolver, providers, canonical services |
| Strategy/backtest | `/api/strategies/*`, `/api/strategy-builder/*`, `/api/backtest*` | strategy hub/lab and backtesting modules |
| Portfolio/trading | `/api/portfolio/*`, `/api/risk/*`, `/api/paper*`, `/api/broker*`, `/api/live-trading/*` | portfolio, broker, execution and paper modules |
| Intelligence | `/api/news*`, `/api/manipulation*`, `/api/quant/*`, `/api/trust/*`, `/api/opportunities/*` | corresponding domain modules |
| Operations | `/api/health`, `/api/reliability/*`, `/api/operations/*`, `/api/monitor/*`, `/api/debug/*` | monitor/reliability/operations |
| Billing | `/api/billing/*`, `/api/subscription/*`, `/api/wallet/*`, `/api/usage` | billing and entitlement modules |
| Public/integration | `/api/public/v1/*`, `/api/openapi`, `/api/contact`, `/api/events` | public handlers and integrations |

There are 331 route files and 343 exported method handlers (219 GET, 98 POST, 10 PATCH, 9 DELETE, 7 PUT) at review time. Use `rg --files src/app/api -g 'route.ts'` for the authoritative exhaustive inventory.

## 9. Data Architecture

### Runtime database

`src/lib/db.ts` creates a global MySQL pool. Discrete `MYSQL_*` variables take precedence; `DATABASE_URL` is a compatibility fallback. `db.query` returns a PostgreSQL-like `{ rows }` shape and performs limited placeholder/SQL conversion. This convenience does not make all PostgreSQL SQL portable.

Schema creation is distributed across `src/lib/db/ensureAllSchemas.ts`, `ensureSchemasSafely.ts`, `migrate*.ts`, and domain repository migrators. `npm run db:ensure` invokes `src/lib/db/ensureSchemasCli.ts`. Numbered MySQL migrations live in `migrations/mysql/`.

### Secondary PostgreSQL architecture

`migrations/postgres/001_create_schemas.sql` onward define `auth`, `master`, `market`, `intel`, `app`, and `ops` schemas. `src/lib/db/postgres/migrate.ts` applies discoverable migrations. Files ending `.sql.proposal` are not normal applied migrations. Docker Compose services use PostgreSQL. Whether production dual-write/service mode is active is **Not verified**.

### Main entity families

| Family | Representative data | Ownership/evidence |
|---|---|---|
| Identity | users, sessions, password resets, MFA and role state | auth migrations, `src/services/auth.ts` |
| Market/master | instruments, securities, universes, candles, quotes, feed health | `src/lib/db/migrateMarketData.ts`, canonical/market repositories |
| Signals | runs, candidates, signals, confirmed snapshots, breakdowns, outcomes | signal-engine repositories and migrations |
| Strategy/backtest | definitions, versions, validations, deployments, runs, trades, metrics | strategy/backtesting repositories |
| Portfolio/trading | accounts, holdings, orders, positions, ledger, risk state | portfolio, paper-trading, broker modules |
| Intelligence | news, manipulation events/scores, rankings, recommendations | news/manipulation/ranking modules |
| Operations | audit, monitoring, alerts, reliability snapshots/deliveries | admin/security/reliability repositories |
| Commercial | subscriptions, plans, wallet/usage/invoices | billing migrations and repositories |

Relationships are numerous and partly created by runtime DDL; a single trustworthy full ER model is **Not verified**, so no complete ER diagram is asserted.

Writes generally use parameterized SQL in repositories/services. Some operations use explicit transactions (notably broker/security paths), but transaction use is not uniform. Validation occurs in route handlers, security helpers, and domain gates rather than a single schema library. Redis caches sessions, quotes/ticks and selected computed state. Local CSV/JSON/XLSX files seed/reference universes; no general object-storage integration was found.

## 10. State Management and Data Flow

- **Local UI state:** React `useState`, `useReducer`-style component logic, and form state.
- **Global browser state:** `AuthProvider` in `src/hooks/useAuth.tsx`.
- **Server state:** TanStack Query via `QueryProvider`; feature hooks under `src/hooks/` wrap API requests, polling and mutations.
- **Streaming state:** `useMarketStream`, `useLiveTick`, `useEventStream`, the WebSocket/tick bus, and Redis quote/tick helpers.
- **Persistent state:** primarily MySQL; PostgreSQL in the alternate service topology.
- **Caching:** React Query in the browser; Redis and module/global caches on the server. Cache TTLs are domain-specific. Redis absence degrades to DB/provider behavior where coded.
- **Mutation:** client hooks call API handlers; handlers authorize and invoke services/domain repositories; successful mutations invalidate/refetch client queries according to each hook.

There is no Redux-style centralized store. Do not treat cached market data as authoritative persistence.

## 11. Authentication and Authorization

`POST /api/auth` in `src/app/api/auth/route.ts` supports login, registration, MFA completion, and logout actions. `src/services/auth.ts` hashes passwords with bcrypt, creates opaque random session tokens, stores sessions in MySQL, and manages TOTP secrets and password resets. The cookie is `q200_session`, HttpOnly, same-site and secure according to route configuration.

`getSession` in `src/lib/session.ts` reads the cookie, checks Redis, then joins `user_sessions` and active `users`; resolved users are cached for 300 seconds. `requireSession`, `requireAdmin`, and `requirePermission` are the server authorization guards. RBAC permissions are sourced from `src/lib/security/rbac.ts`.

`src/proxy.ts` redirects unauthenticated browser navigation based on cookie presence. It is not a cryptographic/session-validity check. Every sensitive API route must still use a server guard and scope data by user. Admin pages/routes require extra care because route coverage is not globally enforced.

Broker tokens and TOTP secrets are encryption boundaries. Production validation requires a dedicated broker-token encryption key unless explicit legacy fallback is allowed. Never log cookies, passwords, MFA secrets, API keys, or broker tokens.

No third-party social identity provider is verified.

## 12. API and Integration Architecture

| Integration | Purpose/client | Configuration/auth | Error/retry/local notes |
|---|---|---|---|
| MySQL | Primary persistence through `src/lib/db.ts` | `MYSQL_*` or compatibility `DATABASE_URL` | Pool has bounded queue/connect timeout; query failures propagate |
| Redis | Cache/live state through `src/lib/redis.ts` | `REDIS_*`, `REDIS_DISABLED` | Optional; callers often fall back to DB/provider |
| Kite Connect | Quotes/history/streaming/broker session | `src/lib/kite/`, adapters; app credentials and user access token | Rate/freshness controls; OAuth callbacks under `/api/kite/auth/*` |
| Shoonya | Alternate data/broker auth | broker adapters/routes and `SHOONYA_*` | Conditional validation; timeouts/configurable URLs |
| NSE/Yahoo | Market-data fallback | resolver/provider adapters | Controlled by provider/fallback flags; Yahoo is emergency-oriented |
| News feeds | RSS and APIs in news engine | `NEWS*`, RSS URLs and optional API keys | Per-source fallbacks/health; demo seed is gated |
| Mailjet | Contact enquiry + acknowledgement via direct `fetch` | `MAILJET_*`, HTTP Basic to provider | Missing config 503; provider/message failure 502; no retry |
| Resend/email | Operational email alerts | `src/lib/reliability/alertDelivery.ts`, `RESEND_API_KEY`, `OPS_EMAIL_*` | Logs provider failures and reports delivery status |
| Slack | Operational alerts | `SLACK_OPS_WEBHOOK_URL` | Webhook failure logged; channel availability is configuration-driven |
| Internal services | `packages/rpc`, `SERVICE_AUTH_TOKEN`, `*_PORT` | Bearer-style service auth in service helpers | Alternate Compose topology; active use **Not verified** |
| WebSocket | Live market feed | `src/lib/ws/`, `STREAM_WS_*`, public WS vars | Disabled/fallback modes exist; Nginx proxies `/ws` |

Provider retry/circuit behavior is centralized in parts of `src/providers/resilience.ts`, but not every direct integration uses it. Inspect each client for timeout and retry semantics.

## 13. Configuration and Environment Variables

No `.env.example`-style file is committed. Local `.env.local`, `.env`, and `.env.production` files may exist but must never be copied into documentation. `server.js` chooses `DOTENV_CONFIG_PATH`, otherwise production `.env`, otherwise local `.env.local`/`.env`; it then loads `.env.production` as a non-overriding secondary source.

The table documents architecture-defining variables. Many domain thresholds also exist; discover them with `rg "process\\.env" src server.js services scripts`.

| Variable(s) | Req. | Purpose / used by | Safe format | Missing behavior |
|---|---|---|---|---|
| `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_DATABASE` | Required by validator | MySQL, `src/lib/db.ts` | hostname, username, database name | Startup validation error |
| `MYSQL_PASSWORD`, `MYSQL_PORT`, `MYSQL_POOL_SIZE` | Optional | MySQL auth/tuning | secret, `3306`, integer | Empty/default port/pool 30 |
| `DATABASE_URL` | Compatibility | MySQL URL fallback | `mysql://user:REDACTED@host/db` | Discrete vars required |
| `DATABASE_URL_PG`, `POSTGRES_URL`, `PG*` | Topology-dependent | PostgreSQL migrator/services | `postgres://...REDACTED...` | PG paths unavailable |
| `SESSION_SECRET` | Required | Sessions/crypto fallback | 32+ random chars | Startup validation error |
| `SESSION_MAX_AGE`, `MAX_SESSIONS_PER_USER` | Optional | Session lifecycle | seconds/integer | Code defaults |
| `ENCRYPTION_KEY` | Recommended | TOTP/general encryption | 64 hex chars | Warn; session-secret-derived fallback |
| `BROKER_TOKEN_ENCRYPTION_KEY` | Production required | Broker token encryption | 64 hex chars | Production error unless legacy override |
| `REDIS_HOST` or `REDIS_URL`; `REDIS_*` | Optional | Redis cache | host/URL, redacted password | DB-only/slower or disabled behavior |
| `NEXT_PUBLIC_APP_URL`, `APP_BASE_URL`, `APP_URL` | Production required as group | redirects/CORS/OAuth | `https://app.example.com` | Production validation error |
| `PORT`, `NEXT_PORT`, `HOST`, `NEXT_HOSTNAME` | Optional | HTTP bind | `5000`, hostname | `server.js` defaults |
| `STREAM_WS_PORT`, `STREAM_WS_DISABLED`, `NEXT_PUBLIC_STREAM_WS_*` | Optional | WebSocket server/client | port, boolean, URL | Defaults or streaming disabled |
| `KITE_API_KEY`, `KITE_API_SECRET`, `KITE_REDIRECT_URL` | Feature-dependent | Kite app/OAuth | redacted key/secret, HTTPS URL | Warning/fallback or auth unavailable |
| `SHOONYA_ENABLED`, `SHOONYA_CLIENT_ID`, `SHOONYA_SECRET_CODE`, `SHOONYA_*_URL` | Feature-dependent | Shoonya auth/data | boolean, redacted IDs, HTTPS URLs | Disabled; error if enabled without credentials |
| `MARKET_DATA_PROVIDER`, provider fallback/rate vars | Optional | Market resolver/provider policy | provider name, numeric thresholds | Kite-oriented defaults/fallback cascade |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET`, `MAILJET_FROM_EMAIL`, `MAILJET_TO_EMAIL` | Required for contact | `/api/contact` | redacted keys, `noreply@example.com` | Contact endpoint returns 503 |
| `RESEND_API_KEY`, `OPS_EMAIL_FROM`, `OPS_EMAIL_TO` | Optional | Reliability email | redacted key/email list | Email channel unavailable/log-only path |
| `SLACK_OPS_WEBHOOK_URL` | Optional | Reliability Slack alerts | `https://hooks.slack.com/...REDACTED` | Slack channel unavailable |
| `NEWS_PIPELINE_ENABLED`, `NEWSAPI_*`, `GNEWS_API_KEY`, `NEWSDATA_API_KEY`, RSS vars | Feature-dependent | News ingestion | boolean/redacted keys/HTTPS URLs | Sources disabled or fallback |
| `Q365_INPROC_SCHEDULER`, `Q365_INPROC_REGEN`, schedule/cron vars | Optional | Job ownership/schedules | `0`/`1`, cron string | Defaults; custom server forces scheduler off in Next |
| `EXECUTION_MODE`, `BROKER_ADAPTER`, kill-switch/risk vars | Required for live use | Execution safety | mode/name/numeric limits | Safe/default disabled behavior varies |
| `LOG_LEVEL`, `LOG_*`, monitor thresholds | Optional | Logging/monitoring | `info`, milliseconds/rates | Defaults |
| `SERVICE_AUTH_TOKEN`, `*_PORT` | Compose service-dependent | Internal services | redacted token, port | Services reject/unavailable |
| `SEED_*`, debug/force/bypass flags | Development only | Seed/debug tools | redacted/boolean | Feature off; production warnings/locks apply |

Never expose `NEXT_PUBLIC_*` values that are intended to be secret; those variables are bundled for the browser.

## 14. Error Handling, Logging, and Observability

`withApiHandler` (`src/lib/apiHandler.ts`) is the preferred route wrapper: it adds request IDs, structured context, typed-error mapping, monitoring and safe unexpected-error responses. Adoption is partial, so many handlers use local `try/catch` and `{ error: string }` responses. Consumers must check HTTP status and the route-specific shape.

`src/lib/logger.ts` is the primary structured JSON logger with levels, child context and deduplication. Direct `console.*` remains in boot code and some routes/workers. `src/lib/api/apiPerf.ts` tracks named steps/SQL for selected hot APIs. `src/lib/monitor/`, `src/lib/reliability/`, and engine-health modules expose internal metrics, snapshots, alerts and health endpoints.

Important health routes include `/api/health`, `/api/operations/health`, `/api/reliability/health`, `/api/market-data/health`, `/api/system/institutional-health`, and `/api/engine-health/status`. `src/instrumentation.ts` registers process-level rejection/exception logging. No third-party tracing/APM SDK is verified. User-facing errors are handled per component; no single global App Router error boundary file was found, while `src/pages/_error.tsx` provides Pages Router compatibility.

## 15. Testing Architecture

Vitest uses Node environment, 30-second test timeout, globals, the `@` alias, and discovery of `src/**/*.vitest.ts(x)` from `vitest.config.ts`. At review time there are 196 `*.vitest.*`/`*.test.*` files. `src/__tests__/` contains unit, integration, component/source-contract, health, architecture, pipeline and operational tests. Testing Library supports React component tests.

Some legacy `*.test.ts` suites are executable scripts run with `tsx`, not discovered by the Vitest include. Tests commonly mock modules/providers with Vitest; some scripts require real DB, credentials, running HTTP/WS services, seeded data, or market conditions. Read the target test and its package script before running it.

CI has:

- Blocking `typecheck`, lint, signals gate and build.
- Blocking operations, deployment, phase/domain test jobs.
- Non-blocking UI contract and full-suite jobs (`continue-on-error`).

Visible gaps: API wrapper/auth patterns are not uniform; live-provider and production topology behavior cannot be fully covered offline; the full suite and contract job are explicitly non-blocking. No coverage threshold is configured or claimed.

## 16. Build, Deployment, and Runtime Operations

Local development uses `npm run dev`. Production build uses `next build --webpack` with an 8 GiB Node heap. `next.config.js` externalizes Node/native packages and stubs Node built-ins for the edge instrumentation bundle; server-only imports must remain runtime-guarded.

The committed VPS path is Nginx -> PM2 -> `server.js`. PM2 runs one forked parent with memory/restart/log settings. Nginx proxies HTTP to port 5000 and `/ws` to 5001. `server.js` starts the scheduler child and daily one-shot workers only after the HTTP listener binds.

Docker provides an alternate topology. `docker-compose.dev.yml` starts PostgreSQL, selected services and Next dev; `docker-compose.prod.yml` includes PostgreSQL, seven services and Next.js. Whether Compose is used in a live deployment is **Not verified**. `services/Dockerfile` and `Dockerfile.nextjs` build the containers.

CI does not deploy. No committed automatic release/rollback workflow is verified. Operational backup/release/validation scripts exist, and PostgreSQL has `_rollback.sql`/a quant-platform rollback migration, but a complete production rollback mechanism is **Not verified**.

Database migrations are not shown as an automatic PM2 deploy step; operators must run the appropriate `db:*` command. Health checks exist in Compose and API routes.

## 17. Development Commands

| Task | Command | What it does | Prerequisites/cautions |
|---|---|---|---|
| Install | `npm ci` | Reproduce lockfile dependencies | Node/npm; deletes/recreates `node_modules` |
| Develop | `npm run dev` | Next development server | Local env; does not run custom worker supervisor |
| Type-check | `npm run typecheck` | `tsc --noEmit` | May update generated Next type references after a build |
| Lint | `npm run lint` | ESLint repository | None beyond install |
| Test | `npm test` | Full discovered Vitest suite | Some tests may need env/infrastructure |
| Core signal gate | `npm run test:signals-gate` | Blocking signal-contract suite | Used by CI |
| Build | `npm run build` | Production Next webpack build | Production-like environment |
| Standard start | `npm start` | Next server on port 3000 | Built `.next`; no custom workers |
| Production start | `npm run start:server` | Custom server and worker supervisor | Built app and runtime env |
| Ensure MySQL schema | `npm run db:ensure` | Runs schema ensure CLI | Valid MySQL; mutates schema |
| Run all migrations | `npm run db:migrate-all` | Runs multiple MySQL domain migrators | Backup/review; mutates schema |
| PostgreSQL migrate | `npm run db:migrate:pg` | Applies PostgreSQL migrations | PG connection; mutates schema |
| Scheduler | `npm run scheduler` | Standalone long-running scheduler | Avoid duplicate production ownership |
| News scheduler | `npm run news-scheduler` | Standalone ingestion scheduler | Provider/DB config |
| Manipulation scan | `npm run manipulation-scan` | One scan worker invocation | DB/data config |
| Candle preflight | `npm run candles:backfill:preflight` | Checks backfill readiness | Provider credentials may be needed |
| Candle backfill | `npm run candles:backfill:batch` | Mutating/resumable candle backfill | Provider quota and DB |
| DB status | `npm run db:status` | Inspect database state | DB connection |
| Deployment validation | `npm run validate:deployment` | Runs deployment checks | Can use offline mode where supported |

`package.json` is authoritative for the larger catalog of domain tests, validators, benchmarks, backfills and repair commands.

## 18. Code Conventions and Extension Guidelines

- TypeScript modules use camelCase; React components use PascalCase; hooks use `useX`; route files are `route.ts`; tests use `.vitest.ts(x)` or legacy `.test.ts`.
- `@/*` maps to `src/*`; package aliases map to `packages/*/src/*`.
- App Router pages live at `src/app/<path>/page.tsx`; dynamic segments use brackets.
- Interactive UI declares `"use client"`, uses feature components/hooks, and keeps server-only imports out of the bundle.
- API handlers validate input, guard authorization, call a service/domain module, and return JSON. Prefer `withApiHandler` for new handlers where its envelope is compatible.
- SQL uses parameter values and belongs in repositories/domain persistence code, not client components.
- SCSS modules are colocated or placed in `src/styles`; global styling is imported from root layout.
- Domain logic is generally function-based rather than class-heavy.

Common changes:

1. **Page:** add `src/app/<route>/page.tsx`; inspect root/nested layout, proxy protection, navigation and a similar page; add a hook/component test where applicable.
2. **API:** add `src/app/api/<route>/route.ts`; choose Node runtime if using Node-only code; add validation and `requireSession`/permission guard; call an existing service/repository; test method/status/error behavior.
3. **Database entity:** add an additive migration/ensure step in the owning domain, repository operations and types; update readers/writers together; run schema checks against a disposable database.
4. **Reusable component:** place it under the relevant `src/components/<feature>/`, keep data access in a hook, and add a component test for meaningful interaction.
5. **Integration:** create/extend a server-only adapter, centralize configuration/timeouts/error translation, expose it through a service, add health/observability and mocked tests.
6. **Test:** prefer `.vitest.ts(x)` for Vitest discovery; add explicit package scripts only for specialized gates or infrastructure-dependent runners.

## 19. Dependency and Boundary Rules

- Client components may import client-safe components, hooks, types and API clients; they must not import DB, crypto, filesystem, worker or secret-bearing modules.
- API routes/workers may import services and `src/lib/` domain/infrastructure modules.
- Prefer route -> service/domain -> repository/adapter direction. The existing repository has exceptions; do not create new UI-to-persistence shortcuts.
- Market data should flow through `src/lib/marketData/resolver/marketDataResolver.ts` and provider interfaces/adapters, preserving quality/fallback metadata.
- Signal writes/promotion/read assembly are separate boundaries. Do not bypass maturity/promotion by inserting displayable snapshots from a read route.
- Authorization must occur server-side even when `src/proxy.ts` protects the browser route.
- Broker tokens, MFA material and passwords must only cross security-controlled server boundaries.
- `src/lib/db.ts`, Redis, broker clients, and most integration code are server-only.
- Files generated by Next (`next-env.d.ts`, `.next/`) should not be hand-maintained as architecture sources.
- PostgreSQL services/packages and MySQL monolith code represent two topologies; do not mix their data access casually.
- Beware circular imports among broad `src/services/` and `src/lib/` modules; use narrow domain entry points and type-only imports where possible.

## 20. Known Risks, Technical Debt, and Ambiguities

| Evidence | Impact | Confidence | Suggested investigation |
|---|---|---:|---|
| 331 route files; partial `withApiHandler` adoption in `src/app/api/` | Inconsistent error envelopes/logging | High | Inventory wrapper adoption before cross-cutting API changes |
| Cookie-presence proxy plus handler-local guards (`src/proxy.ts`, `src/lib/session.ts`) | A missed guard can expose an endpoint | High | Add automated authorization inventory/contract tests |
| Runtime DDL across many `ensure*/migrate*` files plus numbered migrations | Schema ownership/order can drift | High | Generate a disposable-DB schema diff and designate canonical owners |
| MySQL runtime plus PostgreSQL services/migrations/Compose | Two architectures can diverge | High | Confirm deployed topology and dual-write status |
| `.sql.proposal` files in `migrations/postgres/` | Proposed schema may be mistaken for applied schema | High | Keep migrator discovery tests explicit |
| CI full suite and UI contracts are non-blocking | Regressions can merge despite those failures | High | Review failure history before making jobs blocking |
| `strict: false` and `strictNullChecks: false` in `tsconfig.json` | Runtime null/type errors are easier to miss | High | Incrementally tighten leaf modules |
| Custom PostgreSQL-to-MySQL SQL rewriting in `src/lib/db.ts` | Complex SQL may translate incorrectly | High | Test every compatibility pattern; avoid expanding implicit translation |
| No committed `.env.example` | Setup requires rediscovery and risks unsafe local files | High | Create a redacted generated environment template in a separate task |
| PM2 and Docker Compose both documented in code | Actual production topology unclear | Medium | Verify operator runbooks and live process inventory |
| Direct `console.*` and mixed logger usage | Uneven structured observability | High | Migrate non-boot paths to `src/lib/logger.ts` |
| `src/pages/_error.tsx` with App Router and no `src/app/error.tsx` found | App Router error UX may be route-default | Medium | Exercise render errors and decide on App Router boundaries |
| Large `scripts/` and diagnostic files under `src/__tests__/` | Operational commands may be mistaken for hermetic tests | High | Tag/document infrastructure prerequisites |
| Environment contains numerous debug/bypass/force flags | Unsafe combinations can alter production behavior | High | Maintain and test `src/lib/startup/envSafetyLock.ts` |

Whether Yahoo fallback, alternate services, and Docker Compose are used in production is **Not verified**. Some documentation under `docs/` describes intended or historical phases; treat it as **Legacy or potentially unused** until matched to code.

## 21. AI Coding Agent Guide

### Before making changes

- Read this document and inspect the directly involved files.
- Search for existing patterns before introducing new ones.
- Verify client/server boundaries.
- Check affected tests, schemas, types, routes and configuration.
- Treat code as authoritative when documentation conflicts with implementation.
- Check `git status` and preserve unrelated user changes.

### While making changes

- Prefer existing abstractions and conventions.
- Keep changes scoped and avoid duplicating business logic.
- Update related types, validation, tests and documentation.
- Do not access infrastructure or persistence through unapproved shortcuts.
- Do not add dependencies unless necessary.
- Never expose secrets or log security-sensitive data.

### After making changes

- Run relevant lint, type-check, tests and build commands.
- Recheck affected request/data flows and failure behavior.
- Update this file when architecture, boundaries, configuration, integrations or execution flows change.

### High-risk areas

- `server.js` and `src/instrumentation.ts`: boot order, worker ownership and duplicate cron risk.
- `src/lib/db.ts` and `src/lib/db/**`: runtime schema and SQL-dialect compatibility.
- `src/services/auth.ts`, `src/lib/session.ts`, `src/lib/security/**`, `src/proxy.ts`: identity and authorization.
- `src/lib/signal-engine/**`, `src/lib/cron/signalMaturity.ts`, `src/lib/signals/**`: separated write/promotion/read invariants.
- `src/lib/marketData/**`, `src/providers/**`: quotas, fallback order, freshness and data-quality attribution.
- `src/lib/broker/**`, `src/lib/execution/**`, live/paper routes: financial side effects, tokens and kill switches.
- `scripts/fix*.ts`, backfills and migrations: destructive or large-scale data changes.

### Fast navigation map

| Task | Start here | Also inspect |
|---|---|---|
| Add/change page | `src/app/<route>/page.tsx` | nearest layout, `src/proxy.ts`, components/hooks, navigation tests |
| Add API endpoint | nearest `src/app/api/**/route.ts` | `src/lib/apiHandler.ts`, session guard, service/repository, tests |
| Change authentication | `src/app/api/auth/route.ts` | `src/services/auth.ts`, `src/lib/session.ts`, `src/lib/security/`, `src/proxy.ts` |
| Change database entity | owning `src/lib/**/repository/` | `src/lib/db/ensureAllSchemas.ts`, domain migrator, migrations, all consumers |
| Change signals | `src/app/api/signals/route.ts` | response assembly, signal engine, maturity worker, signals gate tests |
| Change market data | `src/lib/marketData/resolver/marketDataResolver.ts` | provider flags/interfaces/adapters, health and provider tests |
| Change broker flow | relevant `src/app/api/broker*` or `kite` route | broker connections/adapters, encryption, risk/kill switch, integration tests |
| Change worker schedule | `server.js`, `src/lib/workers/scheduler.ts` | instrumentation in-process gates, cron modules, schedule tests/docs |
| Add integration | nearest adapter in `src/providers/` or `src/lib/` | env validation/safety, service caller, reliability/health, mocks |
| Change deployment | `ecosystem.config.js` or Compose | `server.js`, Nginx, Dockerfiles, CI, validation scripts |
| Add test | `src/__tests__/` or colocated `.vitest.ts` | `vitest.config.ts`, related package scripts and CI job |
| Diagnose production | `/api/health` implementation | reliability/engine health, logs, DB status and deployment config |

## 22. Architecture Verification Checklist

- [x] Repository structure
- [x] Entry points
- [x] Runtime boundaries
- [x] Main modules
- [x] Routes and APIs
- [x] Data model and migration ownership
- [x] Authentication and authorization
- [x] State management
- [x] External integrations
- [x] Environment variables without values
- [x] Error handling and observability
- [x] Tests and CI behavior
- [x] Build and deployment
- [x] Verified development commands
- [x] Known risks and ambiguities
- [x] AI-agent navigation guidance

Verification basis: repository-wide file inventory excluding dependencies/build output; direct inspection of manifests, runtime/configuration, route/page locations, auth/session/database/provider/signal code, migrations, workers, tests, CI, PM2, Nginx and Docker configuration. Counts are review-time snapshots; use repository search for current values. Live infrastructure, provider credentials, production data, and operator-only deployment state were not accessed.
