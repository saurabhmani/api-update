# Portfolio Analytics

Analytics provide attribution and performance comparison for institutional reporting.

## Attribution Types

- Portfolio attribution (by symbol)
- Strategy attribution (by position)
- Sector attribution
- Risk attribution (volatility, VaR, concentration)
- Performance attribution (realized vs unrealized)

## Performance

- Rolling returns (1M, 3M, 6M, 1Y)
- Benchmark comparison (alpha, tracking error)

## API

```typescript
import { buildPortfolioAnalytics } from '@/lib/portfolio/analytics/portfolioAnalytics';

const analytics = buildPortfolioAnalytics({ snapshot, risk, returnsByPeriod });
```

## Explainability

Every recommendation explains:

- Why selected / why rejected
- Capital impact
- Risk impact
- Diversification impact

See `src/lib/portfolio/explainability/portfolioExplainability.ts`.
