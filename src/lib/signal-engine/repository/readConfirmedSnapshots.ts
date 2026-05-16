// ════════════════════════════════════════════════════════════════
//  Confirmed Intraday Signal Snapshots — reader
//
//  All read sites that previously hit q365_signals via getActiveSignals
//  now go through here:
//    - GET /api/signals (action=top, action=all)
//    - GET /api/signals/freshness
//    - GET /api/signals/[id]
//    - GET /api/signals/stream (SSE)
//    - getIntelligenceSignals
//
//  This module returns ONLY rows that:
//    - status = 'ACTIVE'
//    - valid_until > NOW()
//
//  No BUY/SELL quota, no fixed-count split. Quality > quantity:
//  if 3 stocks qualify, 3 rows come back; if 0, 0.
//
//  Output rows match the legacy SignalRow contract the frontend reads
//  (tradingsymbol, direction, entry_price, …) plus the new snapshot
//  fields (profit_percent, loss_percent, expected_edge_percent,
//  win_probability, validation_gates_passed, valid_until, status).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { normalizeWinProbability } from '@/lib/signals/signalsResponseMapper';

export type SnapshotStatus =
  | 'ACTIVE'
  | 'TARGET_HIT'
  | 'STOP_LOSS_HIT'
  | 'INVALIDATED'
  | 'EXPIRED';

export interface ConfirmedSnapshotRow {
  id:                        number;
  source_signal_id:          number | null;
  /** Legacy alias for `symbol` so frontend tables keep working. */
  tradingsymbol:             string;
  symbol:                    string;
  exchange:                  string;
  direction:                 'BUY' | 'SELL';
  strategy:                  string | null;

  entry_price:               number;
  stop_loss:                 number;
  target1:                   number;
  target2:                   number | null;

  profit_percent:            number;
  loss_percent:              number;
  expected_edge_percent:     number;
  win_probability:           number;
  rr_ratio:                  number;
  /** Legacy alias of rr_ratio so existing UI cells keep rendering. */
  risk_reward:               number;

  confidence_score:          number;
  /** Legacy alias of confidence_score. */
  confidence:                number;
  final_score:               number | null;
  classification:            string | null;

  factor_scores:             Record<string, unknown> | null;
  explanation:               Record<string, unknown> | null;
  gate_details:              Record<string, unknown> | null;

  stress_survival_score:     number | null;
  live_valid:                boolean | null;
  rejection_codes:           string[];

  status:                    SnapshotStatus;
  confirmed_at:              string;
  valid_until:               string;
  status_changed_at:         string;
  invalidation_reason:       string | null;

  /** Convenience: the count of validation gates the snapshot passed. */
  validation_gates_passed:   number;
  /** Convenience: minutes remaining until valid_until. Negative if expired. */
  valid_minutes_remaining:   number;

  /** Always 'APPROVED_SIGNAL' for any row in this table by construction. */
  signal_status:             'APPROVED_SIGNAL';
  /** Always true — these rows passed every gate. UI compatibility. */
  approved:                  boolean;

  // ── Execution contract (consumed by API + stock detail page) ─────
  // execution_allowed reflects whether this row is currently tradable:
  //   - status = 'ACTIVE' AND valid_until > NOW() AND no invalidation
  // When false, rejection_reason carries the WHY (e.g. invalidation_reason
  // such as 'stop_loss_broken' or a live-engine veto). This is the
  // canonical contract the dashboard + stock detail page agree on; the
  // previous /api/signals shape only exposed signal_status which collapsed
  // every reject into the generic "No Trade" pill.
  execution_allowed:         boolean;
  rejection_reason:          string | null;

  // ── Maturity layer (frozen at promotion time) ────────────────────
  maturity_score:                   number | null;
  validation_cycles_passed:         number | null;
  signal_age_minutes_at_promotion:  number | null;
  conviction_level:                 'MEDIUM' | 'HIGH' | 'INSTITUTIONAL' | null;
  stability_passed:                 boolean | null;
  maturity_factors:                 Array<{ name: string; weight: number; raw: number; contribution: number }> | null;

  // Frontend liveness slots — populated by the route's enricher.
  livePrice?:                number | null;
  livePChange?:              number | null;
  liveSource?:               string | null;
  liveTickTs?:               number | null;
}

