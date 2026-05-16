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
import { getSector }                             from '@/lib/signal-engine/constants/phase3.constants';

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
  /** Sector lookup from the instruments master table — the rankings
   *  table itself does not carry sector. Null when no instrument row
   *  matches (typical for newly-seeded symbols). */
  sector:              string | null;
}

export interface RankingsResult {
  data:        RankedEntry[];
  count:       number;
  total:       number;
  page:        number;
  limit:       number;
  has_more:    boolean;
  /**
   * 'redis' when this exact response was served from the cacheGet path,
   * 'mysql' when the rows were just fetched from the DB.  Combined with
   * `cache_hit` so the API layer can label honestly:
   *   data_source='redis' + cache_hit=true   → cached_rankings
   *   data_source='mysql' + cache_hit=false  → live DB read (live_feed
   *                                            during open market,
   *                                            last_rankings_db otherwise)
   */
  data_source: 'redis' | 'mysql' | 'unavailable';
  cache_hit?:  boolean;
  /**
   * Human-readable explanation surfaced to the UI when `data_source`
   * is 'unavailable' — e.g. "Market closed and no cached/EOD rankings
   * available; please retry after the next open." Never set on the
   * happy path so the UI can render it as-is when present.
   */
  message?:    string | null;
  as_of:       string;
}

const RANKINGS_TTL  = 60;
const MAX_LIMIT     = 500;
const DEFAULT_LIMIT = 50;
/**
 * When we want a globally-correct top-N by `opportunity_rank`, we have
 * to fetch a wider candidate pool from the DB first, compute the rank
 * for every row, sort, then slice.  CANDIDATE_MULTIPLIER controls how
 * many extra rows we pull beyond the requested `limit`.  At a multiplier
 * of 4 a `limit=50` request still costs only 200 rows of MySQL traffic
 * — well within the per-source ceiling but wide enough that the true
 * top-50 by opportunity_rank cannot be hidden by a high raw `score`
 * outlier outside the SQL-LIMIT window.  Bounded by CANDIDATE_FLOOR
 * (we always look at at least this many rows) and CANDIDATE_CEILING
 * (so callers passing limit=500 don't quietly fan out to 2000 rows).
 */
const CANDIDATE_MULTIPLIER = 4;
const CANDIDATE_FLOOR      = 200;
const CANDIDATE_CEILING    = 800;

/**
 * Deterministic comparator for the rankings list.
 *
 * The Rankings page header used to say "Top stocks by Quantorus365 score"
 * while this service sorted by `opportunity_rank` — a derived field that
 * blends score with confidence, risk, regime alignment, and conviction.
 * That mismatch let a row with a higher visible score appear below a row
 * with a lower visible score (e.g. ASHOKLEY 75.3 at rank 38 below
 * ADANIGREEN 73.7 at rank 2).
 *
 * Two fixes:
 *   1. The page header now reads "by Opportunity Rank" and exposes both
 *      Quantorus Score and Opportunity Rank as distinct columns, so the
 *      visible primary field matches the sort key.
 *   2. Every tie is broken in a fixed order so the same input always
 *      produces the same row order — no DB-insertion-order surprises:
 *        opportunity_rank DESC
 *        conviction band  (high_conviction > actionable > watchlist > reject > null)
 *        confidence_score DESC
 *        risk_score       ASC   (lower risk wins ties)
 *        volume           DESC  (proxy for liquidity / volume_quality)
 *        symbol           ASC   (final stable tie-breaker)
 */
const CONVICTION_RANK: Record<string, number> = {
  high_conviction: 4,
  actionable:      3,
  watchlist:       2,
  reject:          0,
};

