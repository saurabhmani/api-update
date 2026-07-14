# Product A — Trade Plan Quality (Phase 2)

**Version:** 2.0.0  
**Last updated:** 2026-07-13

## Overview

Strategy-specific geometry remains in `buildTradePlan.ts`. Phase 2 post-processes plans via `tradePlanEnhancements.ts`.

## Calculations (unchanged base geometry)

| Element | Method |
|---------|--------|
| Entry zone | Strategy-specific (EMA, S/R, Fib zone, close) |
| Stop | Structure level ± ATR cushion (`STOP_ATR_MULTIPLIER` = 1.5) |
| Risk | `max(|entry − stop|, 0.5 × ATR)` |
| Target 1 | 1.5R (or structure level if better) |
| Target 2 | 2.5R (or Fib extension) |
| Target 3 | Strategy map 2.5R–4R (`TARGET3_R_MAP`) |

## Phase 2 Enhancements

### Round-price awareness

`roundToIndianTick(price)` — NSE-aware tick rounding:

| Price range | Tick |
|-------------|------|
| ≥ 10,000 | ₹1 |
| ≥ 1,000 | ₹0.50 |
| ≥ 100 | ₹0.05 |
| < 100 | ₹0.01 |

Controlled by `SIGNAL_P2_ROUND_PRICES` (default true).

### Structure stop refinement

Stop is tightened using support/resistance ± `structureStopBufferAtr × ATR` when the resulting risk falls within configured ATR bounds (`minStopAtrMultiple`–`maxStopAtrMultiple`).

### Phase 5 — Fibonacci Pullback 2.0 geometry

For `fibonacci_pullback`:

| Element | Method |
|---------|--------|
| Stop | `min(fib stop anchor, swingLow − 0.35×ATR, close − cushion)` |
| Target 1 | Prior confirmed swing high when R ≥ 1.0 |
| Target 2 | 127.2% Fib extension |
| Target 3 | 161.8% Fib extension (via `resolveLongTarget3`) |
| R:R gate | Candidates with `rewardRiskApprox < 1.2` rejected |

See `docs/product-a/phase-5-fibonacci-pullback-2.md`.

### Phase 3 integration

`enhancePhase3TradePlan()` applies the same logic to persisted `Phase3TradePlan` rows, recalculating R:R fields.

## Explainability

`describeTradePlanCalculation()` documents entry, stop, targets, ATR, and structure levels for each plan.

## Tests

```bash
npm run test:trade-plan
```