interface RawSnapshotRow {
  id:                        number;
  source_signal_id:          number | null;
  symbol:                    string;
  exchange:                  string;
  direction:                 string;
  strategy:                  string | null;
  entry_price:               string | number;
  stop_loss:                 string | number;
  target1:                   string | number;
  target2:                   string | number | null;
  profit_percent:            string | number;
  loss_percent:              string | number;
  expected_edge_percent:     string | number;
  win_probability:           string | number;
  rr_ratio:                  string | number;
  confidence_score:          number;
  final_score:               string | number | null;
  /** MATURATION_AUDIT_2026-05 — JOINed from the source q365_signals row
   *  via source_signal_id. The institutional Phase-4 score that does
   *  NOT decay; preferred over the snapshot's stored final_score for
   *  the wire output and the strict gate. Old snapshots promoted before
   *  the writer fix landed have a decayed final_score baked into the
   *  snapshot row; this column lets the reader correct them at read
   *  time. NULL when the source signal row is missing or its
   *  composite_final_score column was never populated by Phase 4. */
  source_composite_final_score: string | number | null;
  /** JOINed from the source q365_signals row — used as a final
   *  fallback when both snapshot.final_score and
   *  source_composite_final_score are NULL. confidence does NOT decay
   *  and is the closest stable proxy for the institutional score on
   *  rows whose Phase-4 column was never written. */
  source_confidence_score:      number | null;
  classification:            string | null;
  factor_scores_json:        unknown;
  explanation_json:          unknown;
  gate_details_json:         unknown;
  stress_survival_score:     string | number | null;
  live_valid:                number | null;
  rejection_codes_json:      unknown;
  status:                    SnapshotStatus;
  confirmed_at:              Date | string;
  valid_until:               Date | string;
  status_changed_at:         Date | string;
  invalidation_reason:       string | null;
  maturity_score:            string | number | null;
  validation_cycles_passed:  number | null;
  signal_age_minutes_at_promotion: number | null;
  conviction_level:          string | null;
  stability_passed:          number | null;
  maturity_factors_json:     unknown;
}

function toIso(v: Date | string): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    // MySQL returns 'YYYY-MM-DD HH:MM:SS' — normalise to ISO so the
    // frontend's Date.parse always works.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) {
      return v.replace(' ', 'T') + 'Z';
    }
    return v;
  }
  return new Date().toISOString();
}

function parseJsonObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch { return null; }
  }
  return null;
}

function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
    } catch { return []; }
  }
  return [];
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * MATURATION_AUDIT_2026-05 — institutional-score selector for the
 * confirmed-snapshot wire output.
 *
 * Resolves the score the strict gate / UI should compare against,
 * tolerating three layers of stale-data drift:
 *   1. Snapshots promoted BEFORE the writer fix landed have a decayed
 *      `final_score` baked into the snapshot row. Their source
 *      q365_signals row, however, still carries the un-decaying Phase-4
 *      `composite_final_score` — prefer it when present.
 *   2. Some snapshot rows lost their source signal (cleanup, manual
 *      delete) — composite is NULL. Fall back to the snapshot's stored
 *      final_score (which on post-fix promotions IS the institutional
 *      value, on pre-fix ones is decayed but is the only data we have).
 *   3. When BOTH are NULL, fall back to confidence — it doesn't decay
 *      and is the closest stable proxy. Better than serving 0.
 *
 * Returns the resolved score plus the provenance tag so the caller can
 * log which path won. Pure function — same inputs → same output.
 */
export interface ResolvedInstitutionalScore {
  score:      number | null;
  /** Which input contributed the value: 'composite' | 'snapshot' |
   *  'confidence' | 'none'. Null score → 'none'. */
  provenance: 'composite' | 'snapshot' | 'confidence' | 'none';
}
export function resolveInstitutionalFinalScore(
  sourceComposite:  number | null | string | undefined,
  snapshotFinal:    number | null | string | undefined,
  confidenceScore:  number | null | string | undefined,
): ResolvedInstitutionalScore {
  const composite = numOrNull(sourceComposite);
  if (composite != null) return { score: composite, provenance: 'composite' };
  const snapshot  = numOrNull(snapshotFinal);
  if (snapshot != null)  return { score: snapshot,  provenance: 'snapshot' };
  const confidence = numOrNull(confidenceScore);
  if (confidence != null) return { score: confidence, provenance: 'confidence' };
  return { score: null, provenance: 'none' };
}

