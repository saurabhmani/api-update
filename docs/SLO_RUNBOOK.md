# Quantorus365 — SLO & Operations Runbook

Single source of truth for service objectives, error budgets,
rollback procedures, and incident response. Operators should be
able to pick up an on-call shift from this doc alone.

---

## 1. Service Level Objectives (SLOs)

Targets are intentionally conservative for a system in transition.
Tighten only after 30 days of clean data.

### Market Data Ingestion Service

| Indicator | Target | Measurement window | Budget (30d) |
|---|---|---|---|
| `/snapshot` availability | 99.5% | 30 days rolling | ~3h 37m outage |
| `/snapshot` p95 latency | < 500ms | 30 days | — |
| `source=kite` ratio during market hours (09:30-15:30 IST) | > 85% | per trading day | — |
| `data_quality='stale'` responses | < 0.5% of total | 30 days | — |
| Scheduler pass success rate | > 98% of scheduled passes | 30 days | 3 failed passes/day max |

### Market Intelligence Service

| Indicator | Target | Measurement window |
|---|---|---|
| `/news` availability | 99.0% | 30 days |
| `/news` p95 latency | < 1000ms | 30 days |
| News dedup ratio (same title/day) | > 95% collision catch | 30 days |

### Alerting Service

| Indicator | Target | Measurement window |
|---|---|---|
| Alert eval availability | 99.9% | 30 days |
| Alert eval p95 latency (bus event → alert.triggered) | < 200ms | 30 days |
| False-positive rate (oscillation triggers) | < 0.1% of alerts | 30 days |

### Signal Engine / Portfolio / Identity / Reporting

Each follows the same pattern — 99.0% availability, p95 per-route
latencies documented in service README. Add specific SLOs as these
services accumulate production traffic.

### Database / Provider (shared)

| Indicator | Target |
|---|---|
| Postgres primary availability | 99.9% |
| MySQL availability (during dual-write) | 99.5% |
| IndianAPI 2xx rate | > 99.0% |
| Provider circuit-breaker open duration | < 0.5% of market hours |

---

## 2. Error Budget Policy

If a service burns **50%** of its monthly error budget in a single
week, treat as an escalation:
- Freeze non-critical deploys to that service for 48 hours.
- File a mini-postmortem within 24 hours even if the incident is "closed".

If a service burns **100%** of its monthly budget:
- HARD FREEZE all deploys until the next 30-day window begins.
- Only security fixes + rollbacks allowed.

---

## 3. Health Signals

Every service exposes `GET /health` returning the canonical
`HealthResponse`. Green/yellow/red:

| Status | Meaning | Action |
|---|---|---|
| `ok` | All dependencies OK | None |
| `degraded` | At least one dep reports `degraded` (e.g. breaker half-open, DLQ non-empty) | Page during market hours only |
| `down` | At least one dep is `down` | Page immediately, regardless of time |

Poll cadence: 10s from load balancer, 30s from monitoring. A
service that returns `down` for 3 consecutive polls should be
removed from rotation.

### Key dashboards (wire these in your monitoring tool)

- **Provider mix over time** — stacked line of `source` in scheduler runs. Expect kite-dominant during market hours.
- **Provider circuit breaker state** — heatmap per provider.
- **Stale-data rate** — `data_quality='stale'` count per 10-min bucket.
- **Bus DLQ depth** — per-service DLQ size.
- **Scheduler run duration + success rate** — from `ops.scheduler_runs`.
- **IndianAPI rate-limit remaining** — adapter should log this in response headers (TODO: wire).

---

## 4. Incident Response Playbook

### P1 — Signals stopped firing / no data for >5 min during market hours

1. Check **Kite WebSocket status** via `curl http://localhost:4100/health` (market-ingestion). If `kite` dependency is `down`:
   - Check `KITE_API_KEY` / `KITE_API_SECRET` validity.
   - Check `/api/kite/status` on the Next.js app.
   - If token expired, hit `/api/kite/login` and follow the re-auth flow.
