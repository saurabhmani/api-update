# Strategy Flow — Quantorus365

**Version:** 2.1.0  
**Audit Date:** 2025-06-25  
**Parent Document:** [architecture-audit.md](./architecture-audit.md)  
**Related:** [signal-engine-flow.md](./signal-engine-flow.md)

---

## Overview

The Strategy Engine evaluates technical setups against per-strategy rules, scores confidence and risk, builds trade geometry, and returns ranked candidates. It is invoked during **Phase 1** of the signal pipeline and again in **Phase 2** for conflict resolution and enhanced scoring.

**Authority files:**
- Registry (metadata): `src/lib/signal-engine/strategies/strategyRegistry.ts`
- Runner (execution): `src/lib/signal-engine/strategy-engine/runStrategies.ts`
- Conflict resolution: `src/lib/signal-engine/strategy-engine/resolveConflicts.ts`
- Trade geometry: `src/lib/signal-engine/trade-plan/buildTradePlan.ts`

---

## Strategy Flow Diagram

```mermaid
flowchart TD
    A[SignalFeatures from candles + regime] --> B[runAllStrategies]
    B --> C{For each strategy in STRATEGIES[]}
    C --> D[evaluateXxx features]
    D --> E{matched?}
    E -->|No| F[Record rejection reason]
    E -->|Yes| G[scoreConfidenceForStrategy]
    G --> H[scoreRisk]
    H --> I[buildTradePlanForStrategy]
    I --> J[buildReasons + buildWarnings]
    J --> K[StrategyCandidate]
    F --> C
    K --> L{Regime relax retry?}
    L -->|SIGNAL_RELAX_MODE| M[Re-evaluate with relaxed gates]
    L -->|No| N[Sort by confidence.finalScore]
    M --> N
    N --> O[Return best candidate(s)]

    subgraph Phase2["Phase 2 (optional)"]
        O --> P[isStrategyAllowedInRegime]
        P --> Q[scoreForStrategy enhanced RS]
        Q --> R[resolveConflicts]
        R --> S[Persist strategy breakdowns]
    end
```

---

## Strategy Registry

**File:** `src/lib/signal-engine/strategies/strategyRegistry.ts`  
**Type:** `Record<StrategyName, StrategyRegistryEntry>`

Each entry defines:

| Field | Purpose |
|-------|---------|
| `strategyId` | Canonical identifier |
| `displayName` | UI label |
| `direction` | `long` or `short` |
| `allowedRegimes` / `blockedRegimes` | Regime gating |
| `minAdx` | Minimum ADX threshold |
| `idealRsiRange` | RSI bounds |
| `minVolumeExpansion` | Volume multiplier |
| `defaultConfidenceWeight` | Scoring weight |
| `category` | Strategy family |
| `entryType` | Entry pattern type |
| `riskProfile` | Risk classification |
| `timeframe` | `swing` or `intraday` |
| `explanationTemplate` | User-facing explanation |
| `invalidationLogic` | Invalidation criteria |
| `idealMarketRegime` | Preferred regimes |

### Registered Strategies (24 in registry)

#### Active Swing (17 — executed in `runStrategies.ts`)

| ID | Display Name | Direction | Category |
|----|-------------|-----------|----------|
| `bullish_breakout` | Bullish Breakout | long | breakout |
| `range_breakout` | Range Breakout | long | breakout |
| `ema_crossover` | EMA Crossover | long | trend_following |
| `momentum_continuation` | Momentum Continuation | long | momentum |
| `gap_continuation` | Gap Continuation | long | momentum |
| `bullish_pullback` | Bullish Pullback | long | pullback |
| `fibonacci_pullback` | Fibonacci Pullback | long | pullback |
| `mean_reversion_bounce` | Mean Reversion Bounce | long | mean_reversion |
| `oversold_bounce` | Oversold Bounce | long | mean_reversion |
| `bullish_divergence` | Bullish Divergence | long | divergence |
| `volume_climax_reversal` | Volume Climax Reversal | long | reversal |
| `overbought_reversal` | Overbought Reversal | short | reversal |
| `bearish_breakdown` | Bearish Breakdown | short | breakdown |
| `weak_trend_breakdown` | Weak Trend Breakdown | short | breakdown |
| `failed_breakout_reversal` | Failed Breakout Reversal | short | reversal |
| `bearish_pullback_rejection` | Bearish Pullback Rejection | short | rejection |
| `volatility_squeeze_breakout` | Volatility Squeeze Breakout | long | squeeze |

