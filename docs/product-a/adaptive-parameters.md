# Product A — Adaptive Parameters (Phase 4)

## Overview

Phase 4 introduces **versioned adaptive parameters** derived from the canonical learning pipeline (`outcomeTracker` → `learningScheduler`). Learned behaviour exists only as immutable, content-addressed data — never as code changes.

## Canonical Store

Each adaptive parameter record includes:

| Field | Purpose |
|-------|---------|
| `parameterId` | Unique identifier |
| `configurationVersion` | Base signal-engine config version |
| `learningVersion` | Adaptive schema version (`4.0.0`) |
| `effectiveDate` / `expiryDate` | Validity window |
| `sourceSnapshotId` | Immutable learning snapshot provenance |
| `trainingWindowDays` | Lookback used for derivation |
| `sampleSize` | Training evidence count |
| `confidenceInterval` | Wilson CI on win rate |
| `approvalStatus` | Lifecycle state |
| `rollbackVersion` | Prior promoted parameter for rollback |
| `contentHash` | SHA-256 integrity hash |
| `parameters` | Overlay values (see below) |

### Parameter Overlay

- `confidenceOffsets` — per-strategy or `_global` bounded adjustments
- `qualityThresholds` — Phase 2 feature gate overrides
- `rejectionThresholds` — Phase 2 rejection gate overrides
- `minLiquidity`, `minAtrPct`, `minRewardRisk`
- `featureNormalizationLimits` — clamp bounds for normalized features

## Tables

- `q365_adaptive_parameters` — immutable parameter versions
- `q365_adaptive_parameter_audit` — full audit trail
- `q365_adaptive_parameter_pointer` — active promoted pointer

## Module Location

`src/lib/signal-engine/adaptive/adaptiveParameterStore.ts`
