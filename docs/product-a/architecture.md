# Product A — Canonical Signal Architecture

**Phase:** 0 (Foundation)  
**Product:** Product A — Manual Signal UI (`/signals`, `/signals/[key]`)  
**Authority:** This document is the single authoritative path for actionable Product A signals.

---

## End-to-End Pipeline

```
Market Data
    ↓
Feature Build
    ↓
Strategy Matching
    ↓
Setup Confidence
    ↓
Trade Plan
    ↓
Phase 3 Rejection Gate
    ↓
Phase 4 Enrichment
    ↓
Maturity & Confirmation
    ↓
API Assembly
    ↓
Manual Signal UI
    ↓
Outcome Tracking
    ↓
Learning & Calibration
```

No source outside this path may publish **actionable** Product A signals to the Manual Signal UI.

---

## Stage-by-Stage Modules

### 1. Market Data

| Module | Path | Role |
|--------|------|------|
| Candle warehouse | `market_data_daily` / `candles` tables | Daily OHLCV for feature build |
| `CandleProvider` | `pipeline/generatePhase1Signals.ts` | Interface; worker implements DB fetch |
| Worker candle adapter | `workers/scheduler.ts` → `signalCandleProvider` | Reads persisted candles for batch scans |
| Live price resolver | `marketData/resolver/marketDataResolver.ts` | **Canonical** live LTP for save/rescore/API |
| Candle fallback | `marketData/candleFallbackChain.ts` | Evening scan candle refresh |
| Market hours gate | `marketData/marketHours.ts` | Closed-market behaviour |

**Live price contract:** `resolvePrice` / `resolvePrices` / `resolveBatch` from `marketDataResolver` — used by `saveSignals.ts`, `rescoreActiveSignals.ts`, `confirmedSignalsService.ts`, `/api/signals/*`.

### 2. Feature Build

| Module | Path |
|--------|------|
| Candle validation | `utils/candles.ts` — `validateCandleSeries()` |
| Feature assembly | `features/buildSignalFeatures.ts` |
| Regime detection | `regime/detectMarketRegime.ts` |
| Relative strength | `context/relativeStrength.ts` |

### 3. Strategy Matching

| Module | Path |
|--------|------|
| Strategy registry | `strategies/strategyRegistry.ts` |
| Strategy runners | `strategy-engine/runStrategies.ts` — `runAllStrategies()` |
| Per-strategy evaluators | `strategies/*.ts` (17 strategies) |
| Conflict resolution | `strategy-engine/resolveConflicts.ts` |

### 4. Setup Confidence

| Module | Path | Output column |
|--------|------|---------------|
| Generic confidence | `scoring/confidenceScorer.ts` — `scoreConfidence()` | component scores |
| Strategy-specific | `scoring/confidenceScorer.ts` — `scoreConfidenceForStrategy()` | `confidence_score` |
| Strategy scorers (Phase 2) | `scoring/strategyScorers.ts` — `scoreForStrategy()` | enhanced path |

### 5. Trade Plan

| Module | Path |
|--------|------|
| Trade plan builder | `trade-plan/buildTradePlan.ts` — `buildPhase3TradePlanForStrategy()` |
| Position sizing | `position-sizing/positionSizer.ts` |
| Portfolio fit | `portfolio-fit/evaluatePortfolioFit.ts` |
| Phase 3 risk | `risk/phase3Risk.ts` |

### 6. Phase 3 Rejection Gate

| Module | Path |
|--------|------|
| Pipeline orchestrator | `pipeline/generatePhase3Signals.ts` |
| Rejection engine (12 gates) | `core/runRejectionEngine.ts` |
| Execution readiness | `execution/executionReadiness.ts` |
| Lifecycle | `lifecycle/signalLifecycle.ts` |
| Structural scoring adapter | `scoring/phase4FactorAdapter.ts` — `runPhase4Scoring()` |
| Structural scorer | `scoring/scoringEngine.ts` — `calculateFinalScore()` |

**Authority:** Phase 3 rejection decisions are final; Phase 4 cannot override them.

### 7. Phase 4 Enrichment

| Module | Path |
|--------|------|
| Pipeline wrapper | `pipeline/generatePhase4Signals.ts` — **production entry** |
| Scenario | `services/scenarioEngine.ts` |
| Market stance | `services/marketStanceEngine.ts` |
| Macro / news context | `context/macroContext.ts`, `context/contextualModifiers.ts` |
| AI explanations | `ai-explain/buildExplanation.ts` |
| Dexter narrative | `dexter/buildDexterNarrative.ts` |
| Persistence | `repository/savePhase4Artifacts.ts`, `repository/saveSignals.ts` |
| Dynamic rank seed | `ranking/dynamicRanker.ts` — `computeFinalScore()` at INSERT |

### 8. Maturity & Confirmation

