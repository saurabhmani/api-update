# Strategy Research

Experimental strategies live in `src/lib/research/strategies/experimentalStrategies.ts`. They are **not registered** in the production strategy registry.

## Supported Types

| Strategy ID | Type |
|-------------|------|
| `exp_trend_follow` | Trend following |
| `exp_mean_revert` | Mean reversion |
| `exp_breakout` | Breakout |
| `exp_vol_expansion` | Volatility expansion |
| `exp_pairs` | Pairs |
| `exp_factor` | Factor investing |
| `exp_rotation` | Rotation |
| `exp_multi_factor` | Multi-factor |

## Usage

```typescript
import { getExperimentalStrategy, evaluateExperimentalStrategy } from '@/lib/research/strategies/experimentalStrategies';

const strategy = getExperimentalStrategy('exp_breakout')!;
const signals = evaluateExperimentalStrategy(strategy, candles, featureVectors);
```

Each signal includes `barIndex`, `direction`, `confidence`, and `reason` for explainability.

## Constraints

- No production registration
- No ranking or confidence calibration changes
- Results compared against Product A baseline via benchmark framework
