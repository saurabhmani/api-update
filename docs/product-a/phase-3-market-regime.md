# Phase 3 — Advanced Market Regime and Context Engine

**Status:** Complete  
**Date:** 2026-07-14  
**Model version:** `3.0.0`

## Deliverables

| Deliverable | Location |
|-------------|----------|
| Structured regime contract | `types/signalEngine.types.ts` + `detectEnhancedRegime()` |
| Hysteresis / transitions | `regime/regimeHysteresis.ts` + `q365_regime_changes` |
| Evidence breakdown | `regime/regimeEvidence.ts` |
| Strategy–regime matrix | `strategyRegistry.evaluateStrategyRegimeEligibility` |
| Historical performance report | `regime/regimePerformanceReport.ts` |

## Acceptance

- Sideways samples do not oscillate excessively (test)
- Regime rejections identify dimension + rule
- Performance measurable by regime + transition state
- Production scans and backtests use the same detector
- No second regime service for eligibility

## Verification

```bash
npx vitest run src/__tests__/phase3MarketRegime.vitest.ts
npm run test:signals-gate
npx tsc --noEmit
```

**Do not start Phase 4 until this phase is signed off.**
