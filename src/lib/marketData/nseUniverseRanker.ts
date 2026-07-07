// ════════════════════════════════════════════════════════════════
//  NSE Top-1000 universe ranker — liquidity + candle completeness
//
//  Ranks EQ symbols from securities_master by:
//    1. Traded value (sum volume × close, recent window)
//    2. Volume consistency (share of days with non-zero volume)
//    3. Candle data completeness (bar count vs target)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getUniverseMinSize } from './nifty500Universe';
import { loadActiveEqSymbolsFromMaster } from './securitiesMaster';

export interface UniverseRankInput {
  symbol:              string;
  tradedValue:         number;
  volumeConsistency:   number;
  candleCompleteness:  number;
  compositeScore:      number;
}

export interface BuildNseUniverseOptions {
  targetSize?:          number;
  lookbackDays?:        number;
  minBarsTarget?:       number;
  /** When true, only rank symbols that appear in securities_master EQ. */
  requireMaster?:       boolean;
  /** When true (default), refuse ranking until candle coverage threshold is met. */
  requireCandleData?:   boolean;
  /** Minimum % of EQ master with minBarsTarget bars. Default from env or 30. */
  minCoveragePct?:      number;
  /** Only rank symbols with at least this many total daily bars. Default 80. */
  minEligibleBars?:     number;
}

export interface BuildNseUniverseResult {
  ranked:     UniverseRankInput[];
  selected:   string[];
  candidates: number;
}

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

export const NSE_UNIVERSE_TARGET_DEFAULT = () =>
  envNum('UNIVERSE_TARGET_SIZE', 100, 3000, 1000);

export const NSE_UNIVERSE_MIN_COVERAGE_PCT_DEFAULT = () =>
  envNum('UNIVERSE_REBUILD_MIN_CANDLE_COVERAGE_PCT', 5, 100, 30);

export const NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT = () =>
  envNum('UNIVERSE_ACCEPTANCE_MIN_BARS', 50, 300, 80);

function instrumentKey(symbol: string): string {
  return `NSE_EQ|${symbol.toUpperCase()}`;
}

/** Pure scoring — exported for tests. */
export function scoreUniverseCandidate(input: {
  tradedValue:        number;
  volumeConsistency:  number;
  candleCompleteness: number;
  maxTradedValue:     number;
}): number {
  // Log-normalise traded value so the top few mega-caps do not dominate
  // the whole NSE1000 cut. Liquidity still carries the largest weight,
  // but mid/liquid symbols can rank on consistency + data completeness.
  const tvNorm = input.maxTradedValue > 0
    ? Math.log1p(Math.max(0, input.tradedValue)) / Math.log1p(input.maxTradedValue)
    : 0;
  const vc = Math.max(0, Math.min(1, input.volumeConsistency));
  const cc = Math.max(0, Math.min(1, input.candleCompleteness));
  return tvNorm * 0.50 + vc * 0.25 + cc * 0.25;
}

interface CandleAggRow {
  symbol: string;
  bar_count: number;
  traded_value: number;
  active_volume_days: number;
}

async function loadCandleAggregates(
  symbols: string[],
  lookbackDays: number,
): Promise<Map<string, CandleAggRow>> {
  if (symbols.length === 0) return new Map();

  const keys = symbols.map(instrumentKey);
  const placeholders = keys.map(() => '?').join(',');
  const { rows } = await db.query<{
    symbol: string;
    bar_count: number;
    traded_value: number;
    active_volume_days: number;
  }>(
    `SELECT
       SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol,
       COUNT(*) AS bar_count,
       COALESCE(SUM(volume * close), 0) AS traded_value,
       SUM(CASE WHEN volume > 0 THEN 1 ELSE 0 END) AS active_volume_days
     FROM candles
     WHERE candle_type = 'eod'
       AND interval_unit = '1day'
       AND instrument_key IN (${placeholders})
       AND ts >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY instrument_key`,
    [...keys, lookbackDays],
  );

  const out = new Map<string, CandleAggRow>();
  for (const r of rows) {
    const sym = String(r.symbol ?? '').trim().toUpperCase();
    if (!sym) continue;
    out.set(sym, {
      symbol: sym,
      bar_count: Number(r.bar_count ?? 0),
      traded_value: Number(r.traded_value ?? 0),
      active_volume_days: Number(r.active_volume_days ?? 0),
    });
  }
  return out;
}

