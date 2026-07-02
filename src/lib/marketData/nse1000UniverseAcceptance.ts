// ════════════════════════════════════════════════════════════════
//  NSE 1000 universe acceptance — post-build validation
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getUniverseMaxSize, getUniverseMinSize } from './nifty500Universe';
import { loadActiveEqSymbolsFromMaster } from './securitiesMaster';
import {
  buildNseTopUniverse,
  NSE_UNIVERSE_TARGET_DEFAULT,
  type BuildNseUniverseResult,
} from './nseUniverseRanker';

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

export const ACCEPTANCE_MIN_BARS_DEFAULT = () =>
  envNum('UNIVERSE_ACCEPTANCE_MIN_BARS', 50, 300, 80);

export const ACCEPTANCE_MIN_BAR_COVERAGE_PCT_DEFAULT = () =>
  envNum('UNIVERSE_ACCEPTANCE_MIN_BAR_COVERAGE_PCT', 50, 100, 80);

export interface Nse1000AcceptanceCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export interface Nse1000AcceptanceResult {
  ok: boolean;
  checkedAt: string;
  targetSize: number;
  checks: Nse1000AcceptanceCheck[];
  sql: Record<string, string>;
  rankedPreview: BuildNseUniverseResult | null;
}

async function countActiveUniverseWithMinBars(minBars: number): Promise<{
  activeTotal: number;
  withMinBars: number;
  pct: number;
}> {
  const { rows } = await db.query<{ active_total: number; with_min_bars: number }>(
    `SELECT
       COUNT(*) AS active_total,
       SUM(CASE WHEN COALESCE(d.bar_count, 0) >= ? THEN 1 ELSE 0 END) AS with_min_bars
     FROM q365_universe u
     LEFT JOIN (
       SELECT symbol, COUNT(*) AS bar_count
         FROM market_data_daily
        GROUP BY symbol
     ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
     WHERE u.is_active = 1`,
    [minBars],
  );
  const row = (rows[0] as { active_total?: number; with_min_bars?: number }) ?? {};
  const activeTotal = Number(row.active_total) || 0;
  const withMinBars = Number(row.with_min_bars) || 0;
  const pct = activeTotal > 0 ? Math.round((withMinBars / activeTotal) * 1000) / 10 : 0;
  return { activeTotal, withMinBars, pct };
}

/** True when universe order matches liquidity rank, not CSV/master alphabetical order. */
function isLiquidityRanked(
  rankedSelected: string[],
  csvOrderSymbols: string[],
): { pass: boolean; detail: string } {
  if (rankedSelected.length < 20 || csvOrderSymbols.length < 20) {
    return { pass: false, detail: 'insufficient symbols to compare rank vs CSV order' };
  }

  const csvTop20 = new Set(csvOrderSymbols.slice(0, 20));
  const rankedTop20 = rankedSelected.slice(0, 20);
  const csvOverlapTop20 = rankedTop20.filter((s) => csvTop20.has(s)).length;

  // CSV file is roughly alphabetical — a liquidity-ranked top-20 should rarely match.
  const pass = csvOverlapTop20 <= 8;
  return {
    pass,
    detail: `top20 overlap with CSV-first-20=${csvOverlapTop20}/20 ` +
      `(ranked_top5=${rankedTop20.slice(0, 5).join(',')})`,
  };
}

