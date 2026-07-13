# Product A — Strategy Registry (Phase 6)

## Design

Strategies are **metadata-driven**. The platform registry wraps the canonical `STRATEGY_REGISTRY` without changing evaluator logic.

Each strategy declares:

| Field | Source |
|-------|--------|
| `supportedAssets` | Platform metadata |
| `requiredFeatures` | Platform metadata |
| `allowedRegimes` | Canonical registry |
| `minimumHistoryBars` | Derived from `requiresIntradayData` |
| `riskProfile`, `entryType`, `exitType` | Canonical + platform mapping |
| `version` | Platform schema version |
| `family` | Mapped from `category` |

## Usage

```typescript
import { listStrategyDefinitions, getStrategiesForAssetAndRegime } from '@/lib/platform/strategyRegistry';

const equityStrategies = listStrategyDefinitions({ assetClass: 'equity' });
const bullish = getStrategiesForAssetAndRegime('equity', 'Bullish');
```

## Constraints

- Existing `StrategyName` IDs unchanged
- `runStrategies.ts` evaluator roster unchanged for NSE EOD equity
- No hardcoded strategy lists in platform code — hydrated from `STRATEGY_REGISTRY`

## Module

`src/lib/platform/strategyRegistry.ts`
