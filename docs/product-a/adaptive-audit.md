# Product A — Adaptive Learning Audit (Phase 4)

## Traceability

Every adaptive change is recorded with:

| Field | Description |
|-------|-------------|
| `auditId` | Unique audit entry |
| `parameterId` | Target parameter |
| `action` | Lifecycle event |
| `actor` | Who triggered the change |
| `reason` | Human-readable justification |
| `snapshotId` | Source learning snapshot |
| `metrics` | Validation / drift / A/B metrics |
| `createdAt` | Timestamp |

## Actions

- `generated` — candidate created from snapshot
- `validated` / `rejected` — statistical gate result
- `approved` — operator or policy approval
- `promoted` — became active runtime overlay
- `rolled_back` — restored prior version or cleared overlay
- `archived` — terminal archival
- `drift_alert` — informational drift detection

## Storage

- In-process: `learningAudit.ts` (tests, scheduler session)
- Persistent: `q365_adaptive_parameter_audit` table

## Promotion Reports

`promotionReporting.ts` bundles audit trail into JSON, CSV, and Markdown reports including:

- Learning summary
- Parameter changes
- Validation metrics
- Promotion decision
- Rollback capability
- Offline A/B comparison
- Drift alerts

## Module

`src/lib/signal-engine/adaptive/learningAudit.ts`
