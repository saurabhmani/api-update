# Product A — Production Monitoring (Phase 5)

## Health Components

| Component | Monitors |
|-----------|----------|
| `market_data` | Candle warehouse freshness, probe latency |
| `scheduler_jobs` | `q365_learning_job_runs` (24h window) |
| `signal_generation` | Today's signal count + last run |
| `adaptive_pipeline` | Job H status + active parameter pointer |
| `database` | MySQL connectivity + latency |
| `cache` | Redis read/write probe |
| `filesystem` | Reports directory writability |
| `report_generation` | Report path availability |

## Exports

```typescript
import { collectProductionHealth } from '@/lib/operations/productionHealthCollector';

const health = await collectProductionHealth();
// health.overallStatus — healthy | degraded | unhealthy | unknown
// health.components — per-component latency, failures, last success
// health.dependencies — mysql, redis status
```

## Pure Builder (tests / offline)

```typescript
import { buildProductionHealthSummary } from '@/lib/operations/productionHealthService';
```

## Related Endpoints

- `GET /api/operations/health` — Phase 5 ops health
- `GET /api/health` — existing LB probe (unchanged)
- `GET /api/signals/engine-health` — pipeline health map (unchanged)