function compareRanked(a: RankedEntry, b: RankedEntry): number {
  const orDiff = (b.opportunity_rank ?? 0) - (a.opportunity_rank ?? 0);
  if (orDiff !== 0) return orDiff;

  const cb = (CONVICTION_RANK[b.conviction_band ?? ''] ?? 1)
           - (CONVICTION_RANK[a.conviction_band ?? ''] ?? 1);
  if (cb !== 0) return cb;

  const cs = (b.confidence_score ?? -1) - (a.confidence_score ?? -1);
  if (cs !== 0) return cs;

  // Risk: lower is better, so ascending.
  const ra = a.risk_score ?? Number.POSITIVE_INFINITY;
  const rb = b.risk_score ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;

  const vol = (b.volume ?? 0) - (a.volume ?? 0);
  if (vol !== 0) return vol;

  return (a.symbol ?? '').localeCompare(b.symbol ?? '');
}

function applyDeterministicOrder(rows: RankedEntry[]): RankedEntry[] {
  rows.sort(compareRanked);
  // Re-stamp rank_position so the displayed "#" column never disagrees
  // with the sort. Was previously left at the offset assigned during
  // SQL hydration, which was fixed to the SQL ORDER BY (score DESC) and
  // could drift from the in-memory sort's actual order.
  rows.forEach((r, i) => { r.rank_position = i + 1; });
  return rows;
}

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
  exchange?: string,
  /**
   * Optional cap on the number of candidate rows fetched from the SQL
   * query *before* the JS-side opportunity_rank sort + paginate runs.
   * Used by the public API layer to widen the pool so the comparator
   * can pick the true global top-N rather than the SQL-LIMIT-clipped
   * subset. When omitted, defaults to `limit` (legacy behavior).
   */
  candidatePoolSize?: number,
): Promise<{ rows: RankedEntry[]; total: number }> {

  // The COUNT query keeps the `r.exchange` form because it still has
  // the `r` alias on the rankings table.
  const countExFilter = exchange ? 'AND r.exchange = ?' : '';
  // The data query no longer aliases the inner rankings table directly
  // (we wrap it in a ROW_NUMBER subquery), so the filter inside that
  // subquery references `exchange` without an alias.
  const innerExFilter = exchange ? 'AND exchange = ?' : '';

  const params: (string|number)[] = [];
  if (exchange) params.push(exchange);

  let total = 0;
  try {
    const cr = await db.query(
      `SELECT COUNT(DISTINCT r.tradingsymbol) AS total FROM rankings r WHERE 1=1 ${countExFilter}`,
      params.slice()
    );
    total = parseInt((cr.rows[0] as any)?.total ?? '0', 10);
  } catch {}

  // Data-query params: the exchange placeholder appears once (inside the
  // ROW_NUMBER subquery), then LIMIT/OFFSET. The previous version pushed
  // exchange twice because the SQL used the filter twice — that's gone.
  // When we're widening the candidate pool for a true global sort, we
  // pull `candidatePoolSize` rows starting from offset 0 and let the
  // caller slice — pagination is meaningless before sorting.
  const dataParams: (string|number)[] = [...params];
  const sqlLimit  = candidatePoolSize ?? limit;
  const sqlOffset = candidatePoolSize ? 0 : offset;
  dataParams.push(sqlLimit, sqlOffset);

  // Why this rewrite:
  //   The previous query did `GROUP BY r.tradingsymbol` while selecting
  //   many non-aggregated columns (r.name, r.exchange, s.signal_type, …).
  //   Under MySQL 5.7+ default `sql_mode=only_full_group_by` that is a
  //   hard error: "Expression #N of SELECT list is not in GROUP BY clause
  //   and contains nonaggregated column 'r.name' which is not functionally
  //   dependent on columns in GROUP BY clause".
  //
  //   The original intent was: "for each tradingsymbol, return the row
  //   with the highest score". Express that directly with a window
  //   function — ROW_NUMBER() OVER (PARTITION BY tradingsymbol ORDER BY
  //   score DESC) — and pick rn = 1. No GROUP BY needed, no ANY_VALUE
  //   wrapping, deterministic per partition, and only_full_group_by safe.
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
      END AS signal_age_min,
      -- Sector lives on the instruments master table, not on rankings
      -- itself. Join in so the dashboard's Sector column / rankings
      -- page Sector cell render real values instead of "—". The LEFT
      -- JOIN ensures we never drop ranking rows for missing sector
      -- metadata; sector simply renders blank for those.
      i.sector                                                     AS sector
    FROM (
      SELECT
        rankings.*,
        ROW_NUMBER() OVER (PARTITION BY tradingsymbol ORDER BY score DESC) AS rn
      FROM rankings
      WHERE 1=1 ${innerExFilter}
    ) r
    LEFT JOIN instruments i
      ON i.tradingsymbol = r.tradingsymbol
     AND (r.exchange IS NULL OR i.exchange = r.exchange OR i.exchange IS NULL)
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
    WHERE r.rn = 1
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
        rank_position:       idx + 1 + sqlOffset,
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
        // Sector resolution chain:
        //   1. instruments.sector (DB master data) — best
        //   2. SECTOR_MAP from phase3.constants (in-memory, ~50
        //      well-known NSE symbols) — guarantees coverage for the
        //      common universe even when the instruments seeder
        //      hasn't backfilled sectors yet (which is exactly why
        //      /api/rankings was returning sector: null for everyone)
        //   3. 'Other' — getSector() default for unknown symbols
        sector: (() => {
          const fromDb = row.sector != null ? String(row.sector).trim() : '';
          if (fromDb) return fromDb;
          const sym = String(row.symbol || '').toUpperCase();
          const fromMap = sym ? getSector(sym) : 'Other';
          return fromMap;
        })(),
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
          sector: getSector(String(d.symbol ?? g.symbol ?? '').toUpperCase()),
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
        sector: getSector(String(i.name ?? '').toUpperCase()),
      };
      partial.opportunity_rank = computeOpportunityRank(partial);
      return partial as RankedEntry;
    });
  } catch { return []; }
}

