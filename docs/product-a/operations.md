# Product A — Operations Overview (Phase 5)

## Objective

Phase 5 makes Product A production-ready through monitoring, release governance, operational tooling, security hardening, backup/recovery, and deployment automation — **without changing signal generation, scoring, ranking, learning algorithms, or API contracts**.

## Architecture

```
outcomeTracker → learningScheduler → adaptive pipeline (Phase 4)
        ↓
productionHealthCollector → health / dashboard / alerts APIs
        ↓
deploymentValidation → releaseGovernance → CI/CD gates
```

## Module Location

`src/lib/operations/`

| Module | Purpose |
|--------|---------|
| `productionHealthService.ts` | Pure health summary builder |
| `productionHealthCollector.ts` | Read-only DB/cache probes |
| `operationalDashboard.ts` | Dashboard KPI aggregation |
| `operationalAlerts.ts` | Alert evaluation (alerts only) |
| `releaseGovernance.ts` | Release manifest |
| `deploymentValidation.ts` | Pre-deploy gates |
| `backupRecovery.ts` | Backup plan + restore docs |
| `securityOperations.ts` | Secret/config integrity |
| `operationalReporting.ts` | JSON/CSV/Markdown reports |

## API Endpoints (new, non-breaking)

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/operations/health` | Session | Production health summary |
| `GET /api/operations/dashboard` | Session | Operational KPIs |
| `GET /api/operations/alerts` | Session | Active operational alerts |
| `GET /api/operations/release` | Session | Release manifest |

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run validate:deployment` | Pre-deploy validation (exit 1 on failure) |
| `npm run release:manifest` | Generate release manifest |
| `npm run backup:operational` | Export operational data |
| `npm run report:operations` | Full operational report |
| `npm run benchmark:operations` | Offline ops benchmark |

## Constraints

- No signal-engine logic changes
- No HTTP API breaking changes
- Operational schema additions only (no product schema changes)
- All changes backward compatible
