# Product A — Validation Framework

**Phase:** 1

---

## Test Suites

| Command | File | Coverage |
|---------|------|----------|
| `npm run test:feature-consistency` | `featureConsistency.vitest.ts` | Identical inputs → identical feature fingerprints; dedupe determinism |
| `npm run test:market-data-integrity` | `marketDataIntegrity.vitest.ts` | Candle/price integrity rules |
| `npm run test:signal-determinism` | `signalDeterminism.vitest.ts` | Feature → confidence → Phase-4 stability |
| `npm run test:signals-gate` | (Phase 0 gate) | Display policy, scoring regression, gates |
| `npm run check:signal-consistency` | `scripts/checkSignalConsistency.ts` | Table vs detail row alignment (live DB) |
| `npm run validate:signal-engine-functional` | `scripts/validateSignalEngineFunctional.ts` | End-to-end pipeline smoke |

---

## Validation Modules

| Module | Path | Role |
|--------|------|------|
| Candle integrity | `marketData/integrity/marketDataIntegrity.ts` | Reject/normalize corrupt candles |
| Feature fingerprint | `signal-engine/features/featureFingerprint.ts` | Stable hash for regression |
| Authoritative row | `signal-engine/pipeline/authoritativeSignalRow.ts` | Table/detail row parity |
| Canonical pipeline | `signal-engine/pipeline/canonicalPipeline.ts` | Entry-point registry |

---

## Categories

### 1. Feature consistency

- Same candles + regime → same `fingerprintSignalFeatures` output
- Duplicate timestamps deduped deterministically

### 2. Market data integrity

- Future timestamps rejected
- Invalid OHLC rejected
- Duplicate ts deduped
- Split jumps flagged
- LOW resolver quality rejected

### 3. Signal determinism

- Repeated pure pipeline steps produce identical scores
- Frozen historical window → stable fingerprint

### 4. Serialization / display parity

- `getAuthoritativeSignalRow` matches `getActiveSignals` ranking
- `revalidateInstrument` with `preferredDirection` aligns with table pool

### 5. Duplicate detection

- `DUPLICATE_TIMESTAMP` in integrity layer
- `getActiveSignals` symbol+direction dedup (existing)

### 6. Historical replay

- `signalDeterminism.vitest.ts` frozen window test
- Backtest `CandleProvider` (existing) for full pipeline replay

---

## CI Recommendation

Blocking:

```bash
npm run typecheck
npm run lint
npm run build
npm run test:signals-gate
npm run test:feature-consistency
npm run test:market-data-integrity
npm run test:signal-determinism
```

Informational (requires DB):

```bash
npm run check:signal-consistency
npm run validate:signal-engine-functional
```

---

## Debug validation

```bash
PIPELINE_DEBUG=1 npm run validate:signal-engine-functional
PIPELINE_TRACE=1 npm run engine:run-loop
```

---

## Related

- [data-integrity.md](./data-integrity.md)
- [../technical-debt.md](../technical-debt.md)
