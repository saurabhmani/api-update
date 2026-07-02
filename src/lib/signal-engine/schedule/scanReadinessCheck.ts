// ════════════════════════════════════════════════════════════════
//  Pre-market readiness check — no signal generation
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getUniverseMaxSize, getUniverseMinSize } from '@/lib/marketData/nifty500Universe';
import { loadActiveEqSymbolsFromMaster } from '@/lib/marketData/securitiesMaster';

export interface ScanReadinessResult {
  ok: boolean;
  checkedAt: string;
  universeActive: number;
  universeMin: number;
  universeMax: number;
  securitiesMasterEq: number;
  candleCoveragePct: number;
  lastScheduledScanAt: string | null;
  blockers: string[];
  warnings: string[];
}

const SCHEDULED_SCAN_SOURCES = [
  'cron:morning-scan',
  'cron:first-morning-scan',
  'cron:main-morning-scan',
  'cron:evening-scan',
];

async function probeCandleCoverage(universeCount: number): Promise<number> {
  if (universeCount <= 0) return 0;
  const minBars = Number(process.env.READINESS_MIN_CANDLE_BARS) || 100;
  const { rows } = await db.query<{ covered: number }>(
    `SELECT COUNT(*) AS covered FROM (
       SELECT u.symbol
         FROM q365_universe u
         INNER JOIN (
           SELECT instrument_key, COUNT(*) AS bar_count
             FROM candles
            WHERE candle_type = 'eod' AND interval_unit = '1day'
            GROUP BY instrument_key
         ) c ON c.instrument_key = CONCAT('NSE_EQ|', u.symbol)
        WHERE u.is_active = 1 AND c.bar_count >= ?
     ) t`,
    [minBars],
  );
  const covered = Number((rows[0] as { covered?: number })?.covered ?? 0);
  return Math.round((covered / universeCount) * 1000) / 10;
}

async function probeLastScheduledScan(): Promise<string | null> {
  const placeholders = SCHEDULED_SCAN_SOURCES.map(() => '?').join(',');
  const { rows } = await db.query<{ ts: Date | string | null }>(
    `SELECT MAX(generated_at) AS ts
       FROM q365_signals
      WHERE generation_source IN (${placeholders})`,
    SCHEDULED_SCAN_SOURCES,
  );
  const ts = (rows[0] as { ts?: Date | string | null })?.ts;
  if (!ts) return null;
  return ts instanceof Date ? ts.toISOString() : String(ts);
}

export async function runScanReadinessCheck(): Promise<ScanReadinessResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const min = getUniverseMinSize();
  const max = getUniverseMaxSize();

  const [{ rows: uniRows }, masterEq, lastScan] = await Promise.all([
    db.query<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM q365_universe WHERE is_active = 1`),
    loadActiveEqSymbolsFromMaster().catch(() => [] as string[]),
    probeLastScheduledScan(),
  ]);

  const universeActive = Number((uniRows[0] as { cnt?: number })?.cnt ?? 0);
  if (universeActive < min) {
    blockers.push(`q365_universe active=${universeActive} < min=${min}`);
  }
  if (universeActive > max) {
    blockers.push(`q365_universe active=${universeActive} > max=${max}`);
  }
  if (masterEq.length === 0) {
    warnings.push('securities_master has no EQ rows — run loadSecuritiesMaster.ts');
  }

  const candleCoveragePct = await probeCandleCoverage(universeActive).catch(() => 0);
  const minCoverage = Number(process.env.READINESS_MIN_CANDLE_COVERAGE_PCT) || 40;
  if (candleCoveragePct < minCoverage) {
    blockers.push(`candle coverage ${candleCoveragePct}% < ${minCoverage}%`);
  }

  const result: ScanReadinessResult = {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    universeActive,
    universeMin: min,
    universeMax: max,
    securitiesMasterEq: masterEq.length,
    candleCoveragePct,
    lastScheduledScanAt: lastScan,
    blockers,
    warnings,
  };

  console.log(
    `[READINESS_CHECK] ok=${result.ok} universe=${universeActive} ` +
    `master_eq=${masterEq.length} candle_coverage_pct=${candleCoveragePct} ` +
    `last_scan=${lastScan ?? 'none'} ` +
    `blockers=${blockers.length} warnings=${warnings.length}`,
  );
  if (blockers.length > 0) {
    console.warn('[READINESS_CHECK] blockers:', blockers);
  }
  if (warnings.length > 0) {
    console.warn('[READINESS_CHECK] warnings:', warnings);
  }

  return result;
}
