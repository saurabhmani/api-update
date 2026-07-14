# Fibonacci Pullback — Baseline vs 2.0 (OOS report)

**Generated:** 2026-07-14  
**Canonical strategy:** `fibonacci_pullback`  
**Versions compared:** baseline (1.x lookback H/L + fixed ±1%) vs **2.0.0** (confirmed impulse + zone quality + reaction state)

## Method

Outcomes are evaluated on **frozen OOS windows** (not the development/calibration period). Use:

```typescript
import { compareFibBaselineVsV2 } from '@/lib/signal-engine/strategies/fibonacciBacktestCompare';

const report = compareFibBaselineVsV2(rows); // rows: { regime, baselineHit, v2Hit }[]
```

Do not invent live P&L here — populate `rows` from the institutional backtest harness with identical symbol/date locks for both versions.

## Regime coverage (policy)

| Regime | Fib 2.0 policy | Notes |
|--------|----------------|-------|
| Strong Bullish | Enabled | Preferred |
| Bullish | Enabled | Preferred |
| Sideways | **Disabled** | Chop false positives |
| Weak | **Disabled** | Impulse quality fails |
| Bearish | **Disabled** | Against long Fib thesis |
| High Volatility Risk | **Disabled** | Stop geometry unstable |

Acceptance requires acceptable performance across ≥3 regimes **or** explicit disable. Fib 2.0 meets this via **enable in 2 bull regimes + explicit disable in ≥3 others**.

## Illustrative frozen compare (placeholder seed)

When the harness has not yet filled production OOS rows, the helper supports documenting the matrix shape:

| Regime | N (example) | Baseline precision | Fib 2.0 precision |
|--------|-------------|--------------------|-------------------|
| Bullish | — | fill from harness | fill from harness |
| Strong Bullish | — | fill from harness | fill from harness |
| Sideways | — | N/A (2.0 disabled) | N/A |

## What 2.0 changes for OOS fairness

1. **Fewer weak signals** — rejects unconfirmed / noisy swings and zone-only touches stay watchlist.
2. **Tighter geometry** — swing + ATR stops; R:R &lt; 1.2 rejected.
3. **No look-ahead** — pivot confirmation delay bounded by `asOfIndex`.

## Sign-off checklist

- [ ] Frozen OOS row set attached (same N for baseline and 2.0 where both fire)
- [ ] Early_watchlist vs actionable tracked separately (not counted as same actionable hit rate)
- [ ] Sideways / Weak / Bearish remain blocked in production registry
- [ ] Anchors + timestamps present on every persisted Fib candidate
