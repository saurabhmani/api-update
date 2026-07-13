# Product A — Learning Engine Consolidation

**Phase:** 0 (Foundation)  
**Decision date:** 2026-07-13

---

## Canonical Learning System

```
outcomeTracker.ts  +  learningScheduler.ts
```

| Component | Path | Role |
|-----------|------|------|
| Outcome evaluation | `feedback/outcomeTracker.ts` — `evaluateOutcome()` | Grade signal vs post-entry candles (MFE/MAE, T1/T2/T3, stop) |
| Performance aggregation | `aggregatePerformance()` | Win rate, avg PnL-R, MFE/MAE by strategy × regime × vol × sector |
| Confidence calibration | `calibrateConfidence()` | Bucket actual vs expected hit rates by confidence band |
| Adaptive recommendations | `computeAdaptiveRecommendation()` | Bounded confidence modifier from performance |
| Scheduled jobs | `workers/learningScheduler.ts` | Nightly A–E job chain with idempotent DB writes |

**Scheduler jobs (learningScheduler.ts):**

| Job | Function | Output table |
|-----|----------|--------------|
| A | `evaluateSignalOutcomes` | `q365_signal_outcomes` |
| B | `updateConfidenceCalibration` | `q365_confidence_calibration` |
| C | `updateStrategyPerformance` | `q365_strategy_performance` |
| D | `updateAdaptiveRecommendations` | `q365_adaptive_recommendations` |
| E | `updateManipulationCalibration` | manipulation watchlists |

**Manual trigger:** `npm run learning-scheduler`

---

## Inventory: `outcomeLearningEngine.ts`

**Path:** `src/lib/signal-engine/feedback/outcomeLearningEngine.ts`  
**Status:** **DEPRECATED** — zero production imports (verified Phase 0)

### What it provided

| Capability | In outcomeLearningEngine | In outcomeTracker (canonical) |
|------------|--------------------------|-------------------------------|
| Win rate | `buildOutcomeLearningSnapshot()` | `aggregatePerformance()` |
| Avg R:R (pnlR) | ✓ | ✓ (`avgPnlR`) |
| Stop-loss rate | ✓ | via outcome labels |
| False-breakout rate | ✓ (entry + stop, no T1) | **missing** — documented for Phase 1 |
| Volatility failure rate | ✓ (MAE > MFE on stops) | **missing** — documented for Phase 1 |
| Avg hold bars | ✓ (barsToEntry proxy) | **missing** — documented for Phase 1 |
| Confidence modifier | `applyLearningToConfidence()` ±10 pts | `computeAdaptiveRecommendation()` ±5 pts |
| Weight multiplier | `strategyWeightMultiplier()` [0.5, 1.5] | **missing** — documented for Phase 1 |
| Per (strategy, regime, vol) triple | ✓ | partial (regime + vol in perf, not triple-keyed modifiers) |

### Useful calculations to port (Phase 1 — not Phase 0)

1. **False-breakout rate** — `entryTriggered && stopHit && !target1Hit`
2. **Volatility failure rate** — stopped with `|MAE| > |MFE|`
3. **Per-triple weight multiplier** — bounded [0.5, 1.5] for `strategyWeightModel`
4. **Percentile diagnostics** — `describePercentiles()` for ops dashboards

### What NOT to duplicate

- `computeAdaptiveRecommendation()` already provides bounded confidence modifiers from `aggregatePerformance()` — do not run a second adaptive loop
- `learningScheduler.ts` already orchestrates nightly persistence — do not add a parallel scheduler

---

## Consolidation Decision

| Action | Phase | Detail |
|--------|-------|--------|
| Mark `outcomeLearningEngine.ts` deprecated | **0** | `@deprecated marker` added; documented here |
| Keep file on disk | **0** | Reference for Phase 1 metric port |
| Remove file | **1** | After false-breakout / vol-failure metrics ported or explicitly declined |
| Wire learning into confidence pipeline | **1+** | Requires product sign-off; not Phase 0 |

**Parity assessment:** Canonical system covers outcome grading, performance snapshots, calibration, and adaptive confidence. The deprecated module adds richer per-triple analytics and weight multipliers that are **not** currently consumed anywhere. No runtime behaviour change in Phase 0.

---

## Verification

```bash
# Confirm zero imports of deprecated module
rg outcomeLearningEngine src/ scripts/

# Run learning health check (requires DB)
npm run validate:learning-health

# Run learning scheduler dry (manual)
npm run learning-scheduler:dev
```

---

## Related

- [architecture.md](./architecture.md) — Outcome Tracking & Learning stages
- [scoring-terminology.md](./scoring-terminology.md) — confidence modifiers vs structural scores