function shapeRow(r: RawSnapshotRow): ConfirmedSnapshotRow {
  const direction: 'BUY' | 'SELL' = String(r.direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const rejectionCodes = parseStringArray(r.rejection_codes_json);
  const gateDetails    = parseJsonObject(r.gate_details_json);
  // Validation-gates-passed: 12 rejection-engine gates + 1 live-validation
  // gate. Subtract any rejection codes that survived (which on an ACTIVE
  // snapshot is almost always 0 — they're informational).
  const TOTAL_GATES = 13;
  const validationGatesPassed = Math.max(0, TOTAL_GATES - rejectionCodes.length);

  const validUntilIso = toIso(r.valid_until);
  const validUntilMs  = Date.parse(validUntilIso);
  const validMinutesRemaining = Number.isFinite(validUntilMs)
    ? Math.round((validUntilMs - Date.now()) / 60000)
    : 0;

  const rr = num(r.rr_ratio);
  const confidence = num(r.confidence_score);
  // MATURATION_AUDIT_2026-05 — resolve institutional final_score from
  // the source q365_signals row (preferred) before falling back to the
  // snapshot's own final_score column. Surfaces the un-decaying
  // Phase-4 composite even on snapshots promoted before the writer fix.
  const resolved = resolveInstitutionalFinalScore(
    r.source_composite_final_score,
    r.final_score,
    r.source_confidence_score ?? confidence,
  );

  return {
    id:                      r.id,
    source_signal_id:        r.source_signal_id,
    tradingsymbol:           r.symbol,
    symbol:                  r.symbol,
    exchange:                r.exchange,
    direction,
    strategy:                r.strategy,

    entry_price:             num(r.entry_price),
    stop_loss:               num(r.stop_loss),
    target1:                 num(r.target1),
    target2:                 r.target2 != null ? num(r.target2) : null,

    profit_percent:          num(r.profit_percent),
    loss_percent:            num(r.loss_percent),
    expected_edge_percent:   num(r.expected_edge_percent),
    // Spec INSTITUTIONAL §D — wire scale is 0..1. Confirmed snapshots
    // are written as fractions (estimateWinProbability), but legacy
    // rows / future writers may use 0..100. Force-collapse here so
    // downstream consumers (UI, /api/signals/[id]) never see >100.
    win_probability:         normalizeWinProbability(num(r.win_probability)) ?? 0,
    rr_ratio:                rr,
    risk_reward:             rr,

    confidence_score:        confidence,
    confidence:              confidence,
    final_score:             resolved.score,
    classification:          r.classification,

    factor_scores:           parseJsonObject(r.factor_scores_json),
    explanation:             parseJsonObject(r.explanation_json),
    gate_details:            gateDetails,

    stress_survival_score:   numOrNull(r.stress_survival_score),
    live_valid:              r.live_valid == null ? null : Number(r.live_valid) === 1,
    rejection_codes:         rejectionCodes,

    status:                  r.status,
    confirmed_at:            toIso(r.confirmed_at),
    valid_until:             validUntilIso,
    status_changed_at:       toIso(r.status_changed_at),
    invalidation_reason:     r.invalidation_reason,

    validation_gates_passed: validationGatesPassed,
    valid_minutes_remaining: validMinutesRemaining,

    signal_status:           'APPROVED_SIGNAL',
    approved:                true,

    // Execution contract: ACTIVE + non-expired + no invalidation ⇒ allowed.
    // Pulls the rejection reason from the row when blocked so the UI can
    // render a specific veto label (Liquidity Blocked / Risk Veto / etc.)
    // instead of the generic "No Trade".
    execution_allowed:       r.status === 'ACTIVE'
                              && validMinutesRemaining > 0
                              && !r.invalidation_reason,
    rejection_reason:        r.invalidation_reason
                              ?? (rejectionCodes.length > 0 ? rejectionCodes[0] : null),

    maturity_score:                  numOrNull(r.maturity_score),
    validation_cycles_passed:        r.validation_cycles_passed != null ? Number(r.validation_cycles_passed) : null,
    signal_age_minutes_at_promotion: r.signal_age_minutes_at_promotion != null ? Number(r.signal_age_minutes_at_promotion) : null,
    conviction_level:                (r.conviction_level === 'MEDIUM' || r.conviction_level === 'HIGH' || r.conviction_level === 'INSTITUTIONAL')
      ? r.conviction_level : null,
    stability_passed:                r.stability_passed == null ? null : Number(r.stability_passed) === 1,
    maturity_factors:                (() => {
      const v = r.maturity_factors_json;
      if (!v) return null;
      if (Array.isArray(v)) return v as ConfirmedSnapshotRow['maturity_factors'];
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
      }
      return null;
    })(),
  };
}

