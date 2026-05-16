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

import { db }              from '@/lib/db';
import { cacheGet }        from '@/lib/redis';
// applyLiveSanity import removed: read repos are read-only.
// Live validation is owned by runConfirmedSnapshotLifecycle (cron).
import { MAIN_TABLE_CLASSIFICATIONS } from '@/lib/signal-engine/pipeline/phase12Routing';
import { getActiveConfirmedSnapshots } from '@/lib/signal-engine/repository/readConfirmedSnapshots';

// ════════════════════════════════════════════════════════════════
//  Signal-status derivation
//
//  Signals written post-migration carry a persisted signal_status
//  column (APPROVED_SIGNAL | DEVELOPING_SETUP | NO_TRADE). Historical
//  rows written before the migration have NULL, so we derive on the
//  fly from the existing lifecycle + confidence columns:
//
//    status='active' + confidence ≥ 55  → APPROVED_SIGNAL
//    status='watchlist'                  → DEVELOPING_SETUP
//    active but conf < 55                → DEVELOPING_SETUP
//    everything else (expired/flagged)   → DEVELOPING_SETUP
//
//  NO_TRADE is never written by the normal save path (rejected
//  signals don't reach the writer), so it never appears in reads
//  except through the developing-setup backfill which explicitly
//  tags its rows downstream.
// ════════════════════════════════════════════════════════════════
export type PersistedSignalStatus = 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE';

function deriveSignalStatus(r: any): PersistedSignalStatus {
  const persisted = r?.signal_status ? String(r.signal_status) : null;
  if (persisted === 'APPROVED_SIGNAL' || persisted === 'DEVELOPING_SETUP' || persisted === 'NO_TRADE') {
    return persisted;
  }
  const status = String(r?.status ?? '').toLowerCase();
  const conf   = Number(r?.confidence_score ?? r?.confidence ?? 0);
  if (status === 'active' && conf >= 55) return 'APPROVED_SIGNAL';
  return 'DEVELOPING_SETUP';
}

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
  /** Tri-state product classification (APPROVED_SIGNAL | DEVELOPING_SETUP | NO_TRADE). */
  signal_status:      PersistedSignalStatus;
  approved:           boolean;
  reasons:            Array<{ type: string; message: string; factor_key?: string; contribution?: number }>;
  warnings:           string[];
  generated_at:       string;
}

// ════════════════════════════════════════════════════════════════
//  ACTIVE / TOP SIGNALS
// ════════════════════════════════════════════════════════════════

/** All active signals, joined with latest manipulation snapshot + penalty. */
export interface GetActiveSignalsOptions {
  /**
   * When true, only return rows from the latest batch_id present in
   * q365_signals (the most recent successful scan). Eliminates the
   * "table flips between rows from batch A and batch B" flicker on
   * the dashboard during the brief window where the prior batch is
   * still active but a new one has begun persisting rows. The query
   * subselect picks the single newest batch by generated_at.
   *
   * Default false — preserves the legacy multi-batch view for
   * existing callers (intelligence dashboard, history pages).
   */
  latestBatchOnly?: boolean;
}

// Production hot-path control: the manipulation LEFT JOIN uses
// `COLLATE utf8mb4_unicode_ci` + a correlated `MAX(snapshot_date)`
// subquery + a `CAST(s.id AS CHAR)` join key. Each of those individually
// defeats index usage; together they make the query unable to use ANY
// of the indexes we created — every call full-scans the table and
// takes 10+ seconds, exhausting the connection pool within 3 concurrent
// polls and triggering "Queue limit reached" cascades.
//
// On production VPS where the pool is small and the dashboard polls
// every 1s, the JOIN is the single biggest performance killer. Default
// to SKIP the JOIN; manipulation data is informational only (penalty
// columns are cosmetic on the dashboard) so the absence is non-fatal.
// Set ENABLE_MANIPULATION_JOIN=true to opt back in.
const ENABLE_MANIPULATION_JOIN =
  String(process.env.ENABLE_MANIPULATION_JOIN ?? '').toLowerCase() === 'true';

