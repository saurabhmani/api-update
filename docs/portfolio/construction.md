# Portfolio Construction

Portfolio construction supports multiple allocation methods with maximum exposure constraints.

## Methods

| Method | Description |
|--------|-------------|
| `equal_weight` | Equal capital across symbols |
| `risk_parity` | Inverse-volatility weighting |
| `volatility_targeting` | Scale to target annualized volatility |
| `sector_balancing` | Equal sector buckets, equal within sector |
| `market_cap_weighting` | Weight by market capitalization |
| `custom` | User-defined weights with constraint caps |

## Constraints

- Maximum single position exposure
- Maximum sector exposure
- Maximum gross exposure
- Maximum country/currency exposure

## API

```typescript
import { constructPortfolioAllocation } from '@/lib/portfolio/construction/portfolioConstruction';

const plan = constructPortfolioAllocation('risk_parity', signals, {
  volatilities: { RELIANCE: 0.22, TCS: 0.18 },
});
```

## Tests

```bash
npm run test:portfolio-construction
```