// ════════════════════════════════════════════════════════════════
//  Public API
// ════════════════════════════════════════════════════════════════

export interface GetActiveConfirmedSnapshotsOpts {
  limit?:     number;
  /** Filter to a single direction (uppercase). Omit for both. */
  direction?: 'BUY' | 'SELL';
}

/**
 * Active confirmed snapshots — the canonical "what's tradeable right
 * now" pool. ORDER BY final_score DESC then confidence DESC then
 * confirmed_at DESC so the highest-conviction recent snapshots float
 * to the top. No BUY/SELL quota, no fixed minimum count.
 */
export async function getActiveConfirmedSnapshots(
  opts: GetActiveConfirmedSnapshotsOpts = {},
): Promise<ConfirmedSnapshotRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const params: any[] = [];
  // Reader-side classification filter — defence-in-depth. The writer
  // now refuses to insert rows whose classification is not in
  // MAIN_TABLE_CLASSIFICATIONS, but legacy rows promoted before that
  // gate existed can still sit in the table with classification =
  // DEVELOPING_SETUP / WATCHLIST_ONLY / NO_TRADE. Without this WHERE
  // clause those rows would still surface in the main grid and
  // render "Developing" in the Class column. The IN-list mirrors
  // MAIN_TABLE_CLASSIFICATIONS in phase12Routing.ts; keep the two
  // in sync if you add a new label.
  let where = `s.status = 'ACTIVE'
         AND s.valid_until > NOW()
         AND UPPER(s.classification) IN (
               'INSTITUTIONAL_HIGH_CONVICTION',
               'HIGH_CONVICTION',
               'VALID_SIGNAL',
               'HIGH_CONVICTION_BUY',
               'VALID_BUY'
             )`;
  if (opts.direction === 'BUY' || opts.direction === 'SELL') {
    where += ' AND s.direction = ?';
    params.push(opts.direction);
  }
  params.push(limit);

  // Bug fix — confirmed-snapshot rows often carry NULL maturity-tracker
  // columns (older promotions copied them through inconsistently). The
  // q365_signal_maturity_tracker table is the live source of truth for
  // maturity / cycles / conviction / stability, so LEFT JOIN it and
  // COALESCE in case the snapshot's own column is NULL. The dashboard
  // columns (Cycles / Conviction / Stable / Maturity) now always show
  // real values when ANY row in either table has them populated.
  try {
    const result = await db.query<RawSnapshotRow>(
      `SELECT s.id, s.source_signal_id, s.symbol, s.exchange, s.direction, s.strategy,
              s.entry_price, s.stop_loss, s.target1, s.target2,
              s.profit_percent, s.loss_percent, s.expected_edge_percent,
              s.win_probability, s.rr_ratio,
              s.confidence_score, s.final_score, s.classification,
              -- MATURATION_AUDIT_2026-05 — pull the un-decaying Phase-4
              -- composite + the source confidence so the wire output
              -- can prefer the institutional value over the snapshot's
              -- (possibly decayed) stored final_score. resolves stale
              -- snapshots promoted before the writer fix landed.
              q.composite_final_score AS source_composite_final_score,
              q.confidence_score      AS source_confidence_score,
              s.factor_scores_json, s.explanation_json, s.gate_details_json,
              s.stress_survival_score, s.live_valid, s.rejection_codes_json,
              s.status, s.confirmed_at, s.valid_until, s.status_changed_at, s.invalidation_reason,
              COALESCE(s.maturity_score,           mt.maturity_score)           AS maturity_score,
              COALESCE(s.validation_cycles_passed, mt.validation_cycles_passed) AS validation_cycles_passed,
              s.signal_age_minutes_at_promotion,
              COALESCE(s.conviction_level,         mt.conviction_level)         AS conviction_level,
              COALESCE(s.stability_passed,         mt.stable)                   AS stability_passed,
              s.maturity_factors_json
         FROM q365_confirmed_signal_snapshots s
         LEFT JOIN q365_signal_maturity_tracker mt
           ON  mt.symbol    = s.symbol
           AND mt.direction = s.direction
         LEFT JOIN q365_signals q
           ON  q.id = s.source_signal_id
        WHERE ${where}
        ORDER BY COALESCE(q.composite_final_score, s.final_score, s.confidence_score, 0) DESC,
                 s.confidence_score DESC,
                 s.confirmed_at DESC,
                 s.id ASC
        LIMIT ?`,
      params,
    );
    const raw = result.rows as RawSnapshotRow[];
    // MATURATION_AUDIT_2026-05 — score-provenance histogram. Tells the
    // operator at a glance which path won the institutional score for
    // each row: composite (Phase-4, ideal), snapshot (the row's own
    // stored final_score — likely decayed on pre-fix promotions), or
    // confidence (last-resort fallback). A healthy steady state shows
    // composite dominating; large `snapshot` counts mean stale rows are
    // still being served and the user should run a backfill.
    if (raw.length > 0) {
      const provHist: Record<string, number> = { composite: 0, snapshot: 0, confidence: 0, none: 0 };
      const stuckRows: Array<{ symbol: string; snap: number | null; comp: number | null }> = [];
      for (const r of raw) {
        const resolved = resolveInstitutionalFinalScore(
          r.source_composite_final_score,
          r.final_score,
          r.source_confidence_score ?? r.confidence_score,
        );
        provHist[resolved.provenance] = (provHist[resolved.provenance] ?? 0) + 1;
        // Flag rows where the snapshot's stored final_score looks
        // decayed relative to the source signal's composite — those
        // are the rows the JOIN-fix is rescuing this request.
        const snap = numOrNull(r.final_score);
        const comp = numOrNull(r.source_composite_final_score);
        if (snap != null && comp != null && comp - snap > 5) {
          stuckRows.push({ symbol: r.symbol, snap, comp });
        }
      }
      console.log('[SCORE_PROVENANCE]', {
        scope:           'getActiveConfirmedSnapshots',
        rows:            raw.length,
        provenance:      provHist,
        rescued_count:   stuckRows.length,
        rescued_sample:  stuckRows.slice(0, 5),
      });
    }
    return raw.map(shapeRow);
  } catch (err: any) {
    // Table missing on a fresh DB pre-migration. Return empty rather
    // than 500 — the migration will create it on next boot.
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) {
      console.warn('[readConfirmedSnapshots] table missing — returning [] (run migrateSignalEngine)');
      return [];
    }
    throw err;
  }
}