async function loadTotalBarCounts(symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map();
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  const { rows } = await db.query<{ symbol: string; bar_count: number }>(
    `SELECT symbol, COUNT(*) AS bar_count
       FROM market_data_daily
      GROUP BY symbol`,
  );
  const out = new Map<string, number>();
  for (const r of rows as Array<{ symbol: string; bar_count: number }>) {
    const sym = String(r.symbol).trim().toUpperCase();
    if (!wanted.has(sym)) continue;
    out.set(sym, Number(r.bar_count) || 0);
  }
  return out;
}

/** Total daily bar counts from market_data_daily for churn / eligibility. */
export const loadTotalDailyBarCounts = loadTotalBarCounts;

export interface CandleCoverageStats {
  eqMasterCount: number;
  withAnyCandles: number;
  withMinBars: number;
  coveragePct: number;
  minBarsTarget: number;
  minCoveragePct: number;
  targetSize: number;
  readyForRanking: boolean;
  blockers: string[];
  sql: {
    countWithMinBars: string;
    countActiveUniverse: string;
    coverageBySymbol: string;
  };
}

/** Assess whether securities_master EQ pool has enough candle history to rank. */
export async function assessCandleCoverageForRanking(
  options: {
    minBarsTarget?: number;
    minCoveragePct?: number;
    targetSize?: number;
  } = {},
): Promise<CandleCoverageStats> {
  const minBarsTarget = options.minBarsTarget
    ?? NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT();
  const minCoveragePct = options.minCoveragePct ?? NSE_UNIVERSE_MIN_COVERAGE_PCT_DEFAULT();
  const targetSize = options.targetSize ?? NSE_UNIVERSE_TARGET_DEFAULT();
  const blockers: string[] = [];

  const masterSymbols = await loadActiveEqSymbolsFromMaster();
  const eqMasterCount = masterSymbols.length;
  if (eqMasterCount === 0) {
    blockers.push('securities_master has no active EQ rows');
  }

  let withAnyCandles = 0;
  let withMinBars = 0;
  if (eqMasterCount > 0) {
    const { rows } = await db.query<{ with_any: number; with_min: number }>(
      `SELECT
         SUM(CASE WHEN COALESCE(d.bar_count, 0) > 0 THEN 1 ELSE 0 END) AS with_any,
         SUM(CASE WHEN COALESCE(d.bar_count, 0) >= ? THEN 1 ELSE 0 END) AS with_min
       FROM (
         SELECT symbol FROM securities_master WHERE is_active = 1 AND series = 'EQ'
       ) m
       LEFT JOIN (
         SELECT symbol, COUNT(*) AS bar_count
           FROM market_data_daily
          GROUP BY symbol
       ) d ON d.symbol COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci`,
      [minBarsTarget],
    );
    const row = (rows[0] as { with_any?: number; with_min?: number }) ?? {};
    withAnyCandles = Number(row.with_any) || 0;
    withMinBars = Number(row.with_min) || 0;
  }

  const coveragePct = eqMasterCount > 0
    ? Math.round((withMinBars / eqMasterCount) * 1000) / 10
    : 0;

  if (withAnyCandles === 0 && eqMasterCount > 0) {
    blockers.push('no EQ symbols have candle data — run candle backfill first');
  }
  if (withMinBars < getUniverseMinSize() && eqMasterCount > 0) {
    blockers.push(
      `only ${withMinBars}/${getUniverseMinSize()} EQ symbols have >=${minBarsTarget} daily bars ` +
      `(production min=${getUniverseMinSize()}) — ` +
      'run: npx tsx scripts/backfillCandles.ts --source securities_master --resume --min-bars 80',
    );
  } else if (withMinBars < targetSize && eqMasterCount > 0) {
    console.warn(
      `[NSE1000_COVERAGE] eligible ${withMinBars} < target ${targetSize} — ` +
      'ranking proceeds; run backfill to reach full NSE 1000',
    );
  }
  if (coveragePct < minCoveragePct) {
    blockers.push(
      `candle coverage ${coveragePct}% < min=${minCoveragePct}% (with_min_bars=${withMinBars}/${eqMasterCount})`,
    );
  }

  return {
    eqMasterCount,
    withAnyCandles,
    withMinBars,
    coveragePct,
    minBarsTarget,
    minCoveragePct,
    targetSize,
    readyForRanking: blockers.length === 0,
    blockers,
    sql: {
      countWithMinBars:
        `SELECT COUNT(*) AS with_min_bars FROM securities_master m
         INNER JOIN (
           SELECT symbol, COUNT(*) AS bar_count FROM market_data_daily GROUP BY symbol
         ) d ON d.symbol COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci
         WHERE m.is_active=1 AND m.series='EQ' AND d.bar_count >= ${minBarsTarget};`,
      countActiveUniverse:
        "SELECT COUNT(*) AS active_universe FROM q365_universe WHERE is_active = 1;",
      coverageBySymbol:
        `SELECT m.symbol, COALESCE(d.bar_count, 0) AS bar_count
           FROM securities_master m
           LEFT JOIN (
             SELECT symbol, COUNT(*) AS bar_count FROM market_data_daily GROUP BY symbol
           ) d ON d.symbol COLLATE utf8mb4_unicode_ci = m.symbol COLLATE utf8mb4_unicode_ci
          WHERE m.is_active=1 AND m.series='EQ'
          ORDER BY bar_count DESC LIMIT 50;`,
    },
  };
}

