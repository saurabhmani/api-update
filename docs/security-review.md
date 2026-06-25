# Security Review — Quantorus365

**Version:** 2.1.0  
**Audit Date:** 2025-06-25  
**Classification:** Internal — Operator Use Only  
**Parent Document:** [architecture-audit.md](./architecture-audit.md)

---

## Executive Summary

| Category | Status |
|----------|--------|
| Hardcoded secrets in source | ✅ None detected |
| `.env` files in git | ✅ Gitignored |
| Session validation | ❌ Cookie presence only at middleware |
| API auth coverage | ⚠️ ~50% routes lack `requireSession` |
| Public ops endpoints | ❌ 9 routes bypass auth |
| Rate limiting on expensive ops | ❌ Limiters defined but unused |
| Debug endpoint exposure | ❌ High-risk internals accessible |
| SQL injection | ✅ Low risk (parameterized queries) |
| Build type safety bypass | ⚠️ `ignoreBuildErrors: true` |

**Overall Risk Rating:** **HIGH** — authentication gaps on expensive and sensitive endpoints require immediate remediation before enterprise deployment.

---

## 1. Secret Exposure Review

### 1.1 Source Code Scan

| Pattern | Result |
|---------|--------|
| `sk-*` API keys | None in committed source |
| `AKIA*` AWS keys | None |
| `ghp_*` GitHub tokens | None |
| Hardcoded passwords | None (seed passwords read from env) |
| JWT secrets in code | None |

### 1.2 Environment Files

| File | Git Status | Risk |
|------|-----------|------|
| `.env` | Gitignored | Local only — operator responsibility |
| `.env.local` | Gitignored | Local only — contains live keys on disk |
| `.env.production` | May be committed as baseline | Review for placeholder-only values |
| `.cookies.tmp` | Should be gitignored | Session cookie scratch file |

**Recommendation:** Verify `.cookies.tmp` is in `.gitignore`. Never commit files with live `INDIAN_API_KEY`, `SESSION_SECRET`, or DB passwords.

### 1.3 Runtime Secret Leakage

| Vector | File | Severity | Detail |
|--------|------|----------|--------|
| Debug env check | `src/app/api/debug/env-check/route.ts` | HIGH | Exposes API key length + first 5 characters |
| Health endpoint | `src/app/api/health/route.ts` | MED | DB status, process PID, memory |
| Auth console logs | `src/services/auth.ts` | LOW | Logs user IDs on session creation |
| Signals route debug | `src/app/api/signals/route.ts` | MED | Logs env var names (not values) in debug mode |

### 1.4 Encryption

| Item | File | Risk |
|------|------|------|
| TOTP secret storage | `src/lib/encryption.ts` | MED — falls back to `SHA-256(SESSION_SECRET)` if `ENCRYPTION_KEY` unset |
| Session signing | `SESSION_SECRET` | Required, min 32 chars recommended |

---

## 2. Authentication & Authorization

### 2.1 Middleware (`src/middleware.ts`)

**Current behavior:** Checks for non-empty `q200_session` cookie. Does NOT validate token against `auth.sessions` table.

**Impact:** Attacker setting `q200_session=1` passes middleware and reaches ~86 routes that lack `requireSession()`.

### 2.2 Public Routes (Middleware Bypass)

| Path | Risk |
|------|------|
| `/api/auth` | Expected (login/register) |
| `/api/health` | MED — leaks internals |
| `/api/engine-health/status` | LOW — status only |
| `/api/events` | **HIGH** — SSE broadcasts signals/news |
| `/api/market-data/health` | LOW |
| `/api/market-data/reseed` | **CRITICAL** — DB/cache mutation |
| `/api/market-data/bot` | MED — API quota burn |
| `/api/market-data/validate` | MED — cross-check endpoint |

### 2.3 Unauthenticated Expensive Operations

| Endpoint | Operation | Severity |
|----------|-----------|----------|
| `POST /api/scanner/custom-universe/run` | Full universe scan | HIGH |
| `POST /api/manipulation-engine/scan` | Manipulation scan + persist | HIGH |
| `POST /api/backtests` | Queue backtest run | HIGH |
| `POST /api/backtests/process-queue` | Drain backtest queue | HIGH |
| `POST /api/run-signal-engine` | Has `requireSession` but no rate limit | MED |

### 2.4 Admin Endpoints

| Endpoint | Protection |
|----------|-----------|
| `/api/admin/*` | `requireAdmin()` — returns 401 instead of 403 for non-admins |
| `/api/debug/*` | Cookie only — **should be admin-gated** |
| `/api/metrics` | No auth — **should be admin-gated or IP-restricted** |

### 2.5 Registration

- `POST /api/auth?action=register` creates users without invite gate
- `/register` page is public in middleware
- **Recommendation:** Disable in production via env flag `REGISTRATION_DISABLED=true`

---

## 3. Sensitive Configuration

### 3.1 Required Secrets (Production)

| Variable | Sensitivity | Validation |
|----------|-------------|------------|
| `SESSION_SECRET` | CRITICAL | Required, ≥32 chars |
| `MYSQL_PASSWORD` / `PGPASSWORD` | CRITICAL | DB access |
| `INDIAN_API_KEY` / `INDIANAPI_API_KEY` | CRITICAL | Market data quota |
| `ENCRYPTION_KEY` | HIGH | 64-char hex for TOTP |
| `REDIS_PASSWORD` | HIGH | Session cache |
| `SERVICE_AUTH_TOKEN` | HIGH | Inter-service auth |

### 3.2 Optional API Keys (News Feeds)