/** Single-row lookup. Returns null if the snapshot doesn't exist. */
export async function getConfirmedSnapshotById(
  id: number,
): Promise<ConfirmedSnapshotRow | null> {
  try {
    // Bug fix — same tracker JOIN as getActiveConfirmedSnapshots so
    // single-row lookups also surface real maturity / cycles /
    // conviction / stability values when the snapshot column is NULL.
    const result = await db.query<RawSnapshotRow>(
      `SELECT s.id, s.source_signal_id, s.symbol, s.exchange, s.direction, s.strategy,
              s.entry_price, s.stop_loss, s.target1, s.target2,
              s.profit_percent, s.loss_percent, s.expected_edge_percent,
              s.win_probability, s.rr_ratio,
              s.confidence_score, s.final_score, s.classification,
              -- MATURATION_AUDIT_2026-05 — pull the un-decaying Phase-4
              -- composite + the source confidence so the wire output
              -- can prefer the institutional value over the snapshot's
              -- (possibly decayed) stored final_score. resolves stale
              -- snapshots promoted before the writer fix landed.
              q.composite_final_score AS source_composite_final_score,
              q.confidence_score      AS source_confidence_score,
              s.factor_scores_json, s.explanation_json, s.gate_details_json,
              s.stress_survival_score, s.live_valid, s.rejection_codes_json,
              s.status, s.confirmed_at, s.valid_until, s.status_changed_at, s.invalidation_reason,
              COALESCE(s.maturity_score,           mt.maturity_score)           AS maturity_score,
              COALESCE(s.validation_cycles_passed, mt.validation_cycles_passed) AS validation_cycles_passed,
              s.signal_age_minutes_at_promotion,
              COALESCE(s.conviction_level,         mt.conviction_level)         AS conviction_level,
              COALESCE(s.stability_passed,         mt.stable)                   AS stability_passed,
              s.maturity_factors_json
         FROM q365_confirmed_signal_snapshots s
         LEFT JOIN q365_signal_maturity_tracker mt
           ON  mt.symbol    = s.symbol
           AND mt.direction = s.direction
         LEFT JOIN q365_signals q
           ON  q.id = s.source_signal_id
        WHERE s.id = ?
        LIMIT 1`,
      [id],
    );
    const row = (result.rows as RawSnapshotRow[])[0];
    return row ? shapeRow(row) : null;
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) return null;
    throw err;
  }
}

