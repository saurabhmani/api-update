# Phase 6 — Strategy Robustness, Consensus and Selectivity

**Status:** Complete  
**Date:** 2026-07-14  
**Model version:** `6.0.0`  
**Constraint:** No new strategies added.

## Deliverables

| Item | Location |
|------|----------|
| Strategy overlap audit | `docs/product-a/strategy-overlap-audit.md` |
| Correlation-aware consensus | `consensus/correlationAwareConsensus.ts` |
| Explainable no-trade policy | `core/noTradePolicy.ts` |
| Improved conflict resolution | `strategy-engine/resolveConflicts.ts` |
| Diversity ranking controls | `pipeline/rankSignals.ts` |
| Strategy health governance | `governance/strategyHealth.ts` |
| Acceptance tests | `src/__tests__/phase6StrategyRobustness.vitest.ts` |

## Behaviours

1. **Consensus** aggregates independent families (trend, momentum, structure, volume, RS, regime, sector, MTF, news/event, risk geometry). Correlated indicators share a family and cannot both inflate the score.
2. **Conflicts** use consensus in the composite; contradictory high-quality long+short → Elite blocked; unresolved gap → no-trade for the symbol.
3. **No-trade** reasons are always explainable strings (data, MTF, regime, R:R, gap, extension, manipulation, liquidity, conflict, calibration, health).
4. **Ranking diversity** demotes (does not rescore confidence) on sector / strategy / correlated-symbol / same-factor concentration.
5. **Health** states: Active → Watch → Restricted → Research-only → Retired. Versioned ledger; history never deleted. Restricted blocks confirmed publishing.

## Acceptance

- Signal quantity may fall; selectivity rises via no-trade + diversity + elite conflict policy
- No duplicate factor counted twice in the same consensus family
- Contradictory strategies cannot both publish as Elite for the same symbol/time
- Strategy health changes are versioned (`version` + `assessedAt`)
- Elite list may legitimately be empty on weak days

## Verification

```bash
npm run test:phase6
npx tsc --noEmit
```

**Do not start Phase 7 until signed off.**
