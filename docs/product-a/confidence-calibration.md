# Product A — Confidence Calibration (Phase 2)

**Model version:** `2.0.0` (`CONFIDENCE_MODEL_VERSION`)  
**Last updated:** 2026-07-14

## Principle

`scoreConfidenceForStrategy()` in `confidenceScorer.ts` remains the **sole** setup confidence scorer. Phase 2 extends it with a canonical contract, factor-ownership rules, and empirical calibration — it does **not** add a parallel scorer.

## Canonical contract — `SetupConfidenceResult`

```ts
interface SetupConfidenceResult {
  // …ConfidenceBreakdown fields…
  rawScore: number;
  calibratedProbability: number | null;
  confidenceBand: string;
  factorContributions: FactorContribution[];
  penalties: FactorContribution[];
  calibrationSampleSize: number;
  calibrationWindow: string | null;
  calibrationState: 'well_calibrated' | 'overconfident' | 'underconfident' | 'insufficient_data';
  modelVersion: string;
  signalTier: 'Elite' | 'Actionable' | 'Watchlist' | 'Avoid';
  evidenceLabel: string; // always includes n=… or “insufficient_evidence”
}
```

Pinned in `signalEngine.types.ts`. Displayed confidence must show sample size or insufficient evidence.

## Factor ownership (scored once)

| Factor | Owner |
|--------|--------|
| Trend, momentum, volume, structure | Setup confidence |
| Regime alignment, MTF confirmation | Contextual / composite (`scoringEngine` + `strategyWeightModel`) |
| Data quality | Phase 1 gate + one bounded confidence cap |
| Risk / stop geometry | Risk / composite score |
| Freshness / overextension | Dynamic rank |
| News / event risk | Phase 4 context + dynamic rank |
| Manipulation risk | Rejection / penalty layer |

Config **v2+** strips overlapping regime/ATR/gap/overextension penalties from setup. Config **v1** preserves legacy double-count behaviour for frozen baselines (`SIGNAL_ENGINE_CONFIG_VERSION=1`).

## Enhanced-feature calibration (bounded heuristic)

Still applied via `applyPhase2ConfidenceCalibration` when config v2 and `SIGNAL_P2_CONFIDENCE_CALIBRATION=true` (max ±`SIGNAL_P2_CONFIDENCE_MAX_ADJ`).

## Empirical calibration (production)

Module: `empiricalCalibration.ts`. Fixed hit-rate tables are **priors only**.

Per bucket / cell:

- Resolved sample size, actual precision, Wilson CI, Brier, ECE, avg MFE/MAE, entry-trigger rate, expiry rate
- Broken out by strategy × regime × volatility when samples exist

### Hierarchy (most specific reliable cell wins)

1. Strategy + regime + volatility  
2. Strategy + regime  
3. Strategy overall  
4. Confidence bucket overall  
5. No calibration adjustment  

Minimums: **100** fully trusted · **40** partially weighted · **&lt;40** informational only (no material production change). Small samples shrink toward the parent cell.

### Bounded adjustment policy (learning Job B)

| Bound | Value |
|-------|-------|
| Max change per learning cycle | ±1 point |
| Max total calibration modifier | ±8 points |
| Threshold relaxation | **Forbidden** |
| Promote Phase 3 rejection → actionable | **Forbidden** |

Learning may re-rank eligible signals only. Audit table `q365_confidence_calibration_audit` stores old/new/proposed modifiers, evidence JSON, approver state, model version, cycle id — enabling full replay.

## Signal tiers (calibrated probability + evidence)

| Tier | Rule |
|------|------|
| **Elite** | Calibrated p ≥ 78%, n ≥ 100, gates pass — **only** tier vs aspirational 78% precision |
| **Actionable** | p ≥ 55%, n ≥ 40 |
| **Watchlist** | Promising / awaiting confirmation or thin evidence |
| **Avoid** | Weak evidence **or** Phase 3 rejected |

## Reliability report

`buildConfidenceReliabilityReport()` — monotonicity across overall buckets, insufficient-evidence labels, over/under-confident lists. Baseline vs revised scoring compared on the same frozen outcome set via `compareBaselineVsRevisedScoring()`.

## Score-version migration

New scores stamp `modelVersion: '2.0.0'`. Replay / baselines use config v1 + empty calibration cache. Learning persists `model_version` on calibration rows.

## Regression / acceptance tests

```bash
npm run test:confidence-calibration
npx vitest run src/__tests__/phase2ConfidenceCalibration.vitest.ts
npm run test:signals-gate   # includes scoringTerminologyRegression @ config v1 → 87
```

Pinned fixture: `bullish_breakout` → **87** at config v1 (Phase 0 baseline).