export function logCandleCoverageValidation(stats: CandleCoverageStats): void {
  console.log(
    `[NSE1000_COVERAGE] ready=${stats.readyForRanking} eq_master=${stats.eqMasterCount} ` +
    `with_any_candles=${stats.withAnyCandles} with_min_bars=${stats.withMinBars} ` +
    `coverage_pct=${stats.coveragePct} min_bars=${stats.minBarsTarget} ` +
    `min_coverage_pct=${stats.minCoveragePct} target=${stats.targetSize}`,
  );
  if (stats.blockers.length > 0) {
    console.warn('[NSE1000_COVERAGE] blockers:', stats.blockers);
  }
  console.log('[NSE1000_COVERAGE SQL]');
  for (const sql of Object.values(stats.sql)) {
    console.log(`  ${sql}`);
  }
}

async function loadMasterMetaForSymbols(
  symbols: string[],
): Promise<Map<string, { companyName: string; isin: string | null }>> {
  if (symbols.length === 0) return new Map();
  const placeholders = symbols.map(() => '?').join(',');
  const { rows } = await db.query<{
    symbol: string;
    company_name: string;
    isin: string | null;
  }>(
    `SELECT symbol, company_name, isin
       FROM securities_master
      WHERE symbol IN (${placeholders})`,
    symbols,
  );
  const out = new Map<string, { companyName: string; isin: string | null }>();
  for (const r of rows as Array<{ symbol: string; company_name: string; isin: string | null }>) {
    const sym = String(r.symbol).trim().toUpperCase();
    out.set(sym, {
      companyName: String(r.company_name ?? sym).trim() || sym,
      isin: r.isin ? String(r.isin).trim() || null : null,
    });
  }
  return out;
}

