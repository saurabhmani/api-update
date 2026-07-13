# Product A — Data Integrity

**Phase:** 1  
**Last updated:** 2026-07-13

---

## Canonical Row Selection (LGEINDIA / PFC fix)

### Symptom

`check:signal-consistency` reported direction mismatch:

| Symbol | Table | Detail | Revalidation |
|--------|-------|--------|--------------|
| LGEINDIA | BUY | SELL | revalidated |
| PFC | BUY | SELL | revalidated |

### Root cause

Two different SQL orderings for the same symbol:

| Path | ORDER BY | Result for LGEINDIA |
|------|----------|---------------------|
| `getActiveSignals` (table) | `final_score DESC, opportunity_score DESC, generated_at DESC` | BUY id=97157 (fibonacci_pullback, APPROVED) |
| `loadLatestStored` (detail, pre-fix) | `generated_at DESC` | SELL id=100552 (bearish_breakdown, DEVELOPING) |

The table correctly surfaced the higher-ranked BUY row. Detail revalidation loaded a newer but lower-scored SELL row from the same scan batch.

### Fix (Phase 1)

- Shared module: `src/lib/signal-engine/pipeline/authoritativeSignalRow.ts`
- `getAuthoritativeSignalRow()` applies the same filters and ranking as `getActiveSignals`
- `revalidateInstrument` uses it via `loadLatestStored`
- `checkSignalConsistency` passes `preferredDirection: 'BUY'` when validating BUY pool rows

**No scoring, strategy, or formula changes.**

---

## Market Data Integrity Layer

**Module:** `src/lib/marketData/integrity/marketDataIntegrity.ts`

| Check | Code | Default behaviour |
|-------|------|-------------------|
| Empty series | `MISSING_CANDLE` | Reject |
| Duplicate `ts` | `DUPLICATE_TIMESTAMP` | Dedupe (last wins) |
| Future timestamp | `FUTURE_TIMESTAMP` | Reject |
| Non-positive OHLC | `NEGATIVE_PRICE` | Reject |
| Invalid OHLC relationship | `INVALID_OHLC` | Reject |
| Zero volume | `ZERO_VOLUME` | Warn (optional reject) |
| Split-like close jump | `SPLIT_ANOMALY` | Warn |
| Resolver `quality=LOW` | — | Reject in `validateResolvedPriceIntegrity` |

Integrated at feature build: `buildSignalFeatures()` normalizes via `validateCandleSeriesIntegrity()` before indicator computation.

---

## Canonical Pipeline Entry Points

See `src/lib/signal-engine/pipeline/canonicalPipeline.ts`.

Production generation MUST use `generatePhase4Signals()`. Deprecated publishers are listed in `DEPRECATED_SIGNAL_ENTRY_POINTS`.

---

## Observability

| Env var | Purpose |
|---------|---------|
| `PIPELINE_DEBUG=1` | Structured JSON debug lines (`pipelineDebugLog`) |
| `PIPELINE_TRACE=1` | Existing tracer spans (`pipelineTracer`) |

Debug logs write to **stderr only** — no production noise unless enabled.

---

## Related

- [feature-catalog.md](./feature-catalog.md)
- [signal-determinism.md](./signal-determinism.md)
- [validation-framework.md](./validation-framework.md)
- [architecture.md](./architecture.md)