// Helper: prepend the resolved latest_batch_id placeholder param when
// the latestBatchOnly gate is on AND a batch_id was found. The other
// two params (perDirectionLimit, fetchLimit) are always present for
// the outer `WHERE dir_rank <= ?` and `LIMIT ?`. This keeps the same
// SQL string variants in sync with the placeholder count without
// duplicating the conditional at each call site.
function buildSignalQueryParams(
  latestBatchId: string | null,
  perDirectionLimit: number,
  fetchLimit: number,
): any[] {
  return latestBatchId
    ? [latestBatchId, perDirectionLimit, fetchLimit]
    : [perDirectionLimit, fetchLimit];
}

export async function getActiveSignals(limit = 50, opts: GetActiveSignalsOptions = {}): Promise<any[]> {
  const latestBatchOnly = opts.latestBatchOnly === true;
  // Resolve the newest batch_id ONCE up front rather than embedding a
  // correlated subquery (`SELECT batch_id ... ORDER BY generated_at
  // DESC LIMIT 1`) inside the main SELECT's WHERE clause. The embedded
  // form forced the optimiser to re-run the ORDER BY + LIMIT for every
  // row of the outer scan on some MySQL plans, pushing this query past
  // its 10-second timeout and cold-failing the cache (which is what
  // ships `cache_source: cold-fallback` + `signals: []` to the UI).
  // The lookup uses idx_q365sig_generated DESC and is sub-millisecond.
  let resolvedLatestBatchId: string | null = null;
  if (latestBatchOnly) {
    try {
      const head = await db.query(
        `SELECT batch_id FROM q365_signals
          WHERE batch_id IS NOT NULL
          ORDER BY generated_at DESC LIMIT 1`,
      );
      resolvedLatestBatchId = (head.rows[0] as any)?.batch_id ?? null;
    } catch (e: any) {
      console.warn('[readSignals] latest-batch probe failed:', e?.message);
    }
  }
  // Inline as a literal `?` placeholder (param order: prepended below)
  // rather than the correlated form. Empty string when the gate is off
  // or no batches exist (the second case yields zero rows downstream,
  // which is the correct behaviour for an empty DB).
  const latestBatchClause = latestBatchOnly && resolvedLatestBatchId
    ? `AND s2.batch_id = ?`
    : (latestBatchOnly ? `AND 1=0` : '');

  // Spec "RELAXED MODE INCLUDES DEVELOPING_SETUP" — the engine's
  // strict floors emit very few APPROVED_SIGNAL rows on quiet days
  // (e.g. confidence ≥ 70 / final_score ≥ 75). Almost every produced
  // row lands as 'DEVELOPING_SETUP' instead. Without this clause the
  // dashboard shows zero signals even when 16 active DEVELOPING_SETUP
  // rows exist in q365_signals. When SIGNAL_RELAX_MODE=true the SQL
  // accepts both APPROVED_SIGNAL and DEVELOPING_SETUP — the per-row
  // floors_relaxed=30/35/1.2 gate in TS still rejects the lowest-
  // quality rows. Strict mode (SIGNAL_RELAX_MODE!=true) keeps the
  // historical "APPROVED_SIGNAL only" contract.
  const signalRelaxMode =
    String(process.env.SIGNAL_RELAX_MODE ?? '').trim().toLowerCase() === 'true';
  const signalStatusClause = signalRelaxMode
    ? `AND (s2.signal_status IS NULL OR s2.signal_status IN ('APPROVED_SIGNAL', 'DEVELOPING_SETUP'))`
    : `AND (s2.signal_status IS NULL OR s2.signal_status = 'APPROVED_SIGNAL')`;
  // Fetch extra rows so the post-query dedupe (by symbol) still yields
  // `limit` unique symbols even when a symbol appears multiple times —
  // e.g. overlapping batches in q365_signals or manipulation LEFT JOIN
  // fan-out when a signal has multiple penalty rows.
  //
  // Per-direction cap (dir_rank): the SQL ranks rows within each
  // direction (BUY / SELL) and the outer query takes the top
  // `perDirectionLimit` from each side. Without this, a lopsided
  // BUY:SELL ratio (e.g. ~9:1 in a bull regime) would let the BUY
  // pool fill the entire LIMIT window, leaving zero SELLs for the
  // route handler's 25/25 selector. dir_rank guarantees both sides
  // reach the dedup loop with a meaningful pool.
  const fetchLimit         = Math.min(limit * 4, 40000);
  const perDirectionLimit  = Math.min(limit * 2, 20000);
  const perDirectionDedup  = Math.max(1, Math.ceil(limit / 2));
  let rows: any[];
  let manipulationJoined = ENABLE_MANIPULATION_JOIN;
  let phase4ColumnsAvailable = true;

  // Detect the "dynamic-ranking columns not yet migrated" case and
  // transparently fall back to a pre-Phase-4 query that orders by
  // opportunity_score. This prevents a fresh-DB deployment from 500-ing
  // every signals request until migrateSignalEngine runs. Matches
  // MySQL's error prefix "Unknown column '...'.
  const isMissingColumnError = (err: any): boolean =>
    /unknown column|column.*doesn'?t exist/i.test(err?.message ?? '');

  try {
    // Skip the JOIN-path entirely when the manipulation JOIN is disabled.
    // Throwing a synthetic "skipped" error routes execution to the
    // catch block which runs the same SELECT without the JOIN — that
    // path is fast (sub-100ms) and uses indexes correctly. The COLLATE
    // + correlated-subquery + CAST in the JOIN below cannot use any
    // index and takes 10+ seconds, exhausting the connection pool on
    // production within 3 concurrent polls.
    if (!ENABLE_MANIPULATION_JOIN) {
      throw new Error('manipulation JOIN disabled by ENABLE_MANIPULATION_JOIN env');
    }
    const result = await db.query(`
      SELECT
        s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
        s.signal_type, s.confidence_score, s.confidence_band,
        s.risk_score, s.risk_band, s.opportunity_score,
        s.portfolio_fit_score, s.regime_alignment,
        s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
        s.market_regime, s.market_stance, s.scenario_tag,
        s.factor_scores_json, s.ltp, s.pct_change,
        s.status, s.signal_status, s.batch_id, s.generated_at,
        s.final_score, s.freshness_score, s.decay_state, s.age_bars,
        s.overextension_pct, s.invalidation_reason, s.last_rescored_at, s.expires_at,
        s.classification, s.phase4_factor_scores_json,
        s.stress_survival_score, s.recommended_quantity, s.recommended_capital,
        s.live_valid, s.rejection_codes_json, s.rejection_reasons_json,
        s.live_validation_reasons_json, s.explanation_json,
        ms.manipulation_score   AS m_score,
        ms.suspicion_band       AS m_band,
        mp.confidence_penalty   AS m_conf_penalty,
        mp.risk_penalty         AS m_risk_penalty,
        mp.rejection_flag       AS m_rejected,
        mp.reason               AS m_reason
      FROM (
        SELECT
          s2.*,
          ROW_NUMBER() OVER (
            PARTITION BY s2.direction
            ORDER BY s2.final_score DESC, s2.opportunity_score DESC, s2.generated_at DESC
          ) AS dir_rank
        FROM q365_signals s2
        WHERE s2.status IN ('active', 'watchlist', 'flagged', 'stale')
          -- Hard invalidations only. The rescore cron tags routine
          -- price drift as price_drifted (soft tag); a strict NULL-only
          -- filter would drop nearly every row since most live signals
          -- drift at least a bit. Hard invalidations come from
          -- revalidateInstrument: stop_loss_broken, target_reached,
          -- engine_disagree. Anything else is soft and surfaces to the
          -- API; the TS-level gate decides whether to display it.
          AND (
            s2.invalidation_reason IS NULL
            OR s2.invalidation_reason NOT IN (
              'stop_loss_broken', 'stop_loss_broken_confirmed',
              'target_reached', 'target_already_reached',
              'engine_disagree', 'live_rejected'
            )
          )
          AND (s2.expires_at IS NULL OR s2.expires_at > NOW())
          AND s2.decay_state <> 'expired'
          -- Quality gate: surface APPROVED_SIGNAL rows. NULL tolerated
          -- for pre-Phase-4 historical rows. When SIGNAL_RELAX_MODE=true
          -- the clause widens to include DEVELOPING_SETUP so the dashboard
          -- isn't empty when the engine is producing only soft setups
          -- (the TS-layer floors_relaxed=30/35/1.2 still gates them).
          ${signalStatusClause}
          -- Score floor: relaxed to 30 at the SQL layer so the TS
          -- gate (which uses max(final, opp, conf) >= 50) can still
          -- surface decayed APPROVED rows. Pure final_score >= 50
          -- here would re-introduce the decay-kills-everything bug
          -- since the rescore cron decays final_score below 50 within
          -- ~24h on a perfectly valid HIGH_CONVICTION_BUY row.
          AND (s2.final_score IS NULL OR s2.final_score >= 30)
          ${latestBatchClause}
      ) s
      LEFT JOIN q365_manipulation_snapshots ms
        ON ms.symbol COLLATE utf8mb4_unicode_ci = s.symbol COLLATE utf8mb4_unicode_ci
        AND ms.snapshot_date = (
          SELECT MAX(snapshot_date) FROM q365_manipulation_snapshots
          WHERE symbol COLLATE utf8mb4_unicode_ci = s.symbol COLLATE utf8mb4_unicode_ci
        )
      LEFT JOIN q365_manipulation_penalties mp
        ON mp.signal_id COLLATE utf8mb4_unicode_ci = CAST(s.id AS CHAR) COLLATE utf8mb4_unicode_ci
      WHERE s.dir_rank <= ?
      ORDER BY s.final_score DESC, s.opportunity_score DESC, s.generated_at DESC
      LIMIT ?
    `, buildSignalQueryParams(resolvedLatestBatchId, perDirectionLimit, fetchLimit));
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
    } else if (/disabled by ENABLE_MANIPULATION_JOIN/.test(err?.message ?? '')) {
      // Intentional skip — fall through to fast fallback silently.
      // This is the production hot path: log nothing so the operator
      // doesn't see warnings on every poll.
      manipulationJoined = false;
    } else {
      console.warn('[readSignals] manipulation JOIN failed — falling back to plain query:', err?.message);
      manipulationJoined = false;
    }
    try {
      const result = await db.query(
        phase4ColumnsAvailable
          ? // Phase-4 columns available — manipulation JOIN failed only.
            // Same per-direction window function as the primary path so
            // the BUY:SELL split is preserved on this fallback too.
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
            FROM (
              SELECT
                s2.*,
                ROW_NUMBER() OVER (
                  PARTITION BY s2.direction
                  ORDER BY s2.final_score DESC, s2.opportunity_score DESC, s2.generated_at DESC
                ) AS dir_rank
              FROM q365_signals s2
              WHERE s2.status IN ('active', 'watchlist', 'flagged', 'stale')
                AND (
                  s2.invalidation_reason IS NULL
                  OR s2.invalidation_reason NOT IN (
                    'stop_loss_broken', 'stop_loss_broken_confirmed',
                    'target_reached', 'target_already_reached',
                    'engine_disagree', 'live_rejected'
                  )
                )
                AND (s2.expires_at IS NULL OR s2.expires_at > NOW())
                AND s2.decay_state <> 'expired'
                ${signalStatusClause}
                AND (s2.final_score IS NULL OR s2.final_score >= 30)
                ${latestBatchClause}
            ) s
            WHERE s.dir_rank <= ?
            ORDER BY s.final_score DESC, s.opportunity_score DESC, s.generated_at DESC
            LIMIT ?`
          : // Legacy pre-Phase-4 query — no dynamic-ranking columns,
            // no freshness filter. Safe on fresh DB before migration.
            // Window function uses opportunity_score as the ranking key
            // since final_score doesn't exist yet.
            `SELECT
              s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
              s.signal_type, s.confidence_score, s.confidence_band,
              s.risk_score, s.risk_band, s.opportunity_score,
              s.portfolio_fit_score, s.regime_alignment,
              s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
              s.market_regime, s.market_stance, s.scenario_tag,
              s.factor_scores_json, s.ltp, s.pct_change,
              s.status, s.batch_id, s.generated_at
            FROM (
              SELECT
                s2.*,
                ROW_NUMBER() OVER (
                  PARTITION BY s2.direction
                  ORDER BY s2.opportunity_score DESC
                ) AS dir_rank
              FROM q365_signals s2
              WHERE s2.status IN ('active', 'watchlist', 'flagged', 'stale')
                ${latestBatchClause}
            ) s
            WHERE s.dir_rank <= ?
            ORDER BY s.opportunity_score DESC
            LIMIT ?`,
        buildSignalQueryParams(resolvedLatestBatchId, perDirectionLimit, fetchLimit),
      );
      rows = result.rows as any[];
    } catch (innerErr: any) {
      console.error('[readSignals] fallback query also failed:', innerErr?.message);
      throw innerErr;
    }
  }

  // Dedupe by (symbol, direction) with separate per-direction quotas.
  // Two reasons for the per-direction cap:
  //   1. Phase 3 emits one BUY + one SELL for the same symbol in the
  //      best-per-direction path (Nov 2026 change), so a symbol-only
  //      dedup would drop the second one.
  //   2. The outer ORDER BY ranks by final_score DESC. Without a
  //      per-direction quota, BUY rows (which score higher in bull
  //      regimes) would fill the entire `limit` window before any
  //      SELL rows are emitted — the exact starvation the SQL window
  //      function above is designed to prevent. The JS quota mirrors
  //      that intent on the merged result set.
  const seenBuy:  Set<string> = new Set();
  const seenSell: Set<string> = new Set();
  const buyOut:  any[] = [];
  const sellOut: any[] = [];
  // Diagnostic counters — surfaced via the warning below when output
  // is severely imbalanced. Helps the operator distinguish "engine
  // produced no SELLs" (writer issue) from "SELLs exist but were
  // dedup'd away" (reader issue).
  let rawBuyCount  = 0;
  let rawSellCount = 0;
  let rawOtherCount = 0;
  for (const r of rows) {
    const sym = String(r.symbol ?? '').toUpperCase();
    if (!sym) continue;
    const dir = String(r.direction ?? '').toUpperCase().trim();
    if (dir === 'BUY')       rawBuyCount++;
    else if (dir === 'SELL') rawSellCount++;
    else                     rawOtherCount++;

    if (dir === 'BUY') {
      if (seenBuy.has(sym) || buyOut.length >= perDirectionDedup) continue;
      seenBuy.add(sym);
      buyOut.push(r);
    } else if (dir === 'SELL') {
      if (seenSell.has(sym) || sellOut.length >= perDirectionDedup) continue;
      seenSell.add(sym);
      sellOut.push(r);
    }
    if (buyOut.length + sellOut.length >= limit) break;
  }
  const deduped: any[] = [...buyOut, ...sellOut];

  // Imbalance warning — fires when the input pool had SELL rows but
  // the dedup output dropped them all (or vice versa). Without this,
  // a misconfigured deployment (stale build, unicode-quirky direction
  // values, classification mismatch upstream) silently shows 0 SELL
  // and the operator has no idea why. The warning includes the raw
  // input counts so the diagnosis is unambiguous on the LIVE log.
  const wantSellWarning  = rawSellCount > 0 && sellOut.length === 0;
  const wantBuyWarning   = rawBuyCount  > 0 && buyOut.length  === 0;
  const wantOtherWarning = rawOtherCount > 0;
  if (wantSellWarning || wantBuyWarning || wantOtherWarning) {
    console.warn('[readSignals] direction-pool imbalance detected', {
      raw_buy:        rawBuyCount,
      raw_sell:       rawSellCount,
      raw_other:      rawOtherCount,
      output_buy:     buyOut.length,
      output_sell:    sellOut.length,
      perDirectionDedup,
      limit,
      hint: rawOtherCount > 0
        ? 'Found rows with direction not in {BUY, SELL} — DB column may have unexpected values; check direction-column distribution.'
        : (wantSellWarning
            ? 'SELL rows were present in the SQL window but dropped by dedup — investigate (symbol,direction) duplicates.'
            : (wantBuyWarning
                ? 'BUY rows were present but dropped — same investigation as SELL.'
                : '')),
    });
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
      signal_status:     deriveSignalStatus(r),
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

      // ── Phase-11 unified row block ───────────────────────
      // Direct projection of the columns added by the Phase-11
      // Derive classification from final_score when the DB column
      // is null. Mirrors phase11Serialization.classificationFromFinalScore
      // so the API path and the proper Phase-11 deserializer agree.
      // Without this, legacy rows (added before the classification
      // column existed) returned null here → the UI showed "—" or
      // hit the silent NO_TRADE fallback in ClassificationBadge.
      classification:          r.classification
        ?? deriveClassificationFromScore(toNumber(r.final_score)),
      stress_survival_score:   r.stress_survival_score != null ? Number(r.stress_survival_score) : null,
      recommended_quantity:    r.recommended_quantity  != null ? Number(r.recommended_quantity)  : null,
      recommended_capital:     r.recommended_capital   != null ? Number(r.recommended_capital)   : null,
      live_valid:              r.live_valid == null ? null : Number(r.live_valid) === 1,
      rejection_codes:
        typeof r.rejection_codes_json === 'string'
          ? safeJsonParseArray(r.rejection_codes_json)
          : (Array.isArray(r.rejection_codes_json) ? r.rejection_codes_json : []),
      rejection_reasons:
        typeof r.rejection_reasons_json === 'string'
          ? safeJsonParseArray(r.rejection_reasons_json)
          : (Array.isArray(r.rejection_reasons_json) ? r.rejection_reasons_json : []),
      live_validation_reasons:
        typeof r.live_validation_reasons_json === 'string'
          ? safeJsonParseArray(r.live_validation_reasons_json)
          : (Array.isArray(r.live_validation_reasons_json) ? r.live_validation_reasons_json : []),
      explanation:
        typeof r.explanation_json === 'string'
          ? safeJsonParseObject(r.explanation_json)
          : (r.explanation_json && typeof r.explanation_json === 'object' ? r.explanation_json : null),
      factor_scores_phase4:
        typeof r.phase4_factor_scores_json === 'string'
          ? safeJsonParseObject(r.phase4_factor_scores_json)
          : (r.phase4_factor_scores_json && typeof r.phase4_factor_scores_json === 'object' ? r.phase4_factor_scores_json : null),
    };
  });
}

// ── JSON-column parsers (tolerate string or auto-parsed object) ──
function safeJsonParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function safeJsonParseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Mirrors phase11Serialization.classificationFromFinalScore so the API
 * read path and the canonical Phase-11 serializer agree on what bucket
 * a score falls into when the DB column is NULL. Bands match the
 * Phase-12 routing fallback exactly.
 *
 * NO_TRADE is intentionally NOT a fallback bucket. NO_TRADE is a strong
 * negative engine call ("do not trade this") and must never be
 * synthesized from a missing column. Previously the lowest band returned
 * 'NO_TRADE'; combined with `toNumber(null) === 0`, every legacy /
 * partially-populated row whose `classification` AND `final_score` were
 * both NULL got stamped NO_TRADE in the API response, and the
 * dashboard's Class column displayed the generic "No Trade" pill on
 * otherwise-approved BUY signals. The fix routes the floor to
 * DEVELOPING_SETUP so a missing column degrades to the lowest legitimate
 * tradeable bucket; the strict / main-table predicates still reject the
 * row from the confirmed table on score grounds.
 */
function deriveClassificationFromScore(score: number): string {
  if (!Number.isFinite(score)) return 'DEVELOPING_SETUP';
  if (score >= 90) return 'INSTITUTIONAL_HIGH_CONVICTION';
  if (score >= 80) return 'HIGH_CONVICTION';
  if (score >= 50) return 'VALID_SIGNAL';
  return 'DEVELOPING_SETUP';
}

/** Top N signals for dashboard (alias — same ordering as active). */
export async function getTopSignals(limit = 10): Promise<any[]> {
  return getActiveSignals(limit);
}

// ════════════════════════════════════════════════════════════════
//  Developing-setup backfill pool
//
//  Purpose: when the primary active pool returns < target count,
//  pull DEVELOPING_SETUP rows from q365_signals that the primary
//  query excludes — rows whose status is 'rejected' or 'deferred',
//  or which have an invalidation_reason but are NOT decay_state=
//  'expired' and NOT past expires_at. These are the setups that
//  didn't clear the rejection engine but are still "developing"
//  (e.g. scenario NO_STRATEGY, stance restricted, conviction band
//  watchlist→reject). They must never be mixed with approved
//  signals in ranking — they are tagged `is_developing_setup=true`
//  so the UI can render them with a distinct visual treatment and
//  the top-up logic can prefer approved rows.
//
//  Hard rules still apply — no row from `decay_state='expired'` or
//  `expires_at <= NOW()` is ever returned here. Terminal states
//  stay terminal.
// ════════════════════════════════════════════════════════════════
export async function getDevelopingSetupBackfill(
  limit: number,
  excludeSymbols: string[] = [],
): Promise<any[]> {
  if (limit <= 0) return [];

  const excludeClause = excludeSymbols.length > 0
    ? `AND s.symbol NOT IN (${excludeSymbols.map(() => '?').join(',')})`
    : '';
  const params: any[] = [...excludeSymbols, limit * 3];

  let rows: any[] = [];
  let phase4Available = true;

  try {
    const result = await db.query(
      `SELECT
        s.id, s.instrument_key, s.symbol, s.exchange, s.direction, s.timeframe,
        s.signal_type, s.confidence_score, s.confidence_band,
        s.risk_score, s.risk_band, s.opportunity_score,
        s.portfolio_fit_score, s.regime_alignment,
        s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
        s.market_regime, s.market_stance, s.scenario_tag,
        s.factor_scores_json, s.ltp, s.pct_change,
        s.status, s.signal_status, s.batch_id, s.generated_at,
        s.final_score, s.freshness_score, s.decay_state, s.age_bars,
        s.overextension_pct, s.invalidation_reason, s.last_rescored_at, s.expires_at
      FROM q365_signals s
      WHERE (
            s.status IN ('rejected', 'deferred', 'watchlist')
         OR s.invalidation_reason IS NOT NULL
      )
        AND (s.decay_state IS NULL OR s.decay_state <> 'expired')
        AND (s.expires_at  IS NULL OR s.expires_at  > NOW())
      ${excludeClause}
      ORDER BY s.confidence_score DESC, s.opportunity_score DESC, s.generated_at DESC
      LIMIT ?`,
      params,
    );
    rows = result.rows as any[];
  } catch (err: any) {
    if (/unknown column/i.test(err?.message ?? '')) {
      phase4Available = false;
      const legacy = await db.query(
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
        WHERE s.status IN ('rejected', 'deferred', 'watchlist')
        ${excludeClause}
        ORDER BY s.confidence_score DESC, s.opportunity_score DESC, s.generated_at DESC
        LIMIT ?`,
        params,
      );
      rows = legacy.rows as any[];
    } else {
      console.warn('[readSignals] developing-setup backfill failed:', err?.message);
      return [];
    }
  }

  const seen = new Set<string>();
  const deduped: any[] = [];
  for (const r of rows) {
    const sym = String(r.symbol ?? '').toUpperCase();
    const dir = String(r.direction ?? '').toUpperCase();
    if (!sym) continue;
    const key = `${sym}:${dir}`;
    if (seen.has(key)) continue;
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
    // Backfill rows are by definition not approved — force the
    // tri-state to DEVELOPING_SETUP regardless of what's persisted.
    signal_status:     'DEVELOPING_SETUP' as PersistedSignalStatus,
    approved:          false,
    batch_id:          r.batch_id,
    generated_at:      r.generated_at,

    // Phase 4 metadata if available
    final_score:         phase4Available && r.final_score     != null ? Number(r.final_score)     : null,
    freshness_score:     phase4Available && r.freshness_score != null ? Number(r.freshness_score) : null,
    decay_state:         phase4Available ? (r.decay_state ?? null) : null,
    age_bars:            phase4Available && r.age_bars != null ? Number(r.age_bars) : null,
    overextension_pct:   phase4Available && r.overextension_pct != null ? Number(r.overextension_pct) : null,
    invalidation_reason: phase4Available ? (r.invalidation_reason ?? null) : null,
    last_rescored_at:    phase4Available ? (r.last_rescored_at ?? null) : null,
    expires_at:          phase4Available ? (r.expires_at ?? null) : null,

    // UI flags — these rows are tradable but with reduced conviction.
    is_developing_setup: true,
    is_new:              false,
    is_fresh:            false,
    is_aging:            phase4Available && r.decay_state === 'actionable_but_aging',
    is_stale:            phase4Available && r.decay_state === 'stale',
  }));
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
        s.status, s.signal_status, s.batch_id, s.generated_at,
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
    // Archive rows are terminal (stopped out / target hit / expired)
    // — treat as NO_TRADE regardless of what's persisted.
    signal_status:     'NO_TRADE' as PersistedSignalStatus,
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
  // Two-layer split: intelligence reads from confirmed snapshots, the
  // same source the main /signals page reads from. Snapshots have
  // already cleared every gate (rejection engine, live validation, rr
  // / conf / edge floor) so there is no per-call gate-recheck here —
  // the previous applyLiveSanity + strict classification/score gate
  // applied to q365_signals (the live scanner) and is no longer
  // appropriate against locked snapshots.
  //
  // Snapshot rows don't carry every legacy q365_signals column —
  // adapt the few fields downstream code reads so the existing
  // grouping / aggregation logic keeps working without a rewrite.
  const rawSnapshots = await getActiveConfirmedSnapshots({ limit: 200 });
  const signals: any[] = rawSnapshots.map((r) => {
    const gate = (r.gate_details ?? {}) as Record<string, unknown>;
    const klass = String(r.classification ?? '').toUpperCase();
    const conviction =
      klass === 'INSTITUTIONAL_HIGH_CONVICTION' || klass === 'HIGH_CONVICTION_BUY'
        ? 'high_conviction'
        : klass === 'HIGH_CONVICTION'
          ? 'high_conviction'
          : klass === 'VALID_SIGNAL' || klass === 'VALID_BUY'
            ? 'actionable'
            : 'watchlist';
    return {
      ...r,
      regime:            (gate.regime as string)        ?? 'NEUTRAL',
      market_stance:     (gate.market_stance as string) ?? 'selective',
      scenario_tag:      r.strategy ?? 'NO_STRATEGY',
      conviction_band:   (gate.confidence_band as string) ?? conviction,
      risk_score:        Number(gate.risk_score ?? 50),
      risk:              (gate.confidence_band as string) ?? 'medium',
      opportunity_score: Number(r.confidence_score ?? 0),
      timeframe:         'swing',
      ltp:               r.entry_price,
      pct_change:        null,
    };
  });

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
       WHERE status IN ('active','watchlist','flagged','stale')
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
