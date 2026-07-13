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
  getLatestActiveSnapshotBySymbol,
  type ConfirmedSnapshotRow,
}                             from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { getAuthoritativeSignalRow } from '@/lib/signal-engine/pipeline/authoritativeSignalRow';
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
  /** Trade-plan levels duplicated at top level for tabs that read outside `signal`. */
  entry_price?:      number | null;
  stop_loss?:        number | null;
  target1?:          number | null;
  target2?:          number | null;
  risk_reward?:      number | null;
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

function positiveLevel(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function tradeLevelsFromSignal(
  sig: Signal | StoredSignalAsLive | null,
): Pick<RevalidatedInstrumentResponse, 'entry_price' | 'stop_loss' | 'target1' | 'target2' | 'risk_reward'> {
  if (!sig) {
    return { entry_price: null, stop_loss: null, target1: null, target2: null, risk_reward: null };
  }
  const rr = positiveLevel(sig.risk_reward);
  return {
    entry_price: positiveLevel(sig.entry_price),
    stop_loss:   positiveLevel(sig.stop_loss),
    target1:     positiveLevel(sig.target1),
    target2:     positiveLevel(sig.target2),
    risk_reward: rr,
  };
}

function withTradeLevels(resp: RevalidatedInstrumentResponse): RevalidatedInstrumentResponse {
  const levels = tradeLevelsFromSignal(resp.signal);
  return { ...resp, ...levels };
}

async function loadLatestStored(
  symbol: string,
  instrumentKey: string,
  preferredDirection?: 'BUY' | 'SELL',
): Promise<StoredSignalRow | null> {
  try {
    const row = await getAuthoritativeSignalRow(symbol, instrumentKey, {
      direction: preferredDirection,
    });
    if (!row) return null;

    let reasons: StoredSignalRow['reasons'] = [];
    try {
      const reasonRes = await db.query<any>(
        `SELECT reason_type, message
           FROM q365_signal_reasons
          WHERE signal_id = ?
          ORDER BY id ASC`,
        [row.id],
      );
      reasons = (reasonRes.rows as any[]).map((rr) => ({
        type:       String(rr.reason_type ?? ''),
        message:    String(rr.message ?? ''),
        factor_key: null,
      }));
    } catch { /* optional table */ }

    return {
      id:                  row.id,
      symbol:              row.symbol,
      instrument_key:      row.instrument_key,
      exchange:            row.exchange,
      direction:           row.direction,
      signal_type:         row.signal_type,
      confidence_score:    row.confidence_score,
      confidence_band:     row.confidence_band,
      risk_score:          row.risk_score,
      risk_band:           row.risk_band,
      opportunity_score:   row.opportunity_score,
      portfolio_fit_score: row.portfolio_fit_score,
      regime_alignment:    row.regime_alignment,
      entry_price:         row.entry_price,
      stop_loss:           row.stop_loss,
      target1:             row.target1,
      target2:             row.target2,
      risk_reward:         row.risk_reward,
      market_regime:       row.market_regime,
      market_stance:       row.market_stance,
      scenario_tag:        row.scenario_tag,
      status:              row.status,
      signal_status:       row.signal_status,
      generated_at:        row.generated_at,
      invalidation_reason: row.invalidation_reason,
      reasons,
    };
  } catch (err: any) {
    console.warn(`[revalidateInstrument] loadLatestStored ${symbol} failed:`, err?.message);
    return null;
  }
}

function scoreFromFactors(
  factors: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const x = Number((factors as any)[key]);
    if (Number.isFinite(x) && x > 0) return x;
  }
  return null;
}

