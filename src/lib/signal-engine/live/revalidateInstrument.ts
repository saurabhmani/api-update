/**
 * Live revalidation of a stored q365_signals row.
 *
 * Used by GET /api/signals?action=instrument and any per-symbol detail
 * lookup. The previous flow ran `generateSignal()` from scratch every
 * call, which made the stock-detail page disagree with the main
 * Signals table — the table read a stored APPROVED row from the last
 * pipeline run, while the detail page recomputed live and could come
 * back REJECTED with "Confidence below threshold". RATEGAIN was the
 * canonical example: BUY in /signals, REJECTED in /market/RATEGAIN.
 *
 * Resolution policy (single source of truth):
 *   1. Latest non-invalidated q365_signals row for the symbol is the
 *      authoritative DISPLAY signal. Pipeline → table → detail page.
 *   2. Live `generateSignal()` is REVALIDATION, not replacement. Its
 *      role is to confirm the stored row is still tradeable and to
 *      enrich the response with live confidence / rejection metadata.
 *   3. When stored APPROVED ∧ live REJECTED:
 *        - keep the stored signal as the displayed BUY/SELL
 *        - attach a `revalidation` envelope so the UI can render a
 *          "Signal Changed / Revalidated" banner instead of a hard
 *          "REJECTED" pill
 *        - persist the disagreement to q365_signals
 *          (invalidation_reason / signal_status / status) so the next
 *          /api/signals poll drops the row from the main table — this
 *          satisfies the "main table must never show a stock the
 *          detail page would reject" invariant.
 *   4. When stored is missing, the live signal is the only source
 *      (preserves the current "live deep search" behaviour).
 */

import { db }                 from '@/lib/db';
import {
  generateSignal,
  opportunityScore,
  type Signal,
}                             from './analyzeInstrument';

// invalidateSignalsCache wrapper retired — the HTTP route's SWR store
// is gone (only used by the long-deleted buildFreshnessProbe), so the
// call was a no-op. Live-tape revalidation now relies on the next
// route-handler tick reading directly from q365_confirmed_signal_snapshots
// where the lifecycle cron has already persisted the verdict.

// ── Stored signal shape (subset we need) ────────────────────────────

export interface StoredSignalRow {
  id:                  number;
  symbol:              string;
  instrument_key:      string;
  exchange:            string | null;
  direction:           string | null;
  signal_type:         string | null;
  confidence_score:    number | null;
  confidence_band:     string | null;
  risk_score:          number | null;
  risk_band:           string | null;
  opportunity_score:   number | null;
  portfolio_fit_score: number | null;
  regime_alignment:    number | null;
  entry_price:         number | null;
  stop_loss:           number | null;
  target1:             number | null;
  target2:             number | null;
  risk_reward:         number | null;
  market_regime:       string | null;
  market_stance:       string | null;
  scenario_tag:        string | null;
  status:              string | null;
  signal_status:       string | null;
  generated_at:        string | null;
  invalidation_reason: string | null;
  reasons:             Array<{ type: string; message: string; factor_key: string | null }>;
}

// ── Live revalidation outcome (per spec §3) ─────────────────────────

export type RevalidationStatus =
  | 'consistent'    // stored + live agree
  | 'revalidated'   // stored APPROVED but live disagrees → show banner
  | 'live_only'     // no stored row, live result returned as-is
  | 'stored_only'   // stored row present, live engine returned null
  | 'no_data';      // neither path produced a usable result

export interface RevalidationBlock {
  status:           RevalidationStatus;
  display_source:   'stored' | 'live' | 'none';
  live_invalidated: boolean;
  banner:           string | null;
  stored?: {
    direction:        string | null;
    signal_status:    string | null;
    confidence_score: number | null;
    generated_at:     string | null;
    signal_id:        number | null;
  };
  live?: {
    direction:         string | null;
    signal_status:     string | null;
    confidence_score:  number | null;
    rejection_reasons: string[];
    rejection_codes:   string[];
  };
}

