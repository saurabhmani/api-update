# Product A — Drift Detection (Phase 4)

## Purpose

Detect shifts between learning snapshots and emit **alerts only**. Drift detection does **not** modify adaptive parameters or signal generation.

## Categories

| Category | Signal |
|----------|--------|
| `confidence_drift` | ECE shift ≥ 0.02 |
| `performance_drift` | Target-1 hit rate shift ≥ 5pp |
| `strategy_drift` | Per-strategy win rate shift ≥ 10pp |
| `feature_drift` | Feature outcome score shift ≥ 5 |
| `market_regime_drift` | Regime win rate shift ≥ 8pp |

## Severity

- `low` — below medium threshold
- `medium` — meaningful shift
- `high` — requires operator review

## Audit

Alerts are logged via `learningAudit` with action `drift_alert`.

## Module

`src/lib/signal-engine/adaptive/driftDetection.ts`
