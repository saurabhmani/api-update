# Product A — Confidence Calibration (Phase 2)

**Version:** 2.0.0  
**Last updated:** 2026-07-13

## Principle

`scoreConfidenceForStrategy()` in `confidenceScorer.ts` is **not replaced**. Phase 2 adds:

1. Input validation (`validateConfidenceInputs`)
2. Bounded calibration adjustment (`computePhase2ConfidenceAdjustment`)
3. Human-readable explanations (`buildConfidenceExplanation`)

## Flow

```
scoreConfidence()           → generic 0–100 components
  ↓
strategy-specific deltas    → per-strategy adjustment (existing)
  ↓
applyPhase2ConfidenceCalibration() → bounded ±N from enhanced features (config-gated)
```

## Phase 2 Calibration Rules

Enabled when `SIGNAL_ENGINE_CONFIG_VERSION=2` (default) and `SIGNAL_P2_CONFIDENCE_CALIBRATION=true`.

| Condition | Adjustment |
|-----------|------------|
| Trend strength ≥ 60 | +2 |
| Volume quality ≥ 55 | +1 |
| Momentum persistence ≥ 60 | +1 |
| MTF alignment ≥ 70 | +1 |
| Relative strength ≥ 65 | +1 |
| Trend exhaustion ≥ 70 | −3 |
| Volatility regime < 30 | −2 |
| Breakout quality < 30 (breakout strategy) | −2 |
| Liquidity quality < 35 | −2 |

Max adjustment: `SIGNAL_P2_CONFIDENCE_MAX_ADJ` (default 5).

## Phase 1 Replay

Set `SIGNAL_ENGINE_CONFIG_VERSION=1` to disable calibration and reproduce Phase 1 confidence scores exactly.

## Regression Tests

```bash
npm run test:confidence-calibration
npm run test:signals-gate   # includes scoringTerminologyRegression
```

Pinned fixture: `bullish_breakout` → 87 at config v1.