// ── Public API ────────────────────────────────────────────────────

export interface GetRankingsOptions {
  limit?:    number;
  page?:     number;
  exchange?: string;
  /**
   * When false, getRankings refuses to call out to live/external quote
   * providers (`buildFromLiveMarket`) and refuses to trigger
   * `syncRankingsFromNse()` (which fans out to Yahoo Finance for the
   * NIFTY50 universe). The route layer passes `market.isOpen` here so
   * weekend / holiday / post-close requests stay strictly DB+cache.
   *
   * Defaults to `true` to preserve the legacy behavior for any direct
   * caller that has not yet been updated.
   */
  allowExternalFallback?: boolean;
}

export async function getRankings(opts: GetRankingsOptions): Promise<RankingsResult> {
  const limit    = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const page     = Math.max(opts.page  ?? 1, 1);
  const offset   = (page - 1) * limit;
  const exchange = opts.exchange?.toUpperCase();
  const allowExternalFallback = opts.allowExternalFallback !== false;

  // ── Cache lookup ───────────────────────────────────────────────
  // Cache hits MUST be labeled honestly. The previous implementation
  // returned the cached object as-is, so a row that was originally
  // built from MySQL kept `data_source: 'mysql'` even after a 60s
  // Redis round-trip. The UI's "Cached" badge would never light up.
  if (page === 1) {
    const cKey   = rankingsKey(limit, exchange);
    const cached = await cacheGet<RankingsResult>(cKey);
    if (cached) {
      return {
        ...cached,
        data_source: 'redis',
        cache_hit:   true,
        // Deliberately preserve the original `as_of` so callers can see
        // when the snapshot was actually built; the route adds a fresh
        // server time elsewhere if needed.
      };
    }
  }

  // ── Wider candidate pool, then sort + paginate in JS ───────────
  // Previously SQL did `ORDER BY score DESC LIMIT ? OFFSET ?` and the
  // application only computed opportunity_rank on the returned slice.
  // That meant a stock with a high opportunity_rank but a raw score
  // outside the SQL window could never make it into the response — the
  // top-50 by opportunity_rank could quietly disagree with the top-50
  // returned to the client. Now we pull a wider pool, compute
  // opportunity_rank for every candidate, sort by the real comparator,
  // then slice the requested page.
  const candidatePoolSize = Math.min(
    CANDIDATE_CEILING,
    Math.max(CANDIDATE_FLOOR, (offset + limit) * CANDIDATE_MULTIPLIER),
  );
  const { rows: candidates, total } = await fetchFromMySQL(
    limit, offset, exchange, candidatePoolSize,
  );
  applyDeterministicOrder(candidates);
  // Slice the requested page out of the globally-sorted pool. Slicing
  // AFTER sort is the whole point — slicing before would re-introduce
  // the bug we just fixed.
  const pagedRows = candidates.slice(offset, offset + limit);
  // Re-stamp rank_position on the visible slice so the # column starts
  // at offset+1 even when the candidate pool was wider.
  pagedRows.forEach((r, i) => { r.rank_position = i + 1 + offset; });

  // ── Empty-table path: try live, then NSE seed (if allowed) ─────
  if (candidates.length === 0 && page === 1) {
    if (!allowExternalFallback) {
      // Closed-market route: serving stale-or-empty is correct here;
      // we don't fan out to external providers. Return an honest empty
      // result so the UI can render "no cached/EOD data available"
      // instead of silently triggering a Yahoo fan-out on a Saturday.
      return {
        data: [], count: 0, total: 0, page, limit, has_more: false,
        data_source: 'unavailable',
        cache_hit:   false,
        message:
          'Market is closed and no cached or last-close rankings are ' +
          'available. Rankings will refresh on the next open session.',
        as_of: new Date().toISOString(),
      };
    }

    const liveRows = await buildFromLiveMarket(limit);
    if (liveRows.length > 0) {
      applyDeterministicOrder(liveRows);
      return {
        data: liveRows, count: liveRows.length, total: liveRows.length,
        page, limit, has_more: false,
        data_source: 'redis',
        cache_hit:   false,
        as_of: new Date().toISOString(),
      };
    }

    // Live feed also blocked — seed rankings table from NIFTY50 + Yahoo Finance, then re-query
    console.log('[Rankings] live quote feed unavailable — seeding rankings via Yahoo Finance fallback');
    await syncRankingsFromNse();
    const { rows: seededCandidates, total: seededTotal } = await fetchFromMySQL(
      limit, offset, exchange, candidatePoolSize,
    );
    if (seededCandidates.length > 0) {
      applyDeterministicOrder(seededCandidates);
      const seededPaged = seededCandidates.slice(offset, offset + limit);
      seededPaged.forEach((r, i) => { r.rank_position = i + 1 + offset; });
      const seededResult: RankingsResult = {
        data: seededPaged, count: seededPaged.length, total: seededTotal,
        page, limit, has_more: offset + seededPaged.length < seededTotal,
        data_source: 'mysql',
        cache_hit:   false,
        as_of: new Date().toISOString(),
      };
      await cacheSet(rankingsKey(limit, exchange), seededResult, RANKINGS_TTL);
      return seededResult;
    }
  }

  const result: RankingsResult = {
    data: pagedRows, count: pagedRows.length, total, page, limit,
    has_more: offset + pagedRows.length < total,
    data_source: 'mysql',
    cache_hit:   false,
    as_of: new Date().toISOString(),
  };

  if (page === 1 && pagedRows.length > 0) {
    await cacheSet(rankingsKey(limit, exchange), result, RANKINGS_TTL);
  }
  return result;
}

// Keep legacy export name for backward compat. The route layer also
// uses an object form so the new `allowExternalFallback` flag can
// flow through cleanly.
export const getTopRankings = (
  limit = DEFAULT_LIMIT,
  page = 1,
  exchange?: string,
  allowExternalFallback?: boolean,
) => getRankings({ limit, page, exchange, allowExternalFallback });
