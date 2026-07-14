# Product A — Multi-Timeframe Confirmation (Phase 4)

**Model version:** `4.0.0` (`MTF_MODEL_VERSION`)  
**Last updated:** 2026-07-14

## Principle

`multi_timeframe_alignment` is a **confirmation factor**, not an actionable standalone strategy.  
Historic registry id remains for stored-data compatibility with `strategyMode: DISABLED` and `isConfirmationOnly: true`. New standalone signals under this id are not published.

## Production wiring

After a real strategy match in `generatePhase3Signals` / via `applyMultiTimeframeConfirmation`:

1. Fetch/aggregate 1H → 4H (`mtfCandleProvider`, timestamp-safe)
2. Evaluate `evaluateMultiTimeframeAlignment` with strategy-specific policy
3. Apply score **exactly once** (−25..+25) to setup confidence
4. Attach canonical explain contract + audit alignment block

Daily-proxy `enhanced.multiTimeframeAlignment` no longer adds a Phase-2 calibration bonus (avoids double-count).

## Timeframe evidence

Each TF readout includes EMA structure/slope, market structure (HH/HL), RSI zone/direction, MACD histogram direction, ADX, volume confirmation, freshness — skipping indicators when bars are insufficient.

## Strategy policies (`MTF_POLICIES` / `mtfPolicyId` on registry)

| Policy | Daily | 4H | 1H |
|--------|-------|----|----|
| Fibonacci / pullback | primary trend | pullback structure | reaction confirmation |
| Breakout | structure | compression | breakout confirmation |
| Momentum | + 4H trend | — | momentum not exhausted |
| Mean reversion | not strong opposing HTF | not opposing | confirmation |

## Missing-data policy

| Condition | Effect |
|-----------|--------|
| Missing ≥2 TFs | non-actionable; score ≤ 0 |
| Missing one secondary | confidence capped; score cannot boost |
| Stale lower TF | treated as insufficient (not neutral) |
| Incomplete bar | unused for confirmation |

## Explain contract (UI)

```
Daily: bullish|neutral|bearish — evidence
4H: … — evidence
1H: confirmation|waiting|conflict — evidence
Overall alignment: score + state
```

Component: `components/signals/MultiTimeframeExplainPanel.tsx`

## Tests

```bash
npm run test:mtf
npm run test:signals-gate
```