export interface RevalidatedInstrumentResponse {
  signal:            Signal | StoredSignalAsLive | null;
  approved:          boolean;
  rejection_reasons: string[];
  rejection_codes:   string[];
  soft_warnings:     string[];
  factor_scores:     Record<string, number> | null;
  confidence_score:  number | null;
  composite_score:   number | null;
  portfolio_fit:     number | null;
  conviction_band:   string | null;
  regime:            string | null;
  scenario_tag:      string | null;
  market_stance:     string | null;
  opportunity_score: number | null;
  risk_score:        number | null;
  portfolio_fit_score: number | null;
  regime_alignment:  number | null;
  revalidation:      RevalidationBlock;
}

// Stored rows are projected into a Signal-shaped object so the existing
// MarketDetail UI (which expects `signal.direction` / `signal.entry_price`
// / `signal.reasons` / etc.) renders with no further changes.
export interface StoredSignalAsLive {
  instrument_key:    string;
  tradingsymbol:     string;
  exchange:          string;
  direction:         string;
  timeframe:         string;
  confidence:        number;
  risk_score:        number;
  opportunity_score: number;
  portfolio_fit:     number;
  conviction_band:   string;
  market_stance:     string;
  regime_alignment:  number;
  rejection_reasons: string[];
  rejection_codes:   string[];
  signal_status:     string;
  scenario_tag:      string;
  regime:            string;
  entry_price:       number;
  stop_loss:         number;
  target1:           number;
  target2:           number;
  risk_reward:       number;
  reasons:           Array<{ rank: number; factor_key: string | null; text: string; contribution: number }>;
  signal_type:       string;
  generated_at:      string;
  /** Tag so downstream consumers can tell this was projected from a stored row. */
  source:            'stored_q365';
}

// ── Helpers ─────────────────────────────────────────────────────────

