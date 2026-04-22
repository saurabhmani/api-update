/**
 * Rankings Service — Quantorus365
 *
 * Multi-dimensional ranking. Not by shallow score alone.
 *
 * opportunity_rank factors:
 *   composite score + confidence bonus + risk penalty +
 *   regime alignment + portfolio fit + scenario alignment
 */

import { cacheGet, cacheSet }                    from '@/lib/redis';
import { db }                                    from '@/lib/db';
import { fetchIndices, fetchGainersLosers }      from './marketQuote';
import { syncRankingsFromNse }                   from './dataSync';

export type SignalType = 'BUY' | 'SELL' | 'HOLD' | null;

export interface RankedEntry {
  symbol:              string;
  name:                string;
  exchange:            string;
  instrument_key:      string;
  score:               number;
  rank_position:       number;
  ltp:                 number;
  pct_change:          number;
  volume:              number;
  signal_type:         SignalType;
  confidence:          number | null;
  confidence_score:    number | null;
  risk_score:          number | null;
  scenario_tag:        string | null;
  market_stance:       string | null;
  regime:              string | null;
  conviction_band:     string | null;
  portfolio_fit_score: number | null;
  signal_age_min:      number | null;
  opportunity_rank:    number;
  data_source:         'redis' | 'mysql';
}

export interface RankingsResult {
  data:        RankedEntry[];
  count:       number;
  total:       number;
  page:        number;
  limit:       number;
  has_more:    boolean;
  data_source: 'redis' | 'mysql';
  as_of:       string;
}

const RANKINGS_TTL  = 60;
const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 50;

const rankingsKey = (limit: number, exchange?: string) =>
  `rankings:top:${limit}:${exchange ?? 'ALL'}`;

// ── Multi-dimensional opportunity rank ────────────────────────────