function projectConfirmedSnapshot(row: ConfirmedSnapshotRow): StoredSignalAsLive {
  const factors = (row.factor_scores ?? {}) as Record<string, unknown>;
  const gates   = (row.gate_details ?? {}) as Record<string, unknown>;
  const conf    = row.confidence_score ?? 0;
  // Match /signals table backfill: prefer stored factor, else min(100, conf+5)
  const fitFromFactors =
    scoreFromFactors(factors, 'portfolio_fit_score', 'portfolio_fit')
    ?? scoreFromFactors(gates, 'portfolio_fit_score', 'portfolio_fit')
    ?? Math.min(100, conf + 5);
  const riskFromFactors =
    scoreFromFactors(factors, 'risk_score', 'risk')
    ?? 50;

  const visibleReasons = Object.entries(row.explanation ?? {})
    .filter(([, v]) => typeof v === 'string' && v.length > 0)
    .slice(0, 6)
    .map(([key, text], i) => ({
      rank:         i + 1,
      factor_key:   key,
      text:         String(text),
      contribution: 0,
    }));

  if (visibleReasons.length === 0) {
    visibleReasons.push({
      rank: 1,
      factor_key: 'institutional',
      text: 'Cleared institutional approval gate',
      contribution: 0,
    });
  }

  return {
    instrument_key:    `NSE_EQ|${row.symbol}`,
    tradingsymbol:     row.symbol,
    exchange:          row.exchange ?? 'NSE',
    direction:         row.direction,
    timeframe:         'swing',
    confidence:        conf,
    risk_score:        riskFromFactors,
    opportunity_score: row.expected_edge_percent ?? 0,
    portfolio_fit:     fitFromFactors,
    conviction_band:   String(row.conviction_level ?? 'medium').toLowerCase(),
    market_stance:     String((factors as any).market_stance ?? 'selective'),
    regime_alignment:  Number((factors as any).regime_alignment ?? 0) || 0,
    rejection_reasons: [],
    rejection_codes:   row.rejection_codes ?? [],
    signal_status:     'APPROVED_SIGNAL',
    scenario_tag:      row.strategy ?? row.classification ?? 'INSTITUTIONAL',
    regime:            String((factors as any).market_regime ?? 'NEUTRAL'),
    entry_price:       row.entry_price ?? 0,
    stop_loss:         row.stop_loss ?? 0,
    target1:           row.target1 ?? 0,
    target2:           row.target2 ?? 0,
    risk_reward:       row.risk_reward ?? row.rr_ratio ?? 0,
    reasons:           visibleReasons,
    signal_type:       row.strategy ?? row.direction,
    generated_at:      row.confirmed_at ?? new Date().toISOString(),
    source:            'stored_q365',
  };
}