export async function rankNseUniverseCandidates(
  options: BuildNseUniverseOptions = {},
): Promise<UniverseRankInput[]> {
  const lookbackDays = options.lookbackDays
    ?? envNum('UNIVERSE_RANK_LOOKBACK_DAYS', 30, 365, 90);
  const minBarsTarget = options.minBarsTarget
    ?? envNum('UNIVERSE_RANK_MIN_BARS', 50, 500, 200);
  const minEligibleBars = options.minEligibleBars ?? NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT();

  const masterSymbols = options.requireMaster !== false
    ? await loadActiveEqSymbolsFromMaster()
    : [];

  if (masterSymbols.length === 0 && options.requireMaster !== false) {
    throw new Error(
      'securities_master has no active EQ rows. Run: npx tsx scripts/loadSecuritiesMaster.ts',
    );
  }

  const totalBars = await loadTotalBarCounts(masterSymbols);
  const eligibleSymbols = masterSymbols.filter(
    (sym) => (totalBars.get(sym) ?? 0) >= minEligibleBars,
  );

  if (eligibleSymbols.length === 0) {
    throw new Error(
      `No EQ symbols have >=${minEligibleBars} daily bars in market_data_daily. ` +
      'Run candle backfill against securities_master first.',
    );
  }

  const candleAggs = await loadCandleAggregates(eligibleSymbols, lookbackDays);
  const ranked: UniverseRankInput[] = [];

  for (const symbol of eligibleSymbols) {
    const agg = candleAggs.get(symbol);
    const barCount = agg?.bar_count ?? 0;
    const totalBarCount = totalBars.get(symbol) ?? 0;
    const tradedValue = agg?.traded_value ?? 0;
    const activeDays = agg?.active_volume_days ?? 0;
    // Consistency is "how many observed recent bars had volume", not
    // active days divided by calendar days. Calendar-day division penalised
    // every symbol for weekends/holidays and pushed otherwise liquid names
    // below thin names with fewer rows.
    const volumeConsistency = barCount > 0 ? activeDays / barCount : 0;
    // Completeness is based on total EOD history available in the warehouse,
    // not only the rolling liquidity window. A 90-calendar-day rank window
    // has ~60 trading bars, so comparing recent bars to a 200-bar target made
    // complete symbols look incomplete.
    const candleCompleteness = minBarsTarget > 0
      ? Math.min(1, totalBarCount / minBarsTarget)
      : 0;
    ranked.push({
      symbol,
      tradedValue,
      volumeConsistency,
      candleCompleteness,
      compositeScore: 0,
    });
  }

  const maxTv = ranked.reduce((m, r) => Math.max(m, r.tradedValue), 0);
  for (const r of ranked) {
    r.compositeScore = scoreUniverseCandidate({
      tradedValue: r.tradedValue,
      volumeConsistency: r.volumeConsistency,
      candleCompleteness: r.candleCompleteness,
      maxTradedValue: maxTv,
    });
  }

  ranked.sort((a, b) => {
    const d = b.compositeScore - a.compositeScore;
    if (d !== 0) return d;
    const tv = b.tradedValue - a.tradedValue;
    if (tv !== 0) return tv;
    return a.symbol.localeCompare(b.symbol);
  });

  return ranked;
}

export async function buildNseTopUniverse(
  options: BuildNseUniverseOptions = {},
): Promise<BuildNseUniverseResult> {
  const targetSize = options.targetSize ?? NSE_UNIVERSE_TARGET_DEFAULT();
  const requireCandleData = options.requireCandleData !== false;

  if (requireCandleData) {
    const coverage = await assessCandleCoverageForRanking({
      minBarsTarget: options.minBarsTarget,
      minCoveragePct: options.minCoveragePct,
      targetSize,
    });
    logCandleCoverageValidation(coverage);
    if (!coverage.readyForRanking) {
      throw new Error(
        `Cannot build NSE top-${targetSize} — candle data insufficient. ` +
        `Blockers: ${coverage.blockers.join('; ')}. ` +
        'Run candle backfill against securities_master first.',
      );
    }
  }

  const ranked = await rankNseUniverseCandidates(options);
  if (ranked.length < targetSize) {
    throw new Error(
      `Cannot build NSE top-${targetSize}: only ${ranked.length} eligible EQ symbols ` +
      `have sufficient candle history. Run securities_master candle backfill until ` +
      `at least ${targetSize} symbols pass eligibility.`,
    );
  }
  const selected = ranked.slice(0, targetSize).map((r) => r.symbol);
  return { ranked, selected, candidates: ranked.length };
}

