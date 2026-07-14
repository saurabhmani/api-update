# Phase 7 — Institutional Backtesting and Robustness Validation

**Status:** Complete  
**Date:** 2026-07-14  
**Model version:** `7.0.0`

## Deliverables

| Item | Location |
|------|----------|
| Production/backtest parity contract | `parity/productionParity.ts` |
| Leakage / survivorship guards | `bias/leakageGuards.ts` |
| In-sample calibration + freeze | `calibration/inSampleCalibration.ts` |
| Completed walk-forward (IS→freeze→OOS) | `runner/runWalkForward.ts` |
| Robustness suite + report template | `robustness/robustnessSuite.ts` |
| Baseline / ablation comparison | `robustness/baselineComparison.ts` |
| Strategy version approval + auto-restrict | `approval/strategyVersionApproval.ts` |
| Acceptance tests | `src/__tests__/phase7InstitutionalBacktesting.vitest.ts` |

## Walk-forward contract

For each fold:

1. Run **in-sample** via production `runBacktest` (or injected `runWindow`)
2. `calibrateFromInSample` → **freeze** `FrozenCalibrationArtifact`
3. Apply freeze to OOS config (`applyFrozenCalibration`) — **no OOS re-fit**
4. Persist both windows + artefacts
5. **Headline metrics = OOS only** (`headline.source === 'out_of_sample_only'`)

## Approval (not win-rate alone)

OOS expectancy, profit factor, drawdown ceiling, sample size, concentration, calibration, leakage clean, robustness (incl. parameter perturbation), WF consistency, reproducibility versions.

Failing robustness / leakage → Phase 6 health **Restricted** (blocks elite publication).

Elite 78% target, when reported, must include **sample size + confidence interval**.

## Bias labels

Default config uses `universeMembershipMode: 'current_list_biased'` with an explicit `universeBiasLabel`. Unlabelled current-list universes fail leakage audit.

## Verification

```bash
npm run test:phase7
npx tsc --noEmit
```

**Phase 8 status:** Implemented — see `docs/product-a/phase-8-model-governance.md`.
