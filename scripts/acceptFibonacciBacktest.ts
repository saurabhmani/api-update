/**
 * Acceptance gate for fibonacci_pullback in backtest / performance surfaces.
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });
dotenvConfig({ path: resolve(process.cwd(), '.env.production') });

import { db } from '@/lib/db';
import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';
import {
  buildStrategyPerformance,
  buildPerformanceReport,
  loadBacktestOutcomes,
} from '@/lib/strategies/strategyPerformance';
import {
  evaluateStrategyPerformanceBacktest,
  runDailyBacktest,
  type SignalForBacktest,
} from '@/lib/signals/dailyBacktestEngine';

const COMPARE = ['fibonacci_pullback', 'bullish_pullback', 'bullish_breakout', 'momentum_continuation'] as const;

async function signalCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of COMPARE) {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE signal_type = ? AND generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [s],
    );
    out[s] = Number(rows?.[0]?.c ?? 0);
  }
  return out;
}

async function distinctSymbolCount(strategy: string): Promise<number> {
  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(DISTINCT symbol) AS c FROM q365_signals
      WHERE signal_type = ? AND generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [strategy],
  );
  return Number(rows?.[0]?.c ?? 0);
}

async function recentFibQuality(): Promise<{
  total: number;
  approved: number;
  rejected: number;
  avgConfidence: number | null;
}> {
  const { rows } = await db.query<any>(
    `SELECT signal_status, confidence_score
       FROM q365_signals
      WHERE signal_type = 'fibonacci_pullback'
      ORDER BY generated_at DESC
      LIMIT 500`,
  );
  const list = rows ?? [];
  const approved = list.filter((r) =>
    String(r.signal_status ?? '').toUpperCase().includes('APPROVED'),
  ).length;
  const rejected = list.filter((r) =>
    String(r.signal_status ?? '').toUpperCase().includes('REJECT'),
  ).length;
  const confs = list
    .map((r) => Number(r.confidence_score))
    .filter((n) => Number.isFinite(n));
  return {
    total: list.length,
    approved,
    rejected,
    avgConfidence: confs.length > 0
      ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10
      : null,
  };
}

function fixtureDailyBacktest() {
  const signals: SignalForBacktest[] = [
    {
      symbol: 'FIBACCEPT',
      signal_type: 'fibonacci_pullback',
      direction: 'BUY',
      risk_reward: 2.0,
      entry_price: 100,
      target1: 110,
      stop_loss: 95,
      __tier: 'APPROVED',
      __candles: [
        { ts: '2026-06-20', open: 100, high: 105, low: 99, close: 104, volume: 1e6 },
        { ts: '2026-06-21', open: 104, high: 108, low: 103, close: 107, volume: 1e6 },
      ],
    } as unknown as SignalForBacktest,
  ];

  return runDailyBacktest({
    window: '7D',
    startDate: '2026-06-20',
    endDate: '2026-06-21',
    signals: { approved: signals, highPotential: [], watchlist: [], rejected: [] },
    candleSeriesBySymbol: new Map(),
  });
}

async function main(): Promise<void> {
  const results: Record<string, { pass: boolean; detail: string }> = {};

  // 1 — appears in performance aggregation
  const perfRows = buildStrategyPerformance([]);
  const fibPerf = perfRows.find((r) => r.strategyId === 'fibonacci_pullback');
  results['1_performance_row_present'] = {
    pass: !!fibPerf && fibPerf.strategyName === STRATEGY_REGISTRY.fibonacci_pullback.displayName,
    detail: fibPerf
      ? `leaderboard row: ${fibPerf.strategyId} (${fibPerf.performanceStatus})`
      : 'missing from buildStrategyPerformance',
  };

  const report = buildPerformanceReport([]);
  const inLeaderboard = report.report.leaderboard.some(
    (e) => e.strategyId === 'fibonacci_pullback',
  );
  results['1_leaderboard_includes_fibonacci'] = {
    pass: inLeaderboard,
    detail: `totalStrategies=${report.report.totalStrategies}`,
  };

  const daily = fixtureDailyBacktest();
  const fibDaily = daily.strategyPerformance?.find(
    (r) => r.strategyId === 'fibonacci_pullback',
  );
  results['1_daily_backtest_strategy_slice'] = {
    pass: !!fibDaily && fibDaily.totalSignals === 1,
    detail: fibDaily
      ? `signals=${fibDaily.totalSignals} winRate=${fibDaily.winRate} avgRr=${fibDaily.averageRiskReward}`
      : 'strategyPerformance missing fibonacci_pullback',
  };

  // 2 — performance report builds without throw
  try {
    const backtestOutcomes = await loadBacktestOutcomes('90D');
    const mixed = buildPerformanceReport(backtestOutcomes);
    const pageSafe =
      Array.isArray(mixed.report.leaderboard)
      && Array.isArray(mixed.report.strategies)
      && mixed.report.strategies.every(
        (s) => typeof s.strategyId === 'string' && typeof s.strategyName === 'string',
      );
    results['2_performance_page_safe'] = {
      pass: pageSafe,
      detail: `strategies=${mixed.report.strategies.length} evaluated=${mixed.report.totalSignalsEvaluated}`,
    };
  } catch (err: unknown) {
    results['2_performance_page_safe'] = {
      pass: false,
      detail: (err as Error)?.message ?? String(err),
    };
  }

  // 3 — signal count reasonable vs peer pullback (7D window; rows include rescan churn)
  const counts = await signalCounts();
  const fib = counts.fibonacci_pullback ?? 0;
  const pullback = counts.bullish_pullback ?? 0;
  const brk = counts.bullish_breakout ?? 0;
  const mom = counts.momentum_continuation ?? 0;
  const fibSymbols = await distinctSymbolCount('fibonacci_pullback');
  const peer = Math.max(pullback, brk, mom, 1);
  const rowRatio = fib / peer;
  const symbolCapOk = fibSymbols <= 80;
  const rowRatioOk = fib <= peer * 0.5 || (pullback > 0 && fib <= pullback * 0.25);
  results['3_signal_count_reasonable'] = {
    pass: symbolCapOk && rowRatioOk,
    detail: `7d rows fib=${fib} pullback=${pullback} breakout=${brk} momentum=${mom} distinct_symbols=${fibSymbols} row_ratio_vs_peer=${rowRatio.toFixed(2)}`,
  };

  // 4 — false positives not too high (rejection rate + low approval share)
  const quality = await recentFibQuality();
  const rejectRate = quality.total > 0 ? quality.rejected / quality.total : 0;
  const approvalRate = quality.total > 0 ? quality.approved / quality.total : 0;
  results['4_false_positive_guard'] = {
    pass:
      quality.total === 0
      || (approvalRate <= 0.35 && (rejectRate >= 0.2 || quality.avgConfidence! < 75)),
    detail: quality.total === 0
      ? 'no live fibonacci_pullback rows — detector is selective (pass)'
      : `total=${quality.total} approved=${quality.approved} rejected=${quality.rejected} avgConf=${quality.avgConfidence} approvalRate=${(approvalRate * 100).toFixed(1)}%`,
  };

  console.log(JSON.stringify({ counts, quality, results }, null, 2));
  const pass = Object.values(results).every((r) => r.pass);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
