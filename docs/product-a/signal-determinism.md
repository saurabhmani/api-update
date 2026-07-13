# Product A — Signal Determinism

**Phase:** 1

---

## Requirement

Identical historical inputs must always produce identical:

- Strategy match (given same features + RS)
- Confidence (`scoreConfidenceForStrategy`)
- Trade plan (given same candidate)
- Risk scores
- Targets / stop
- Phase-4 factor scores and classification (given same upstream status)
- Feature fingerprint

---

## Guarantees (Phase 1)

| Layer | Deterministic? | Notes |
|-------|----------------|-------|
| Candle normalization | Yes | Dedupe by `ts`, ascending sort |
| `buildSignalFeatures` | Yes | Pure functions, no IO |
| `scoreConfidenceForStrategy` | Yes | Pure |
| `runPhase4Scoring` | Yes | Pure (given fixed inputs) |
| `runAllStrategies` | Yes | Pure (given fixed features) |
| `generatePhase4Signals` batch | Yes* | *Fixed candle provider + fixed `generatedAt` in rejection input |
| `generateSignal` live | No** | Uses `Date.now()` for staleness gate and `generatedAt` |

**Live path** intentionally uses wall-clock time for staleness rejection (3-day candle age). Batch/historical replay paths must inject fixed timestamps for full determinism.

---

## Non-deterministic inputs (by design)

| Source | Field | Mitigation |
|--------|-------|------------|
| Live revalidation | `Date.now()` staleness | Document only; not used in batch pipeline |
| Pipeline tracer | `runId` random suffix | Debug only |
| `pipelineDebugLog` | `ts` ISO timestamp | Debug only, off by default |

---

## No hidden mutable state

- Feature builders: no module-level accumulators
- Scoring functions: pure (Phase 0 regression tests pin outputs)
- Strategy registry: static definitions

---

## Historical replay

Backtest / replay paths use `CandleProvider` with fixed candle windows. Use:

```typescript
fingerprintSignalFeatures(buildSignalFeatures(candles, regime))
```

to verify replay stability.

---

## Testing

```bash
npm run test:signal-determinism
```

---

## Related

- [validation-framework.md](./validation-framework.md)
- [feature-catalog.md](./feature-catalog.md)
