/**
 * Fetch daily candles from IndianAPI, run Phase-4 + maturity worker,
 * then audit which rows could pass the institutional approval gate chain.
 *
 * Usage:
 *   npx tsx scripts/fetchIndianApiAndCheckApproval.ts
 *   npx tsx scripts/fetchIndianApiAndCheckApproval.ts --limit=50
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { initOnce, getNifty500Symbols } from '../src/lib/marketData/nifty500Universe';
import { refreshDailyCandles } from '../src/lib/marketData/candleIngest';
import { getApiUsage } from '../src/providers/adapters/indianApiUsageTracker';
import { migrateSignalEngine } from '../src/lib/db/migrateSignalEngine';
import {
  generatePhase4Signals,
  DEFAULT_PHASE3_CONFIG,
} from '../src/lib/signal-engine';
import { DEFAULT_PHASE1_CONFIG } from '../src/lib/signal-engine/constants/signalEngine.constants';
import { runSignalMaturityWorker } from '../src/lib/cron/signalMaturity';
import { runConfirmedSnapshotLifecycle } from '../src/lib/cron/confirmedSnapshotLifecycle';

function parseLimit(argv: string[]): number {
  for (const a of argv) {
    if (a.startsWith('--limit=')) {
      const n = Number(a.split('=')[1]);
      if (Number.isFinite(n) && n > 0) return Math.min(502, Math.floor(n));
    }
  }
  return 100;
}

const LIMIT = parseLimit(process.argv.slice(2));

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('IndianAPI fetch → Phase-4 → Maturity → Approval audit');
  console.log('='.repeat(72));

  const usageBefore = getApiUsage();
  console.log('[API USAGE before]', usageBefore);

  console.log('[1/6] Initializing NIFTY-500 universe…');
  await initOnce();
  const allSymbols = getNifty500Symbols();
  const symbols = allSymbols.slice(0, LIMIT);
  console.log(`  universe=${allSymbols.length}  run_subset=${symbols.length}`);

  await migrateSignalEngine().catch(() => {});

  console.log('[2/6] Refreshing daily candles via IndianAPI (stale symbols)…');
  const refresh = await refreshDailyCandles({
    symbols,
    force: false,
    maxAgeHours: Number(process.env.CANDLE_INGEST_MAX_AGE_HOURS) || 3,
  });
  console.log('[IndianAPI refresh]', {
    requested:          refresh.requested,
    staleCount:         refresh.staleCount,
    refreshed:          refresh.refreshed,
    barsIngested:       refresh.barsIngested,
    indianApiRequests:  refresh.indianApiRequests,
    failed:             refresh.failed.length,
    ageHoursBefore:     refresh.ageHoursBefore,
    ageHoursAfter:      refresh.ageHoursAfter,
  });

  const candleProvider = {
    async fetchDailyCandles(symbol: string) {
      const r = await db.query(
        `SELECT ts, open, high, low, close, volume FROM (
           SELECT ts, open, high, low, close, volume
           FROM market_data_daily WHERE symbol = ?
           ORDER BY ts DESC LIMIT 300
         ) t ORDER BY ts ASC`,
        [symbol.toUpperCase()],
      );
      return r.rows.map((row: any) => ({
        ts: row.ts,
        open: Number(row.open), high: Number(row.high),
        low: Number(row.low), close: Number(row.close),
        volume: Number(row.volume),
      }));
    },
  };

  const portfolio = {
    capital:       DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };

  const phase1Config = { ...DEFAULT_PHASE1_CONFIG, universe: symbols };

  console.log(`[3/6] Running Phase-4 on ${symbols.length} symbols…`);
  const t0 = Date.now();
  const phase4 = await generatePhase4Signals(
    candleProvider as any,
    portfolio as any,
    undefined,
    undefined,
    phase1Config,
    undefined,
    { generationSource: 'scripts:fetchIndianApiAndCheckApproval' },
  );
  console.log('[Phase-4]', {
    elapsed_ms: Date.now() - t0,
    signals:    phase4.signals.length,
    approved:   phase4.meta.approved,
    deferred:   phase4.meta.deferred,
    rejected:   phase4.meta.rejected,
    scanned:    phase4.meta.scanned,
  });

  console.log('[4/6] Running maturity worker…');
  const maturity = await runSignalMaturityWorker();
  console.log('[Maturity]', maturity);

  console.log('[5/6] Running snapshot lifecycle (classification cleanup)…');
  const lifecycle = await runConfirmedSnapshotLifecycle();
  console.log('[Lifecycle]', lifecycle);

  console.log('[6/6] Approval gate audit…');
  const { execSync } = await import('child_process');
  execSync('npx tsx scripts/checkApprovalEligibility.ts', {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  const usageAfter = getApiUsage();
  console.log('[API USAGE after]', usageAfter);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
