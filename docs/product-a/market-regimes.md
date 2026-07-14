# Product A — Market Regimes (Phase 3)

**Model version:** `3.0.0` (`REGIME_MODEL_VERSION`)  
**Last updated:** 2026-07-14

## Principle

**One regime engine:** `detectMarketRegime.ts` / `detectEnhancedRegime()`.  
Supporting calculators (`regimeEvidence`, `regimeDimensions`, `regimeHysteresis`) feed that entry point. There is no second production or UI-only classifier for strategy eligibility.

Historical analytics in `regimeAndExplainabilityAnalytics.ts` remain **analytics-only** and do not change live generation.

## Structured contract

```ts
dimensions: {
  trend_state:       'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear'
  volatility_state:  'compressed' | 'normal' | 'elevated' | 'extreme'
  breadth_state:     'broad_participation' | 'selective' | 'deteriorating' | 'capitulation'
  liquidity_state:   'healthy' | 'thin' | 'stressed'
  transition_state:  'stable' | 'emerging' | 'weakening' | 'reversal_risk'
}
```

Legacy human-readable `label` (`Strong Bullish`, …) remains for backward compatibility. Strategy logic must use the registry + dimensions via `evaluateStrategyRegimeEligibility()`.

## Evidence

Built from benchmark candles + optional `RegimeExternalEvidence`:

- EMA stack / slope, RSI, ADX, ATR%, **ATR percentile**
- Gap behaviour, distribution/accumulation day counts
- Optional: advance/decline, % universe above EMAs, new highs/lows, sector participation / rotation concentration

**Never fabricated:** FII/DII, derivatives OI — listed under `sourcesUnavailable` when absent.

Wire sector rotation via `sectorRotationToRegimeEvidence()` → `detectEnhancedRegime(..., { external })`.

## Hysteresis

- Entry / exit softening (adjacent flips preferred over jumps)
- Minimum confirmation bars (default **2**)
- Previous-state awareness + transition confidence
- Confirmed changes persist to `q365_regime_changes` (`persistRegimeChange`)

## Strategy–regime matrix

`strategyRegistry.ts` is the **only** eligibility source:

| Field | Role |
|-------|------|
| `allowedRegimes` / `blockedRegimes` / `idealMarketRegime` | Legacy label gates |
| `regimeMatrix` (or `deriveRegimeMatrix`) | Ideal / allowed / blocked dimensions, non-ideal penalty, transition confirmation |

`runStrategies.evaluateOne` and Phase 2/3 pipelines call `evaluateStrategyRegimeEligibility`. Strategy-local duplicate regime ifs were removed; structure/liquidity invalidation rules remain in evaluators.

Rejection reasons always name **dimension + rule** (e.g. `trend_state=strong_bear`, `rule=blocked`).

## Same path in production and backtests

`contextReplay.captureReplayContext` calls `detectEnhancedRegime` — identical calculation.

## Performance report

`buildRegimePerformanceReport(outcomes)` → cells by strategy × regime × transition_state.

## Tests

```bash
npx vitest run src/__tests__/phase3MarketRegime.vitest.ts
npm run test:signals-gate
```
