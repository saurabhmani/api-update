# Phase 4 — Multi-Timeframe Confirmation

**Status:** Complete  
**Date:** 2026-07-14  
**Model version:** `4.0.0`

## Deliverables

| Item | Location |
|------|----------|
| Production-wired MTF factor | `applyMtfConfirmation` + Phase 3 pipeline |
| Strategy-specific policies | `MTF_POLICIES` + registry `mtfPolicyId` |
| Audit snapshot | `institutionalAuditLog` AlignmentBlock + explain |
| UI explain component | `MultiTimeframeExplainPanel` |
| Timestamp-safe candles | `mtfCandleProvider.truncateCandlesAsOf` |

## Acceptance

- No new standalone `multi_timeframe_alignment` actionable signals
- Backtest helper supports with/without factor comparison
- Missing/stale data cannot increase confidence
- Score applied exactly once
- Replay candles cannot include future bars

## Verification

```bash
npm run test:mtf
npm run test:signals-gate
npx tsc --noEmit
```

**Do not start Phase 6 until Phase 5 is signed off.**