#### Intraday Stubs (7 — registry only, not in runner)

| ID | Display Name | Status |
|----|-------------|--------|
| `multi_timeframe_alignment` | Multi-Timeframe Alignment | Returns `INSUFFICIENT_DATA` on EOD |
| `vwap_reclaim_long` | VWAP Reclaim Long | Intraday only |
| `vwap_rejection_short` | VWAP Rejection Short | Intraday only |
| `opening_range_breakout` | Opening Range Breakout | Intraday only |
| `opening_range_breakdown` | Opening Range Breakdown | Intraday only |

Intraday strategies are registered in `strategyRegistry` and `STRATEGY_EVALUATORS` but deliberately excluded from `STRATEGIES[]` in `runStrategies.ts` because EOD warehouse data cannot satisfy intraday evaluators.

---

## Evaluator Files

| Strategy | Evaluator File | Function |
|----------|---------------|----------|
| Bullish Breakout | `strategies/bullishBreakout.ts` | `evaluateBullishBreakout()` |
| Momentum Continuation | `strategies/momentumContinuation.ts` | `evaluateMomentumContinuation()` |
| Gap Continuation | `strategies/gapContinuation.ts` | `evaluateGapContinuation()` |
| Bullish Pullback | `strategies/bullishPullback.ts` | `evaluateBullishPullback()` |
| Fibonacci Pullback | `strategies/fibonacciPullback.ts` | `evaluateFibonacciPullback()` |
| Bearish Breakdown | `strategies/bearishBreakdown.ts` | `evaluateBearishBreakdown()` |
| Overbought Reversal | `strategies/overboughtReversal.ts` | `evaluateOverboughtReversal()` |
| Weak Trend Breakdown | `strategies/weakTrendBreakdown.ts` | `evaluateWeakTrendBreakdown()` |
| Mean Reversion Bounce | `strategies/meanReversionBounce.ts` | `evaluateMeanReversionBounce()` |
| Bullish Divergence | `strategies/bullishDivergence.ts` | `evaluateBullishDivergence()` |
| Volume Climax Reversal | `strategies/volumeClimaxReversal.ts` | `evaluateVolumeClimaxReversal()` |
| Range Breakout | `strategies/rangeBreakout.ts` | `evaluateRangeBreakout()` |
| EMA Crossover | `strategies/emaCrossover.ts` | `evaluateEmaCrossover()` |
| Oversold Bounce | `strategies/oversoldBounce.ts` | `evaluateOversoldBounce()` |
| Failed Breakout Reversal | `strategies/failedBreakoutReversal.ts` | `evaluateFailedBreakoutReversal()` |
| Bearish Pullback Rejection | `strategies/bearishPullbackRejection.ts` | `evaluateBearishPullbackRejection()` |
| Volatility Squeeze Breakout | `strategies/volatilitySqueezeBreakout.ts` | `evaluateVolatilitySqueezeBreakout()` |
| Intraday stubs | `strategies/intradayStubs.ts` | Various — all return `INSUFFICIENT_DATA` |

---

## Evaluation Pipeline (Per Symbol)

### Input: `SignalFeatures`

Built by `src/lib/signal-engine/features/buildSignalFeatures.ts` from daily candles:

- RSI, ADX, ATR, EMA (multiple periods)
- Volume expansion ratio
- Price structure (highs, lows, ranges)
- Benchmark relative strength (`RelativeStrengthFeatures`)