2. If Kite is healthy but signals empty, check `ENFORCE_PROVIDER` — if `throw` and there's a broken mapping in a legacy helper, requests will 5xx. Flip temporarily to `warn` while investigating.
3. Check `[provider-enforcer] BYPASS` lines in app logs — a recent deploy may have reintroduced a direct vendor call.

### P2 — Dual-write inconsistency detected

1. Run `npm run db:validate:data -- --since=60m` — get the mismatch list.
2. If mismatches are in <1% of rows and all recent: likely a temporary provider blip. Re-run validation after 30 min.
3. If mismatches are growing: **disable dual-write** by unsetting `MYSQL_DUAL_WRITE_TABLE`, then reconcile PG from MySQL via `npm run db:backfill:pg -- --since=1h`.

### P3 — Scheduler silent

1. Check `ops.scheduler_runs` — when was the last row?
2. If >30 min old during market hours: the Node process is dead.
   - PM2: `pm2 restart scheduler`.
   - docker compose: `docker compose restart market-ingestion`.
3. Confirm with `curl http://localhost:4100/health` immediately after.

### P4 — High `data_quality='stale'` rate

Means Kite + IndianAPI + Yahoo all failed and we served from DB.
1. Check `ops.provider_health_logs` — which provider is failing?
2. If IndianAPI specifically: check rate limits / API key / status page.
3. If all three: the app has a network problem, not a provider problem.

---

## 5. Rollback Procedures

### 5a. Application rollback (code)

```bash
# Revert to the previous prod tag
git checkout v<previous>
docker compose -f docker-compose.prod.yml up -d --build
# Watch /health + error rate for 10 min
```

### 5b. Rollback a feature flag

| Flag | Flip to | Effect |
|---|---|---|
| `ENFORCE_PROVIDER=throw` | `warn` or `off` | Stops throwing on bypasses (bypasses still logged) |
| `USE_POSTGRES=true` | `false` | Provider stops preferring PG; Yahoo takes the slot |
| `MYSQL_DUAL_WRITE_TABLE` | unset | PG-only writes (MySQL reverts to its own existing writers) |
| `ENABLE_KITE_ADAPTER=true` | `false` | Provider chain starts at IndianAPI — matches Phase-1 doc |

### 5c. Postgres schema rollback

**DESTRUCTIVE — backups first.**

```bash
# 1. Dump everything valuable first.
pg_dump -Fc --schema=market --schema=intel --schema=app "$POSTGRES_URL" > backup-$(date +%F).dump

# 2. Execute the guarded rollback.
psql "$POSTGRES_URL" -v rollback.allow=1 -f migrations/postgres/_rollback.sql

# 3. Re-apply from scratch.
npm run db:migrate:pg
```

### 5d. Full DB rollback (Phase 2)

If PG cutover goes sideways:
1. Set `USE_POSTGRES=false` in every service env, restart.
2. MySQL becomes authoritative again (it always was during dual-write).
3. Run `scripts/validatePg.ts` to confirm PG is still readable for forensics.
4. File postmortem; do not re-attempt cutover until root cause identified.

---

## 6. Deployment gates (pre-flight checklist)

Before any Phase-1 → Phase-2 → Phase-3 promotion, all of these must
be green:

- [ ] `npm run lint` — zero errors
- [ ] `npm run test:unit` — all vitest suites pass
- [ ] `npm run db:check:pg` — schema green, 0 missing tables
- [ ] `npm run check:provider` — zero bypass violations
- [ ] `npm run db:sql-lint` — report reviewed (not necessarily zero — reviewed)
- [ ] 48h of `ENFORCE_PROVIDER=warn` with no new `BYPASS` lines in logs
- [ ] Dual-write validation (`npm run db:validate:data`) shows zero mismatches over the last 24h
- [ ] Health endpoints all return `ok` or `degraded` (not `down`)

---

## 7. Contact & Escalation

| Role | When to page | Response SLA |
|---|---|---|
| On-call engineer | Any `down` status, any P1/P2 | 15 min |
| Database lead | Dual-write mismatches, PG replication lag | 1 hour |
| Vendor management (IndianAPI/Kite) | Quota exhaustion, auth failures | Business hours |
| Product / Trading desk | Trading-flow impact | Immediate, business hours |

Update this table with real names and pager IDs before production.
