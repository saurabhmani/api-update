# Product A — Rejection Engine (Phase 2)

**Version:** 2.0.0  
**Last updated:** 2026-07-13

## Canonical Engine

`runRejectionEngine()` in `src/lib/signal-engine/core/runRejectionEngine.ts` remains the single rejection authority.

Phase 2 adds **quality gates** via `phase2RejectionGates.ts`, invoked when `RejectionInput.features` is provided.

## Phase 2 Quality Gates

| Code | Trigger |
|------|---------|
| `weak_trend` | Enhanced trend strength below floor (bullish strategies) |
| `poor_liquidity_quality` | Liquidity quality score below floor |
| `high_spread` | Estimated spread from daily range exceeds limit |
| `abnormal_volatility` | ATR% exceeds max |
| `low_confirmation` | Composite confirmation score below floor |
| `poor_reward_risk` | R:R below Phase 2 floor |
| `late_breakout` | Breakout extension beyond limit |
| `overextended_move` | Distance from EMA20 or trend exhaustion too high |

Every rejection includes a human-readable `rejection_reasons` entry.

## Confirmation Score

Weighted composite of momentum persistence, MTF alignment, swing structure, volume quality, and relative strength. Breakout strategies weight breakout quality at 30%.

## Configuration

All thresholds in `signalEnginePhase2Config.ts` under `rejection`.  
Disabled when `SIGNAL_ENGINE_CONFIG_VERSION=1`.

## Integration

- `generatePhase3Signals.ts` passes `features` into `runRejectionEngine`
- Discovery mode: Phase 2 gates still apply (portfolio gates remain advisory)

## Tests

```bash
npm run test:rejection-engine
npm run test:signals-gate
```
