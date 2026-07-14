# Phase 5 — Fibonacci Pullback 2.0

**Status:** Complete  
**Date:** 2026-07-14  
**Strategy id (canonical):** `fibonacci_pullback`  
**Model version:** `2.0.0`

No duplicate strategy identifiers (`fibonacci_early` / `fibonacci_confirmed`). Lifecycle uses `confirmationState`: `early_watchlist` | `actionable_confirmation`.

## Deliverables

| Item | Location |
|------|----------|
| Confirmed swing anchors (ATR pivots, confirm delay, no look-ahead) | `structure/confirmedSwingAnchors.ts` |
| Structure features prefer confirmed impulse | `features/buildStructureFeatures.ts` |
| Zone quality + volatility-aware tolerance (cap 1.25%) | `structure/fibZoneQuality.ts` |
| Reaction evidence + confirmation state | `strategies/fibonacciReaction.ts` |
| Strategy rewrite v2.0.0 | `strategies/fibonacciPullback.ts` |
| Trade geometry (swing stop, swing-high / 127.2 / 161.8) | `trade-plan/buildTradePlan.ts` |
| Explain helper + Product A explainability | `explain/buildFibonacciExplanation.ts` |
| Baseline vs 2.0 OOS compare helper | `strategies/fibonacciBacktestCompare.ts` |
| Acceptance tests | `src/__tests__/phase5FibonacciPullback.vitest.ts` |

## Acceptance

- Zero look-ahead in pivot confirmation (`assertNoLookAheadInAnchors`)
- Every Fib match records anchors + timestamps on `fibonacciSnapshot`
- Touch without reaction → `early_watchlist` (confidence soft-cap ≤58)
- Enabled in **Strong Bullish / Bullish**; **disabled** in Sideways / Weak / Bearish / HVR
- Canonical id remains `fibonacci_pullback`

## Regime policy

Fibonacci Pullback 2.0 is a trend-pullback strategy. Outside bullish trending regimes it is **explicitly disabled** via registry `allowedRegimes` / `blockedRegimes` rather than force-fitted.

See `docs/product-a/fibonacci-pullback-2.0-oos-report.md` for baseline vs 2.0 compare workflow.

## Verification

```bash
npm run test:fibonacci-2
npx tsc --noEmit
```

**Do not start Phase 6 until signed off.**
