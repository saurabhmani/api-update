// ════════════════════════════════════════════════════════════════
//  NSE Top-1000 universe ranker — liquidity + candle completeness
//
//  Ranks EQ symbols from securities_master by:
//    1. Traded value (sum volume × close, recent window)
//    2. Volume consistency (share of days with non-zero volume)
//    3. Candle data completeness (bar count vs target)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
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
  const tvNorm = input.maxTradedValue > 0
    ? input.tradedValue / input.maxTradedValue
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

export async function rankNseUniverseCandidates(
  options: BuildNseUniverseOptions = {},
): Promise<UniverseRankInput[]> {
  const lookbackDays = options.lookbackDays
    ?? envNum('UNIVERSE_RANK_LOOKBACK_DAYS', 30, 365, 90);
  const minBarsTarget = options.minBarsTarget
    ?? envNum('UNIVERSE_RANK_MIN_BARS', 50, 500, 200);

  const masterSymbols = options.requireMaster !== false
    ? await loadActiveEqSymbolsFromMaster()
    : [];

  if (masterSymbols.length === 0 && options.requireMaster !== false) {
    throw new Error(
      'securities_master has no active EQ rows. Run: npx tsx scripts/loadSecuritiesMaster.ts',
    );
  }

  const candleAggs = await loadCandleAggregates(masterSymbols, lookbackDays);
  const ranked: UniverseRankInput[] = [];

  for (const symbol of masterSymbols) {
    const agg = candleAggs.get(symbol);
    const barCount = agg?.bar_count ?? 0;
    const tradedValue = agg?.traded_value ?? 0;
    const activeDays = agg?.active_volume_days ?? 0;
    const volumeConsistency = lookbackDays > 0 ? activeDays / lookbackDays : 0;
    const candleCompleteness = minBarsTarget > 0
      ? Math.min(1, barCount / minBarsTarget)
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
    return a.symbol.localeCompare(b.symbol);
  });

  return ranked;
}

export async function buildNseTopUniverse(
  options: BuildNseUniverseOptions = {},
): Promise<BuildNseUniverseResult> {
  const targetSize = options.targetSize ?? NSE_UNIVERSE_TARGET_DEFAULT();
  const ranked = await rankNseUniverseCandidates(options);
  const selected = ranked.slice(0, targetSize).map((r) => r.symbol);
  return { ranked, selected, candidates: ranked.length };
}

export interface ApplyUniverseResult {
  activated:   number;
  deactivated: number;
  totalActive: number;
}

/** Upsert top-N into q365_universe; deactivate symbols outside the cut. */
export async function applyNseTopUniverseToDb(
  ranked: UniverseRankInput[],
  targetSize: number,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyUniverseResult> {
  const selected = ranked.slice(0, targetSize);
  const selectedSet = new Set(selected.map((r) => r.symbol));

  if (opts.dryRun) {
    return { activated: selected.length, deactivated: 0, totalActive: selected.length };
  }

  for (const row of selected) {
    await db.query(
      `INSERT INTO q365_universe (symbol, company_name, is_active)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1, updated_at = CURRENT_TIMESTAMP`,
      [row.symbol, row.symbol],
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
  };
}
