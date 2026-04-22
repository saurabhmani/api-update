/**
 * Signal Engine — Read-side repository
 *
 * Single source of truth for signal reads. All /api routes (dashboard,
 * intelligence, signals) consume these functions. Queries q365_signals
 * and related audit tables directly — no dependency on the legacy
 * services/signalPipeline layer.
 *
 * Shapes here MUST stay byte-identical with what the UI already reads,
 * since this module is a drop-in replacement for the legacy readers.
 */

import { db }       from '@/lib/db';
import { cacheGet } from '@/lib/redis';

// ════════════════════════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════════════════════════

export interface IntelligenceSignal {
  id:                 number;
  tradingsymbol:      string;
  exchange:           string;
  direction:          string;
  timeframe:          string;
  signal_type:        string;
  signal_subtype:     string;
  strategy_group:     string;
  strategy_display:   string;
  confidence_score:   number;
  conviction_band:    string;
  strength_tag:       string;
  market_context_tag: string;
  risk_score:         number;
  risk:               string;
  opportunity_score:  number;
  entry_price:        number;
  stop_loss:          number;
  target1:            number;
  target2:            number | null;
  risk_reward:        number;
  regime:             string;
  market_stance:      string;
  scenario_tag:       string;
  factor_scores:      Record<string, number> | null;
  ltp:                number | null;
  pct_change:         number | null;
  status:             string;
  approved:           boolean;
  reasons:            Array<{ type: string; message: string; factor_key?: string; contribution?: number }>;
  warnings:           string[];
  generated_at:       string;
}

// ════════════════════════════════════════════════════════════════
//  ACTIVE / TOP SIGNALS
// ════════════════════════════════════════════════════════════════

