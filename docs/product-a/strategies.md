# Product A — Strategy Registry & Robustness (Phase 6)

## Design

Strategies are **metadata-driven**. The platform registry wraps the canonical `STRATEGY_REGISTRY` without changing evaluator logic.

Phase 6 adds **robustness without new strategy IDs**:

| Layer | Module |
|-------|--------|
| Overlap audit | `docs/product-a/strategy-overlap-audit.md` |
| Consensus (not a strategy) | `consensus/correlationAwareConsensus.ts` |
| Conflict + elite policy | `strategy-engine/resolveConflicts.ts` |
| No-trade explainability | `core/noTradePolicy.ts` |
| Diversity ranking | `pipeline/rankSignals.ts` |
| Health governance | `governance/strategyHealth.ts` |

See `docs/product-a/phase-6-strategy-robustness.md`.

## Usage

```typescript
import { listStrategyDefinitions, getStrategiesForAssetAndRegime } from '@/lib/platform/strategyRegistry';
import { evaluateStrategyConsensus } from '@/lib/signal-engine/consensus/correlationAwareConsensus';

const equityStrategies = listStrategyDefinitions({ assetClass: 'equity' });
const bullish = getStrategiesForAssetAndRegime('equity', 'Bullish');
```

## Constraints

- Existing `StrategyName` IDs unchanged — **no new strategies in Phase 6**
- `runStrategies.ts` evaluator roster unchanged for NSE EOD equity (17 swing)
- Consensus aggregates independent evidence families; correlated factors share a family cap
- Health states are versioned; historical strategy records are never deleted

## Module

`src/lib/platform/strategyRegistry.ts` + Phase 6 modules above
