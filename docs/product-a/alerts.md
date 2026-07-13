# Product A — Operational Alerts (Phase 5)

## Design

Alerts are **generated only** — no automatic parameter modification, no notification dispatch in this module. Callers (cron, dashboard, on-call tooling) decide how to notify.

## Severity Levels

| Level | Meaning |
|-------|---------|
| `warning` | Degraded state; investigate during business hours |
| `critical` | Revenue/governance impact; page on-call |
| `resolved` | Prior alert condition cleared |

## Alert Categories

| Category | Trigger |
|----------|---------|
| `scheduler_failure` | Learning scheduler job failed (24h) |
| `market_feed_outage` | Market data unhealthy |
| `database_failure` | DB probe failed |
| `adaptive_promotion_failure` | `runAdaptiveLearningPipeline` failed |
| `report_generation_failure` | Reports path degraded |
| `high_rejection_spike` | Rejection rate > 50% |
| `confidence_drift` | Confidence drift detected |
| `snapshot_failure` | Learning snapshot job failed |

## API

```typescript
import { evaluateOperationalAlerts } from '@/lib/operations/operationalAlerts';

const alerts = evaluateOperationalAlerts({ health, generatedAt });
```

`GET /api/operations/alerts` returns active alerts for session-authenticated operators.
