# Product A Phase 1 — Data Quality, Lineage & Reproducibility

**Status:** Implemented 2026-07-14  
**Scope:** Canonical input snapshots, strengthened candle validation, corporate-action guard, deterministic features, DQ decision gate, counters.

---

## Canonical modules extended

| Module | Change |
|--------|--------|
| `marketData/integrity/marketDataIntegrity.ts` | Extra issue codes + incomplete/warmup/gap/disagreement checks |
| `signal-engine/features/buildSignalFeatures.ts` | `buildSignalFeaturesDetailed` + injectable `nowMs` |
| `signal-engine/lineage/*` | Snapshot contract, DQ decision, CA guard, counters |
| `strategy-engine/runStrategies.ts` | CA block + single DQ confidence modifier |
| `pipeline/generatePhase3Signals.ts` | DQ gate before strategies; snapshot on ExecutableSignal |
| `pipeline/generatePhase4Signals.ts` | Persist features + inputSnapshot |
| `repository/saveSignals.ts` | Lineage columns on feature snapshots |
| `db/ensureAllSchemas.ts` | `input_snapshot_json`, `provider_lineage`, `data_quality_status`, `data_timestamp` |
| `monitor/prometheus.ts` | DQ rejection counters |

IndiaAPI fallback remains prohibited (Gate Z). Provider identity recorded as Zerodha/Kite path.

---

## Severity ladder (1.5) — single influence point

| Severity | Effect | Module |
|----------|--------|--------|
| Critical | Reject before `runAllStrategies` | `evaluateDataQualityDecision` |
| Moderate | Cap confidence + mark non-actionable (defer approval) | same + Phase 3 |
| Minor | One score modifier via `applyDataQualityConfidenceModifier` in `runStrategies` only | same |

Do **not** re-apply DQ penalties in Phase-4 structural scoring or dynamic ranker.

---

## Tests

```bash
npx vitest run src/__tests__/phase1DataQualityLineage.vitest.ts
npm run test:signal-determinism
npm run test:feature-consistency
npm run test:market-data-integrity
```

Acceptance covered:

1. 1,000 frozen window replays → identical fingerprints / confidence / matches  
2. Incomplete current candle → fatal / non-actionable  
3. Snapshot includes provider lineage, timestamp, quality  
4. Counters by reason × provider  
5. Feature builder parity with identical candles + `nowMs`

---

## Related

- [architecture.md](./architecture.md)
- [signal-determinism.md](./signal-determinism.md)
- [data-integrity.md](./data-integrity.md)