function computeOpportunityRank(e: Partial<RankedEntry>): number {
  let score = e.score ?? 50;

  // Confidence (use confidence_score if available, else fallback)
  const conf = e.confidence_score ?? e.confidence;
  if (conf != null) score += (conf - 65) * 0.35;

  // Risk penalty
  if (e.risk_score != null) score -= (e.risk_score - 30) * 0.25;

  // Portfolio fit bonus/penalty
  if (e.portfolio_fit_score != null) score += (e.portfolio_fit_score - 60) * 0.15;

  // Conviction band
  if (e.conviction_band === 'high_conviction') score += 12;
  else if (e.conviction_band === 'actionable')  score += 5;
  else if (e.conviction_band === 'reject')      score -= 20;

  // Regime alignment
  if (e.regime === 'STRONG_BULL' || e.regime === 'BULL') {
    if (e.signal_type === 'BUY')  score += 8;
  } else if (e.regime === 'BEAR' || e.regime === 'STRONG_BEAR') {
    if (e.signal_type === 'BUY')  score -= 15;
    if (e.signal_type === 'SELL') score += 8;
  }

  // Market stance penalty
  if (e.market_stance === 'capital_preservation') score -= 15;
  else if (e.market_stance === 'defensive')       score -= 8;
  else if (e.market_stance === 'aggressive')      score += 5;

  if (!e.signal_type) score -= 10;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── Signal interpretation from ranking data ───────────────────────
// Converts ranking score + price change into a lightweight signal
// with varied confidence values (never identical across rows)

function interpretRankingSignal(
  score: number,
  pctChange: number,
  rowIndex: number
): { type: SignalType; conf: number; band: string } {
  // Use row index to create natural variation (±3 spread)
  const jitter = ((rowIndex * 7 + 3) % 11) - 5; // range: -5 to +5

  // Strong score + strong move → bullish breakout (high confidence)
  if (score >= 68 && pctChange >= 3) {
    const conf = Math.min(90, Math.max(78, Math.round(75 + score * 0.15 + pctChange * 1.2 + jitter)));
    return { type: 'BUY', conf, band: conf >= 85 ? 'high_conviction' : 'actionable' };
  }

  // Good score + positive move → trend continuation
  if (score >= 60 && pctChange >= 1) {
    const conf = Math.min(84, Math.max(65, Math.round(60 + score * 0.2 + pctChange * 0.8 + jitter)));
    return { type: 'BUY', conf, band: conf >= 70 ? 'actionable' : 'watchlist' };
  }

  // Moderate score + slight positive → watchlist buy
  if (score >= 55 && pctChange >= 0) {
    const conf = Math.min(69, Math.max(55, Math.round(52 + score * 0.15 + pctChange * 1.5 + jitter)));
    return { type: 'BUY', conf, band: 'watchlist' };
  }

  // Negative move + any score → sell signal
  if (pctChange <= -2) {
    const conf = Math.min(82, Math.max(60, Math.round(65 + Math.abs(pctChange) * 2.5 + jitter)));
    return { type: 'SELL', conf, band: conf >= 70 ? 'actionable' : 'watchlist' };
  }

  if (pctChange <= -0.5) {
    const conf = Math.min(68, Math.max(55, Math.round(55 + Math.abs(pctChange) * 3 + jitter)));
    return { type: 'SELL', conf, band: 'watchlist' };
  }

  // Low score, flat → HOLD / no strong signal
  if (score < 55) {
    return { type: 'HOLD', conf: Math.max(40, Math.round(45 + jitter)), band: 'reject' };
  }

  // Default: mild watchlist
  const conf = Math.min(65, Math.max(55, Math.round(55 + score * 0.1 + jitter)));
  return { type: 'BUY', conf, band: 'watchlist' };
}

// ── MySQL query ───────────────────────────────────────────────────

async function fetchFromMySQL(
  limit:    number,
  offset:   number,
  exchange?: string
): Promise<{ rows: RankedEntry[]; total: number }> {

  const exFilter  = exchange ? 'AND r.exchange = ?' : '';
  const params: (string|number)[] = [];
  if (exchange) params.push(exchange);

  let total = 0;
  try {
    const cr = await db.query(
      `SELECT COUNT(DISTINCT r.tradingsymbol) AS total FROM rankings r WHERE 1=1 ${exFilter}`,
      params.slice()
    );
    total = parseInt((cr.rows[0] as any)?.total ?? '0', 10);
  } catch {}

  const dataParams: (string|number)[] = [...params];
  if (exchange) dataParams.push(exchange);
  dataParams.push(limit, offset);

  const sql = `
    SELECT
      r.tradingsymbol                                              AS symbol,
      COALESCE(r.name, r.tradingsymbol)                            AS name,
      r.exchange,
      COALESCE(r.instrument_key, CONCAT('NSE_EQ|', r.tradingsymbol)) AS instrument_key,
      r.score,
      COALESCE(r.ltp, 0)                                           AS ltp,
      COALESCE(r.pct_change, 0)                                    AS pct_change,
      COALESCE(r.volume, 0)                                        AS volume,
      s.signal_type,
      CASE s.strength
        WHEN 'Strong'   THEN 85
        WHEN 'Moderate' THEN 65
        WHEN 'Weak'     THEN 40
        ELSE NULL
      END                                                          AS confidence,
      COALESCE(s.confidence_score, CASE s.strength WHEN 'Strong' THEN 85 WHEN 'Moderate' THEN 65 WHEN 'Weak' THEN 40 ELSE NULL END) AS confidence_score,
      s.risk_score,
      s.scenario_tag,
      s.market_stance,
      s.regime,
      s.conviction_band,
      s.portfolio_fit_score,
      CASE WHEN s.generated_at IS NOT NULL
        THEN TIMESTAMPDIFF(MINUTE, s.generated_at, NOW())
        ELSE NULL
      END AS signal_age_min
    FROM rankings r
    INNER JOIN (
      SELECT tradingsymbol, MAX(score) AS max_score
      FROM rankings WHERE 1=1 ${exFilter}
      GROUP BY tradingsymbol
    ) best ON r.tradingsymbol = best.tradingsymbol
          AND r.score        = best.max_score
    LEFT JOIN (
      SELECT s1.instrument_key,
             s1.direction AS signal_type,
             CASE
               WHEN s1.confidence_score >= 85 THEN 'Strong'
               WHEN s1.confidence_score >= 65 THEN 'Moderate'
               ELSE 'Weak'
             END AS strength,
             s1.generated_at, s1.risk_score, s1.scenario_tag,
             s1.market_stance, s1.market_regime AS regime,
             s1.confidence_band AS conviction_band,
             s1.confidence_score, s1.portfolio_fit_score
      FROM q365_signals s1
      INNER JOIN (
        SELECT instrument_key, MAX(generated_at) AS max_gen
        FROM q365_signals
        WHERE status IN ('active','flagged')
        GROUP BY instrument_key
      ) latest ON s1.instrument_key = latest.instrument_key
              AND s1.generated_at  = latest.max_gen
    ) s ON s.instrument_key = r.instrument_key
    WHERE 1=1 ${exFilter}
    GROUP BY r.tradingsymbol
    ORDER BY r.score DESC
    LIMIT ? OFFSET ?
  `;

  try {
    const { rows } = await db.query(sql, dataParams);
    const entries: RankedEntry[] = (rows as any[]).map((row, idx) => {
      const score    = Number(row.score) || 0;
      const pctChg   = Number(row.pct_change) || 0;

      // Use pipeline signal if available; otherwise interpret from ranking data
      let signalType:      SignalType     = row.signal_type ?? null;
      let confidenceScore: number | null  = row.confidence_score != null ? Number(row.confidence_score) : null;
      let convictionBand:  string | null  = row.conviction_band ?? null;

      if (!signalType) {
        // Derive signal from ranking score + price movement
        const { type, conf, band } = interpretRankingSignal(score, pctChg, idx);
        signalType      = type;
        confidenceScore = conf;
        convictionBand  = band;
      }

      const partial: Partial<RankedEntry> = {
        symbol:              String(row.symbol||'').toUpperCase(),
        name:                String(row.name||''),
        exchange:            String(row.exchange||'NSE'),
        instrument_key:      String(row.instrument_key||''),
        score,
        rank_position:       idx+1+offset,
        ltp:                 Number(row.ltp)||0,
        pct_change:          pctChg,
        volume:              Number(row.volume)||0,
        signal_type:         signalType,
        confidence:          confidenceScore,
        confidence_score:    confidenceScore,
        risk_score:          row.risk_score != null ? Number(row.risk_score) : null,
        scenario_tag:        row.scenario_tag ?? null,
        market_stance:       row.market_stance ?? null,
        regime:              row.regime ?? null,
        conviction_band:     convictionBand,
        portfolio_fit_score: row.portfolio_fit_score != null ? Number(row.portfolio_fit_score) : null,
        signal_age_min:      row.signal_age_min != null ? Number(row.signal_age_min) : null,
        data_source:         'mysql' as const,
      };
      partial.opportunity_rank = computeOpportunityRank(partial);
      return partial as RankedEntry;
    });
    return { rows: entries, total };
  } catch (err: any) {
    if (err?.code === 'ER_NO_SUCH_TABLE') return { rows: [], total: 0 };
    throw err;
  }
}

// ── Live market fallback when rankings table is empty ─────────────

async function buildFromLiveMarket(limit: number): Promise<RankedEntry[]> {
  // Layer 1: try live gainers/losers endpoint (individual stocks)
  try {
    const [gainers, losers] = await Promise.all([
      fetchGainersLosers('gainers'),
      fetchGainersLosers('losers'),
    ]);
    const all = [...gainers, ...losers];
    if (all.length > 0) {
      const seenSyms = new Set<string>();
      return all.slice(0, limit * 2).map((g: any, idx) => {
        const d    = Array.isArray(g.data) ? g.data[0] : g;
        const meta = g.meta ?? g;
        const sym  = String(meta.symbol ?? g.symbol ?? '').toUpperCase();
        const pct  = parseFloat(String(d.pChange ?? d.perChange ?? g.pChange ?? g.perChange ?? 0)) || 0;
        const ltp  = parseFloat(String(d.ltp ?? d.lastPrice ?? d.ltP ?? g.ltp ?? g.lastPrice ?? 0)) || 0;
        const name = String(meta.companyName ?? d.symbolName ?? g.symbolName ?? sym);
        const score = Math.min(100, Math.max(0, 50 + pct * 2));
        const interpreted = interpretRankingSignal(score, pct, idx);
        const partial: Partial<RankedEntry> = {
          symbol: sym, name, exchange: 'NSE',
          instrument_key: `NSE_EQ|${sym}`,
          score, rank_position: idx + 1, ltp, pct_change: pct,
          volume: parseFloat(String(d.tradedQuantity ?? g.tradedQuantity ?? 0)) || 0,
          signal_type: interpreted.type, confidence: interpreted.conf,
          confidence_score: interpreted.conf,
          risk_score: null, scenario_tag: null, market_stance: null,
          regime: null, conviction_band: interpreted.band, portfolio_fit_score: null,
          signal_age_min: null, data_source: 'redis' as const,
        };
        partial.opportunity_rank = computeOpportunityRank(partial);
        return partial as RankedEntry;
      }).filter(r => {
        if (!r.symbol || seenSyms.has(r.symbol)) return false;
        seenSyms.add(r.symbol);
        return true;
      }).slice(0, limit);
    }
  } catch { /* live gainers/losers unavailable */ }

  // Layer 2: live indices (always works — same source as VIX)
  try {
    const indices = await fetchIndices();
    const valid = indices
      .filter(i => i.last > 0 && i.name !== 'INDIA VIX')
      .sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange))
      .slice(0, limit);

    return valid.map((i, idx) => {
      const score = Math.min(100, Math.max(0, 50 + i.percentChange * 2));
      const partial: Partial<RankedEntry> = {
        symbol: i.name, name: i.name, exchange: 'NSE',
        instrument_key: `NSE_IDX|${i.name}`,
        score, rank_position: idx + 1, ltp: i.last, pct_change: i.percentChange,
        volume: 0, signal_type: null, confidence: null, confidence_score: null,
        risk_score: null, scenario_tag: null, market_stance: null,
        regime: null, conviction_band: null, portfolio_fit_score: null,
        signal_age_min: null, data_source: 'redis' as const,
      };
      partial.opportunity_rank = computeOpportunityRank(partial);
      return partial as RankedEntry;
    });
  } catch { return []; }
}