export async function runNse1000UniverseAcceptance(
  options: { targetSize?: number; minBars?: number; minBarCoveragePct?: number } = {},
): Promise<Nse1000AcceptanceResult> {
  const targetSize = options.targetSize ?? NSE_UNIVERSE_TARGET_DEFAULT();
  const minBars = options.minBars ?? ACCEPTANCE_MIN_BARS_DEFAULT();
  const minBarCoveragePct = options.minBarCoveragePct ?? ACCEPTANCE_MIN_BAR_COVERAGE_PCT_DEFAULT();
  const checks: Nse1000AcceptanceCheck[] = [];

  const masterEq = await loadActiveEqSymbolsFromMaster();
  checks.push({
    id: 'securities_master_active_eq',
    pass: masterEq.length > 0,
    detail: `active EQ rows=${masterEq.length}`,
  });

  const barStats = await countActiveUniverseWithMinBars(minBars);
  const universeMin = getUniverseMinSize();
  const universeMax = getUniverseMaxSize();

  checks.push({
    id: 'q365_universe_active_count',
    pass: barStats.activeTotal >= universeMin && barStats.activeTotal <= universeMax,
    detail: `active=${barStats.activeTotal} band=[${universeMin},${universeMax}] target=${targetSize}`,
  });

  checks.push({
    id: 'selected_symbols_min_bars',
    pass: barStats.pct >= minBarCoveragePct,
    detail: `${barStats.withMinBars}/${barStats.activeTotal} active symbols have >=${minBars} bars (${barStats.pct}%, min=${minBarCoveragePct}%)`,
  });

  let rankedPreview: BuildNseUniverseResult | null = null;
  let liquidityCheck = { pass: false, detail: 'rank preview not run' };

  if (masterEq.length > 0) {
    try {
      rankedPreview = await buildNseTopUniverse({
        targetSize,
        minBarsTarget: minBars,
        requireCandleData: false,
      });

      const { rows: activeRows } = await db.query<{ symbol: string }>(
        `SELECT symbol FROM q365_universe WHERE is_active = 1 ORDER BY symbol`,
      );
      const activeSet = new Set(
        (activeRows as Array<{ symbol: string }>).map((r) => String(r.symbol).trim().toUpperCase()),
      );
      const rankedSet = new Set(rankedPreview.selected);
      const overlap = rankedPreview.selected.filter((s) => activeSet.has(s)).length;
      const overlapPct = rankedPreview.selected.length > 0
        ? Math.round((overlap / rankedPreview.selected.length) * 1000) / 10
        : 0;
      const activeMatchesRanked = barStats.activeTotal === rankedPreview.selected.length
        && overlap === rankedPreview.selected.length;

      checks.push({
        id: 'universe_matches_liquidity_rank',
        pass: activeMatchesRanked || overlapPct >= 95,
        detail: activeMatchesRanked
          ? `active universe matches ranked selection (${barStats.activeTotal} symbols)`
          : `active universe overlaps ranked top-${targetSize} by ${overlapPct}% (${overlap}/${rankedPreview.selected.length})`,
      });

      liquidityCheck = isLiquidityRanked(rankedPreview.selected, masterEq);
      checks.push({
        id: 'not_csv_order',
        pass: liquidityCheck.pass,
        detail: liquidityCheck.detail,
      });
    } catch (err) {
      checks.push({
        id: 'universe_matches_liquidity_rank',
        pass: false,
        detail: `rank preview failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      checks.push({
        id: 'not_csv_order',
        pass: false,
        detail: 'rank preview failed',
      });
    }
  }

  const ok = checks.every((c) => c.pass);

  const result: Nse1000AcceptanceResult = {
    ok,
    checkedAt: new Date().toISOString(),
    targetSize,
    checks,
    sql: {
      activeEq:
        "SELECT COUNT(*) AS active_eq FROM securities_master WHERE is_active = 1 AND series = 'EQ';",
      activeUniverse:
        'SELECT COUNT(*) AS active_universe FROM q365_universe WHERE is_active = 1;',
      selectedBarDepth:
        `SELECT u.symbol, COALESCE(d.bar_count, 0) AS bar_count
           FROM q365_universe u
           LEFT JOIN (
             SELECT symbol, COUNT(*) AS bar_count FROM market_data_daily GROUP BY symbol
           ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
          WHERE u.is_active = 1
          ORDER BY bar_count ASC LIMIT 20;`,
      topRankedScores:
        `SELECT SUBSTRING_INDEX(c.instrument_key, '|', -1) AS symbol,
                COUNT(*) AS bar_count,
                COALESCE(SUM(c.volume * c.close), 0) AS traded_value
           FROM candles c
          WHERE c.candle_type = 'eod' AND c.interval_unit = '1day'
          GROUP BY c.instrument_key
          ORDER BY traded_value DESC LIMIT 20;`,
    },
    rankedPreview,
  };

  console.log(`[NSE1000_ACCEPTANCE] ok=${ok}`);
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`);
  }
  console.log('[NSE1000_ACCEPTANCE SQL]');
  for (const [key, sql] of Object.entries(result.sql)) {
    console.log(`  -- ${key}\n  ${sql}`);
  }

  return result;
}
