/**
 * Validates fibonacci_pullback inclusion in strategy performance /
 * backtesting aggregation and compares metrics with breakout + momentum.
 *
 * Usage:
 *   npx tsx scripts/validateFibonacciBacktestPerformance.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });
dotenvConfig({ path: resolve(process.cwd(), '.env.production') });

import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import { routeStrategy } from '@/lib/strategies/regimeRouter';
import { getStrategyFactorWeights } from '@/lib/signal-engine/scoring/strategyWeightModel';
import {
  buildStrategyPerformance,
  loadBacktestOutcomes,
  type StrategyPerformance,
} from '@/lib/strategies/strategyPerformance';
import {
  evaluateStrategyPerformanceBacktest,
  type SignalForBacktest,
  type SignalOutcomeReview,
} from '@/lib/signals/dailyBacktestEngine';
import { analyzeByStrategy } from '@/lib/backtesting/analytics/byStrategy';
import type { SimulatedTrade, StrategyName } from '@/lib/backtesting/types';

const COMPARE: StrategyName[] = [
  'fibonacci_pullback',
  'bullish_breakout',
  'momentum_continuation',
];

interface StrategyMetrics {
  strategyId: string;
  totalSignals: number;
  winRate: number | null;
  avgReturnPercent: number | null;
  maxDrawdownPercent: number | null;
  averageRiskReward: number | null;
  source: string;
}

function pickMetrics(id: string, row: StrategyPerformance | undefined, source: string): StrategyMetrics {
  return {
    strategyId: id,
    totalSignals: row?.totalSignals ?? 0,
    winRate: row?.evaluatedSignals > 0 ? row.winRate : null,
    avgReturnPercent: row?.evaluatedSignals > 0 ? row.averageReturnPct : null,
    maxDrawdownPercent: row?.evaluatedSignals > 0 ? row.maxDrawdownPct : null,
    averageRiskReward: row?.evaluatedSignals > 0 ? row.averageRiskReward : null,
    source,
  };
}

function mockDailyStrategySlice(): StrategyMetrics[] {
  const signals = [
    { symbol: 'FIB1', strategy: 'fibonacci_pullback', direction: 'BUY', risk_reward: 2.1, __tier: 'APPROVED', entry_price: 100, target1: 110, stop_loss: 95 },
    { symbol: 'BRK1', strategy: 'bullish_breakout', direction: 'BUY', risk_reward: 1.8, __tier: 'APPROVED', entry_price: 100, target1: 108, stop_loss: 96 },
    { symbol: 'MOM1', strategy: 'momentum_continuation', direction: 'BUY', risk_reward: 1.5, __tier: 'APPROVED', entry_price: 100, target1: 107, stop_loss: 97 },
  ] as unknown as SignalForBacktest[];

  const outcomes: SignalOutcomeReview[] = [
    { symbol: 'FIB1', signalId: 1, strategyId: 'fibonacci_pullback', tier: 'APPROVED', direction: 'BUY', generatedAt: null, entryPrice: 100, targetPrice: 110, stopLoss: 95, exitPrice: 108, reviewWindow: '7D', returnPercent: 8, maxFavorableMovePercent: 9, maxAdverseMovePercent: 2, targetHit: false, stopLossHit: false, timeToTargetMinutes: null, timeToStopMinutes: null, outcome: 'PARTIAL_WIN', explanation: 'mock' },
    { symbol: 'BRK1', signalId: 2, strategyId: 'bullish_breakout', tier: 'APPROVED', direction: 'BUY', generatedAt: null, entryPrice: 100, targetPrice: 108, stopLoss: 96, exitPrice: 105, reviewWindow: '7D', returnPercent: 5, maxFavorableMovePercent: 6, maxAdverseMovePercent: 1, targetHit: false, stopLossHit: false, timeToTargetMinutes: null, timeToStopMinutes: null, outcome: 'WIN', explanation: 'mock' },
    { symbol: 'MOM1', signalId: 3, strategyId: 'momentum_continuation', tier: 'APPROVED', direction: 'BUY', generatedAt: null, entryPrice: 100, targetPrice: 107, stopLoss: 97, exitPrice: 96, reviewWindow: '7D', returnPercent: -4, maxFavorableMovePercent: 2, maxAdverseMovePercent: 5, targetHit: false, stopLossHit: true, timeToTargetMinutes: null, timeToStopMinutes: null, outcome: 'LOSS', explanation: 'mock' },
  ];

  const rows = evaluateStrategyPerformanceBacktest(outcomes, signals);
  return rows
    .filter((r) => COMPARE.includes(r.strategyId as StrategyName))
    .map((r) => ({
      strategyId: r.strategyId,
      totalSignals: r.totalSignals,
      winRate: r.winRate,
      avgReturnPercent: r.avgReturnPercent,
      maxDrawdownPercent: r.maxDrawdownPercent,
      averageRiskReward: r.averageRiskReward,
      source: 'daily_backtest_mock',
    }));
}

function mockSimulatedTrades(): StrategyMetrics[] {
  const trades = COMPARE.map((strategy, i) => ({
    tradeId: `${strategy}-w`,
    signalId: `sig-${i}`,
    runId: 'mock',
    symbol: `SYM${i}`,
    strategy,
    direction: 'long' as const,
    regime: 'Bullish' as const,
    sector: 'IT',
    confidenceScore: 70,
    confidenceBand: 'HIGH' as const,
    signalDate: '2025-06-01',
    entryDate: '2025-06-02',
    exitDate: '2025-06-10',
    barsToEntry: 1,
    barsInTrade: 6,
    entryPrice: 100,
    exitPrice: strategy === 'momentum_continuation' ? 96 : 108,
    stopLoss: 95,
    target1: 110,
    target2: 115,
    target3: 120,
    positionSize: 10,
    positionValue: 1000,
    riskAmount: 50,
    grossPnl: strategy === 'momentum_continuation' ? -400 : 800,
    netPnl: strategy === 'momentum_continuation' ? -420 : 780,
    returnPct: strategy === 'momentum_continuation' ? -4 : 8,
    returnR: strategy === 'momentum_continuation' ? -1 : 1.6,
    mfePct: 5,
    maePct: 2,
    mfeR: 1,
    maeR: 0.4,
    outcome: strategy === 'momentum_continuation' ? 'loss' : 'win',
    exitReason: 'target',
    target1Hit: strategy !== 'momentum_continuation',
    target2Hit: false,
    target3Hit: false,
    slippageCost: 10,
    commissionCost: 10,
  })) as unknown as SimulatedTrade[];

  return analyzeByStrategy(trades)
    .filter((r) => COMPARE.includes(r.strategy))
    .map((r) => ({
      strategyId: r.strategy,
      totalSignals: r.trades,
      winRate: r.winRate,
      avgReturnPercent: r.avgReturnPct,
      maxDrawdownPercent: null,
      averageRiskReward: r.avgReturnR,
      source: 'simulated_trades_mock',
    }));
}

async function main(): Promise<void> {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];

  checks.registry_has_fibonacci = !!STRATEGY_REGISTRY.fibonacci_pullback;
  checks.factor_weights_preset = getStrategyFactorWeights('fibonacci_pullback').source === 'preset';

  const fibRoute = routeStrategy({
    strategyId: 'fibonacci_pullback',
    regime: 'sideways',
    regimeStatus: 'AVAILABLE',
  });
  checks.regime_router_sideways_watchlist =
    fibRoute.routingDecision === 'WATCHLIST_ONLY';

  const perfRows = buildStrategyPerformance([]);
  const fibRow = perfRows.find((r) => r.strategyId === 'fibonacci_pullback');
  checks.performance_aggregation_includes_fibonacci = !!fibRow;

  const dailyMock = mockDailyStrategySlice();
  checks.daily_backtest_strategy_slice =
    dailyMock.some((r) => r.strategyId === 'fibonacci_pullback')
    && dailyMock.length === COMPARE.length;

  const tradeMock = mockSimulatedTrades();
  checks.backtest_analytics_by_strategy =
    tradeMock.some((r) => r.strategyId === 'fibonacci_pullback');

  let liveComparison: StrategyMetrics[] = [];
  try {
    const outcomes = await loadBacktestOutcomes('90D');
    if (outcomes.length > 0) {
      const built = buildStrategyPerformance(outcomes);
      liveComparison = COMPARE.map((id) =>
        pickMetrics(id, built.find((r) => r.strategyId === id), 'backtest_trades_90d'),
      );
      notes.push(`Loaded ${outcomes.length} backtest outcome rows (90D window).`);
    } else {
      notes.push('No backtest_trades rows in DB — live comparison skipped.');
    }
  } catch (err: unknown) {
    notes.push(`Backtest DB load skipped: ${(err as Error)?.message ?? String(err)}`);
  }

  const comparison = liveComparison.length > 0 ? liveComparison : dailyMock;

  const fib = comparison.find((r) => r.strategyId === 'fibonacci_pullback');
  const breakout = comparison.find((r) => r.strategyId === 'bullish_breakout');
  const momentum = comparison.find((r) => r.strategyId === 'momentum_continuation');

  // Quality gate: fibonacci should not dominate signal count vs breakout when live data exists.
  if (liveComparison.length > 0 && fib && breakout) {
    const ratio = breakout.totalSignals > 0
      ? fib.totalSignals / breakout.totalSignals
      : 0;
    checks.quality_signal_count_not_excessive = ratio <= 1.5;
    if (!checks.quality_signal_count_not_excessive) {
      notes.push(
        `Fibonacci signal count (${fib.totalSignals}) exceeds 1.5× breakout (${breakout.totalSignals}) — review detector strictness.`,
      );
    }
  } else {
    checks.quality_signal_count_not_excessive = true;
  }

  const result = {
    checks,
    notes,
    comparison: {
      fibonacci_pullback: fib ?? null,
      bullish_breakout: breakout ?? null,
      momentum_continuation: momentum ?? null,
    },
    simulated_trade_analytics: tradeMock,
  };

  console.log(JSON.stringify(result, null, 2));

  const pass = Object.values(checks).every(Boolean);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