/**
 * Latest ACTIVE snapshot for a (symbol, direction) pair — used by the
 * /api/signals/[id] endpoint when the caller passes a symbol-derived
 * key rather than a snapshot id.
 */
export async function getLatestActiveSnapshotBySymbol(
  symbol: string,
  direction?: 'BUY' | 'SELL',
): Promise<ConfirmedSnapshotRow | null> {
  const params: any[] = [symbol.toUpperCase()];
  let where = `s.symbol = ? AND s.status = 'ACTIVE' AND s.valid_until > NOW()`;
  if (direction) {
    where += ` AND s.direction = ?`;
    params.push(direction);
  }
  try {
    // Bug fix — same tracker JOIN as the other readers so symbol
    // lookups also surface real tracker values when the snapshot
    // column is NULL.
    const result = await db.query<RawSnapshotRow>(
      `SELECT s.id, s.source_signal_id, s.symbol, s.exchange, s.direction, s.strategy,
              s.entry_price, s.stop_loss, s.target1, s.target2,
              s.profit_percent, s.loss_percent, s.expected_edge_percent,
              s.win_probability, s.rr_ratio,
              s.confidence_score, s.final_score, s.classification,
              -- MATURATION_AUDIT_2026-05 — pull the un-decaying Phase-4
              -- composite + the source confidence so the wire output
              -- can prefer the institutional value over the snapshot's
              -- (possibly decayed) stored final_score. resolves stale
              -- snapshots promoted before the writer fix landed.
              q.composite_final_score AS source_composite_final_score,
              q.confidence_score      AS source_confidence_score,
              s.factor_scores_json, s.explanation_json, s.gate_details_json,
              s.stress_survival_score, s.live_valid, s.rejection_codes_json,
              s.status, s.confirmed_at, s.valid_until, s.status_changed_at, s.invalidation_reason,
              COALESCE(s.maturity_score,           mt.maturity_score)           AS maturity_score,
              COALESCE(s.validation_cycles_passed, mt.validation_cycles_passed) AS validation_cycles_passed,
              s.signal_age_minutes_at_promotion,
              COALESCE(s.conviction_level,         mt.conviction_level)         AS conviction_level,
              COALESCE(s.stability_passed,         mt.stable)                   AS stability_passed,
              s.maturity_factors_json
         FROM q365_confirmed_signal_snapshots s
         LEFT JOIN q365_signal_maturity_tracker mt
           ON  mt.symbol    = s.symbol
           AND mt.direction = s.direction
         LEFT JOIN q365_signals q
           ON  q.id = s.source_signal_id
        WHERE ${where}
        ORDER BY s.confirmed_at DESC
        LIMIT 1`,
      params,
    );
    const row = (result.rows as RawSnapshotRow[])[0];
    return row ? shapeRow(row) : null;
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) return null;
    throw err;
  }
}

/**
 * Lightweight freshness probe — last confirmation timestamp + active
 * count. Replaces the q365_signals batch-freshness probe used by the
 * dashboard banner.
 */