/** All active signals, joined with latest manipulation snapshot + penalty. */
export async function getActiveSignals(limit = 50): Promise<any[]> {
  // Fetch extra rows so the post-query dedupe (by symbol) still yields
  // `limit` unique symbols even when a symbol appears multiple times —
  // e.g. overlapping batches in q365_signals or manipulation LEFT JOIN
  // fan-out when a signal has multiple penalty rows.
  const fetchLimit = Math.min(limit * 4, 40000);
  let rows: any[];
  let manipulationJoined = true;
  let phase4ColumnsAvailable = true;

  // Detect the "dynamic-ranking columns not yet migrated" case and
  // transparently fall back to a pre-Phase-4 query that orders by
  // opportunity_score. This prevents a fresh-DB deployment from 500-ing
  // every signals request until migrateSignalEngine runs. Matches
  // MySQL's error prefix "Unknown column '...'.
  const isMissingColumnError = (err: any): boolean =>
    /unknown column|column.*doesn'?t exist/i.test(err?.message ?? '');

  try {
    const result = await db.query(`
      SELECT
        s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
        s.signal_type, s.confidence_score, s.confidence_band,
        s.risk_score, s.risk_band, s.opportunity_score,
        s.portfolio_fit_score, s.regime_alignment,
        s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
        s.market_regime, s.market_stance, s.scenario_tag,
        s.factor_scores_json, s.ltp, s.pct_change,
        s.status, s.batch_id, s.generated_at,
        s.final_score, s.freshness_score, s.decay_state, s.age_bars,
        s.overextension_pct, s.invalidation_reason, s.last_rescored_at, s.expires_at,
        ms.manipulation_score   AS m_score,
        ms.suspicion_band       AS m_band,
        mp.confidence_penalty   AS m_conf_penalty,
        mp.risk_penalty         AS m_risk_penalty,
        mp.rejection_flag       AS m_rejected,
        mp.reason               AS m_reason
      FROM q365_signals s
      LEFT JOIN q365_manipulation_snapshots ms
        ON ms.symbol COLLATE utf8mb4_unicode_ci = s.symbol COLLATE utf8mb4_unicode_ci
        AND ms.snapshot_date = (
          SELECT MAX(snapshot_date) FROM q365_manipulation_snapshots
          WHERE symbol COLLATE utf8mb4_unicode_ci = s.symbol COLLATE utf8mb4_unicode_ci
        )
      LEFT JOIN q365_manipulation_penalties mp
        ON mp.signal_id COLLATE utf8mb4_unicode_ci = CAST(s.id AS CHAR) COLLATE utf8mb4_unicode_ci
      WHERE s.status IN ('active', 'watchlist', 'flagged')
        AND s.invalidation_reason IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
        AND s.decay_state <> 'expired'
      ORDER BY s.final_score DESC, s.opportunity_score DESC, s.generated_at DESC
      LIMIT ?
    `, [fetchLimit]);
    rows = result.rows as any[];
  } catch (err: any) {
    if (isMissingColumnError(err)) {
      // Phase-4 dynamic-ranking columns don't exist yet. Run
      // migrateSignalEngine() to add them. Meanwhile, degrade
      // gracefully to a pre-Phase-4 query.
      console.warn(
        '[readSignals] dynamic-ranking columns missing — ' +
        'run migrateSignalEngine() to unlock freshness/decay. ' +
        'Falling back to opportunity_score ordering.',
      );
      phase4ColumnsAvailable = false;
      manipulationJoined = false;
    } else {
      console.warn('[readSignals] manipulation JOIN failed — falling back to plain query:', err?.message);
      manipulationJoined = false;
    }
    try {
      const result = await db.query(
        phase4ColumnsAvailable
          ? // Phase-4 columns available — manipulation JOIN failed only
            `SELECT
              s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
              s.signal_type, s.confidence_score, s.confidence_band,
              s.risk_score, s.risk_band, s.opportunity_score,
              s.portfolio_fit_score, s.regime_alignment,
              s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
              s.market_regime, s.market_stance, s.scenario_tag,
              s.factor_scores_json, s.ltp, s.pct_change,
              s.status, s.batch_id, s.generated_at,
              s.final_score, s.freshness_score, s.decay_state, s.age_bars,
              s.overextension_pct, s.invalidation_reason, s.last_rescored_at, s.expires_at
            FROM q365_signals s
            WHERE s.status IN ('active', 'watchlist', 'flagged')
              AND s.invalidation_reason IS NULL
              AND (s.expires_at IS NULL OR s.expires_at > NOW())
              AND s.decay_state <> 'expired'
            ORDER BY s.final_score DESC, s.opportunity_score DESC, s.generated_at DESC
            LIMIT ?`
          : // Legacy pre-Phase-4 query — no dynamic-ranking columns,
            // no freshness filter. Safe on fresh DB before migration.
            `SELECT
              s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
              s.signal_type, s.confidence_score, s.confidence_band,
              s.risk_score, s.risk_band, s.opportunity_score,
              s.portfolio_fit_score, s.regime_alignment,
              s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
              s.market_regime, s.market_stance, s.scenario_tag,
              s.factor_scores_json, s.ltp, s.pct_change,
              s.status, s.batch_id, s.generated_at
            FROM q365_signals s
            WHERE s.status IN ('active', 'watchlist', 'flagged')
            ORDER BY s.opportunity_score DESC
            LIMIT ?`,
        [fetchLimit],
      );
      rows = result.rows as any[];
    } catch (innerErr: any) {
      console.error('[readSignals] fallback query also failed:', innerErr?.message);
      throw innerErr;
    }
  }

  // Dedupe by (symbol, direction) so one BUY + one SELL for the
  // same symbol can both surface in the output. Prior symbol-only
  // dedup dropped the second-direction row whenever Phase 3 emitted
  // both (common after the Nov 2026 best-per-direction change). The
  // ORDER BY final_score keeps the highest-scoring row per pair
  // first; `seen` ensures we never emit the same pair twice when
  // overlapping batches leave multiple active rows.
  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const r of rows) {
    const sym = String(r.symbol ?? '').toUpperCase();
    if (!sym) continue;
    const dir = String(r.direction ?? '').toUpperCase();
    const key = `${sym}:${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= limit) break;
  }
  return deduped.map(r => {
    const mScore = manipulationJoined && r.m_score != null ? Number(r.m_score) : null;
    const mBand  = manipulationJoined ? (r.m_band ?? null) : null;
    const penalized = manipulationJoined &&
      r.m_conf_penalty != null &&
      (Number(r.m_conf_penalty) > 0 || Number(r.m_risk_penalty) > 0 || Number(r.m_rejected) === 1);
    return {
      id:                r.id,
      instrument_key:    r.instrument_key,
      tradingsymbol:     r.symbol,
      exchange:          r.exchange,
      direction:         r.direction,
      timeframe:         r.timeframe,
      signal_type:       r.signal_type,
      confidence:        r.confidence_score,
      confidence_score:  r.confidence_score,
      conviction_band:   r.confidence_band,
      risk_score:        r.risk_score,
      risk:              r.risk_band,
      opportunity_score: r.opportunity_score,
      portfolio_fit:     r.portfolio_fit_score,
      regime_alignment:  r.regime_alignment,
      entry_price:       Number(r.entry_price),
      stop_loss:         Number(r.stop_loss),
      target1:           Number(r.target1),
      target2:           r.target2 ? Number(r.target2) : null,
      risk_reward:       Number(r.risk_reward),
      regime:            r.market_regime,
      market_stance:     r.market_stance,
      scenario_tag:      r.scenario_tag,
      factor_scores:     typeof r.factor_scores_json === 'string'
        ? JSON.parse(r.factor_scores_json) : r.factor_scores_json,
      ltp:               r.ltp ? Number(r.ltp) : null,
      pct_change:        r.pct_change ? Number(r.pct_change) : null,
      status:            r.status,
      approved:          r.status === 'active',
      batch_id:          r.batch_id,
      generated_at:      r.generated_at,
      // ── Dynamic ranking (Phase 4) ────────────────────────
      // These fields are null when the legacy fallback query ran
      // (fresh DB, migration pending). UI must tolerate nulls —
      // that's the Phase-4-unavailable signal to the frontend.
      final_score:         phase4ColumnsAvailable && r.final_score     != null ? Number(r.final_score)     : null,
      freshness_score:     phase4ColumnsAvailable && r.freshness_score != null ? Number(r.freshness_score) : null,
      decay_state:         phase4ColumnsAvailable ? (r.decay_state ?? null) : null,
      age_bars:            phase4ColumnsAvailable && r.age_bars != null ? Number(r.age_bars) : null,
      overextension_pct:   phase4ColumnsAvailable && r.overextension_pct != null ? Number(r.overextension_pct) : null,
      invalidation_reason: phase4ColumnsAvailable ? (r.invalidation_reason ?? null) : null,
      last_rescored_at:    phase4ColumnsAvailable ? (r.last_rescored_at ?? null) : null,
      expires_at:          phase4ColumnsAvailable ? (r.expires_at ?? null) : null,
      // ── UI badges (derived from the above) ───────────────
      // Degrade to false when Phase 4 columns are unavailable; the
      // UI renders no badges in that case rather than wrong ones.
      is_new:              phase4ColumnsAvailable && r.age_bars != null ? Number(r.age_bars) <= 1 : false,
      is_fresh:            phase4ColumnsAvailable && r.decay_state === 'fresh',
      is_aging:            phase4ColumnsAvailable && r.decay_state === 'actionable_but_aging',
      is_stale:            phase4ColumnsAvailable && (r.decay_state === 'stale' || r.decay_state === 'expired'),
      manipulation_score:     mScore,
      manipulation_band:      mBand,
      manipulation_warning:   manipulationJoined ? (r.m_reason ?? null) : null,
      manipulation_penalized: penalized,
    };
  });
}

/** Top N signals for dashboard (alias — same ordering as active). */
export async function getTopSignals(limit = 10): Promise<any[]> {
  return getActiveSignals(limit);
}

// ════════════════════════════════════════════════════════════════
//  Archive pool — last-resort padding source
//
//  Returns signals that the normal read path excludes:
//    - status = 'expired' (batch-expired, max_lifetime_reached)
//    - invalidation_reason IS NOT NULL (stop_violated, target_hit,
//      price_overextended, structure_break, etc.)
//    - expires_at < NOW()
//
//  EVERY row returned is tagged `is_archived: true` and includes the
//  `invalidation_reason` so the UI can render a clear visual marker
//  (greyed out, "STOPPED OUT" / "TARGET HIT" badge). Operators must
//  never mistake these for active trade ideas.
//
//  Used only to pad the dashboard toward a target count when the
//  live pool is thin — NOT for normal ranking. The signals have no
//  freshness value and should never compete with live ones on score.
// ════════════════════════════════════════════════════════════════
export async function getArchivedSignalsForPad(
  limit: number,
  excludeSymbols: string[] = [],
): Promise<any[]> {
  if (limit <= 0) return [];

  const excludeClause = excludeSymbols.length > 0
    ? `AND s.symbol NOT IN (${excludeSymbols.map(() => '?').join(',')})`
    : '';
  const params: any[] = [...excludeSymbols, limit * 2];

  let rows: any[] = [];
  try {
    const result = await db.query(
      `SELECT
        s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
        s.signal_type, s.confidence_score, s.confidence_band,
        s.risk_score, s.risk_band, s.opportunity_score,
        s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
        s.market_regime, s.market_stance, s.scenario_tag,
        s.factor_scores_json, s.ltp, s.pct_change,
        s.status, s.batch_id, s.generated_at,
        s.final_score, s.freshness_score, s.decay_state, s.age_bars,
        s.overextension_pct, s.invalidation_reason, s.invalidated_at
      FROM q365_signals s
      WHERE (
            s.status = 'expired'
         OR s.invalidation_reason IS NOT NULL
         OR (s.expires_at IS NOT NULL AND s.expires_at <= NOW())
         OR s.decay_state = 'expired'
      )
      ${excludeClause}
      ORDER BY
        COALESCE(s.invalidated_at, s.generated_at) DESC,
        s.opportunity_score DESC
      LIMIT ?`,
      params,
    );
    rows = result.rows as any[];
  } catch (err: any) {
    // Phase 4 columns may not exist on a fresh DB. Fall back to a
    // legacy query that identifies "archived" only by status.
    if (/unknown column/i.test(err?.message ?? '')) {
      const legacy = await db.query(
        `SELECT
          s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
          s.signal_type, s.confidence_score, s.confidence_band,
          s.risk_score, s.risk_band, s.opportunity_score,
          s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
          s.market_regime, s.market_stance, s.scenario_tag,
          s.factor_scores_json, s.ltp, s.pct_change,
          s.status, s.batch_id, s.generated_at
        FROM q365_signals s
        WHERE s.status = 'expired'
        ${excludeClause}
        ORDER BY s.generated_at DESC
        LIMIT ?`,
        params,
      );
      rows = legacy.rows as any[];
    } else {
      throw err;
    }
  }

  // Dedupe by symbol — keep the most recently archived row per symbol.
  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const r of rows) {
    const key = String(r.symbol ?? '').toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
    if (deduped.length >= limit) break;
  }

  return deduped.map((r) => ({
    id:                r.id,
    instrument_key:    r.instrument_key,
    tradingsymbol:     r.symbol,
    exchange:          r.exchange,
    direction:         r.direction,
    timeframe:         r.timeframe,
    signal_type:       r.signal_type,
    confidence:        r.confidence_score,
    confidence_score:  r.confidence_score,
    conviction_band:   r.confidence_band,
    risk_score:        r.risk_score,
    risk:              r.risk_band,
    opportunity_score: r.opportunity_score,
    entry_price:       Number(r.entry_price),
    stop_loss:         Number(r.stop_loss),
    target1:           Number(r.target1),
    target2:           r.target2 ? Number(r.target2) : null,
    risk_reward:       Number(r.risk_reward),
    regime:            r.market_regime,
    market_stance:     r.market_stance,
    scenario_tag:      r.scenario_tag,
    factor_scores:     typeof r.factor_scores_json === 'string'
      ? JSON.parse(r.factor_scores_json) : r.factor_scores_json,
    ltp:               r.ltp ? Number(r.ltp) : null,
    pct_change:        r.pct_change ? Number(r.pct_change) : null,
    status:            r.status,
    approved:          false,
    batch_id:          r.batch_id,
    generated_at:      r.generated_at,
    // Phase 4 metadata if present — falls through to null on legacy DB.
    final_score:         r.final_score != null ? Number(r.final_score) : null,
    freshness_score:     r.freshness_score != null ? Number(r.freshness_score) : null,
    decay_state:         r.decay_state ?? null,
    age_bars:            r.age_bars != null ? Number(r.age_bars) : null,
    overextension_pct:   r.overextension_pct != null ? Number(r.overextension_pct) : null,
    invalidation_reason: r.invalidation_reason ?? null,
    invalidated_at:      r.invalidated_at ?? null,
    // ── Critical flags for UI ───────────────────────────────
    // is_archived=true ⇒ render with greyed-out style, show
    // invalidation_reason as a badge, disable "take trade" actions.
    is_archived:         true,
    is_new:              false,
    is_fresh:            false,
    is_aging:            false,
    is_stale:            true,
    below_quality_floor: false,
  }));
}

// ════════════════════════════════════════════════════════════════
//  INTELLIGENCE GROUPING
// ════════════════════════════════════════════════════════════════

const STRATEGY_GROUP_MAP: Record<string, { buy: string; sell: string }> = {
  TREND_CONTINUATION:       { buy: 'bullish_trend',         sell: 'bearish_trend' },
  BREAKOUT_CONTINUATION:    { buy: 'bullish_breakout',      sell: 'bearish_breakdown' },
  PULLBACK_IN_TREND:        { buy: 'bullish_pullback',      sell: 'bearish_pullback' },
  MEAN_REVERSION:           { buy: 'mean_reversion_bounce', sell: 'mean_reversion_fade' },
  MOMENTUM_EXPANSION:       { buy: 'bullish_momentum',      sell: 'bearish_momentum' },
  RELATIVE_STRENGTH_LEADER: { buy: 'relative_strength',     sell: 'relative_weakness' },
  VOLATILITY_COMPRESSION:   { buy: 'volatility_breakout',   sell: 'volatility_breakdown' },
  EVENT_DRIVEN:             { buy: 'event_driven_long',     sell: 'event_driven_short' },
  SECTOR_ROTATION:          { buy: 'sector_rotation',       sell: 'sector_rotation' },
  WATCHLIST_OPPORTUNITY:    { buy: 'watchlist_long',        sell: 'watchlist_short' },
  NO_STRATEGY:              { buy: 'unclassified',          sell: 'unclassified' },
};

const STRATEGY_DISPLAY: Record<string, string> = {
  bullish_trend:         'Bullish Trend',
  bearish_trend:         'Bearish Trend',
  bullish_breakout:      'Bullish Breakout',
  bearish_breakdown:     'Bearish Breakdown',
  bullish_pullback:      'Bullish Pullback',
  bearish_pullback:      'Bearish Pullback',
  mean_reversion_bounce: 'Mean Reversion Bounce',
  mean_reversion_fade:   'Mean Reversion Fade',
  bullish_momentum:      'Bullish Momentum',
  bearish_momentum:      'Bearish Momentum',
  relative_strength:     'Relative Strength',
  relative_weakness:     'Relative Weakness',
  volatility_breakout:   'Volatility Breakout',
  volatility_breakdown:  'Volatility Breakdown',
  event_driven_long:     'Event Driven Long',
  event_driven_short:    'Event Driven Short',
  sector_rotation:       'Sector Rotation',
  watchlist_long:        'Watchlist Long',
  watchlist_short:       'Watchlist Short',
  unclassified:          'Unclassified',
};

function resolveStrategyGroup(scenarioTag: string, direction: string): string {
  const mapping = STRATEGY_GROUP_MAP[scenarioTag];
  if (!mapping) return direction === 'SELL' ? 'bearish_trend' : 'bullish_trend';
  return direction === 'SELL' ? mapping.sell : mapping.buy;
}

function resolveStrengthTag(confidence: number): string {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Ignore';
}

function resolveMarketContextTag(regime: string): string {
  if (['STRONG_BULL', 'BULL'].includes(regime)) return 'Bullish';
  if (['STRONG_BEAR', 'BEAR'].includes(regime)) return 'Weak';
  return 'Neutral';
}

export async function getIntelligenceSignals(): Promise<{
  buySignals:    Record<string, IntelligenceSignal[]>;
  sellSignals:   Record<string, IntelligenceSignal[]>;
  by_direction:  Record<string, IntelligenceSignal[]>;
  by_strategy:   Record<string, IntelligenceSignal[]>;
  by_conviction: Record<string, IntelligenceSignal[]>;
  summary: {
    total: number; buy: number; sell: number; hold: number;
    avg_confidence: number; avg_rr: number;
    buy_avg_confidence: number; sell_avg_confidence: number;
    conviction_distribution: Record<string, number>;
  };
}> {
  const signals = await getActiveSignals(100);

  // Batch-fetch reasons for all signals
  const signalIds = signals.map((s: any) => s.id).filter(Boolean);
  const reasonsMap  = new Map<number, Array<{ type: string; message: string; factor_key?: string; contribution?: number }>>();
  const warningsMap = new Map<number, string[]>();

  if (signalIds.length > 0) {
    try {
      const placeholders = signalIds.map(() => '?').join(',');
      const { rows } = await db.query(
        `SELECT signal_id, reason_type, message, factor_key, contribution
         FROM q365_signal_reasons WHERE signal_id IN (${placeholders}) ORDER BY id`,
        signalIds
      );
      for (const r of rows as any[]) {
        const sid = r.signal_id;
        if (r.reason_type === 'warning') {
          if (!warningsMap.has(sid)) warningsMap.set(sid, []);
          warningsMap.get(sid)!.push(r.message);
        } else {
          if (!reasonsMap.has(sid)) reasonsMap.set(sid, []);
          reasonsMap.get(sid)!.push({
            type: r.reason_type, message: r.message,
            factor_key: r.factor_key ?? undefined,
            contribution: r.contribution != null ? Number(r.contribution) : undefined,
          });
        }
      }
    } catch {}
  }

  const buySignals:    Record<string, IntelligenceSignal[]> = {};
  const sellSignals:   Record<string, IntelligenceSignal[]> = {};
  const by_direction:  Record<string, IntelligenceSignal[]> = {};
  const by_strategy:   Record<string, IntelligenceSignal[]> = {};
  const by_conviction: Record<string, IntelligenceSignal[]> = {};
  const convictionDist: Record<string, number> = { high_conviction: 0, actionable: 0, watchlist: 0, reject: 0 };

  let totalConf = 0, totalRR = 0;
  let buy = 0, sell = 0, hold = 0;
  let buyConfTotal = 0, sellConfTotal = 0;

  for (const s of signals) {
    const dir      = s.direction || 'HOLD';
    const regime   = s.regime || 'NEUTRAL';
    const scenario = s.scenario_tag || 'NO_STRATEGY';
    const conf     = s.confidence_score || 0;
    const band     = s.conviction_band || 'watchlist';

    const stratGroup   = resolveStrategyGroup(scenario, dir);
    const stratDisplay = STRATEGY_DISPLAY[stratGroup] || stratGroup.replace(/_/g, ' ');
    const strengthTag  = resolveStrengthTag(conf);
    const contextTag   = resolveMarketContextTag(regime);

    const enriched: IntelligenceSignal = {
      ...s,
      signal_type:        dir === 'BUY' ? 'LONG' : dir === 'SELL' ? 'SHORT' : 'NEUTRAL',
      signal_subtype:     scenario.toLowerCase(),
      strategy_group:     stratGroup,
      strategy_display:   stratDisplay,
      strength_tag:       strengthTag,
      market_context_tag: contextTag,
      conviction_band:    band,
      reasons:            reasonsMap.get(s.id) ?? [],
      warnings:           warningsMap.get(s.id) ?? [],
    };

    if (!by_direction[dir]) by_direction[dir] = [];
    by_direction[dir].push(enriched);

    if (dir === 'BUY') {
      buy++;
      buyConfTotal += conf;
      if (!buySignals[stratGroup]) buySignals[stratGroup] = [];
      buySignals[stratGroup].push(enriched);
    } else if (dir === 'SELL') {
      sell++;
      sellConfTotal += conf;
      if (!sellSignals[stratGroup]) sellSignals[stratGroup] = [];
      sellSignals[stratGroup].push(enriched);
    } else {
      hold++;
    }

    if (!by_strategy[stratGroup]) by_strategy[stratGroup] = [];
    by_strategy[stratGroup].push(enriched);

    if (!by_conviction[band]) by_conviction[band] = [];
    by_conviction[band].push(enriched);
    if (convictionDist[band] != null) convictionDist[band]++;

    totalConf += conf;
    totalRR   += s.risk_reward || 0;
  }

  const sortGroup = (group: Record<string, IntelligenceSignal[]>) => {
    for (const key of Object.keys(group)) {
      group[key].sort((a, b) => b.opportunity_score - a.opportunity_score);
    }
  };
  sortGroup(buySignals);
  sortGroup(sellSignals);
  sortGroup(by_strategy);

  return {
    buySignals,
    sellSignals,
    by_direction,
    by_strategy,
    by_conviction,
    summary: {
      total:               signals.length,
      buy, sell, hold,
      avg_confidence:      signals.length > 0 ? Math.round(totalConf / signals.length) : 0,
      avg_rr:              signals.length > 0 ? parseFloat((totalRR / signals.length).toFixed(1)) : 0,
      buy_avg_confidence:  buy > 0 ? Math.round(buyConfTotal / buy) : 0,
      sell_avg_confidence: sell > 0 ? Math.round(sellConfTotal / sell) : 0,
      conviction_distribution: convictionDist,
    },
  };
}

// ════════════════════════════════════════════════════════════════
//  MARKET REGIME + STATS
// ════════════════════════════════════════════════════════════════

export async function getLatestRegime(): Promise<string> {
  try {
    const cached = await cacheGet<{ regime: string }>('market:regime');
    if (cached?.regime) return cached.regime;
  } catch {}

  try {
    const { rows } = await db.query(
      `SELECT market_regime FROM q365_signals
       WHERE status IN ('active','watchlist','flagged')
       ORDER BY created_at DESC LIMIT 1`
    );
    return (rows[0] as any)?.market_regime ?? 'NEUTRAL';
  } catch {}

  return 'NEUTRAL';
}

export async function getSignalStats(): Promise<any> {
  try {
    const [overviewRes, convictionRes, scenarioRes] = await Promise.allSettled([
      db.query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
               AVG(confidence_score) AS avg_confidence,
               AVG(risk_reward) AS avg_rr
        FROM q365_signals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `),
      db.query(`
        SELECT confidence_band, COUNT(*) AS count
        FROM q365_signals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY confidence_band
      `),
      db.query(`
        SELECT scenario_tag, COUNT(*) AS count, AVG(confidence_score) AS avg_conf
        FROM q365_signals
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY scenario_tag ORDER BY count DESC
      `),
    ]);

    return {
      overview:      overviewRes.status === 'fulfilled'   ? overviewRes.value.rows[0]   : null,
      by_conviction: convictionRes.status === 'fulfilled' ? convictionRes.value.rows    : [],
      by_scenario:   scenarioRes.status === 'fulfilled'   ? scenarioRes.value.rows      : [],
    };
  } catch {
    return { overview: null, by_conviction: [], by_scenario: [] };
  }
}

