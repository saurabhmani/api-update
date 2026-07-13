# Institutional Risk Engine

The risk engine measures portfolio-level risk metrics for institutional oversight.

## Metrics

| Metric | Description |
|--------|-------------|
| Portfolio volatility | Annualized return standard deviation |
| VaR (95%) | Value at Risk at 95% confidence |
| CVaR (95%) | Conditional VaR (expected shortfall) |
| Max drawdown | Peak-to-trough decline |
| Beta | Sensitivity to benchmark |
| Correlation matrix | Pairwise symbol correlations |
| Sector exposure | Sector concentration breakdown |
| Country exposure | Geographic concentration |
| Currency exposure | Currency concentration |
| Concentration (HHI) | Herfindahl-Hirschman Index |

## Stress Scenarios

Reports-only stress tests:

- Market crash
- Sector rotation
- Volatility spike
- Currency movement
- Interest rate shock
- Gap risk

## API

```typescript
import { computePortfolioRiskMetrics } from '@/lib/portfolio/risk/riskEngine';
import { runStressScenarios } from '@/lib/portfolio/scenarios/scenarioAnalysis';

const risk = computePortfolioRiskMetrics({ snapshot, returns, equityCurve });
const stress = runStressScenarios(snapshot);
```

## Tests

```bash
npm run test:risk-engine
```
