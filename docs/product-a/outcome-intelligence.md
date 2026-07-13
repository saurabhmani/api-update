# Product A Outcome Intelligence

Version: 3.0.0  
Canonical path: `outcomeTracker` → `learningScheduler` → outcome persistence

Phase 3 expands outcome measurement without changing signal generation.

## Stored outcome fields

- Entry trigger and entry-quality score (0–100)
- Stop and target 1/2/3 hits
- Time to first target and stop, in bars
- Holding duration, in bars
- Maximum favorable excursion (MFE)
- Maximum adverse excursion (MAE)
- Exit reason
- Realized return percentage
- Risk-adjusted return in R units
- Expected and realized reward/risk
- Outcome and metadata versions

`evaluateOutcome()` accepts an optional stable `evaluatedAt` value. Historical
replay should always provide it; the scheduler uses the final evaluation
candle timestamp.

## Exit ordering

When a stop and target occur on the same candle, stop takes precedence because
intraday ordering is unavailable. This conservative rule is deterministic.
The highest target reached before a stop determines the target exit reason.

## Entry quality

Entry quality is based on adverse excursion relative to initial risk:

`entryQuality = clamp(100 - 50 × MAE_in_R, 0, 100)`

## Persistence

Additive columns are managed by `ensurePhase4Tables()`. Existing rows remain
valid as outcome version 1 until replayed. New rows use outcome version 3.0.0.

## Tests

`npm run test:outcome-intelligence`