function n(v: unknown, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

async function loadLatestStored(symbol: string, instrumentKey: string): Promise<StoredSignalRow | null> {
  // Prefer the latest non-invalidated row. A row whose
  // `invalidation_reason` is already set is by definition not the
  // signal the user clicked from /signals (the table filters those
  // out at the SQL layer), so falling through to it would resurrect
  // a disagreement we already resolved. The same query also rejects
  // expired rows so we never revalidate a signal the lifecycle gate
  // has already retired.
  try {
    const { rows } = await db.query<any>(
      `SELECT
         s.id, s.symbol, s.instrument_key, s.exchange,
         s.direction, s.signal_type,
         s.confidence_score, s.confidence_band,
         s.risk_score, s.risk_band, s.opportunity_score,
         s.portfolio_fit_score, s.regime_alignment,
         s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
         s.market_regime, s.market_stance, s.scenario_tag,
         s.status, s.signal_status, s.generated_at, s.invalidation_reason
       FROM q365_signals s
       WHERE (s.instrument_key = ? OR s.symbol = ?)
         AND s.status IN ('active','watchlist','flagged')
         AND s.invalidation_reason IS NULL
         AND (s.expires_at IS NULL OR s.expires_at > NOW())
         AND (s.decay_state IS NULL OR s.decay_state <> 'expired')
       ORDER BY s.generated_at DESC
       LIMIT 1`,
      [instrumentKey, symbol],
    );
    if (!rows.length) return null;
    const r = rows[0];

    // Pull typed reasons (best-effort; table may be empty for legacy rows).
    let reasons: StoredSignalRow['reasons'] = [];
    try {
      const reasonRes = await db.query<any>(
        `SELECT reason_type, message, factor_key
           FROM q365_signal_reasons
          WHERE signal_id = ?
          ORDER BY id ASC`,
        [r.id],
      );
      reasons = (reasonRes.rows as any[]).map((rr) => ({
        type:       String(rr.reason_type ?? ''),
        message:    String(rr.message ?? ''),
        factor_key: rr.factor_key ? String(rr.factor_key) : null,
      }));
    } catch { /* optional table */ }

    return {
      id:                  Number(r.id),
      symbol:              String(r.symbol ?? symbol),
      instrument_key:      String(r.instrument_key ?? instrumentKey),
      exchange:            r.exchange ? String(r.exchange) : null,
      direction:           r.direction ? String(r.direction) : null,
      signal_type:         r.signal_type ? String(r.signal_type) : null,
      confidence_score:    r.confidence_score != null ? n(r.confidence_score) : null,
      confidence_band:     r.confidence_band ? String(r.confidence_band) : null,
      risk_score:          r.risk_score != null ? n(r.risk_score) : null,
      risk_band:           r.risk_band ? String(r.risk_band) : null,
      opportunity_score:   r.opportunity_score != null ? n(r.opportunity_score) : null,
      portfolio_fit_score: r.portfolio_fit_score != null ? n(r.portfolio_fit_score) : null,
      regime_alignment:    r.regime_alignment != null ? n(r.regime_alignment) : null,
      entry_price:         r.entry_price != null ? n(r.entry_price) : null,
      stop_loss:           r.stop_loss   != null ? n(r.stop_loss)   : null,
      target1:             r.target1     != null ? n(r.target1)     : null,
      target2:             r.target2     != null ? n(r.target2)     : null,
      risk_reward:         r.risk_reward != null ? n(r.risk_reward) : null,
      market_regime:       r.market_regime ? String(r.market_regime) : null,
      market_stance:       r.market_stance ? String(r.market_stance) : null,
      scenario_tag:        r.scenario_tag  ? String(r.scenario_tag)  : null,
      status:              r.status ? String(r.status) : null,
      signal_status:       r.signal_status ? String(r.signal_status) : null,
      generated_at:        r.generated_at ? new Date(r.generated_at).toISOString() : null,
      invalidation_reason: r.invalidation_reason ? String(r.invalidation_reason) : null,
      reasons,
    };
  } catch (err: any) {
    console.warn(`[revalidateInstrument] loadLatestStored ${symbol} failed:`, err?.message);
    return null;
  }
}

function projectStored(row: StoredSignalRow): StoredSignalAsLive {
  // Convert a stored q365_signals row into the same shape MarketDetail
  // already consumes for `signal`. Splitting the typed reasons into
  // `reasons[]` (vs rejection codes) mirrors the saveSignals writer
  // and the stockDetailService reader.
  const visibleReasons = row.reasons
    .filter((r) => r.type !== 'rejection')
    .map((r, i) => ({
      rank:         i + 1,
      factor_key:   r.factor_key,
      text:         r.message,
      contribution: 0,
    }));

  return {
    instrument_key:    row.instrument_key,
    tradingsymbol:     row.symbol,
    exchange:          row.exchange ?? 'NSE',
    direction:         row.direction ?? 'HOLD',
    timeframe:         'swing',
    confidence:        row.confidence_score ?? 0,
    risk_score:        row.risk_score ?? 0,
    opportunity_score: row.opportunity_score ?? 0,
    portfolio_fit:     row.portfolio_fit_score ?? 0,
    conviction_band:   row.confidence_band ?? 'actionable',
    market_stance:     row.market_stance ?? 'selective',
    regime_alignment:  row.regime_alignment ?? 0,
    rejection_reasons: [],
    rejection_codes:   [],
    signal_status:     row.signal_status ?? 'APPROVED_SIGNAL',
    scenario_tag:      row.scenario_tag ?? '',
    regime:            row.market_regime ?? 'NEUTRAL',
    entry_price:       row.entry_price ?? 0,
    stop_loss:         row.stop_loss   ?? 0,
    target1:           row.target1     ?? 0,
    target2:           row.target2     ?? 0,
    risk_reward:       row.risk_reward ?? 0,
    reasons:           visibleReasons,
    signal_type:       row.signal_type ?? row.direction ?? 'HOLD',
    generated_at:      row.generated_at ?? new Date().toISOString(),
    source:            'stored_q365',
  };
}

// ── Persist live disagreement (spec §6) ─────────────────────────────
//
// Marks the stored row as live-invalidated so the next /api/signals
// SWR refresh drops it from the main BUY/SELL table. We set:
//   invalidation_reason → so the SQL gate (`invalidation_reason IS
//                          NULL`) excludes the row at the read layer
//   invalidated_at     → audit trail
//   signal_status      → moves the row out of APPROVED_SIGNAL so the
//                          API-layer strictHardExclude also catches it
//                          even before the SWR refresh
//   status             → 'flagged' so it's still queryable for audit /
//                          history without showing in the main table
//
// Reasons are appended to q365_signal_reasons as `rejection` rows so
// the same source the stock-detail UI already reads can render the
// "why" list. We dedupe against existing rejection rows to avoid
// piling up identical messages on every poll.
async function persistInvalidation(
  storedId:           number,
  liveStatus:         string,                 // signal_status from live (NO_TRADE / DEVELOPING_SETUP)
  rejectionReasons:   string[],
  rejectionCodes:     string[],
  liveConfidence:     number | null,
): Promise<void> {
  const reasonHeader = liveConfidence != null
    ? `Live revalidation: ${liveStatus} (confidence ${liveConfidence})`
    : `Live revalidation: ${liveStatus}`;

  // 1. Update q365_signals row.
  try {
    await db.query(
      `UPDATE q365_signals
          SET invalidation_reason = ?,
              invalidated_at      = NOW(),
              signal_status       = ?,
              status              = 'flagged'
        WHERE id = ?
          AND invalidation_reason IS NULL`,
      [reasonHeader, liveStatus, storedId],
    );
  } catch (err: any) {
    console.warn(`[revalidateInstrument] UPDATE q365_signals id=${storedId} failed:`, err?.message);
    return; // Don't bother appending reasons if the row update failed.
  }

  // 2. Append rejection rows (best-effort; tolerate missing factor_key column).
  if (rejectionReasons.length === 0 && rejectionCodes.length === 0) return;
  try {
    const existing = await db.query<any>(
      `SELECT message FROM q365_signal_reasons
        WHERE signal_id = ? AND reason_type = 'rejection'`,
      [storedId],
    );
    const have = new Set((existing.rows as any[]).map((r) => String(r.message ?? '')));

    const tuples: Array<[number, string, string, string | null]> = [];
    const codeQueue = [...rejectionCodes];
    for (const msg of rejectionReasons) {
      if (have.has(msg)) continue;
      const code = codeQueue.shift() ?? null;
      tuples.push([storedId, 'rejection', msg, code]);
      have.add(msg);
    }
    // Any leftover codes without a matching message still get persisted
    // so the UI can render the humanized label even for code-only rows.
    for (const code of codeQueue) {
      const msg = `Live revalidation rejected: ${code}`;
      if (have.has(msg)) continue;
      tuples.push([storedId, 'rejection', msg, code]);
      have.add(msg);
    }
    if (tuples.length === 0) return;

    // Try the variant with factor_key first (production schema). Fall
    // back to the 3-column form if the column doesn't exist on a
    // legacy DB.
    try {
      const placeholders = tuples.map(() => '(?, ?, ?, ?)').join(', ');
      await db.query(
        `INSERT INTO q365_signal_reasons (signal_id, reason_type, message, factor_key)
         VALUES ${placeholders}`,
        tuples.flat(),
      );
    } catch {
      const placeholders = tuples.map(() => '(?, ?, ?)').join(', ');
      await db.query(
        `INSERT INTO q365_signal_reasons (signal_id, reason_type, message)
         VALUES ${placeholders}`,
        tuples.flatMap((t) => [t[0], t[1], t[2]]),
      );
    }
  } catch (err: any) {
    console.warn(`[revalidateInstrument] append rejection rows failed for id=${storedId}:`, err?.message);
  }
}

// ── Public API ──────────────────────────────────────────────────────

export interface RevalidateOpts {
  /** Set to false to skip the DB invalidation write — used by the
   *  acceptance-test script which only wants to compare. */
  persistInvalidation?: boolean;
}

export async function revalidateInstrument(
  instrumentKey: string,
  symbol:        string,
  exchange:      string,
  opts:          RevalidateOpts = {},
): Promise<RevalidatedInstrumentResponse> {
  const persist = opts.persistInvalidation !== false;

  // 1. Fetch stored + live in parallel — they don't share state.
  const [stored, live] = await Promise.all([
    loadLatestStored(symbol, instrumentKey),
    generateSignal(instrumentKey, symbol, exchange).catch((err) => {
      console.warn(`[revalidateInstrument] generateSignal ${symbol} threw:`, err?.message);
      return null;
    }),
  ]);

  const liveDirection      = live?.direction ?? null;
  const liveStatus         = live?.signal_status ?? null;
  const liveRejected       = !!live && live.rejection_reasons.length > 0;
  const liveConfidence     = live?.confidence ?? null;
  const liveRejectionList  = live?.rejection_reasons ?? [];
  const liveRejectionCodes = live?.rejection_codes   ?? [];

  const liveBlock: RevalidationBlock['live'] = live ? {
    direction:         liveDirection,
    signal_status:     liveStatus,
    confidence_score:  liveConfidence,
    rejection_reasons: [...liveRejectionList],
    rejection_codes:   [...liveRejectionCodes],
  } : undefined;

  const storedBlock: RevalidationBlock['stored'] = stored ? {
    direction:        stored.direction,
    signal_status:    stored.signal_status,
    confidence_score: stored.confidence_score,
    generated_at:     stored.generated_at,
    signal_id:        stored.id,
  } : undefined;

  // ── Case A: no stored row — live is the only source ──────────────
  if (!stored) {
    if (!live) {
      return {
        signal:            null,
        approved:          false,
        rejection_reasons: [],
        rejection_codes:   [],
        soft_warnings:     [],
        factor_scores:     null,
        confidence_score:  null,
        composite_score:   null,
        portfolio_fit:     null,
        conviction_band:   null,
        regime:            null,
        scenario_tag:      null,
        market_stance:     null,
        opportunity_score: null,
        risk_score:        null,
        portfolio_fit_score: null,
        regime_alignment:  null,
        revalidation: {
          status:           'no_data',
          display_source:   'none',
          live_invalidated: false,
          banner:           null,
          stored:           storedBlock,
          live:             liveBlock,
        },
      };
    }
    if (liveRejected) {
      return {
        signal:            null,
        approved:          false,
        rejection_reasons: liveRejectionList,
        rejection_codes:   liveRejectionCodes,
        soft_warnings:     live.soft_warnings,
        factor_scores:     live.factor_scores,
        confidence_score:  live.confidence,
        composite_score:   Math.round(live.score_raw * 100),
        portfolio_fit:     live.portfolio_fit,
        conviction_band:   live.conviction_band,
        regime:            live.regime,
        scenario_tag:      live.scenario_tag,
        market_stance:     live.market_stance,
        opportunity_score: null,
        risk_score:        live.risk_score,
        portfolio_fit_score: live.portfolio_fit,
        regime_alignment:  live.regime_alignment,
        revalidation: {
          status:           'live_only',
          display_source:   'live',
          live_invalidated: true,
          banner:           null,
          stored:           storedBlock,
          live:             liveBlock,
        },
      };
    }
    return {
      signal:            live,
      approved:          true,
      rejection_reasons: [],
      rejection_codes:   [],
      soft_warnings:     live.soft_warnings,
      factor_scores:     live.factor_scores,
      confidence_score:  live.confidence,
      composite_score:   Math.round(live.score_raw * 100),
      portfolio_fit:     live.portfolio_fit,
      conviction_band:   live.conviction_band,
      regime:            live.regime,
      scenario_tag:      live.scenario_tag,
      market_stance:     live.market_stance,
      opportunity_score: opportunityScore(live),
      risk_score:        live.risk_score,
      portfolio_fit_score: live.portfolio_fit,
      regime_alignment:  live.regime_alignment,
      revalidation: {
        status:           'live_only',
        display_source:   'live',
        live_invalidated: false,
        banner:           null,
        stored:           storedBlock,
        live:             liveBlock,
      },
    };
  }

  // ── Case B: stored present, live engine returned null ────────────
  // Probably means the live engine couldn't fetch candles or the
  // benchmark snapshot. Don't downgrade the stored signal — render it
  // as-is and surface the missing live result via the envelope.
  if (!live) {
    const projected = projectStored(stored);
    return {
      signal:            projected,
      approved:          true,
      rejection_reasons: [],
      rejection_codes:   [],
      soft_warnings:     [],
      factor_scores:     null,
      confidence_score:  projected.confidence,
      composite_score:   null,
      portfolio_fit:     projected.portfolio_fit,
      conviction_band:   projected.conviction_band,
      regime:            projected.regime,
      scenario_tag:      projected.scenario_tag,
      market_stance:     projected.market_stance,
      opportunity_score: projected.opportunity_score,
      risk_score:        projected.risk_score,
      portfolio_fit_score: projected.portfolio_fit,
      regime_alignment:  projected.regime_alignment,
      revalidation: {
        status:           'stored_only',
        display_source:   'stored',
        live_invalidated: false,
        banner:           null,
        stored:           storedBlock,
        live:             liveBlock,
      },
    };
  }

  // ── Case C: stored + live agree (consistent) ─────────────────────
  const storedDirection = (stored.direction ?? '').toUpperCase();
  const liveDirNorm     = (liveDirection ?? '').toUpperCase();
  const sameDirection   = storedDirection && liveDirNorm && storedDirection === liveDirNorm;

  if (!liveRejected && sameDirection) {
    return {
      signal:            live,
      approved:          true,
      rejection_reasons: [],
      rejection_codes:   [],
      soft_warnings:     live.soft_warnings,
      factor_scores:     live.factor_scores,
      confidence_score:  live.confidence,
      composite_score:   Math.round(live.score_raw * 100),
      portfolio_fit:     live.portfolio_fit,
      conviction_band:   live.conviction_band,
      regime:            live.regime,
      scenario_tag:      live.scenario_tag,
      market_stance:     live.market_stance,
      opportunity_score: opportunityScore(live),
      risk_score:        live.risk_score,
      portfolio_fit_score: live.portfolio_fit,
      regime_alignment:  live.regime_alignment,
      revalidation: {
        status:           'consistent',
        display_source:   'live',
        live_invalidated: false,
        banner:           null,
        stored:           storedBlock,
        live:             liveBlock,
      },
    };
  }

  // ── Case D: stored APPROVED, live disagrees → REVALIDATED ────────
  // Display the stored signal so the user sees the same BUY/SELL the
  // main /signals table promised, and attach a banner so the UI can
  // tell them the live engine no longer agrees.
  const projected = projectStored(stored);
  const banner = !sameDirection && liveDirNorm && storedDirection
    ? `Signal Changed / Revalidated — live engine now reports ${liveDirNorm}`
    : 'Signal Changed / Revalidated — live engine no longer confirms this setup';

  if (persist && stored.signal_status === 'APPROVED_SIGNAL') {
    // Choose persisted signal_status: prefer the live engine's tri-state
    // when present (NO_TRADE / DEVELOPING_SETUP), else fall back to
    // NO_TRADE since liveRejected ⇒ the engine refused the trade.
    const persistedStatus = liveStatus === 'NO_TRADE' || liveStatus === 'DEVELOPING_SETUP'
      ? liveStatus
      : 'NO_TRADE';
    await persistInvalidation(
      stored.id,
      persistedStatus,
      liveRejectionList,
      liveRejectionCodes,
      liveConfidence,
    );
    // SWR-cache invalidation removed: the HTTP route's keyed SWR
    // store was retired with buildFreshnessProbe. The route reads
    // directly from q365_confirmed_signal_snapshots on every poll
    // (gated by its own short-TTL freezeCache, not a content cache),
    // so the invalidated row drops out on the next tick naturally.
  }

  return {
    signal:            projected,
    // approved=true here is intentional: from the user's POV the
    // displayed signal IS the actionable BUY/SELL. The revalidation
    // banner communicates the live disagreement; downstream UI gates
    // can read `revalidation.live_invalidated` to suppress execute
    // affordances.
    approved:          true,
    rejection_reasons: liveRejectionList,
    rejection_codes:   liveRejectionCodes,
    soft_warnings:     live.soft_warnings,
    factor_scores:     live.factor_scores,
    confidence_score:  projected.confidence,
    composite_score:   Math.round(live.score_raw * 100),
    portfolio_fit:     projected.portfolio_fit,
    conviction_band:   projected.conviction_band,
    regime:            projected.regime,
    scenario_tag:      projected.scenario_tag,
    market_stance:     projected.market_stance,
    opportunity_score: projected.opportunity_score,
    risk_score:        projected.risk_score,
    portfolio_fit_score: projected.portfolio_fit,
    regime_alignment:  projected.regime_alignment,
    revalidation: {
      status:           'revalidated',
      display_source:   'stored',
      live_invalidated: true,
      banner,
      stored:           storedBlock,
      live:             liveBlock,
    },
  };
}