export async function getSignalReasons(signalId: number): Promise<any[]> {
  const { rows } = await db.query(
    `SELECT reason_type, message, factor_key, contribution
     FROM q365_signal_reasons WHERE signal_id = ? ORDER BY id`,
    [signalId]
  );
  return rows as any[];
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY BREAKDOWNS (audit)
// ════════════════════════════════════════════════════════════════

export interface StrategyBreakdownRow {
  strategy_name:    string;
  score:            number;
  is_selected:      boolean;
  rejection_reason: string | null;
}

export interface SignalStrategyAudit {
  signal_id:         number;
  winning_strategy:  string | null;
  strategies:        StrategyBreakdownRow[];
}

/**
 * Full audit of every strategy evaluated for a signal. Reads from
 * q365_strategy_breakdowns — one row per (signal, strategy), with
 * matched=1 on the winner. Shape matches the Phase 2 transparency spec:
 * `{ winning_strategy, strategies: [{ strategy_name, score, is_selected,
 * rejection_reason }] }`.
 */
export async function getStrategyBreakdowns(
  signalId: number,
): Promise<SignalStrategyAudit> {
  const { rows } = await db.query(
    `SELECT strategy_name,
            confidence_score AS score,
            matched          AS is_selected,
            rejection_reason
       FROM q365_strategy_breakdowns
      WHERE signal_id = ?
      ORDER BY matched DESC, confidence_score DESC`,
    [signalId],
  );

  const strategies: StrategyBreakdownRow[] = (rows as any[]).map((r) => ({
    strategy_name:    r.strategy_name,
    score:            r.score != null ? Number(r.score) : 0,
    is_selected:      Number(r.is_selected) === 1,
    rejection_reason: r.rejection_reason ?? null,
  }));

  const winner = strategies.find((s) => s.is_selected)?.strategy_name ?? null;

  return {
    signal_id:        signalId,
    winning_strategy: winner,
    strategies,
  };
}

/**
 * Batch variant — one query for multiple signal_ids. Returns a map so
 * list endpoints can enrich their payload without N+1.
 */
export async function getStrategyBreakdownsBatch(
  signalIds: number[],
): Promise<Map<number, SignalStrategyAudit>> {
  const result = new Map<number, SignalStrategyAudit>();
  if (signalIds.length === 0) return result;

  const placeholders = signalIds.map(() => '?').join(',');
  const { rows } = await db.query(
    `SELECT signal_id,
            strategy_name,
            confidence_score AS score,
            matched          AS is_selected,
            rejection_reason
       FROM q365_strategy_breakdowns
      WHERE signal_id IN (${placeholders})
      ORDER BY signal_id ASC, matched DESC, confidence_score DESC`,
    signalIds,
  );

  for (const r of rows as any[]) {
    const sid = Number(r.signal_id);
    if (!result.has(sid)) {
      result.set(sid, { signal_id: sid, winning_strategy: null, strategies: [] });
    }
    const audit = result.get(sid)!;
    const row: StrategyBreakdownRow = {
      strategy_name:    r.strategy_name,
      score:            r.score != null ? Number(r.score) : 0,
      is_selected:      Number(r.is_selected) === 1,
      rejection_reason: r.rejection_reason ?? null,
    };
    audit.strategies.push(row);
    if (row.is_selected && !audit.winning_strategy) {
      audit.winning_strategy = row.strategy_name;
    }
  }
  return result;
}