export async function getConfirmedSnapshotFreshness(): Promise<{
  latest_confirmed_at: string | null;
  latest_confirmed_ms: number | null;
  active_count:        number;
  total_lifetime:      number;
}> {
  try {
    const [latestRes, activeRes, lifetimeRes] = await Promise.all([
      db.query<{ ts: number | null }>(
        `SELECT UNIX_TIMESTAMP(MAX(confirmed_at)) AS ts
           FROM q365_confirmed_signal_snapshots`,
      ),
      db.query<{ c: number }>(
        `SELECT COUNT(*) AS c
           FROM q365_confirmed_signal_snapshots
          WHERE status = 'ACTIVE' AND valid_until > NOW()`,
      ),
      db.query<{ c: number }>(
        `SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots`,
      ),
    ]);
    const ms = latestRes.rows[0]?.ts != null
      ? Number(latestRes.rows[0].ts) * 1000
      : null;
    return {
      latest_confirmed_at: ms ? new Date(ms).toISOString() : null,
      latest_confirmed_ms: ms,
      active_count:        Number(activeRes.rows[0]?.c ?? 0),
      total_lifetime:      Number(lifetimeRes.rows[0]?.c ?? 0),
    };
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) {
      return { latest_confirmed_at: null, latest_confirmed_ms: null, active_count: 0, total_lifetime: 0 };
    }
    return { latest_confirmed_at: null, latest_confirmed_ms: null, active_count: 0, total_lifetime: 0 };
  }
}

/**
 * 7-day stats window — count of snapshots by terminal status. Used by
 * the existing ?action=stats endpoint to keep the dashboard summary
 * card alive after the read-source switch.
 */
export async function getConfirmedSnapshotStats(): Promise<{
  overview: {
    total:         number;
    active:        number;
    target_hit:    number;
    stop_loss_hit: number;
    invalidated:   number;
    expired:       number;
    avg_confidence: number;
    avg_rr:        number;
    avg_edge:      number;
  };
  by_classification: Array<{ classification: string; count: number }>;
}> {
  try {
    const [overviewRes, classRes] = await Promise.all([
      db.query(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status='ACTIVE'        THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status='TARGET_HIT'    THEN 1 ELSE 0 END) AS target_hit,
               SUM(CASE WHEN status='STOP_LOSS_HIT' THEN 1 ELSE 0 END) AS stop_loss_hit,
               SUM(CASE WHEN status='INVALIDATED'   THEN 1 ELSE 0 END) AS invalidated,
               SUM(CASE WHEN status='EXPIRED'       THEN 1 ELSE 0 END) AS expired,
               AVG(confidence_score)         AS avg_conf,
               AVG(rr_ratio)                 AS avg_rr,
               AVG(expected_edge_percent)    AS avg_edge
          FROM q365_confirmed_signal_snapshots
         WHERE confirmed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      `),
      db.query(`
        SELECT COALESCE(classification, 'UNCLASSIFIED') AS classification,
               COUNT(*) AS count
          FROM q365_confirmed_signal_snapshots
         WHERE confirmed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
         GROUP BY classification
         ORDER BY count DESC
      `),
    ]);
    const r = (overviewRes.rows[0] as any) ?? {};
    return {
      overview: {
        total:          Number(r.total ?? 0),
        active:         Number(r.active ?? 0),
        target_hit:     Number(r.target_hit ?? 0),
        stop_loss_hit:  Number(r.stop_loss_hit ?? 0),
        invalidated:    Number(r.invalidated ?? 0),
        expired:        Number(r.expired ?? 0),
        avg_confidence: r.avg_conf != null ? Math.round(Number(r.avg_conf)) : 0,
        avg_rr:         r.avg_rr   != null ? Math.round(Number(r.avg_rr) * 10) / 10 : 0,
        avg_edge:       r.avg_edge != null ? Math.round(Number(r.avg_edge) * 100) / 100 : 0,
      },
      by_classification: ((classRes.rows as any[]) ?? []).map((c) => ({
        classification: c.classification ?? 'UNCLASSIFIED',
        count:          Number(c.count ?? 0),
      })),
    };
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) {
      return {
        overview: { total: 0, active: 0, target_hit: 0, stop_loss_hit: 0, invalidated: 0, expired: 0, avg_confidence: 0, avg_rr: 0, avg_edge: 0 },
        by_classification: [],
      };
    }
    throw err;
  }
}