| Variable | Service |
|----------|---------|
| `GNEWS_API_KEY` | GNews |
| `NEWSDATA_API_KEY` | NewsData |
| `NEWSAPI_KEY` / `NEWSAPI_API_KEY` | NewsAPI |
| `FINNHUB_API_KEY` | Finnhub |
| `SOCIAL_SIGNALS_API_KEY` | Social signals |
| `DEALS_FEED_API_KEY` | Deals feed |

### 3.3 Dangerous Production Flags

| Variable | Risk if Set in Production |
|----------|--------------------------|
| `FORCE_MARKET_OPEN` | Bypasses market hours — blocked by `envSafetyLock` |
| `SEED_ADMIN_PASSWORD` | Warned at boot — remove after setup |
| `NEWS_ALLOW_DEMO_SEED` | Injects demo news data |
| `Q365_REGEN_24X7` | Signal regen outside market hours |
| `BYPASS_MARKET_HOURS` | Test-only market bypass |

**Guard:** `src/lib/startup/envSafetyLock.ts` blocks boot if dangerous combos detected in production.

### 3.4 Quota & Budget Variables

| Variable | Purpose |
|----------|---------|
| `INDIANAPI_PER_RUN_LIMIT` | Per-scan API call cap |
| `CANDLE_MAX_PER_CYCLE` | Candle fetch cap |
| `INDIANAPI_BUDGET_REDUCE_THRESHOLD` | Budget throttle (0.85) |
| `INDIANAPI_BUDGET_CRITICAL_THRESHOLD` | Budget halt (0.95) |

---

## 4. Data Security

### 4.1 SQL Injection

- Application queries use `?` parameterized placeholders
- Dynamic SQL in `decisionTraceBuilder.ts` builds clauses from hardcoded templates only
- Migration DDL uses controlled table/column names
- **Risk:** LOW

### 4.2 Redis

- Password encoded in connection URL (`src/lib/pipeline/streams.ts`)
- `REDIS_DISABLED=true` falls back to DB-only sessions (slower, not less secure)

### 4.3 CORS & Headers

- `NEXT_PUBLIC_APP_URL` used for canonical origin
- Nginx reverse proxy on VPS — ports 3000/5000/5001 not publicly exposed

---

## 5. Monitoring & Logging Risks

| Issue | Location | Severity |
|-------|----------|----------|
| `console.log` in hot API paths | `signals/route.ts` (69 calls), `run-signal-engine` (55) | MED — may leak context to PM2 logs |
| Structured logger underused | Only ~30 routes use `withApiHandler` | MED |
| Auth events to console | `auth.ts` | LOW |
| Verbose middleware | `LOG_VERBOSE_MIDDLEWARE=1` | LOW — path logging |

---

## 6. Risk Register

| ID | Finding | Severity | Likelihood | Impact | Priority |
|----|---------|----------|------------|--------|----------|
| SEC-001 | Middleware cookie presence check | Critical | High | Full API access with fake cookie | P0 |
| SEC-002 | Public `/api/market-data/reseed` | Critical | Medium | Data corruption | P0 |
| SEC-003 | Public `/api/events` SSE | High | High | Signal/news leak | P0 |
| SEC-004 | Unauthenticated backtest/scanner triggers | High | Medium | Resource exhaustion | P1 |
| SEC-005 | Debug endpoints expose internals | High | Medium | Key metadata leak | P1 |
| SEC-006 | Open registration | High | Medium | Unauthorized accounts | P1 |
| SEC-007 | `/api/metrics` unauthenticated | Medium | Low | Infra fingerprinting | P2 |
| SEC-008 | Unused rate limiters | Medium | High | Quota abuse | P1 |
| SEC-009 | `ignoreBuildErrors: true` | Medium | Medium | Type-unsafe deploys | P2 |
| SEC-010 | ENCRYPTION_KEY fallback | Medium | Low | Weaker TOTP protection | P2 |
| SEC-011 | Health endpoint detail level | Low | High | Reconnaissance | P2 |
| SEC-012 | `.cookies.tmp` on disk | Low | Low | Session cookie exposure | P3 |

---

## 7. Remediation Plan

### P0 — Immediate (Before Enterprise Launch)

1. Validate session token in middleware (DB lookup + expiry check)
2. Remove `/api/market-data/reseed` from `PUBLIC_PATHS`; require `requireAdmin`
3. Authenticate `/api/events` SSE stream
4. Add `requireSession` to all non-public API routes

### P1 — Short Term (2 weeks)

5. Gate `/api/debug/*` and `/api/metrics` behind `requireAdmin`
6. Add `requireSession` + `pipelineLimiter` to scanner, backtest, manipulation scan
7. Disable open registration in production (`REGISTRATION_DISABLED`)
8. Replace `console.log` in `signals/route.ts` with structured logger

### P2 — Medium Term (1 month)

9. Remove `ignoreBuildErrors: true` after null-safety refactor
10. Set dedicated `ENCRYPTION_KEY` in all environments
11. Reduce `/api/health` response detail for public callers
12. Wire `apiLimiter` on all authenticated routes

---

## 8. Compliance Checklist

| Control | Status |
|---------|--------|
| Secrets not in source control | ✅ |
| Secrets not in build artifacts | ✅ (env at runtime) |
| Auth on admin operations | ⚠️ Partial |
| Auth on data mutation | ❌ Gaps on reseed, backtest |
| Audit logging | ✅ `auth.audit_logs`, `auditLogService` |
| Rate limiting | ❌ Defined but not wired |
| Input validation | ⚠️ Manual, no Zod schemas |
| Dependency scanning | ❌ Not configured in CI |
| HTTPS termination | ✅ Nginx on VPS |

---

*Remediation tracked in [implementation-roadmap.md](./implementation-roadmap.md) Phase 0.*