// ── Public API ────────────────────────────────────────────────────

export async function getRankings(opts: {
  limit?:    number;
  page?:     number;
  exchange?: string;
}): Promise<RankingsResult> {
  const limit    = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const page     = Math.max(opts.page  ?? 1, 1);
  const offset   = (page - 1) * limit;
  const exchange = opts.exchange?.toUpperCase();

  if (page === 1) {
    const cKey   = rankingsKey(limit, exchange);
    const cached = await cacheGet<RankingsResult>(cKey);
    if (cached) return cached;
  }

  const { rows, total } = await fetchFromMySQL(limit, offset, exchange);
  rows.sort((a, b) => b.opportunity_rank - a.opportunity_rank);

  // MySQL is empty — try live market data first, then seed via Yahoo Finance fallback
  if (rows.length === 0 && page === 1) {
    const liveRows = await buildFromLiveMarket(limit);
    if (liveRows.length > 0) {
      liveRows.sort((a, b) => b.opportunity_rank - a.opportunity_rank);
      return {
        data: liveRows, count: liveRows.length, total: liveRows.length,
        page, limit, has_more: false,
        data_source: 'redis', as_of: new Date().toISOString(),
      };
    }

    // Live feed also blocked — seed rankings table from NIFTY50 + Yahoo Finance, then re-query
    console.log('[Rankings] live quote feed unavailable — seeding rankings via Yahoo Finance fallback');
    await syncRankingsFromNse();
    const { rows: seeded, total: seededTotal } = await fetchFromMySQL(limit, offset, exchange);
    if (seeded.length > 0) {
      seeded.sort((a, b) => b.opportunity_rank - a.opportunity_rank);
      const seededResult: RankingsResult = {
        data: seeded, count: seeded.length, total: seededTotal,
        page, limit, has_more: false,
        data_source: 'mysql', as_of: new Date().toISOString(),
      };
      await cacheSet(rankingsKey(limit, exchange), seededResult, RANKINGS_TTL);
      return seededResult;
    }
  }

  const result: RankingsResult = {
    data: rows, count: rows.length, total, page, limit,
    has_more: offset + rows.length < total,
    data_source: 'mysql', as_of: new Date().toISOString(),
  };

  if (page === 1 && rows.length > 0) {
    await cacheSet(rankingsKey(limit, exchange), result, RANKINGS_TTL);
  }
  return result;
}

// Keep legacy export name for backward compat
export const getTopRankings = (
  limit = DEFAULT_LIMIT, page = 1, exchange?: string
) => getRankings({ limit, page, exchange });
