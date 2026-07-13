# Execution Planning

The execution planner generates **recommendations only** — no broker connectivity, no automatic execution.

## Outputs

- Recommended order sequence
- Position sizing (from Product A `recommended_quantity`)
- Execution batches (capital-limited groups)
- Capital usage estimate
- Estimated slippage (basis points)
- Estimated fees (per-trade commission)

## Signal Prioritization

Signals are ranked using **existing Product A confidence** plus:

- Portfolio exposure
- Correlation/sector clustering
- Available capital
- Sector limits
- Liquidity score
- Existing positions

Product A confidence is **never modified**.

## API

```typescript
import { prioritizeSignals } from '@/lib/portfolio/prioritization/signalPrioritization';
import { planExecution, recommendOrderSequence } from '@/lib/portfolio/planner/executionPlanner';

const prioritized = prioritizeSignals(signals, snapshot);
const plan = planExecution(portfolioId, prioritized);
const sequence = recommendOrderSequence(plan);
```

## Tests

```bash
npm run test:execution-planner
```
