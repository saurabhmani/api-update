// ════════════════════════════════════════════════════════════════
//  Confirmed Intraday Signal Snapshots — writer
//
//  The two-layer split:
//    Layer 1 — q365_signals (the live scanner). Mutates every batch.
//    Layer 2 — q365_confirmed_signal_snapshots (this module). Locked
//              snapshot of a fully-validated signal at the moment it
//              cleared every gate. Insert-once for content; only
//              `status`, `status_changed_at`, `invalidation_reason`
//              ever change after insert (driven by the lifecycle
//              worker — see src/lib/cron/confirmedSnapshotLifecycle.ts).
//
//  Insertion contract (every condition must hold):
//    - The source row in q365_signals exists and INSERT succeeded
//      (we have a numeric signal_id to back-reference).
//    - signal_status === 'APPROVED_SIGNAL' (set by saveSignals when
//      the rejection engine accepted the signal).
//    - live_valid !== false (the Phase-8 live gate did not reject).
//    - rr_ratio >= MIN_RR_RATIO (default 2.0).
//    - confidence_score >= MIN_CONFIDENCE.
//    - final_score (when present) >= MIN_FINAL_SCORE.
//    - expected_edge_percent > MIN_EXPECTED_EDGE_PCT.
//    - validation_cycles_passed >= MIN_VALIDATION_CYCLES (3).
//    - maturity_score >= MIN_MATURITY_SCORE (85).
//    - No ACTIVE snapshot already exists for (symbol, direction)
//      with valid_until > NOW(). If one does, we keep the existing
//      frozen signal and the new one is silently skipped — that is
//      the "must not change every refresh" rule.
//
//  Validity window:
//    - 90 minutes default.
//    - Override via CONFIRMED_SNAPSHOT_VALIDITY_MINUTES env, clamped
//      to [60, 120].
//
//  This file deliberately has zero coupling to QuantSignal — it
//  takes the fields it needs as inputs so saveSignals can call it
//  with already-reconciled values (live LTP, recalculated stop /
//  target). That keeps the writer testable and reusable.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { MAIN_TABLE_CLASSIFICATIONS } from '@/lib/signal-engine/pipeline/phase12Routing';

// ── Tunables ─────────────────────────────────────────────────────
//
// Validity window for confirmed snapshots. Default 90 minutes — a
// "BUY at price X with stop Y" trade idea is most actionable while
// the live tape is still close to the entry. Beyond ~2 hours the
// price has typically moved enough that the original stop / target
// no longer reflect the setup.
//
// The MAX ceiling was raised 120 → 1440 (24h) per spec "FIX ZERO
// SIGNALS" §3 so operators on slower cadences (manual review,
// off-hours backtesting harness) can extend via
// CONFIRMED_SNAPSHOT_VALIDITY_MINUTES. **Setting this above 120 in
// production is a trading decision** — long validity means the row
// stays "ACTIVE" through price moves the original setup didn't
// anticipate. The default is unchanged so this only kicks in when
// an operator explicitly opts in.
const VALIDITY_MIN = 60;
const VALIDITY_MAX = 1440;
const VALIDITY_DEFAULT = 90;

// Promotion floors — calibrated 2026-05 to match the institutional
// response-layer spec. The original V2.10 floors (80/75/2.2/88) were
// 25 points stricter than the response-layer reads, so the maturity
// worker would correctly identify a tracker as promotable but the
// writer would silently reject the insert — leaving
// q365_confirmed_signal_snapshots permanently empty.
//
// New defaults (env-overridable, clamped to safe bands):
//   MIN_RR_RATIO            1.5  (was 2.2)
//   MIN_CONFIDENCE          55   (was 80)
//   MIN_FINAL_SCORE         60   (was 75)
//   MIN_EXPECTED_EDGE_PCT   1.0  (was 2.0)
//   MIN_VALIDATION_CYCLES   2    (was 3)  — still > 1 (single detection)
//   MIN_MATURITY_SCORE      70   (was 88) — well above STAGE_MATURE
//
// Operators who want the prior strict band can re-export:
//   PROMOTE_MIN_CONFIDENCE=80
//   PROMOTE_MIN_FINAL_SCORE=75
//   PROMOTE_MIN_RR=2.2
//   PROMOTE_MIN_EDGE_PCT=2.0
//   PROMOTE_MIN_CYCLES=3
//   PROMOTE_MIN_MATURITY=88
function envFloor(name: string, fallback: number, lo: number, hi: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}
const MIN_RR_RATIO          = envFloor('PROMOTE_MIN_RR',          1.5, 0.5,   5);
const MIN_CONFIDENCE        = envFloor('PROMOTE_MIN_CONFIDENCE',  55,    0, 100);
const MIN_FINAL_SCORE       = envFloor('PROMOTE_MIN_FINAL_SCORE', 60,    0, 100);
const MIN_EXPECTED_EDGE_PCT = envFloor('PROMOTE_MIN_EDGE_PCT',    1.0,   0,  20);
const MIN_VALIDATION_CYCLES = envFloor('PROMOTE_MIN_CYCLES',      2,     1,  20);
const MIN_MATURITY_SCORE    = envFloor('PROMOTE_MIN_MATURITY',    70,    0, 100);