export interface ApplyUniverseResult {
  activated:   number;
  deactivated: number;
  totalActive: number;
  added?:        number;
  kept?:         number;
  removed?:      number;
  sql: {
    countActive: string;
    sampleActive: string;
  };
}

/** Apply an explicit symbol selection to q365_universe (supports churn control). */
export async function applyNseUniverseSelectionToDb(
  ranked: UniverseRankInput[],
  selectedSymbols: string[],
  opts: { dryRun?: boolean; churn?: { added: number; kept: number; removed: number } } = {},
): Promise<ApplyUniverseResult> {
  const selectedSet = new Set(selectedSymbols.map((s) => s.toUpperCase()));
  const rankedBySymbol = new Map(ranked.map((r) => [r.symbol.toUpperCase(), r]));
  const selected = selectedSymbols
    .map((s) => s.toUpperCase())
    .filter((s) => selectedSet.has(s));

  if (opts.dryRun) {
    return {
      activated: selected.length,
      deactivated: 0,
      totalActive: selected.length,
      added: opts.churn?.added,
      kept: opts.churn?.kept,
      removed: opts.churn?.removed,
      sql: {
        countActive:
          "SELECT COUNT(*) AS active_universe FROM q365_universe WHERE is_active = 1;",
        sampleActive:
          "SELECT symbol, company_name, isin FROM q365_universe WHERE is_active = 1 ORDER BY symbol LIMIT 20;",
      },
    };
  }

  const meta = await loadMasterMetaForSymbols(selected);

  for (const sym of selected) {
    const row = rankedBySymbol.get(sym);
    const master = meta.get(sym);
    const companyName = master?.companyName ?? sym;
    const isin = master?.isin ?? null;
    await db.query(
      `INSERT INTO q365_universe (symbol, company_name, isin, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         company_name = VALUES(company_name),
         isin = VALUES(isin),
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [sym, companyName, isin],
    );
  }

  const { rows: activeRows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM q365_universe WHERE is_active = 1`,
  );
  let deactivated = 0;
  for (const r of activeRows as Array<{ symbol: string }>) {
    const sym = String(r.symbol).trim().toUpperCase();
    if (!selectedSet.has(sym)) {
      await db.query(
        `UPDATE q365_universe SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE symbol = ?`,
        [sym],
      );
      deactivated++;
    }
  }

  return {
    activated: selected.length,
    deactivated,
    totalActive: selected.length,
    added: opts.churn?.added,
    kept: opts.churn?.kept,
    removed: opts.churn?.removed,
    sql: {
      countActive:
        "SELECT COUNT(*) AS active_universe FROM q365_universe WHERE is_active = 1;",
      sampleActive:
        "SELECT symbol, company_name, isin FROM q365_universe WHERE is_active = 1 ORDER BY symbol LIMIT 20;",
    },
  };
}

/** Upsert top-N into q365_universe; deactivate symbols outside the cut. */
export async function applyNseTopUniverseToDb(
  ranked: UniverseRankInput[],
  targetSize: number,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyUniverseResult> {
  const selected = ranked.slice(0, targetSize).map((r) => r.symbol);
  return applyNseUniverseSelectionToDb(ranked, selected, opts);
}

export function logUniverseApplyValidation(
  applied: ApplyUniverseResult,
  targetSize: number,
): void {
  console.log(
    `[NSE1000_UNIVERSE] applied activated=${applied.activated} deactivated=${applied.deactivated} ` +
    `total_active=${applied.totalActive} target=${targetSize}`,
  );
  console.log('[NSE1000_UNIVERSE SQL]');
  for (const sql of Object.values(applied.sql)) {
    console.log(`  ${sql}`);
  }
}
