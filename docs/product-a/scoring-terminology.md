# Product A — Scoring Terminology

**Phase:** 0 (Foundation)  
**Rule:** This document names three distinct scoring functions. Their formulas, weights, thresholds, and output values are **frozen** in Phase 0.

Regression tests: `src/__tests__/scoringTerminologyRegression.vitest.ts` (included in `npm run test:signals-gate`).

---

## Overview — Three Scores, Three Jobs

| Name | Function | Module | Persisted as | When |
|------|----------|--------|--------------|------|
| **Setup Confidence** | `scoreConfidenceForStrategy()` | `scoring/confidenceScorer.ts` | `q365_signals.confidence_score` | After strategy match, before trade plan |
| **Composite Score** | `calculateFinalScore()` | `scoring/scoringEngine.ts` | `q365_signals.composite_final_score`, `classification` | Phase 3/4 via `runPhase4Scoring()` |
| **Display / Live Rank** | `computeFinalScore()` | `ranking/dynamicRanker.ts` | `q365_signals.final_score` | At INSERT + every rescore tick |

**Disambiguating aliases (Phase 0 — behaviour unchanged):**

- `computeLegacySixFactorScore` — alias for `scoringEngine.computeFinalScore` (legacy six-factor model; not the composite score)
- `computeCompositeScore` — alias for `scoringEngine.calculateFinalScore` (Composite Score)
- `computeRankerFinalScore` — alias for `dynamicRanker.computeFinalScore` (Display / Live Rank)

---

## 1. Setup Confidence — `scoreConfidenceForStrategy()`

### Purpose

Produces the **setup confidence** that answers: *"How strong is this technical setup for this specific strategy?"*

Runs immediately after strategy matching in `runStrategies.ts`. Applies the generic `scoreConfidence()` breakdown (trend + momentum + volume + structure + context) plus **strategy-specific adjustment deltas** (e.g. volume bonus for `bullish_breakout`, Fibonacci alignment for `fibonacci_pullback`).

### Inputs

- `SignalFeatures` — built from daily candles
- `StrategyName` — which strategy matched
- `RelativeStrengthFeatures` — vs index / sector

### Output

`ConfidenceBreakdown` with:

- Component scores (trend, momentum, volume, structure, context)
- `finalScore` 0–100 → persisted as `confidence_score`
- `band`: `High Conviction` | `Actionable` | `Watchlist` | `Avoid`

### Not responsible for

- Trade-plan R:R validation
- 6-band institutional classification (`VALID_SIGNAL`, `NO_TRADE`, etc.)
- Freshness decay or live-price penalties

### Callers

- `strategy-engine/runStrategies.ts` — primary batch path
- `scoring/strategyScorers.ts` — Phase 2 enhanced path fallback

---

## 2. Composite Score — `calculateFinalScore()`

### Purpose

Produces the **composite decision score** (also called structural final score in older notes) that answers: *"Does this signal meet institutional quality thresholds across eight graded dimensions?"*

This is the Phase-4 classification engine. Eight weighted factor scores minus three penalties → 6-band result. Null factors are **ignored** and remaining weights renormalized (MATURATION_AUDIT_2026-05).

### Formula (weights sum to 1.0)

| Factor | Default weight |
|--------|----------------|
| Strategy Quality | 20% |
| Trend Alignment | 15% |
| Momentum | 10% |
| Volume Confirmation | 10% |
| Risk Reward | 15% |
| Liquidity | 10% |
| Market Regime | 10% |
| Portfolio Fit | 10% |

Penalties (subtracted): manipulation risk, staleness, volatility shock.

### Classification bands

| Score | Band |
|-------|------|
| 85–100 | `INSTITUTIONAL_HIGH_CONVICTION` |
| 75–84 | `HIGH_CONVICTION` |
| 65–74 | `VALID_SIGNAL` |
| 50–64 | `DEVELOPING_SETUP` |
| 35–49 | `WATCHLIST_ONLY` |
| <35 | `NO_TRADE` |

### Adapter entry point

Production code should call `phase4FactorAdapter.runPhase4Scoring()`, which:

1. Builds `FinalScoreInput` from Phase-3 context
2. Applies per-strategy weights via `getFinalScoreWeights()`
3. Calls `calculateFinalScore()`
4. Applies upstream override (`NO_TRADE` / `DEVELOPING_SETUP` from rejection engine cannot be upgraded)

### Callers

- `pipeline/generatePhase3Signals.ts` — batch path
- `live/analyzeInstrument.ts` — per-symbol path
- `repository/saveSignals.ts` — persistence

### Not responsible for

- Intraday freshness decay (that's the ranker)
- Display sort order on the live board (ranker `final_score`)

---

## 3. Dynamic Ranker Score — `dynamicRanker.computeFinalScore()`

### Purpose

Produces the **live ranking score** that answers: *"Given current market conditions, how actionable is this signal right now?"*

Subtractive model on top of setup confidence:

```
finalScore = confidence × contextModifier
           − freshnessPenalty
           − stepAgePenalty
           − overextensionPenalty
           − eventRiskPenalty
           − manipulationPenalty
           × verdictMultiplier
```

Clamped to [0, 100]. Decimal precision for stable tie-breaking.

### Inputs (`RankerInput`)

- `confidenceScore` — from setup confidence
- `regimeAlignment`, `portfolioFit`, `marketStance` — context modifier
- `freshness` — from `freshnessEngine` (age, overextension)
- `eventRiskScore` — news engine
- `manipulationPenalty` — surveillance overlay
- `verdict` — from `postSignalValidator` (keep / downgrade / invalidate)

### Callers

- `repository/saveSignals.ts` — seed rank at INSERT (freshness age = 0)
- `rescore/rescoreActiveSignals.ts` — recompute every ~5 min intraday

### Not responsible for

- 6-band classification (`classification` column)
- Strategy matching or confidence component breakdown

---

## Legacy: `scoringEngine.computeFinalScore()` (six-factor)

### Purpose

**Legacy** weighted blend used before the 8-factor `calculateFinalScore()` was wired into production. Six components: confidence, inverted risk, R:R, portfolio fit, regime alignment, freshness → 4-band classification (`HIGH_CONVICTION`, `VALID_SIGNAL`, `DEVELOPING_SETUP`, `NO_TRADE`).

Still used for:

- Rank seed at INSERT (alongside structural score)
- Explainability engine references
- Test harnesses (`scripts/testScoringSystem.ts`)

**Alias:** `computeLegacySixFactorScore`

**Not** the authoritative `composite_final_score`.

---

## Score Column Quick Reference

| DB column | Scoring function | UI label (typical) |
|-----------|------------------|-------------------|
| `confidence_score` | `scoreConfidenceForStrategy` | Confidence |
| `composite_final_score` | `calculateFinalScore` | Final Score / Classification |
| `final_score` | `dynamicRanker.computeFinalScore` | Rank / Live Score |
| `classification` | `calculateFinalScore` band | Tier badge |

---

## Phase 0 Changes

- Documentation only + disambiguating export aliases
- Regression tests pin exact outputs for all three functions
- **No** formula, weight, threshold, or output value changes
