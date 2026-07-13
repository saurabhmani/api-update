# Deterministic Backtesting

Research backtesting is implemented in `src/lib/research/backtesting/deterministicBacktest.ts`. It is fully isolated from the enterprise backtest pipeline and production signal generation.

## Capabilities

- **Deterministic execution** — same seed + inputs → same metrics
- **Walk-forward** — rolling in-sample / out-of-sample folds
- **Cross-validation** — k-fold metric splits
- **Multiple assets** — via dataset registry (per-symbol candles)
- **Multiple regimes** — optional `regime` tag on config
- **Transaction costs** — `commissionPerTrade`
- **Slippage** — configurable basis points

## API

```typescript
import { runDeterministicBacktest, runWalkForwardResearch, runCrossValidation } from '@/lib/research/backtesting/deterministicBacktest';

const result = runDeterministicBacktest(candles, signals, {
  symbol: 'TEST',
  strategyId: 'exp_trend_follow',
  initialCapital: 1_000_000,
  riskPerTradePct: 1,
  slippageBps: 10,
  commissionPerTrade: 20,
  evaluationHorizon: 10,
  randomSeed: 42,
});
```

## Metrics

Computed via `computeBenchmarkMetrics()`:

Sharpe, Sortino, Calmar, profit factor, win rate, max drawdown, recovery factor, total return.

## Tests

```bash
npm run test:backtesting
```
