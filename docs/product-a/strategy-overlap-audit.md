# Phase 6 — Strategy Overlap Audit

**Status:** Complete (audit only — no merges/retirements in this phase)  
**Date:** 2026-07-14  
**Scope:** 17 active EOD swing evaluators in `runStrategies.ts`  
**Rule:** Do not add new strategies. Merge/retire only after persisted-data compatibility is designed.

## Active roster (17)

| Strategy | Mode | Family | Overlap notes |
|----------|------|--------|---------------|
| bullish_breakout | CONFIRMED | breakout | Overlaps range_breakout / squeeze on resistance pierce |
| range_breakout | CONFIRMED | breakout | Narrow-range variant of breakout |
| volatility_squeeze_breakout | CONFIRMED | breakout | BB squeeze + breakout — related to range_breakout |
| gap_continuation | CONFIRMED | breakout/momentum | Gap + trend — distinct trigger |
| momentum_continuation | CONFIRMED | momentum | Overlaps ema_crossover (trend/MACD/RSI) |
| ema_crossover | CONFIRMED | momentum | Score-gated; correlated with momentum factors |
| bullish_pullback | CONFIRMED | pullback | Overlaps fibonacci_pullback (EMA vs Fib geometry) |
| fibonacci_pullback | CONFIRMED | pullback | Flagship pullback (Phase 5) — keep separate |
| mean_reversion_bounce | WATCHLIST | mean_rev | Near low20 + RSI — overlaps oversold_bounce |
| oversold_bounce | WATCHLIST | mean_rev | RSI&lt;30 bounce — near mean_reversion_bounce |
| bullish_divergence | WATCHLIST | mean_rev | Distinct divergence evidence |
| volume_climax_reversal | WATCHLIST | mean_rev | Volume climax — distinct |
| overbought_reversal | WATCHLIST | mean_rev | Short — near resistance extension |
| bearish_breakdown | WATCHLIST | breakdown | Overlaps weak_trend_breakdown |
| weak_trend_breakdown | WATCHLIST | momentum/short | Softer breakdown |
| failed_breakout_reversal | WATCHLIST | reversal | Distinct failed-break pattern |
| bearish_pullback_rejection | WATCHLIST | breakdown | Short rejection into EMA/resistance |

## Contradictory directions (same symbol)

Long vs short pairs that can co-fire:
- bullish_breakout / momentum_* vs bearish_breakdown / overbought_reversal / weak_trend_breakdown
- Phase 6 `resolveConflicts` + elite block prevents both publishing as Elite

## Duplicate factor usage (fixed in consensus)

| Correlated pair | Family | Policy |
|-----------------|--------|--------|
| EMA20&gt;EMA50 + EMA stack | trend | Max + diminishing rest |
| RSI + Stochastic | momentum | Keep stronger only |
| Breakout distance + close above resistance | structure | Same event — dedupe |
| MACD vs EMA trend | trend/momentum | Split families; no double-count in one family |

## Static thresholds → volatility/regime aware (backlog)

Flagged for later adaptive work (not silently widened now):
- Fixed RSI bands (42–72 etc.) — should scale mildly with ATR%
- Fixed volume multiples — already partly regime gated
- Extension % caps — prefer ATR multiples

## Insufficient outcome evidence

WATCHLIST_ONLY strategies plus any Active strategy with `sample_size &lt; 20` in `q365_strategy_performance_snapshots` → Phase 6 health **Watch**. Restricted when OOS expectancy/calibration deteriorates.

## Same setup under different names (candidates to merge later)

| Candidate merge | Persistence risk | Recommendation |
|-----------------|------------------|----------------|
| mean_reversion_bounce ∪ oversold_bounce | Distinct `signal_type` in DB | Defer — watchlist-only dual is tolerable |
| bullish_pullback ⊂ fibonacci_pullback | Different geometry | Keep both; Fib is flagship |
| range_breakout ∪ volatility_squeeze_breakout | Distinct subtypes | Defer; squeeze is confirmatory |
| bearish_breakdown ∪ weak_trend_breakdown | Distinct | Defer until OOS proves redundancy |

**Do not retire or rename without migration plan for historical signals, breakdowns, and calibration rows.**