| Module | Path |
|--------|------|
| Maturity worker | `cron/signalMaturity.ts` (~60s) |
| Maturity scorer | `maturity/maturityScorer.ts` |
| Tracker repo | `repository/maturityTracker.ts` |
| Confirmed snapshots | `repository/confirmedSnapshots.ts` |
| Snapshot lifecycle | `cron/confirmedSnapshotLifecycle.ts` |
| Rescore (intraday) | `rescore/rescoreActiveSignals.ts` (~5 min) |
| Phase 12 routing | `pipeline/phase12Routing.ts` |

**Rule:** Confirmed snapshots are created **only** by `signalMaturity.ts`, never directly by the scanner.

### 9. API Assembly

| Module | Path |
|--------|------|
| Signals API | `app/api/signals/route.ts` |
| Stream API | `app/api/signals/stream/route.ts` |
| Confirmed service | `signals/confirmedSignalsService.ts` |
| Display filter | `signals/filterDisplayableApproved.ts` |
| Policy gates | `signals/confirmedSignalPolicy.ts` |
| Response mapper | `signals/signalsResponseMapper.ts`, `signals/responseAssembly.ts` |
| Read layer | `repository/readSignals.ts`, `repository/readConfirmedSnapshots.ts` |
| Closed market | `signals/closedMarketSignals.ts` |

### 10. Manual Signal UI

| Module | Path |
|--------|------|
| Signals board | `app/signals/page.tsx` |
| Signal detail | `app/signals/[key]/page.tsx` |
| Engine health | `app/signals/engine-health/page.tsx` |
| Daily report | `app/signals/daily-report/page.tsx` |

### 11. Outcome Tracking

| Module | Path |
|--------|------|
| Outcome evaluator | `feedback/outcomeTracker.ts` — `evaluateOutcome()` |
| Evaluation job | `feedback/runOutcomeEvaluation.ts` |
| Persistence | `repository/savePhase4Artifacts.ts` — `saveOutcome()` |

### 12. Learning & Calibration

| Module | Path |
|--------|------|
| **Canonical scheduler** | `workers/learningScheduler.ts` |
| Performance aggregation | `feedback/outcomeTracker.ts` — `aggregatePerformance()` |
| Confidence calibration | `feedback/outcomeTracker.ts` — `calibrateConfidence()` |
| Adaptive recommendations | `feedback/outcomeTracker.ts` — `computeAdaptiveRecommendation()` |
| Learning persistence | `repository/saveLearningArtifacts.ts` |

---

## Production Entry Points

| Trigger | File | Function |
|---------|------|----------|
| Intraday regen | `workers/scheduler.ts` | `generatePhase4Signals()` |
| Morning / evening scan | `workers/dailyScanSchedule.ts` | `runPhase4Scan()` |
| Manual API | `app/api/run-signal-engine/route.ts` | `generatePhase4Signals()` |
| Per-symbol live | `live/analyzeInstrument.ts` | `generateSignal()` |
| In-process regen | `workers/bootInProc.ts` | cron when `Q365_INPROC_REGEN=1` |

**Barrel export:** `src/lib/signal-engine/index.ts`

---

## Deprecated Paths (Must Not Publish Actionable Product A Signals)

| Path | Reason | Status |
|------|--------|--------|
| `scanner/customUniverseBatchScanner.ts` | Parallel Yahoo-based scanner; tags `generation_source='scanner:custom-universe:yahoo'` | Deprecated — not Product A canonical |
| `scanner/yahooScoringEngine.ts` | Standalone Yahoo scoring | Deprecated stub |
| `scanner/yahooDataService.ts` | Yahoo OHLCV fetch | Deprecated stub |
| `lib/marketData/getLivePrice.ts` | Legacy Kite→Yahoo chain | Deprecated — use `marketDataResolver` |
| `signal-engine/examples/simpleMomentumSignal.ts` | Reference example only | Not production |
| `feedback/outcomeLearningEngine.ts` | Duplicate learning; zero imports | Deprecated — see learning-consolidation.md |
| Phase 2-only path | `generatePhase2Signals.ts` without Phase 3/4 | Legacy — not production entry |
| Trust layer board | `trust-layer/` | Separate product surface — not Manual Signal UI |

---

## Data-Flow Diagram

```mermaid
flowchart TB
    MD[marketDataResolver + CandleProvider]
    FB[buildSignalFeatures]
    SM[runAllStrategies]
    SC[scoreConfidenceForStrategy]
    TP[buildTradePlan + positionSizer]
    P3[generatePhase3Signals + runRejectionEngine]
    P4[generatePhase4Signals + enrichment]
    SAVE[saveSignals → q365_signals]
    MAT[signalMaturity → confirmed_snapshots]
    API[/api/signals + confirmedSignalsService]
    UI[/signals UI]
    OUT[outcomeTracker.evaluateOutcome]
    LEARN[learningScheduler]

    MD --> FB --> SM --> SC --> TP --> P3 --> P4 --> SAVE --> MAT --> API --> UI
    SAVE --> MAT
    UI --> OUT --> LEARN
```

---

## Related Documentation

- [scoring-terminology.md](./scoring-terminology.md)
- [learning-consolidation.md](./learning-consolidation.md)
- [../signal-engine-flow.md](../signal-engine-flow.md) — detailed phase breakdown (legacy doc, superseded for Product A authority by this file)
