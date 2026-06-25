# Quant Intelligence Platform — Release Gate

## Scope

Eight systems: AI Research Assistant, Strategy Recommendation Engine, Portfolio Optimizer,
Sector Rotation, News Sentiment, Event Risk Detection, Enterprise Reports, Public API Platform.

## Acceptance Criteria

| System | Criteria | Status |
|--------|----------|--------|
| Research Assistant | Explainable responses, risk warnings, underlying data refs | Met |
| Recommendation Engine | Regime-aware, confidence scoring, strategy ranking | Met |
| Portfolio Optimizer | Allocation suggestions, risk calcs, diversification metrics | Met |

## Database Tables

| Table | Purpose |
|-------|---------|
| `research_reports` | AI research reports |
| `strategy_recommendations` | Ranked regime-aware recommendations |
| `portfolio_allocations` | Optimization targets + metrics |
| `sentiment_scores` | News sentiment snapshots |
| `event_risk_scores` | Event risk assessments |

MySQL runtime DDL: `ensureQuantTables()` in `src/lib/quant-platform/repository/quantRepository.ts`  
Postgres migration: `migrations/postgres/031_quant_platform.sql`

## APIs

| Method | Endpoint |
|--------|----------|
| POST | `/api/research` |
| GET | `/api/recommendations` |
| POST | `/api/portfolio/optimize` |

Aliases: `/api/quant/*`, `/api/public/v1/*`

## UI

`/quant` — AI Research Assistant, Strategy Recommendations, Portfolio Optimizer,
Enterprise Reports, API Management.

## Monitoring

All `/api/research`, `/api/recommendations`, `/api/portfolio/optimize`, and `/api/quant/*`
routes use `withApiHandler` → automatic `apiMonitor` + trace integration.
View: `/debug/system-health`, `/admin/reliability`.

## Rollback Plan

### Application (code)

```bash
git revert <merge-commit>
npm run build && pm2 restart quantorus365-app
```

### Postgres schema

```bash
psql "$POSTGRES_URL" -v rollback.allow=1 -f migrations/postgres/031_quant_platform_rollback.sql
```

### MySQL runtime tables

Tables are created via `CREATE TABLE IF NOT EXISTS` and are non-destructive.
To drop manually:

```sql
DROP TABLE IF EXISTS event_risk_scores, sentiment_scores, portfolio_allocations,
  strategy_recommendations, research_reports;
```

## Test Commands

```bash
# Full release gate (recommended before merge)
npm run test:release-gate

# Individual checks
npm run typecheck
npm run lint
npm run build
npm run test:quant          # Quant acceptance tests (45 checks)
npm run test:billing
npm run test:reliability
npm run test:admin-monitoring
npm run test:security
npm run test:pipeline       # Integration pipeline test (96 checks)

# Vitest suite (broader UI/provider contracts — separate from phase gate)
npm run test
```

Note: `npm run test` (vitest `*.vitest.ts`) may have pre-existing failures in
dashboard UI contract and market-data provider tests unrelated to quant platform.
Phase acceptance tests (`test:quant`, `test:pipeline`, etc.) are the merge gate.

## Secrets

- API keys stored as SHA-256 hashes only (`api_keys.key_hash`)
- Raw keys returned once on creation; never logged
- No secrets in source control (`.env` gitignored)