### Step 1: Strategy Matching

```typescript
// runStrategies.ts
for (const { name, evaluate } of STRATEGIES) {
  const match = evaluate(features);
  if (!match.matched) {
    rejections.push({ strategy: name, reason: match.reason });
    continue;
  }
  // score + trade plan...
}
```

### Step 2: Confidence Scoring

`scoreConfidenceForStrategy()` in `scoring/confidenceScorer.ts`:
- 9-component decision quality formula
- Weights from `system_thresholds` table via `systemConfigService`

### Step 3: Risk Scoring

`scoreRisk()` in `scoring/riskScorer.ts`:
- ATR-based stop distance
- Gap risk, regime risk
- Returns `RiskBreakdown`

### Step 4: Trade Plan

`buildTradePlanForStrategy()` in `trade-plan/buildTradePlan.ts`:
- Entry zone (price range)
- Stop loss level
- Target levels (T1, T2)
- Risk-reward ratio
- Strategy-specific geometry rules

### Step 5: Ranking

Candidates sorted by `confidence.finalScore` descending. Best candidate returned to Phase 1 pipeline.

---

## Phase 2 Enhancements

When `generatePhase2Signals()` runs:

1. **Enhanced relative strength** — sector-adjusted RS
2. **Regime check** — `isStrategyAllowedInRegime(strategy, regime)`
3. **Strategy-specific scoring** — `scoreForStrategy()` in `scoring/strategyScorers.ts`
4. **Conflict resolution** — `resolveConflicts()` when multiple strategies match same symbol
5. **Breakdown persistence** — `saveStrategyBreakdowns()` → `q365_strategy_breakdowns`

---

## Regime Relax Mode

**Env:** `SIGNAL_RELAX_MODE=true`

When enabled, if all strategies reject due to regime gates, the runner retries with relaxed regime constraints. Prevents zero-candidate scans in transitional markets (e.g., Sideways regime blocking all bullish strategies).

---

## Alternate Strategy Runtime (Redis Tick Pipeline)

**File:** `src/lib/pipeline/strategyWorker.ts`

```
market_ticks (Redis stream)
    → StrategyFn(tick) [injectable]
    → signals_stream (Redis stream)
```

- Used for live tick experimentation and `pipeline/backtestEngine.ts`
- Same `StrategyFn` signature enables unchanged backtest replay
- **Not** the production EOD pipeline

---

## Strategy Performance Feedback Loop

```
q365_signals (outcomes)
    → learningScheduler.ts (20:30 IST)
    → updateStrategyPerformance()
    → q365_strategy_performance_snapshots
    → strategies/performance API
    → /strategies/performance UI
```

Writers:
- `src/lib/strategies/writers/strategySnapshotWriter.ts`
- `src/lib/strategies/writers/signalOutcomesWriter.ts`

---

## Adding a New Strategy (Checklist)

1. Add entry to `STRATEGY_REGISTRY` in `strategyRegistry.ts`
2. Create evaluator file in `strategies/newStrategy.ts`
3. Register in `STRATEGIES[]` array in `runStrategies.ts`
4. Add trade plan rules in `buildTradePlan.ts`
5. Add strategy scorer in `strategyScorers.ts` (if custom scoring)
6. Add acceptance test in `scripts/validatePhase*.ts` or vitest
7. Update `StrategyName` type in `types/signalEngine.types.ts`

---

## Key Environment Variables

| Variable | Effect |
|----------|--------|
| `SIGNAL_RELAX_MODE` | Enable regime-relax retry |
| `SIGNAL_FALLBACK_SCORING` | Fallback scoring when no match |
| `SIGNAL_ENGINE_MIN_RAW_VOLUME` | Minimum volume gate in rejection engine |

---

*See [signal-engine-flow.md](./signal-engine-flow.md) for how strategy output feeds the full signal pipeline.*
