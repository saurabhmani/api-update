# Research Paper Trading

Paper trading simulation lives in `src/lib/research/paperTrading/researchPaperTrading.ts`. There is **no broker connectivity**.

## Simulated Behaviors

| Behavior | Support |
|----------|---------|
| Entries | Market fill with slippage |
| Stops | Stop-loss exit on bar low |
| Targets | Full and partial target exits |
| Fills | Via `orderSimulator` helpers |
| Fees | Per-trade commission |
| Partial exits | Half position at target |
| Portfolio evolution | Cash, positions, realized PnL |

## API

```typescript
import { createPaperPortfolio, simulatePaperEntry, evolvePaperPortfolioOnBar } from '@/lib/research/paperTrading/researchPaperTrading';

let portfolio = createPaperPortfolio(100_000);
const { portfolio: next, event } = simulatePaperEntry({
  portfolio,
  symbol: 'TEST',
  quantity: 10,
  referencePrice: 100,
  barIndex: 1,
  stopLoss: 95,
  target: 110,
});
```

## Isolation

Paper trading reuses slippage/fill math from `src/lib/paper-trading/orderSimulator.ts` but does not write to production tables or trigger live orders.

## Tests

```bash
npm run test:paper-trading
```