function responseFromConfirmedSnapshot(
  snap:  ConfirmedSnapshotRow,
  live:  Signal | null,
): RevalidatedInstrumentResponse {
  const projected = projectConfirmedSnapshot(snap);
  const liveDirection      = live?.direction ?? null;
  const liveStatus         = live?.signal_status ?? null;
  const liveRejected       = !!live && live.rejection_reasons.length > 0;
  const liveConfidence     = live?.confidence ?? null;
  const liveRejectionList  = live?.rejection_reasons ?? [];
  const liveRejectionCodes = live?.rejection_codes   ?? [];

  const storedBlock: RevalidationBlock['stored'] = {
    direction:        snap.direction,
    signal_status:    'APPROVED_SIGNAL',
    confidence_score: snap.confidence_score,
    generated_at:     snap.confirmed_at,
    signal_id:        snap.source_signal_id,
  };

  const liveBlock: RevalidationBlock['live'] = live ? {
    direction:         liveDirection,
    signal_status:     liveStatus,
    confidence_score:  liveConfidence,
    rejection_reasons: [...liveRejectionList],
    rejection_codes:   [...liveRejectionCodes],
  } : undefined;

  const storedDirection = snap.direction.toUpperCase();
  const liveDirNorm     = (liveDirection ?? '').toUpperCase();
  const sameDirection   = liveDirNorm
    ? storedDirection === liveDirNorm
    : !liveRejected;

  let revalidation: RevalidationBlock;
  if (!live) {
    revalidation = {
      status: 'stored_only', display_source: 'stored', live_invalidated: false,
      banner: null, stored: storedBlock, live: liveBlock,
    };
  } else if (!liveRejected && sameDirection) {
    revalidation = {
      status: 'consistent', display_source: 'stored', live_invalidated: false,
      banner: null, stored: storedBlock, live: liveBlock,
    };
  } else {
    revalidation = {
      status:           'revalidated',
      display_source:   'stored',
      live_invalidated: true,
      banner: !sameDirection && liveDirNorm
        ? `Signal Changed / Revalidated — live engine now reports ${liveDirNorm}`
        : 'Market is currently closed — awaiting fresh confirmation',
      stored: storedBlock,
      live:   liveBlock,
    };
  }

  const riskScore = projected.risk_score;
  return {
    signal:              projected,
    approved:            true,
    rejection_reasons:   liveRejected ? liveRejectionList : [],
    rejection_codes:     liveRejected ? liveRejectionCodes : [],
    soft_warnings:       live?.soft_warnings ?? [],
    factor_scores:       (live?.factor_scores ?? snap.factor_scores ?? null) as Record<string, number> | null,
    confidence_score:    projected.confidence,
    composite_score:     snap.final_score != null ? Math.round(snap.final_score) : null,
    portfolio_fit:       projected.portfolio_fit,
    conviction_band:     projected.conviction_band,
    regime:              projected.regime,
    scenario_tag:        projected.scenario_tag,
    market_stance:       projected.market_stance,
    opportunity_score:   projected.opportunity_score,
    risk_score:          riskScore,
    portfolio_fit_score: projected.portfolio_fit,
    regime_alignment:    projected.regime_alignment,
    revalidation,
  };
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
  /** When set, load the authoritative row for this direction (matches
   *  /signals table BUY/SELL pool selection). */
  preferredDirection?: 'BUY' | 'SELL';
}

export async function revalidateInstrument(
  instrumentKey: string,
  symbol:        string,
  exchange:      string,
  opts:          RevalidateOpts = {},
): Promise<RevalidatedInstrumentResponse> {
  const persist = opts.persistInvalidation !== false;
  const sym = symbol.toUpperCase();

  // Prefer confirmed snapshots — same source as the main /signals table.
  // Without this, the stock-detail page runs live-only generateSignal() and
  // shows "Signal Rejected" while /signals still lists the symbol as APPROVED.
  const confirmedSnap = await getLatestActiveSnapshotBySymbol(sym).catch(() => null);
  if (confirmedSnap?.status === 'ACTIVE') {
    const live = await generateSignal(instrumentKey, sym, exchange).catch((err) => {
      console.warn(`[revalidateInstrument] generateSignal ${sym} threw:`, err?.message);
      return null;
    });
    return withTradeLevels(responseFromConfirmedSnapshot(confirmedSnap, live));
  }

  // 1. Fetch stored + live in parallel — they don't share state.
  const [stored, live] = await Promise.all([
    loadLatestStored(symbol, instrumentKey, opts.preferredDirection),
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
      return withTradeLevels({
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
      });
    }
    if (liveRejected) {
      return withTradeLevels({
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
      });
    }
    return withTradeLevels({
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
    });
  }

  // ── Case B: stored present, live engine returned null ────────────
  // Probably means the live engine couldn't fetch candles or the
  // benchmark snapshot. Don't downgrade the stored signal — render it
  // as-is and surface the missing live result via the envelope.
  if (!live) {
    const projected = projectStored(stored);
    return withTradeLevels({
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
    });
  }

  // ── Case C: stored + live agree (consistent) ─────────────────────
  const storedDirection = (stored.direction ?? '').toUpperCase();
  const liveDirNorm     = (liveDirection ?? '').toUpperCase();
  const sameDirection   = storedDirection && liveDirNorm && storedDirection === liveDirNorm;

  if (!liveRejected && sameDirection) {
    return withTradeLevels({
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
    });
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

  return withTradeLevels({
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
  });
}
