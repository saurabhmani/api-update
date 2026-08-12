import { logger } from '@/lib/logger';
import { DEFAULT_BACKTEST_CONFIG, runBacktest, persistFullRun } from '@/lib/backtesting';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { toIstCalendarDate } from '@/lib/marketData/marketHours';

const log = logger.child({ component: 'maintenance-nightly-backtest' });

/**
 * Durable nightly backtest producer — persists to backtest_runs so /api/health
 * and fleet monitors share the same canonical artifact as the legacy 19:00 cron.
 */
export async function runNightlyBacktestForTradingDate(tradingDate: string): Promise<{
  runId: string | null;
  signalCount: number;
  tradeCount: number;
}> {
  const started = Date.now();
  log.info('nightly backtest stage starting', { tradingDate });

  await ensureBacktestTables();

  const endDate = tradingDate;
  const config = {
    ...DEFAULT_BACKTEST_CONFIG,
    name:    `Nightly Backtest ${tradingDate}`,
    endDate,
  };
  const result = await runBacktest(config);

  if (result.status !== 'completed') {
    throw new Error(`Backtest ${result.status}: ${result.error ?? 'unknown'}`);
  }

  let runId: string | null = null;
  try {
    const persisted = await persistFullRun(result);
    runId = persisted.runId ?? result.runId ?? null;
  } catch (err) {
    log.warn('persistFullRun failed in maintenance stage', {
      tradingDate,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  log.info('nightly backtest stage complete', {
    tradingDate,
    runId,
    signals:   result.signalCount,
    trades:    result.tradeCount,
    elapsedMs: Date.now() - started,
  });

  return {
    runId,
    signalCount: result.signalCount,
    tradeCount:  result.tradeCount,
  };
}

/** Default end date for ad-hoc nightly backtest: yesterday IST calendar. */
export function defaultNightlyBacktestEndDate(nowMs = Date.now()): string {
  const yesterday = new Date(nowMs - 86_400_000);
  return toIstCalendarDate(yesterday);
}
