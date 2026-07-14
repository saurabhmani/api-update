# Phase 2 — Confidence Scoring and Statistical Calibration

**Status:** Complete  
**Date:** 2026-07-14  
**Model version:** `2.0.0`

## Deliverables

| Deliverable | Location |
|-------------|----------|
| Canonical confidence contract | `SetupConfidenceResult` in `signalEngine.types.ts` |
| Factor attribution (no double-count) | `confidenceScorer.ts` v2 ownership + adapter notes |
| Empirical calibration service | `scoring/empiricalCalibration.ts` |
| Confidence reliability report | `scoring/confidenceReliabilityReport.ts` |
| Score-version migration | `CONFIDENCE_MODEL_VERSION` + persisted `model_version` |
| Calibration audit log | `q365_confidence_calibration_audit` via `saveLearningArtifacts.ts` |
| Learning Job B upgrade | `learningScheduler.updateConfidenceCalibration` |
| Docs | `docs/product-a/confidence-calibration.md` |
| Tests | `phase2ConfidenceCalibration.vitest.ts` + extended gate |

## Acceptance

- Higher calibrated buckets must not systematically underperform lower → reliability `monotonicityOk`
- Every displayed confidence includes sample size or insufficient evidence → `evidenceLabel`
- Calibration update fully replayable from audit + stored outcomes
- Learning cannot convert Phase 3 rejection into Elite/Actionable → `assignSignalConfidenceTier({ phase3Rejected: true })`
- Baseline vs revised compared on frozen OOS set → `compareBaselineVsRevisedScoring`
- Phase 0 fixture intact at config v1: `bullish_breakout` → 87

## Verification

```bash
npm run test:confidence-calibration   # 12 tests
npm run test:signals-gate             # 112 tests
npx tsc --noEmit
```

**Do not start Phase 3 until this phase is signed off.**