function resolveValidityMinutes(): number {
  const raw = Number(process.env.CONFIRMED_SNAPSHOT_VALIDITY_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return VALIDITY_DEFAULT;
  return Math.max(VALIDITY_MIN, Math.min(VALIDITY_MAX, Math.floor(raw)));
}

function toMysqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ── Public types ─────────────────────────────────────────────────
export type SnapshotStatus =
  | 'ACTIVE'
  | 'TARGET_HIT'
  | 'STOP_LOSS_HIT'
  | 'INVALIDATED'
  | 'EXPIRED';

export interface SnapshotInsertInput {
  /** ID of the row in q365_signals that this snapshot is locking. */
  source_signal_id:   number;
  symbol:             string;
  exchange:           string;
  direction:          'BUY' | 'SELL';
  /** Strategy / scenario tag (e.g. BREAKOUT_CONTINUATION). Optional. */
  strategy?:          string | null;

  entry_price:        number;
  stop_loss:          number;
  target1:            number;
  target2?:           number | null;

  confidence_score:   number;
  final_score?:       number | null;
  classification?:    string | null;
  signal_status:      string;
  /** True/false from Phase-8 live validation; null means unknown. */
  live_valid?:        boolean | null;

  factor_scores?:     unknown;
  explanation?:       unknown;
  gate_details?:      unknown;
  rejection_codes?:   string[] | null;
  stress_survival_score?: number | null;

  /** Maturity layer — set at promotion time by the maturity worker.
   *  These fields are frozen with the rest of the snapshot. */
  maturity_score?:                   number | null;
  validation_cycles_passed?:         number | null;
  signal_age_minutes_at_promotion?:  number | null;
  conviction_level?:                 'MEDIUM' | 'HIGH' | 'INSTITUTIONAL' | null;
  stability_passed?:                 boolean | null;
  maturity_factors?:                 unknown;
}

export interface SnapshotInsertResult {
  inserted:    boolean;
  snapshot_id: number | null;
  /** Why we didn't insert (only set when inserted=false). */
  reason?:
    | 'not_approved'
    | 'wrong_classification'
    | 'live_invalid'
    | 'low_rr'
    | 'low_confidence'
    | 'low_final_score'
    | 'no_edge'
    | 'low_cycles'
    | 'low_maturity'
    | 'duplicate_active'
    | 'invalid_prices'
    | 'db_error';
}

// ── Derived fields ───────────────────────────────────────────────
/**
 * Profit %, Loss %, RR — direction-aware.
 * For a BUY, profit = (target1 - entry) / entry, loss = (entry - stop) / entry.
 * For a SELL, profit = (entry - target1) / entry, loss = (stop - entry) / entry.
 * Both are returned as positive numbers when the trade plan is sane.
 */
function computeProfitLossPct(
  direction: 'BUY' | 'SELL',
  entry: number,
  stop:  number,
  target: number,
): { profitPct: number; lossPct: number } {
  if (!isFinite(entry) || entry <= 0) return { profitPct: 0, lossPct: 0 };
  const isBuy = direction === 'BUY';
  const profit = isBuy ? target - entry : entry - target;
  const loss   = isBuy ? entry - stop   : stop  - entry;
  const profitPct = (profit / entry) * 100;
  const lossPct   = (loss   / entry) * 100;
  return {
    profitPct: Number.isFinite(profitPct) ? profitPct : 0,
    lossPct:   Number.isFinite(lossPct)   ? lossPct   : 0,
  };
}

/**
 * Win-probability heuristic from confidence + final scores. We don't
 * have a calibrated probability model in the codebase — confidence is
 * the closest proxy. Map [0..100] confidence into [0.40..0.80] win
 * probability, blended with final_score when available so a high-
 * confidence row whose final_score has decayed gets a slightly lower
 * estimate. This is intentionally a soft mapping; the lifecycle
 * worker is what tells us the true outcome.
 */
function estimateWinProbability(
  confidence: number,
  finalScore: number | null,
): number {
  const conf = Math.max(0, Math.min(100, Number(confidence) || 0));
  const fs   = finalScore != null && Number.isFinite(finalScore)
    ? Math.max(0, Math.min(100, finalScore))
    : conf;
  const blended = 0.6 * conf + 0.4 * fs;
  // Map 0..100 → 0.40..0.80
  const p = 0.40 + (blended / 100) * 0.40;
  return Math.round(p * 1000) / 1000;
}

/**
 * Expected edge = winProb * profitPct - (1 - winProb) * lossPct.
 * Positive => insertable. Negative => skip (the trade plan is
 * adversely skewed even given the win-probability estimate).
 */
function computeExpectedEdge(
  winProb: number,
  profitPct: number,
  lossPct: number,
): number {
  const edge = winProb * profitPct - (1 - winProb) * lossPct;
  return Number.isFinite(edge) ? edge : 0;
}

// ── Public API ───────────────────────────────────────────────────
export async function insertConfirmedSnapshotIfEligible(
  input: SnapshotInsertInput,
): Promise<SnapshotInsertResult> {
  // Spec INSTITUTIONAL §J — every refusal is now logged with the gate
  // that fired and the offending value. The previous silent-skip path
  // produced empty q365_confirmed_signal_snapshots with no diagnostic
  // trail; operators had to reverse-engineer which gate dropped each
  // row. The reject() helper centralises the [PERSIST_FAILED] line.
  const reject = (
    reason: NonNullable<SnapshotInsertResult['reason']>,
    detail: string,
  ): SnapshotInsertResult => {
    // PROMOTION-AUDIT (2026-05) — emit BOTH legacy and new grep tags
    // so dashboards / ops scripts written against either name keep
    // working. [PERSIST_FAILED] is the older symbol; [PROMOTION_BLOCK]
    // is the canonical institutional-audit name in the SRE runbook.
    console.warn(
      `[PERSIST_FAILED] table=q365_confirmed_signal_snapshots ` +
      `symbol=${input.symbol} dir=${input.direction} reason=${reason} ${detail}`,
    );
    console.warn(
      `[PROMOTION_BLOCK] table=q365_confirmed_signal_snapshots ` +
      `symbol=${input.symbol} dir=${input.direction} reason=${reason} ` +
      `cls=${input.classification ?? 'null'} conf=${input.confidence_score} ` +
      `final=${input.final_score ?? 'null'} maturity=${input.maturity_score ?? 'null'} ` +
      `cycles=${input.validation_cycles_passed ?? 'null'} ${detail}`,
    );
    return { inserted: false, snapshot_id: null, reason };
  };
  console.log(
    `[PERSIST_ATTEMPT] table=q365_confirmed_signal_snapshots ` +
    `symbol=${input.symbol} dir=${input.direction} ` +
    `cls=${input.classification ?? 'null'} ` +
    `conf=${input.confidence_score} final=${input.final_score ?? 'null'} ` +
    `cycles=${input.validation_cycles_passed ?? 'null'} ` +
    `maturity=${input.maturity_score ?? 'null'} ` +
    `live_valid=${input.live_valid ?? 'null'}`,
  );

  // 1. Gate checks — every one is a hard skip with a [PERSIST_FAILED] log.
  if (input.signal_status !== 'APPROVED_SIGNAL') {
    return reject('not_approved', `signal_status=${input.signal_status}`);
  }
  // Classification gate — defence-in-depth.
  //
  // Why this exists: signal_status === 'APPROVED_SIGNAL' should imply
  // that classification ∈ MAIN_TABLE_CLASSIFICATIONS, but the upstream
  // pipeline can produce internally-contradictory rows where the
  // rejection engine accepts the signal yet the classification engine
  // labels it DEVELOPING_SETUP / WATCHLIST_ONLY / NO_TRADE. Without
  // this gate, those rows promote into q365_confirmed_signal_snapshots
  // and the dashboard renders "Developing" in the Class column of the
  // main BUY/SELL grid — exactly the failure mode the two-layer
  // architecture is supposed to prevent. A confirmed snapshot must
  // have a main-table-eligible classification, or it is not confirmed.
  const klass = String(input.classification ?? '').toUpperCase();
  if (!MAIN_TABLE_CLASSIFICATIONS.has(klass)) {
    return reject(
      'wrong_classification',
      `classification=${klass || '(empty)'} not in {${[...MAIN_TABLE_CLASSIFICATIONS].join(', ')}}`,
    );
  }
  if (input.live_valid === false) {
    return reject('live_invalid', 'live_valid=false');
  }
  if (!Number.isFinite(input.entry_price) || input.entry_price <= 0
   || !Number.isFinite(input.stop_loss)   || input.stop_loss   <= 0
   || !Number.isFinite(input.target1)     || input.target1     <= 0) {
    return reject(
      'invalid_prices',
      `entry=${input.entry_price} stop=${input.stop_loss} target=${input.target1}`,
    );
  }
  if (input.confidence_score < MIN_CONFIDENCE) {
    return reject(
      'low_confidence',
      `${input.confidence_score} < ${MIN_CONFIDENCE} (PROMOTE_MIN_CONFIDENCE)`,
    );
  }
  if (input.final_score != null && Number(input.final_score) < MIN_FINAL_SCORE) {
    return reject(
      'low_final_score',
      `${input.final_score} < ${MIN_FINAL_SCORE} (PROMOTE_MIN_FINAL_SCORE)`,
    );
  }

  // Maturity gates — must clear BOTH cycles and score floors before we
  // freeze a snapshot. Null is treated as a fail (we will not promote a
  // row whose maturity layer wasn't computed at all).
  const cycles = Number(input.validation_cycles_passed ?? 0);
  if (!Number.isFinite(cycles) || cycles < MIN_VALIDATION_CYCLES) {
    return reject('low_cycles', `${input.validation_cycles_passed} < ${MIN_VALIDATION_CYCLES} (PROMOTE_MIN_CYCLES)`);
  }
  const maturity = input.maturity_score == null ? NaN : Number(input.maturity_score);
  if (!Number.isFinite(maturity) || maturity < MIN_MATURITY_SCORE) {
    return reject('low_maturity', `${input.maturity_score} < ${MIN_MATURITY_SCORE} (PROMOTE_MIN_MATURITY)`);
  }

  const { profitPct, lossPct } = computeProfitLossPct(
    input.direction, input.entry_price, input.stop_loss, input.target1,
  );
  if (lossPct <= 0 || profitPct <= 0) {
    return reject('invalid_prices', `profitPct=${profitPct.toFixed(2)} lossPct=${lossPct.toFixed(2)}`);
  }
  const rrRatio = profitPct / lossPct;
  if (rrRatio < MIN_RR_RATIO) {
    return reject('low_rr', `${rrRatio.toFixed(2)} < ${MIN_RR_RATIO} (PROMOTE_MIN_RR)`);
  }

  const winProb = estimateWinProbability(input.confidence_score, input.final_score ?? null);
  const expectedEdge = computeExpectedEdge(winProb, profitPct, lossPct);
  if (expectedEdge <= MIN_EXPECTED_EDGE_PCT) {
    return reject('no_edge', `edge=${expectedEdge.toFixed(2)} <= ${MIN_EXPECTED_EDGE_PCT} (PROMOTE_MIN_EDGE_PCT)`);
  }

  // 2. Duplicate protection — symbol+direction with active validity wins.
  try {
    const dup = await db.query<{ id: number }>(
      `SELECT id FROM q365_confirmed_signal_snapshots
        WHERE symbol = ?
          AND direction = ?
          AND status = 'ACTIVE'
          AND valid_until > NOW()
        LIMIT 1`,
      [input.symbol.toUpperCase(), input.direction],
    );
    if (((dup.rows as any[]) ?? []).length > 0) {
      return reject('duplicate_active', `existing ACTIVE snapshot for ${input.symbol} ${input.direction}`);
    }
  } catch (err: any) {
    // Best-effort — if the lookup fails (e.g. table missing on a fresh
    // DB), let the INSERT itself surface the real error below.
    console.warn('[confirmedSnapshots] duplicate check failed:', err?.message);
  }

  // 3. Compose insert payload.
  const validityMin   = resolveValidityMinutes();
  const now           = new Date();
  const validUntil    = new Date(now.getTime() + validityMin * 60 * 1000);
  const liveValidInt  =
    input.live_valid === true  ? 1 :
    input.live_valid === false ? 0 :
    null;
  const factorScoresJson = input.factor_scores != null
    ? JSON.stringify(input.factor_scores, (_k, v) => Number.isFinite(v) ? v : null)
    : null;
  const explanationJson = input.explanation != null
    ? JSON.stringify(input.explanation)
    : null;
  const gateDetailsJson = input.gate_details != null
    ? JSON.stringify(input.gate_details)
    : null;
  const rejectionCodesJson = input.rejection_codes && input.rejection_codes.length > 0
    ? JSON.stringify(input.rejection_codes)
    : null;
  const maturityFactorsJson = input.maturity_factors != null
    ? JSON.stringify(input.maturity_factors)
    : null;

  try {
    const result: any = await db.query(
      `INSERT INTO q365_confirmed_signal_snapshots
        (source_signal_id, symbol, exchange, direction, strategy,
         entry_price, stop_loss, target1, target2,
         profit_percent, loss_percent, expected_edge_percent,
         win_probability, rr_ratio,
         confidence_score, final_score, classification,
         factor_scores_json, explanation_json, gate_details_json,
         stress_survival_score, live_valid, rejection_codes_json,
         status, confirmed_at, valid_until, status_changed_at,
         maturity_score, validation_cycles_passed,
         signal_age_minutes_at_promotion, conviction_level,
         stability_passed, maturity_factors_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.source_signal_id,
        input.symbol.toUpperCase(),
        input.exchange,
        input.direction,
        input.strategy ?? null,
        input.entry_price,
        input.stop_loss,
        input.target1,
        input.target2 ?? null,
        round4(profitPct),
        round4(lossPct),
        round4(expectedEdge),
        winProb,
        round2(rrRatio),
        input.confidence_score,
        input.final_score ?? null,
        input.classification ?? null,
        factorScoresJson,
        explanationJson,
        gateDetailsJson,
        input.stress_survival_score ?? null,
        liveValidInt,
        rejectionCodesJson,
        toMysqlDateTime(now),
        toMysqlDateTime(validUntil),
        toMysqlDateTime(now),
        input.maturity_score ?? null,
        input.validation_cycles_passed ?? null,
        input.signal_age_minutes_at_promotion ?? null,
        input.conviction_level ?? null,
        input.stability_passed == null
          ? null
          : (input.stability_passed ? 1 : 0),
        maturityFactorsJson,
      ],
    );

    const snapshotId = Number(result?.insertId ?? 0);
    if (!snapshotId) {
      return reject('db_error', 'INSERT returned no insertId');
    }
    console.log(
      `[SNAPSHOT_WRITE] table=q365_confirmed_signal_snapshots ` +
      `id=${snapshotId} symbol=${input.symbol} dir=${input.direction} ` +
      `cls=${input.classification ?? 'null'} conf=${input.confidence_score} ` +
      `final=${input.final_score ?? 'null'} rr=${round2(rrRatio)} ` +
      `edge=${round4(expectedEdge)} valid_until=${toMysqlDateTime(validUntil)}`,
    );
    console.log(
      `[PERSIST_SUCCESS] table=q365_confirmed_signal_snapshots ` +
      `symbol=${input.symbol} dir=${input.direction} id=${snapshotId}`,
    );
    // PROMOTION-AUDIT (2026-05) — canonical institutional-audit log.
    // Mirrors [PERSIST_SUCCESS]; emitted under the runbook-grep name so
    // operators searching `[PROMOTION_SUCCESS]` see every confirmed
    // promotion event without combing through PERSIST_*.
    console.log(
      `[PROMOTION_SUCCESS] table=q365_confirmed_signal_snapshots ` +
      `id=${snapshotId} symbol=${input.symbol} dir=${input.direction} ` +
      `cls=${input.classification ?? 'null'} conf=${input.confidence_score} ` +
      `final=${input.final_score ?? 'null'} rr=${round2(rrRatio)} ` +
      `maturity=${input.maturity_score ?? 'null'} ` +
      `cycles=${input.validation_cycles_passed ?? 'null'} ` +
      `valid_until=${toMysqlDateTime(validUntil)}`,
    );
    return { inserted: true, snapshot_id: snapshotId };
  } catch (err: any) {
    console.error(
      `[TRANSACTION_ROLLBACK] table=q365_confirmed_signal_snapshots ` +
      `symbol=${input.symbol} dir=${input.direction} reason=${err?.message ?? String(err)}`,
    );
    return reject('db_error', err?.message ?? String(err));
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
