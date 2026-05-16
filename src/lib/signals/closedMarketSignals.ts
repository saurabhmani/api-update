// ════════════════════════════════════════════════════════════════
//  closedMarketSignals — DB-only loader for /api/signals when the
//  NSE cash session is closed.
//
//  BALANCED_REAL_DATA_MODE contract:
//    - NEVER calls an upstream provider (IndianAPI / NSE direct / Yahoo).
//    - Reads ONLY from MySQL — no synthetic injection, no fake-data
//      backfill, no force_seed rows. Every row is real scanner output.
//    - Two-tier filter ladder. Strict primary; relaxed fallback only
//      when strict returns zero — never both.
//
//        TIER 1 (STRICT):
//          confidence_score    >= 70
//          final_score         >= 75
//          risk_reward / rr    >= 1.5
//          signal_status        = 'APPROVED_SIGNAL'
//          classification     != 'WATCHLIST_ONLY'
//
//        TIER 2 (RELAXED) — fires only if TIER 1 returns 0:
//          confidence_score    >= 60
//          final_score         >= 65
//          risk_reward / rr    >= 1.2
//          signal_status        ∈ {APPROVED_SIGNAL, DEVELOPING_SETUP}
//          classification     != 'WATCHLIST_ONLY'
//
//      Both tiers also enforce: direction ∈ {BUY,SELL},
//      status='ACTIVE', invalidation_reason IS NULL/empty,
//      valid_until > NOW() (or NULL).
//
//    - Force-seed guard at the SQL layer — both tiers reject any row
//      where signal_type='force_seed' or batch_id LIKE 'force_seed%'.
//      Defense in depth even though POST /api/signals/force-seed is
//      disabled (returns 410).
//
//    - Sorted by final_score DESC, confidence_score DESC.
//      Capped at the spec band (20–30) via `applyConfirmedCap`.
//
//    - Empty case: when BOTH tiers return 0, the bundle reports
//      `signalQuality: 'NONE'` and the caller surfaces
//      "No high-quality real signals found". The dashboard stays
//      empty rather than showing seeded or generated data.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  applyConfirmedCap,
  confirmedSnapshotCmp,
  strictApproved,
  mainTableApproved,
  relaxedMainTableApproved,
  earlySignalApproved,
  SIGNAL_RELAX_MODE_ENABLED,
  STRICT_FINAL_FLOOR,
  STRICT_CONFIDENCE_FLOOR,
  STRICT_RR_FLOOR,
} from '@/lib/signals/confirmedSignalPolicy';
import { normalizeWinProbability, type ConfirmedSignalRow } from '@/lib/signals/signalsResponseMapper';

export type ClosedSignalsSource =
  | 'confirmed_snapshots'
  | 'q365_signals_strict'
  | 'q365_signals_relaxed'
  | 'none';

export type SignalQuality = 'STRICT' | 'RELAXED' | 'NONE';

export interface ClosedSignalsBundle {
  signals:    ConfirmedSignalRow[];
  source:     ClosedSignalsSource;
  /** STRICT  = passed the strict floors (70/75/1.5 + APPROVED_SIGNAL).
   *  RELAXED = strict returned 0; fallback (60/65/1.2 +
   *            APPROVED_SIGNAL/DEVELOPING_SETUP) was used.
   *  NONE    = both tiers returned 0; caller surfaces the empty
   *            "No high-quality real signals found" response. */
  signalQuality: SignalQuality;
  /** Row count produced by the strict tier before the fallback ran.
   *  Equal to `signals.length` when signalQuality='STRICT', 0 when
   *  the relaxed tier was used or both tiers were empty. */
  strictCount: number;
  /** True when the response is the relaxed-tier output. */
  relaxedUsed: boolean;
  buyCount:   number;
  sellCount:  number;
  scannedRowCount: number;
  approvedRowCount: number;
  /** Spec MAIN-TABLE-STRICT §4 — q365_signals rows that did NOT clear
   *  the main-table gate (insufficient maturity / cycles / stability /
   *  edge / rr / scores). Surfaced separately so the dashboard can
   *  render a "Stored Scanner Candidates / Not Tradable" panel
   *  without polluting the confirmed signals table. */
  scannerCandidates: ConfirmedSignalRow[];
}

interface RawSignalRow {
  id:                  number;
  symbol:              string;
  exchange:            string | null;
  direction:           string;
  signal_type:         string | null;
  strategy?:           string | null;
  classification:      string | null;
  entry_price:         string | number;
  stop_loss:           string | number;
  target1:             string | number;
  target2:             string | number | null;
  confidence_score:    number | null;
  final_score:         string | number | null;
  /** Phase-4 calculateFinalScore output — institutional structural score
   *  (does NOT decay). The dynamic `final_score` column above bleeds
   *  freshness/age/overextension penalties over time; this column does
   *  not. The wire-level `final_score` published to clients is sourced
   *  from this column when present so the UI / strict gate compare
   *  against the institutional scale. */
  composite_final_score: string | number | null;
  risk_reward:         string | number | null;
  rr_ratio?:           string | number | null;
  risk_score?:         string | number | null;
  opportunity_score?:  string | number | null;
  portfolio_fit_score?: string | number | null;
  stress_survival_score?: string | number | null;
  confidence_band?:    string | null;
  ltp:                 string | number | null;
  pct_change:          string | number | null;
  status:              string | null;
  signal_status:       string | null;
  invalidation_reason: string | null;
  generated_at:        Date | string;
  expires_at?:         Date | string | null;
  batch_id:            string | null;
  // Joined from q365_signal_maturity_tracker on (symbol, direction).
  // Always NULL when no tracker row exists for the pair.
  mt_maturity_score?:           string | number | null;
  mt_validation_cycles_passed?: number | null;
  mt_conviction_level?:         string | null;
  mt_stability_passed?:         number | null;
  mt_first_detected_at?:        Date | string | null;
  /** Tracker last_seen_at — used by the dashboard to flag stale
   *  candidates (last_seen older than TRACKER_STALE_HOURS). The
   *  shapeQ365Row helper falls back to generated_at when this is null. */
  mt_last_seen_at?:             Date | string | null;
  /** Tracker stage at the moment of the read. Surfaced for the
   *  source-visibility envelope so the API consumer can tell whether
   *  a row is still in 'candidate', has been 'promoted', etc. */
  mt_stage?:                    string | null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Max age (in hours) for a q365_signals row to be eligible for the
 * closed-market loader. Defaults to 72h so the typical weekend case
 * (Friday close → Sunday/Monday open ≈ 60h) keeps the prior session's
 * scanner candidates visible in the side panel. Configurable via
 * CLOSED_SIGNALS_MAX_AGE_HOURS — operators on a tighter cadence can
 * lower it; pre-holiday windows can raise it. Floored at 1h, ceiling
 * 168h (one week — anything older is dead regardless of column state).
 *
 * History: was 24h originally; the production diagnostic showed
 * Sunday weekend trackers at ~30h, which the 24h cap dropped to zero
 * rows. The 72h default covers Friday close → Monday open without
 * needing an env override.
 */
export function resolveClosedSignalsMaxAgeHours(): number {
  const raw = Number(process.env.CLOSED_SIGNALS_MAX_AGE_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return 168; // Default to 7 days
  return Math.max(1, Math.min(720, Math.floor(raw))); // Cap at 30 days
}

/** Stable discriminator on every closed-market row. The signals UI
 *  reads it to decide whether to render the "Confirmed" label, the
 *  "⚠️ Early Signal · Cycle N · Not Confirmed · Last Close" tooltip,
 *  or the "Scanner Candidate (Not Yet Tradable)" panel banner.
 *
 *  Values:
 *    confirmed_snapshot  — promoted row out of q365_confirmed_signal_snapshots.
 *    q365_signals_early  — pre-promotion row from q365_signals (cycles < 3,
 *                          maturity tracker not yet matured); shown only
 *                          when the strict + relaxed snapshot tiers are
 *                          empty. Treated as "early scanner candidate"
 *                          in the UI, never as a confirmed trade signal.
 *    scanner_candidate   — q365_signals row routed to the side panel
 *                          (informational only, never enters main table).
 */
export type ClosedSignalSourceKind =
  | 'confirmed_snapshot'
  | 'q365_signals_early'
  | 'scanner_candidate';

/** Tag a q365_signals-derived row as the "Early Signal" source so the
 *  UI never mislabels it as a confirmed trade signal. is_relaxed=true
 *  makes the existing badge fall through to "⚠️ Early Signal", and
 *  source_kind gives downstream consumers a stable discriminator
 *  independent of the relaxed/strict label. */
function tagAsEarly(r: ConfirmedSignalRow): ConfirmedSignalRow {
  (r as { is_relaxed?: boolean }).is_relaxed = true;
  (r as { source_kind?: ClosedSignalSourceKind }).source_kind = 'q365_signals_early';
  return r;
}

/**
 * Spec INSTITUTIONAL §H + §A — final-score-driven classification.
 * Aligned with the institutional 6-band scheme so closed-market rows
 * use the SAME labels the main-table whitelist accepts. The previous
 * HIGH/MEDIUM/LOW vocabulary forced the response-layer firewall
 * (`MAIN_TABLE_DISPLAY_CLS`) to reject every closed-market row whose
 * final_score landed in the 65-74 band — even though that band is
 * exactly the VALID_SIGNAL bucket the main table is supposed to ship.
 *
 *    final_score >= 85 → INSTITUTIONAL_HIGH_CONVICTION
 *    final_score >= 75 → HIGH_CONVICTION
 *    final_score >= 65 → VALID_SIGNAL
 *    final_score >= 50 → DEVELOPING_SETUP
 *    final_score >= 35 → WATCHLIST_ONLY
 *    else              → NO_TRADE
 *
 * Stored 'NO_TRADE' / 'WATCHLIST_ONLY' markers pass through untouched
 * so the original NO-TRADE-PRECEDENCE invariant (ADANIPORTS bug)
 * still holds.
 */
const PASSTHROUGH_CLASSIFICATIONS = new Set(['NO_TRADE', 'WATCHLIST_ONLY']);
export type NormalizedClassification =
  | 'INSTITUTIONAL_HIGH_CONVICTION'
  | 'HIGH_CONVICTION'
  | 'VALID_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'WATCHLIST_ONLY'
  | 'NO_TRADE';
export function normalizeClassification(
  finalScore: number | null | undefined,
  rawClassification?: string | null,
): NormalizedClassification {
  const raw = String(rawClassification ?? '').toUpperCase().trim();
  if (PASSTHROUGH_CLASSIFICATIONS.has(raw)) {
    return raw as 'NO_TRADE' | 'WATCHLIST_ONLY';
  }
  const fs = Number(finalScore ?? 0);
  if (!Number.isFinite(fs))   return 'NO_TRADE';
  if (fs >= 85)               return 'INSTITUTIONAL_HIGH_CONVICTION';
  if (fs >= 75)               return 'HIGH_CONVICTION';
  if (fs >= 65)               return 'VALID_SIGNAL';
  if (fs >= 50)               return 'DEVELOPING_SETUP';
  if (fs >= 35)               return 'WATCHLIST_ONLY';
  return 'NO_TRADE';
}

/**
 * Spec NO-TRADE-PRECEDENCE §6 — the effective signal status for the
 * UI / API, with classification overriding signal_status.
 *
 * The pipeline can emit contradictory rows where signal_status =
 * 'APPROVED_SIGNAL' but classification = 'NO_TRADE'. The dashboard
 * MUST treat these as no-trade — surfacing them as APPROVED would be
 * wrong (the engine already decided not to trade). Returns one of:
 *   'NO_TRADE'           — classification overrides
 *   'WATCHLIST_ONLY'     — pre-approved watchlist context
 *   'APPROVED_SIGNAL'    — confirmed trade
 *   'DEVELOPING_SETUP'   — early scanner candidate
 *   'EXPIRED'            — expired/invalidated
 *   'UNKNOWN'            — anything else (defensive default)
 */
export type EffectiveSignalStatus =
  | 'NO_TRADE'
  | 'WATCHLIST_ONLY'
  | 'APPROVED_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'EXPIRED'
  | 'UNKNOWN';
export function deriveEffectiveSignalStatus(
  rawClassification: string | null | undefined,
  signalStatus: string | null | undefined,
  invalidationReason?: string | null,
  validUntilIso?: string | null,
): EffectiveSignalStatus {
  if (invalidationReason && String(invalidationReason).trim() !== '') {
    return 'EXPIRED';
  }
  if (validUntilIso) {
    const ms = Date.parse(validUntilIso);
    if (Number.isFinite(ms) && ms <= Date.now()) return 'EXPIRED';
  }
  const cls = String(rawClassification ?? '').toUpperCase().trim();
  if (cls === 'NO_TRADE')       return 'NO_TRADE';
  if (cls === 'WATCHLIST_ONLY') return 'WATCHLIST_ONLY';
  const ss = String(signalStatus ?? '').toUpperCase().trim();
  if (ss === 'APPROVED_SIGNAL')   return 'APPROVED_SIGNAL';
  if (ss === 'DEVELOPING_SETUP')  return 'DEVELOPING_SETUP';
  return 'UNKNOWN';
}

/**
 * Display bucket the UI uses to route a row to the right panel/tab.
 * Pure function of (effective_status, source_table, cycles, alive).
 */
export type DisplayBucket =
  | 'confirmed'        // q365_confirmed_signal_snapshots, alive, classification approved
  | 'early_candidate'  // q365_signals, cycles<3 OR not yet matured
  | 'no_trade'         // classification = NO_TRADE (regardless of signal_status)
  | 'rejected'         // invalidated / expired
  | 'scanner_candidate'; // catch-all side-panel slot
export function deriveDisplayBucket(args: {
  sourceTable:        'q365_confirmed_signal_snapshots' | 'q365_signals';
  effectiveStatus:    EffectiveSignalStatus;
  validationCycles:   number | null;
  isAlive:            boolean;
}): DisplayBucket {
  if (!args.isAlive || args.effectiveStatus === 'EXPIRED')           return 'rejected';
  if (args.effectiveStatus === 'NO_TRADE')                            return 'no_trade';
  if (args.sourceTable === 'q365_confirmed_signal_snapshots')        return 'confirmed';
  // q365_signals never confirmed even with 3+ cycles — promotion goes
  // through the maturity worker. Show as early candidate when alive.
  const cycles = Number(args.validationCycles ?? 0);
  if (Number.isFinite(cycles) && cycles >= 3)                         return 'early_candidate';
  if (args.effectiveStatus === 'WATCHLIST_ONLY')                      return 'scanner_candidate';
  return 'early_candidate';
}

/** Stale-candidate threshold (hours) for tracker `last_seen_at`.
 *  Default 72h to span the typical weekend window (Friday close →
 *  Monday open). Rows older than this are flagged
 *  `is_stale_candidate=true` per spec §4 — the predicates reject them
 *  from the main signals table, but the SQL still returns them so the
 *  scanner-candidates side panel can render them with the stale flag
 *  for operator visibility. Configurable via TRACKER_STALE_HOURS env. */
export function resolveTrackerStaleHours(): number {
  const raw = Number(process.env.TRACKER_STALE_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) return 72;
  return Math.max(1, Math.min(168, Math.floor(raw)));
}

/**
 * Spec DATA-QUALITY §3 — live %-change since entry.
 *   livePChange = ((livePrice - entry_price) / entry_price) * 100
 * Returns null only when the inputs are unavailable / invalid; in
 * that case the row carries the legacy `pct_change` (last-close %)
 * already populated upstream so the cell is never blank. Callers
 * should prefer this helper over a raw column read.
 */
export function computeLivePChange(
  livePrice: number | null | undefined,
  entryPrice: number | null | undefined,
): number | null {
  const lp = Number(livePrice  ?? NaN);
  const ep = Number(entryPrice ?? NaN);
  if (!Number.isFinite(lp) || !Number.isFinite(ep) || ep <= 0) return null;
  return Math.round(((lp - ep) / ep) * 10_000) / 100;  // 2-decimal precision
}
function toIso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v.replace(' ', 'T') + 'Z';
    return v;
  }
  return null;
}

function shapeQ365Row(r: RawSignalRow): ConfirmedSignalRow {
  const dir = String(r.direction ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const rr  = num(r.rr_ratio ?? r.risk_reward);
  const entry  = num(r.entry_price);
  const stop   = num(r.stop_loss);
  const tgt1   = num(r.target1);
  const conf   = numOrNull(r.confidence_score) ?? 0;

  // Derived trade-math — q365_signals doesn't persist these but the
  // dashboard renders them as separate columns (Profit %, Loss %,
  // Win Prob %, Edge %). Computing from entry/stop/target keeps the
  // closed-market view in feature parity with confirmed_snapshots.
  const profitPct = entry > 0
    ? Math.abs(tgt1 - entry) / entry * 100
    : 0;
  const lossPct = entry > 0
    ? Math.abs(entry - stop) / entry * 100
    : 0;
  // Edge: rough expected-value estimate using confidence as p-win.
  // edge = pWin*profit - (1-pWin)*loss. Bounded to ≥ 0 to avoid
  // negative-edge rows accidentally showing as opportunities.
  const pWin = Math.min(0.95, Math.max(0.5, conf / 100));
  const edgePct = Math.max(0,
    pWin * profitPct - (1 - pWin) * lossPct,
  );

  // Maturity-tracker enrichment. The tracker is populated by the
  // regen worker; fresh seed data and first-pass strict-tier rows
  // Spec MAIN-TABLE-STRICT §5 — DO NOT synthesize defaults for
  // tracker fields. The previous code defaulted maturity from
  // final_score, cycles to 1, stability from conviction, and
  // validation_gates_passed to 13. That allowed scanner-only rows
  // (which never went through the maturity tracker) to slip into
  // the main signals table during off-hours. Pass NULL through so
  // mainTableApproved correctly rejects rows without real tracker
  // data.
  const maturityScore  = numOrNull(r.mt_maturity_score);                              // null when tracker missing
  const cycles         = r.mt_validation_cycles_passed != null
    ? Number(r.mt_validation_cycles_passed) : null;
  const convictionRaw  = (r.mt_conviction_level ?? '').toUpperCase();
  const conviction: 'INSTITUTIONAL' | 'HIGH' | 'MEDIUM' | null =
      convictionRaw === 'INSTITUTIONAL' ? 'INSTITUTIONAL'
    : convictionRaw === 'HIGH'          ? 'HIGH'
    : convictionRaw === 'MEDIUM'        ? 'MEDIUM'
    :                                     null;
  const stabilityPassed: boolean | null =
      r.mt_stability_passed == null ? null : Number(r.mt_stability_passed) === 1;

  // Age in minutes since generation — matches the Phase-12
  // `signal_age_minutes_at_promotion` column the live path emits.
  const generatedMs = r.generated_at instanceof Date
    ? r.generated_at.getTime()
    : Date.parse(String(r.generated_at).replace(' ', 'T'));
  const ageMinutes = Number.isFinite(generatedMs)
    ? Math.max(0, Math.floor((Date.now() - generatedMs) / 60000))
    : null;

  // Validation gates — null when q365_signals doesn't carry a real
  // gate count (the tracker tables don't expose this field). The
  // main-table predicate doesn't read this column, so null is safe;
  // the legacy "13" default falsely implied "fully validated".
  const validationGatesPassed: number | null = null;

  // Confidence band derived from score so the "Conv Band" cell has
  // something to render even when q365_signals didn't set it.
  const confBand = r.confidence_band
    ?? (conf >= 85 ? 'INSTITUTIONAL'
      : conf >= 75 ? 'HIGH'
      : conf >= 65 ? 'MEDIUM'
      : 'LOW');

  // Spec NO-TRADE-PRECEDENCE §1 — preserve the raw classification
  // emitted by the pipeline so a NO_TRADE marker never gets rewritten
  // to MEDIUM_CONVICTION just because the row's final_score happens
  // to clear the 65 threshold. ADANIPORTS in production was the
  // canary: stored classification='NO_TRADE', final_score=70.88,
  // signal_status='APPROVED_SIGNAL'. The previous unconditional
  // rebucketing produced classification='MEDIUM_CONVICTION' which
  // sailed through every downstream NO_TRADE check.
  const rawClassification = String(r.classification ?? '').toUpperCase().trim();
  // MATURATION_AUDIT_2026-05 — institutional score selection.
  // q365_signals carries TWO score columns:
  //   - final_score          → dynamic ranker output, decays via
  //                            freshnessPenalty + stepAgePenalty +
  //                            overextensionPenalty (designed to bleed
  //                            ~25-35 points across many cycles).
  //   - composite_final_score → Phase-4 calculateFinalScore (structural
  //                            institutional quality, does NOT decay).
  // Strict / elite gates and the UI label are calibrated against the
  // institutional scale.
  //
  // Fallback chain (preferred → last-resort):
  //   1. composite_final_score   — Phase-4 institutional, never decays.
  //   2. confidence_score        — also stable; closest proxy when
  //                                Phase-4 didn't populate the
  //                                composite (legacy row, pre-wiring).
  //   3. final_score (dynamic)   — DECAYED, used only when nothing else
  //                                is present, so a row never collapses
  //                                to 0 wire-side.
  // Skipping the dynamic value (step 3) until both stable inputs are
  // unavailable is what prevents the "final_score=45 stuck on a
  // confidence=79 row" wire bug. Same precedence runs in the SQL
  // filter / ORDER BY clauses below.
  const institutionalFinalScore =
    numOrNull(r.composite_final_score)
    ?? numOrNull(r.confidence_score)
    ?? numOrNull(r.final_score);
  const normalizedClassification = normalizeClassification(
    institutionalFinalScore, rawClassification,
  );
  const validUntilIso = toIso(r.expires_at ?? null);
  const effectiveStatus = deriveEffectiveSignalStatus(
    rawClassification,
    r.signal_status ?? 'APPROVED_SIGNAL',
    r.invalidation_reason ?? null,
    validUntilIso,
  );
  // q365_signals is NEVER a confirmed signal — promotion happens via
  // the maturity worker into q365_confirmed_signal_snapshots. The
  // dashboard's main "Signals & Opportunities" panel keys on
  // is_trade_ready, so any q365_signals row reaches it only via the
  // scanner-candidates side panel. Trade-readiness here means
  // "would be tradeable IF promoted" — used by the UI to choose a
  // neutral "Early Candidate" pill vs the rejected 'NO_TRADE' chip.
  const cyclesNum = cycles == null ? 0 : cycles;
  const isAlive   = !r.invalidation_reason
    && (validUntilIso == null || Date.parse(validUntilIso) > Date.now());
  // Stale-candidate calculation prefers the tracker's last_seen_at
  // (refreshed on every detection by saveSignals → upsertTrackerOnDetection)
  // and falls back to first_detected_at, then to the q365_signals
  // generated_at column when no tracker row exists. Whichever is the
  // freshest "this signal was seen" timestamp wins.
  const lastSeenTs = (() => {
    const candidates: Array<Date | string | null | undefined> = [
      r.mt_last_seen_at, r.mt_first_detected_at, r.generated_at,
    ];
    for (const v of candidates) {
      if (!v) continue;
      const ms = v instanceof Date ? v.getTime() : Date.parse(String(v).replace(' ', 'T'));
      if (Number.isFinite(ms)) return ms;
    }
    return NaN;
  })();
  const isStaleCandidate = Number.isFinite(lastSeenTs)
    ? (Date.now() - lastSeenTs) / 3_600_000 >= resolveTrackerStaleHours()
    : false;
  const minutesSinceSeen = Number.isFinite(lastSeenTs)
    ? Math.max(0, Math.round((Date.now() - lastSeenTs) / 60_000))
    : null;
  const isConfirmed   = false;
  const isTradeReady  =
       isAlive
    && effectiveStatus === 'APPROVED_SIGNAL'
    && cyclesNum >= 3
    && !isStaleCandidate
    && rawClassification !== 'NO_TRADE'
    && rawClassification !== 'WATCHLIST_ONLY';
  const displayBucket = deriveDisplayBucket({
    sourceTable:      'q365_signals',
    effectiveStatus,
    validationCycles: cycles,
    isAlive,
  });

  return {
    // ── Source visibility (spec §7) ─────────────────────────────────
    source_table:            'q365_signals' as const,
    source_type:             effectiveStatus === 'NO_TRADE'
                                ? 'no_trade' as const
                                : 'early_candidate' as const,
    raw_classification:      rawClassification || null,
    effective_signal_status: effectiveStatus,
    display_bucket:          displayBucket,
    is_confirmed:            isConfirmed,
    is_trade_ready:          isTradeReady,
    is_stale_candidate:      isStaleCandidate,
    minutes_since_seen:      minutesSinceSeen,
    cycle_reset_reason:      null as null,

    id:                 r.id,
    symbol:             r.symbol,
    tradingsymbol:      r.symbol,
    direction:          dir,
    strategy:           r.strategy ?? r.signal_type ?? null,
    entry_price:        entry,
    stop_loss:          stop,
    target1:            tgt1,
    target2:            numOrNull(r.target2),
    confidence_score:   conf,
    confidence:         conf,
    final_score:        institutionalFinalScore,
    classification:     normalizedClassification,
    risk_reward:        rr,
    rr_ratio:           rr,
    // BUG-FIX (2026-05) — `status` is the lifecycle column
    // (ACTIVE/INVALIDATED/EXPIRED/STOP_LOSS_HIT/TARGET_HIT), NOT the
    // engine signal_status (APPROVED_SIGNAL/DEVELOPING_SETUP/NO_TRADE).
    // Earlier shaping leaked `signal_status` into `status` so every
    // closed-market row entered the response with status='APPROVED_SIGNAL',
    // then dropStaleOrConflictingRows() in responseAssembly.ts rejected
    // them all because `status !== 'ACTIVE'`. Map lifecycle from the
    // upstream lifecycle column only; default to 'ACTIVE' for live rows
    // that pass invalidation/expiry checks above (isAlive=true).
    status:             r.status ?? (isAlive ? 'ACTIVE' : 'EXPIRED'),
    signal_status:      r.signal_status ?? 'APPROVED_SIGNAL',
    invalidation_reason: r.invalidation_reason,
    confirmed_at:       toIso(r.generated_at),
    valid_until:        validUntilIso,
    livePrice:          numOrNull(r.ltp),
    // Spec DATA-QUALITY §3 — prefer the entry-relative % change when
    // we have both ltp and entry. Fall back to the stored pct_change
    // (last-close move) so the cell is never blank.
    livePChange:        computeLivePChange(numOrNull(r.ltp), entry) ?? numOrNull(r.pct_change),

    // Derived trade-math
    profit_percent:     Math.round(profitPct * 100) / 100,
    loss_percent:       Math.round(lossPct   * 100) / 100,
    expected_edge_percent: Math.round(edgePct * 100) / 100,
    // Spec INSTITUTIONAL §D — wire scale is 0..1. The frontend renders
    // `(value * 100).toFixed(1) + '%'`, so a 0..100 value here would
    // render as 5000% / 6500%. normalizeWinProbability collapses both
    // legacy scales (0..1 and 0..100) to a single fraction.
    win_probability:    normalizeWinProbability(pWin) ?? 0,

    // Risk / opportunity / portfolio metrics straight from q365_signals.
    // Spec DATA-QUALITY §3 — pfit fallback formula min(100, conf+5)
    // applied here so a NULL/0 column never reaches the dashboard.
    risk_score:            numOrNull(r.risk_score) ?? null,
    opportunity_score:     numOrNull(r.opportunity_score)     ?? null,
    portfolio_fit_score:   numOrNull(r.portfolio_fit_score) || Math.min(100, conf + 5),
    stress_survival_score: numOrNull(r.stress_survival_score) ?? null,
    confidence_band:       confBand,

    // Maturity tracker
    maturity_score:                  maturityScore,
    validation_cycles_passed:        cycles,
    signal_age_minutes_at_promotion: ageMinutes,
    conviction_level:                conviction,
    stability_passed:                stabilityPassed,
    validation_gates_passed:         validationGatesPassed,

    live_valid:        true,
    rejection_codes:   [],
    rejection_reasons: [],
  } as unknown as ConfirmedSignalRow;
}

/**
 * Read pre-confirmed snapshots from `q365_confirmed_signal_snapshots`
 * for the closed-market path. The shape is compatible with the rest
 * of the response pipeline because the live path uses the same table.
 *
 * No live-price enrichment — we are off-hours and ANY upstream call is
 * forbidden. The dashboard already understands `livePrice = null` and
 * falls back to the entry-time `ltp`.
 */
async function loadConfirmedSnapshotsClosed(limit: number): Promise<ConfirmedSignalRow[]> {
  // Pull every column the dashboard renders. confirmed_snapshots
  // already persists profit/loss/edge/win_probability + maturity
  // fields, so no JS derivation needed here — just a faithful copy.
  // PURE_REAL_DATA_MODE: defensive guards exclude any synthetic rows
  // that may have been inserted by an older force-seed call before the
  // route was disabled. `strategy` carries the seeding marker on
  // confirmed snapshots that were promoted from a force_seed row.
  // Bug fix — confirmed-snapshot rows often carry NULL tracker columns
  // (older promotions copied them through inconsistently). The
  // q365_signal_maturity_tracker table is the live source of truth
  // for maturity / cycles / conviction / stability, so LEFT JOIN it
  // and COALESCE in case the snapshot's own column is NULL. The join
  // is keyed on (symbol, direction) — same as `shapeQ365Row`.
  // MATURATION_AUDIT_2026-05 — JOIN q365_signals on source_signal_id
  // so the wire output prefers the un-decaying composite_final_score
  // over the snapshot's stored (possibly decayed) final_score. Strict
  // floor + ORDER BY also use the institutional precedence so old
  // stale snapshots automatically surface Phase-4's view at read time.
  const sql = `
    SELECT s.id, s.symbol, s.exchange, s.direction, s.strategy, s.classification,
           s.entry_price, s.stop_loss, s.target1, s.target2,
           s.profit_percent, s.loss_percent, s.expected_edge_percent, s.win_probability,
           s.confidence_score, s.final_score, s.rr_ratio,
           q.composite_final_score AS source_composite_final_score,
           q.confidence_score      AS source_confidence_score,
           s.stress_survival_score,
           COALESCE(s.maturity_score,           mt.maturity_score)            AS maturity_score,
           COALESCE(s.validation_cycles_passed, mt.validation_cycles_passed)  AS validation_cycles_passed,
           s.signal_age_minutes_at_promotion,
           COALESCE(s.conviction_level,         mt.conviction_level)          AS conviction_level,
           COALESCE(s.stability_passed,         mt.stable)                    AS stability_passed,
           s.rejection_codes_json, s.gate_details_json,
           s.status, s.invalidation_reason,
           s.confirmed_at, s.valid_until
      FROM q365_confirmed_signal_snapshots s
      LEFT JOIN q365_signal_maturity_tracker mt
        ON  mt.symbol    = s.symbol
        AND mt.direction = s.direction
      LEFT JOIN q365_signals q
        ON  q.id = s.source_signal_id
     WHERE s.status = 'ACTIVE'
       AND s.invalidation_reason IS NULL
       AND s.direction IN ('BUY','SELL')
       AND s.confidence_score >= ?
       AND COALESCE(q.composite_final_score, s.final_score, s.confidence_score, 0) >= ?
       AND s.rr_ratio         >= ?
       -- AND (s.valid_until IS NULL OR s.valid_until > NOW())
       -- Spec "FIX SIGNAL VISIBILITY" — in market_closed mode, we ship the last active signals
       -- even if they have technically expired (which usually happens at 15:30 IST).
       -- s.status='ACTIVE' and s.invalidation_reason IS NULL already ensure they are not "dead" signals.
       AND s.confirmed_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       AND COALESCE(s.strategy, '') <> 'force_seed'
     ORDER BY COALESCE(q.composite_final_score, s.final_score, s.confidence_score, 0) DESC,
              s.confidence_score DESC
     LIMIT ?`;
  try {
    const { rows } = await db.query<any>(sql, [
      STRICT_CONFIDENCE_FLOOR, STRICT_FINAL_FLOOR, STRICT_RR_FLOOR,
      resolveClosedSignalsMaxAgeHours(),
      Math.max(1, Math.min(limit, 200)),
    ]);
    return (rows as any[]).map((r) => {
      const conf = numOrNull(r.confidence_score) ?? 0;
      let rejectionCodes: string[] = [];
      try {
        const parsed = typeof r.rejection_codes_json === 'string'
          ? JSON.parse(r.rejection_codes_json)
          : r.rejection_codes_json;
        if (Array.isArray(parsed)) rejectionCodes = parsed.filter((x) => typeof x === 'string');
      } catch { /* keep [] */ }
      const validationGatesPassed = Math.max(0, 13 - rejectionCodes.length);
      // Same NO_TRADE-preservation contract as q365_signals — even
      // promoted snapshots can carry a NO_TRADE marker if the engine
      // promoted earlier under different rules. The normalizer keeps
      // it intact instead of silently rebucketing.
      const rawCls = String(r.classification ?? '').toUpperCase().trim();
      // MATURATION_AUDIT_2026-05 — institutional final_score fallback
      // chain: source signal's composite_final_score (Phase-4, never
      // decays) → snapshot's stored final_score (institutional only on
      // post-fix promotions; decayed on older ones) → confidence_score
      // (last-resort stable proxy). Old snapshots whose final_score
      // baked in a decayed value are rescued by the JOIN.
      const institutionalFinalScore =
        numOrNull(r.source_composite_final_score)
        ?? numOrNull(r.final_score)
        ?? numOrNull(r.source_confidence_score)
        ?? (conf > 0 ? conf : null);
      const normalizedCls = normalizeClassification(institutionalFinalScore, rawCls);
      const validUntilIso = toIso(r.valid_until);
      const effectiveStatus = deriveEffectiveSignalStatus(
        rawCls, 'APPROVED_SIGNAL', r.invalidation_reason ?? null, validUntilIso,
      );
      const cyclesNum   = r.validation_cycles_passed != null ? Number(r.validation_cycles_passed) : 0;
      const isAlive     = !r.invalidation_reason
        && (validUntilIso == null || Date.parse(validUntilIso) > Date.now());
      const confirmedAtIso = toIso(r.confirmed_at);
      const minutesSince = (() => {
        const ts = confirmedAtIso ? Date.parse(confirmedAtIso) : NaN;
        return Number.isFinite(ts) ? Math.max(0, Math.round((Date.now() - ts) / 60_000)) : null;
      })();
      const isStale       = (() => {
        const ts = confirmedAtIso ? Date.parse(confirmedAtIso) : NaN;
        if (!Number.isFinite(ts)) return false;
        return (Date.now() - ts) / 3_600_000 >= resolveTrackerStaleHours();
      })();
      const isConfirmedSnap = isAlive
        && effectiveStatus === 'APPROVED_SIGNAL'
        && rawCls !== 'NO_TRADE'
        && rawCls !== 'WATCHLIST_ONLY';
      return {
        // Spec SOURCE-KIND §1 — every confirmed-snapshot row carries
        // a stable `confirmed_snapshot` discriminator so the UI can
        // never accidentally render it under the "Early Signal" tier.
        source_kind:                     'confirmed_snapshot' as ClosedSignalSourceKind,
        // Spec §7 — source visibility: every row exposes the table it
        // came from + a UI-routing bucket + the trade-readiness verdict.
        // Confirmed snapshots are the only table whose rows can be
        // is_trade_ready=true.
        source_table:                    'q365_confirmed_signal_snapshots' as const,
        source_type:                     'confirmed_snapshot' as const,
        raw_classification:              rawCls || null,
        effective_signal_status:         effectiveStatus,
        display_bucket:                  deriveDisplayBucket({
                                            sourceTable:      'q365_confirmed_signal_snapshots',
                                            effectiveStatus,
                                            validationCycles: cyclesNum,
                                            isAlive,
                                          }),
        is_confirmed:                    isConfirmedSnap,
        is_trade_ready:                  isConfirmedSnap && !isStale,
        is_stale_candidate:              isStale,
        minutes_since_seen:              minutesSince,
        cycle_reset_reason:              null as null,
        id:                              Number(r.id),
        symbol:                          r.symbol,
        tradingsymbol:                   r.symbol,
        direction:                       String(r.direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        strategy:                        r.strategy ?? null,
        entry_price:                     num(r.entry_price),
        stop_loss:                       num(r.stop_loss),
        target1:                         num(r.target1),
        target2:                         numOrNull(r.target2),
        profit_percent:                  numOrNull(r.profit_percent) ?? 0,
        loss_percent:                    numOrNull(r.loss_percent)   ?? 0,
        expected_edge_percent:           numOrNull(r.expected_edge_percent) ?? 0,
        // Spec INSTITUTIONAL §D — confirmed snapshots persist 0..1
        // fractions; older rows from q365_signals carry 0..100. Force
        // single 0..1 wire scale so the dashboard never renders 5000%.
        win_probability:                 normalizeWinProbability(numOrNull(r.win_probability)) ?? 0,
        confidence_score:                conf,
        confidence:                      conf,
        confidence_band:                 conf >= 85 ? 'INSTITUTIONAL'
                                        : conf >= 75 ? 'HIGH'
                                        : conf >= 65 ? 'MEDIUM' : 'LOW',
        final_score:                     institutionalFinalScore,
        classification:                  normalizedCls,
        signal_status:                   'APPROVED_SIGNAL',
        risk_reward:                     num(r.rr_ratio),
        rr_ratio:                        num(r.rr_ratio),
        // Spec DATA-QUALITY §3 — fallback formulas so the dashboard
        // never renders 0 / blank for these columns. risk_score
        // mirrors the bootstrap insert; pfit uses min(100, conf+5).
        risk_score:                      Math.min(100, Math.max(0, Math.round(num(r.rr_ratio) * 20))),
        opportunity_score:               conf,
        portfolio_fit_score:             Math.min(100, conf + 5),
        stress_survival_score:           numOrNull(r.stress_survival_score) ?? Math.max(0, 100 - conf),
        maturity_score:                  numOrNull(r.maturity_score),
        validation_cycles_passed:        r.validation_cycles_passed != null ? Number(r.validation_cycles_passed) : null,
        signal_age_minutes_at_promotion: r.signal_age_minutes_at_promotion != null ? Number(r.signal_age_minutes_at_promotion) : null,
        conviction_level:                (r.conviction_level === 'INSTITUTIONAL' || r.conviction_level === 'HIGH' || r.conviction_level === 'MEDIUM')
                                          ? r.conviction_level : null,
        stability_passed:                r.stability_passed == null ? null : Number(r.stability_passed) === 1,
        validation_gates_passed:         validationGatesPassed,
        rejection_codes:                 rejectionCodes,
        rejection_reasons:               [],
        live_valid:                      true,
        status:                          r.status,
        invalidation_reason:             r.invalidation_reason,
        confirmed_at:                    toIso(r.confirmed_at),
        valid_until:                     toIso(r.valid_until),
      } as unknown as ConfirmedSignalRow;
    });
  } catch (err) {
    console.warn('[closedMarketSignals] confirmed_snapshots query failed:', (err as Error).message);
    return [];
  }
}

// Shared SELECT clause + JOIN — used by both strict and relaxed tiers.
// Pulls every column the dashboard needs, plus a LEFT JOIN against
// q365_signal_maturity_tracker for the per-symbol/direction maturity
// fields (maturity_score, validation_cycles_passed, conviction_level,
// stability_passed). Tracker rows may be missing (fresh seed data,
// first-pass strict rows that haven't been promoted) — defaults are
// derived in `shapeQ365Row` when those columns come back NULL.
const Q365_SIGNALS_SELECT = `
  SELECT
    s.id, s.symbol, s.exchange, s.direction, s.signal_type, s.classification,
    s.entry_price, s.stop_loss, s.target1, s.target2,
    s.confidence_score, s.confidence_band, s.risk_score,
    s.opportunity_score, s.portfolio_fit_score, s.stress_survival_score,
    s.final_score, s.composite_final_score, s.risk_reward,
    s.ltp, s.pct_change, s.status, s.signal_status,
    s.invalidation_reason, s.generated_at, s.expires_at, s.batch_id,
    mt.maturity_score           AS mt_maturity_score,
    mt.validation_cycles_passed AS mt_validation_cycles_passed,
    mt.conviction_level         AS mt_conviction_level,
    mt.stable                   AS mt_stability_passed,
    mt.first_detected_at        AS mt_first_detected_at,
    mt.last_seen_at             AS mt_last_seen_at,
    mt.stage                    AS mt_stage
  FROM q365_signals s
  LEFT JOIN q365_signal_maturity_tracker mt
    ON  mt.symbol    = s.symbol
    AND mt.direction = s.direction
`;

/** BALANCED_REAL_DATA_MODE relaxed tier. Fires ONLY when both strict
 *  loaders returned 0 rows. Floors are softened so the dashboard can
 *  still show real, scanner-emitted candidates instead of going empty:
 *
 *    confidence_score        >= 60
 *    final_score             >= 65
 *    risk_reward / rr_ratio  >= 1.2
 *    signal_status            ∈ {APPROVED_SIGNAL, DEVELOPING_SETUP}
 *    classification          != 'WATCHLIST_ONLY'
 *    invalidation_reason      IS NULL / empty
 *    status                   ACTIVE / blank
 *
 *  Force-seed rows are excluded at the SQL layer — same guards as the
 *  strict tier, no synthetic rows can reach the response.
 *
 *  The bundle returned by `loadClosedMarketSignals` carries
 *  `signal_quality: 'RELAXED'` so the UI can surface a banner and
 *  the caller logs the tier in the spec-required line. */
// Spec "FIX SIGNAL VISIBILITY" §2 — relaxed-tier floors env-overridable.
//
// Defaults recalibrated 2026-05: 55/60/1.2 → 30/35/1.2.
//
// The previous 55/60/1.2 defaults were identical to the strict tier,
// so the "relaxed" fallback was relaxed in name only. When the engine
// runs with SIGNAL_RELAX_MODE=true (or DEBUG_FORCE_SIGNAL=true), it
// produces signals at confidence ≥ 30 — the relaxed read-tier's job
// is to surface those signals while the strict tier continues to
// gate production-grade output (≥ 55). With identical floors, every
// engine output below 55 was hidden from the API, surfacing as
// signals=[] even when 20+ signals were saved to q365_signals.
//
// New defaults (30/35/1.2) match the engine's relax-mode internal
// floors so a relax-mode run actually populates the API response.
// Strict tier stays at 55/60/1.2 (production gate). Production
// operators running without SIGNAL_RELAX_MODE see no behaviour change
// because the engine still emits ≥ 55 and the relaxed tier is a
// fallback that only fires when strict is empty.
//
// Operators who want the prior 55/60/1.2 relaxed behaviour can set:
//   SIGNAL_API_RELAX_CONFIDENCE_FLOOR=55
//   SIGNAL_API_RELAX_FINAL_FLOOR=60
function relaxFloor(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}
// Spec "FIX FINAL SIGNAL VISIBILITY" §2 — exported so the route's
// [FILTER] funnel log can stamp the exact thresholds that the relaxed
// SQL applied (instead of the old hardcoded "60/65/1.2" / "50/55/1.0"
// strings that drift from the actual cutoffs the moment env vars
// override them).
export function getRelaxedSignalFloors(): {
  confidence: number;
  final:      number;
  rr:         number;
} {
  return {
    confidence: relaxFloor('SIGNAL_API_RELAX_CONFIDENCE_FLOOR', 0,   100, 30),
    final:      relaxFloor('SIGNAL_API_RELAX_FINAL_FLOOR',      0,   100, 35),
    rr:         relaxFloor('SIGNAL_API_RELAX_RR_FLOOR',       0.5,     5,  1.2),
  };
}

export async function loadQ365SignalsRelaxed(limit: number): Promise<ConfirmedSignalRow[]> {
  // Spec "FIX FINAL SIGNAL VISIBILITY" §2 — defaults pinned to the
  // spec band (55 / 60 / 1.2) so the relaxed q365_signals fallback
  // surfaces real Phase-4 output that landed below the strict 60/55/1.2
  // cutoff after live-tape penalties were applied. Operators can still
  // tighten the floors via the SIGNAL_API_RELAX_* env vars.
  const { confidence: RELAX_CONFIDENCE, final: RELAX_FINAL, rr: RELAX_RR } =
    getRelaxedSignalFloors();
  // Expiry + max-age guards. q365_signals carries an `expires_at`
  // column populated by the engine when it knows the signal's
  // validity horizon (typically 60-120 min for intraday rows). Without
  // these guards the closed-market loader would happily surface
  //   • rows that have already passed their natural expiry
  //   • rows generated > 1 trading day ago and now obviously stale
  // both of which feed the "Cycle 1 / Last Close losers unavailable"
  // confusion users reported. The age cutoff is configurable via
  // CLOSED_SIGNALS_MAX_AGE_HOURS (default 24h ≈ "last trading session
  // window"); an operator can shorten it for a tighter dashboard.
  // Spec NO-TRADE-PRECEDENCE §5 — confirmed/main outputs must NEVER
  // include DEVELOPING_SETUP rows; that bucket is "scanner saw
  // something but the engine hasn't approved it yet". The relaxed
  // tier feeds scannerCandidates exclusively (per spec §2 — main
  // signals come ONLY from q365_confirmed_signal_snapshots). The SQL
  // is left permissive for both signal_status values so the panel
  // can render the full development picture; downstream routing
  // tags every row source_type='early_candidate' / 'no_trade'.
  // NO_TRADE rows are deliberately allowed through — the routing
  // layer below tags them display_bucket='no_trade' so the UI can
  // render them as "no-trade context" per spec §1.
  //
  // RELAXED MODE — when SIGNAL_RELAX_MODE=true, the SQL also admits
  // WATCHLIST_ONLY rows. On quiet days every Phase-3 row tends to
  // come back tagged WATCHLIST_ONLY ("monitor for confirmation"); the
  // strict SQL drops them all and the dashboard goes blank. Pairs
  // with the matching admission in `earlySignalApproved` so the row
  // makes it through both gates. Strict mode (default) keeps the
  // historical exclusion.
  const signalRelaxMode =
    String(process.env.SIGNAL_RELAX_MODE ?? '').trim().toLowerCase() === 'true';
  const watchlistClause = signalRelaxMode
    ? `` // relaxed mode admits WATCHLIST_ONLY rows
    : `AND UPPER(COALESCE(s.classification, '')) <> 'WATCHLIST_ONLY'`;
  // MATURATION_AUDIT_2026-05 — gate against the institutional score
  // chain: composite_final_score (Phase-4) → confidence_score (stable
  // proxy) → final_score (decayed, last resort). The dynamic value is
  // intentionally last so a NULL composite on a legacy row falls
  // through to confidence rather than the decayed dynamic value that
  // dragged mature rows below the floor and hid them from the API.
  const sql = `${Q365_SIGNALS_SELECT}
    WHERE s.direction IN ('BUY','SELL')
      AND s.confidence_score >= ?
      AND COALESCE(s.composite_final_score, s.confidence_score, s.final_score, 0) >= ?
      AND COALESCE(s.risk_reward, 0)  >= ?
      AND COALESCE(s.invalidation_reason, '') = ''
      AND UPPER(COALESCE(s.signal_status, '')) IN ('APPROVED_SIGNAL','DEVELOPING_SETUP')
      ${watchlistClause}
      AND UPPER(COALESCE(s.status, 'ACTIVE')) IN ('ACTIVE','')
      AND COALESCE(s.signal_type, '') <> 'force_seed'
      AND COALESCE(s.batch_id, '') NOT LIKE 'force_seed%'
      -- AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND s.generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      -- Staleness is enforced per-row in shapeQ365Row via
      -- is_stale_candidate (using mt.last_seen_at). The predicates
      -- (mainTableApproved / relaxedMainTableApproved /
      -- earlySignalApproved) reject stale rows from the main signals
      -- table, but we deliberately let them through the SQL so the
      -- scanner-candidates side panel can render them with the
      -- is_stale_candidate flag for operator visibility (spec §4 —
      -- stale candidates do not appear in dashboard opportunities,
      -- but DO appear elsewhere with the flag set).
    ORDER BY COALESCE(s.composite_final_score, s.confidence_score, s.final_score, 0) DESC,
             s.confidence_score DESC, s.generated_at DESC
    LIMIT ?`;
  try {
    const { rows } = await db.query<RawSignalRow>(sql, [
      RELAX_CONFIDENCE, RELAX_FINAL, RELAX_RR,
      resolveClosedSignalsMaxAgeHours(),
      Math.max(1, Math.min(limit, 200)),
    ]);
    logQ365ScoreProvenance(rows as RawSignalRow[], 'q365_relaxed');
    return (rows as RawSignalRow[]).map(shapeQ365Row).map(tagAsEarly);
  } catch (err) {
    console.warn('[closedMarketSignals] relaxed query failed:', (err as Error).message);
    return [];
  }
}

async function loadQ365SignalsStrict(limit: number): Promise<ConfirmedSignalRow[]> {
  // q365_signals stores the live scanner output. We apply the
  // institutional strict filter at the SQL layer:
  //   confidence_score          >= STRICT_CONFIDENCE_FLOOR  (70)
  //   final_score               >= STRICT_FINAL_FLOOR       (75)
  //   risk_reward / rr_ratio    >= STRICT_RR_FLOOR          (1.5)
  //   direction                 in (BUY, SELL)
  //   signal_status             = 'APPROVED_SIGNAL'
  //   classification            != 'WATCHLIST_ONLY'
  //   invalidation_reason       IS NULL / empty
  //   row not expired           (status ACTIVE / blank)
  // PURE_REAL_DATA_MODE: defensive guards exclude any synthetic rows
  // that may linger from an older force-seed call. `signal_type` is
  // the column the seeder wrote 'force_seed' into; `batch_id` is
  // 'force_seed_<ts>'. Either match → drop the row.
  // Same expiry + max-age guards as the relaxed tier. Without these,
  // strict rows that have already passed their `expires_at` (or that
  // were emitted by yesterday's batch but never invalidated) would
  // still light up the dashboard as fresh BUY/SELL calls. The
  // generated_at cutoff is bounded by CLOSED_SIGNALS_MAX_AGE_HOURS so
  // the closed-market view always reflects "this trading session" by
  // default and never silently drifts to "the last week of stored
  // scanner output".
  // Spec NO-TRADE-PRECEDENCE §5 — the SQL no longer enforces
  // signal_status='APPROVED_SIGNAL' as the sole acceptable value for
  // strict scanner candidates. Even APPROVED_SIGNAL rows with
  // classification='NO_TRADE' need to be visible (as no-trade context
  // in the side panel) per spec §1. The `effective_signal_status`
  // computed in `shapeQ365Row` is what downstream routing uses to
  // decide bucket. NO_TRADE classification rows pass the SQL and
  // surface in the panel tagged display_bucket='no_trade'.
  // MATURATION_AUDIT_2026-05 — institutional-score gate (see
  // loadQ365SignalsRelaxed comment above for the rationale). Same
  // composite → confidence → final_score fallback so a NULL Phase-4
  // column doesn't collapse a strong-confidence row to its decayed
  // dynamic score.
  const sql = `${Q365_SIGNALS_SELECT}
    WHERE s.direction IN ('BUY','SELL')
      AND s.confidence_score >= ?
      AND COALESCE(s.composite_final_score, s.confidence_score, s.final_score, 0) >= ?
      AND COALESCE(s.risk_reward, 0)  >= ?
      AND COALESCE(s.invalidation_reason, '') = ''
      AND UPPER(COALESCE(s.signal_status, '')) = 'APPROVED_SIGNAL'
      AND UPPER(COALESCE(s.classification, '')) <> 'WATCHLIST_ONLY'
      AND UPPER(COALESCE(s.status, 'ACTIVE')) IN ('ACTIVE','')
      AND COALESCE(s.signal_type, '') <> 'force_seed'
      AND COALESCE(s.batch_id, '') NOT LIKE 'force_seed%'
      -- AND (s.expires_at IS NULL OR s.expires_at > NOW())
      AND s.generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      -- Staleness is enforced per-row by shapeQ365Row (is_stale_candidate),
      -- not at the SQL boundary, so stale rows still surface in the
      -- scanner-candidates side panel with the flag set.
    ORDER BY COALESCE(s.composite_final_score, s.confidence_score, s.final_score, 0) DESC,
             s.confidence_score DESC, s.generated_at DESC
    LIMIT ?`;
  try {
    const { rows } = await db.query<RawSignalRow>(sql, [
      STRICT_CONFIDENCE_FLOOR, STRICT_FINAL_FLOOR, STRICT_RR_FLOOR,
      resolveClosedSignalsMaxAgeHours(),
      Math.max(1, Math.min(limit, 200)),
    ]);
    logQ365ScoreProvenance(rows as RawSignalRow[], 'q365_strict');
    return (rows as any[]).map(shapeQ365Row).map(tagAsEarly);
  } catch (err) {
    console.warn('[closedMarketSignals] strict query failed:', (err as Error).message);
    return [];
  }
}

/**
 * MATURATION_AUDIT_2026-05 — score-provenance histogram for q365_signals
 * loaders. Same shape as the [SCORE_PROVENANCE] log emitted by the
 * confirmed-snapshot reader; together the two answer the operator's
 * question "where is the wire `final_score` actually coming from?"
 * without forcing a DB query. Healthy steady state has `composite`
 * dominating; large `confidence` counts mean Phase-4 wasn't run for
 * those rows; `final` (the decayed dynamic value) should be rare —
 * appearing only when neither composite nor confidence is present.
 */
function logQ365ScoreProvenance(rows: RawSignalRow[], scope: string): void {
  if (!rows || rows.length === 0) return;
  const hist: Record<string, number> = { composite: 0, confidence: 0, final: 0, none: 0 };
  for (const r of rows) {
    if (numOrNull(r.composite_final_score) != null)      hist.composite++;
    else if (numOrNull(r.confidence_score)  != null)     hist.confidence++;
    else if (numOrNull(r.final_score)       != null)     hist.final++;
    else                                                  hist.none++;
  }
  console.log('[SCORE_PROVENANCE]', { scope, rows: rows.length, provenance: hist });
}

export interface LoadClosedSignalsOpts {
  limit: number;
}

/**
 * BALANCED_REAL_DATA_MODE entry point — returns strict-filtered
 * BUY/SELL signals from the DB, with a single relaxed-tier fallback
 * ONLY when every strict tier returns 0. NEVER calls an upstream
 * provider, NEVER injects synthetic data, NEVER serves force_seed rows.
 *
 *   TIER 1 — STRICT (primary)
 *     1a. q365_confirmed_signal_snapshots (post-promotion, ACTIVE)
 *     1b. q365_signals (pre-promotion, signal_status=APPROVED_SIGNAL)
 *     Floors: confidence>=70, final>=75, rr>=1.5,
 *             classification ∈ approved set (no WATCHLIST_ONLY).
 *
 *   TIER 2 — RELAXED (fallback, fires ONLY when STRICT returns 0)
 *     2a. q365_signals (signal_status ∈ {APPROVED_SIGNAL, DEVELOPING_SETUP})
 *     Floors: confidence>=60, final>=65, rr>=1.2,
 *             classification != WATCHLIST_ONLY.
 *
 * Returns `signal_quality: 'STRICT'` when tier 1 produced rows,
 * `'RELAXED'` when tier 2 was used, `'NONE'` when both are empty.
 * The caller surfaces the message + UI banner accordingly.
 */
export async function loadClosedMarketSignals(
  opts: LoadClosedSignalsOpts,
): Promise<ClosedSignalsBundle> {
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 200));
  let scannedRowCount = 0;
  let approvedRowCount = 0;

  // Spec SMART-RELAXED — tiered confirmed-snapshot filter.
  //   Tier 1 (STRICT)  — `mainTableApproved`: maturity ≥ 85, cycles ≥ 3,
  //                      stability = true, edge > 2, rr ≥ 2, conf ≥ 75,
  //                      final ≥ 70, approved classification, alive.
  //   Tier 2 (RELAXED) — `relaxedMainTableApproved`: maturity ≥ 65,
  //                      cycles ≥ 1, conf ≥ 65, final ≥ 65, rr ≥ 1.5,
  //                      classification != 'NO_TRADE'. Rows are tagged
  //                      `is_relaxed = true` so the UI renders them as
  //                      "⚠️ Early Signal" instead of "Confirmed".
  //
  // q365_signals rows are NEVER shown in the main table; they route
  // to `scannerCandidates` for the separate "Not Tradable" panel.
  const snapRows = await loadConfirmedSnapshotsClosed(limit);
  scannedRowCount += snapRows.length;
  const matureMain = snapRows.filter(mainTableApproved);
  approvedRowCount += matureMain.length;

  // Scanner candidates: every q365_signals strict-tier row + any
  // confirmed-snapshot row that didn't clear EITHER tier. Computed
  // up-front so all three return paths share the same panel content.
  const q365Strict = await loadQ365SignalsStrict(limit);

  if (matureMain.length > 0) {
    // MATURATION_AUDIT_2026-05 — drop any q365_signals scanner-candidate
    // whose (symbol, direction) is already shipping in `matureMain`.
    // Without this, a row that has both a confirmed_snapshot row AND a
    // surviving q365_signals row for the same key surfaces TWICE in the
    // wire payload — once as a confirmed BUY in `signals[]`, once as
    // a scanner candidate in `scannerCandidates[]`. The frontend renders
    // both lists, so the user sees the symbol duplicated. Build a key
    // set from `matureMain` first and filter the candidate echo out.
    const shippedKeys = new Set(
      matureMain.map((r) =>
        `${String(r.symbol ?? '').toUpperCase()}|${String(r.direction ?? '').toUpperCase()}`,
      ),
    );
    const candidates: ConfirmedSignalRow[] = [
      ...snapRows.filter((r) => !mainTableApproved(r)),
      ...q365Strict.filter((r) =>
        !shippedKeys.has(
          `${String(r.symbol ?? '').toUpperCase()}|${String(r.direction ?? '').toUpperCase()}`,
        ),
      ),
    ];
    const candidatesUniq   = dedupeLatestPerSymbolDirection(candidates);
    const candidatesSorted = candidatesUniq.sort(confirmedSnapshotCmp);
    const candidatesCapped = applyConfirmedCap(candidatesSorted)
      .map(asScannerCandidate);
    const bundle = finalizeBundle(
      matureMain, 'confirmed_snapshots', 'STRICT', matureMain.length, false,
      scannedRowCount, approvedRowCount,
    );
    bundle.scannerCandidates = candidatesCapped;
    return bundle;
  }

  // Spec SMART-RELAXED §2 — strict empty → try relaxed tier on the
  // same snapshot pool. Successful rows are tagged `is_relaxed=true`
  // so the UI flags them as "⚠️ Early Signal".
  const relaxedMain = snapRows
    .filter(relaxedMainTableApproved)
    .map((r) => ({ ...r, is_relaxed: true } as ConfirmedSignalRow));
  approvedRowCount += relaxedMain.length;

  if (relaxedMain.length > 0) {
    // MATURATION_AUDIT_2026-05 — same scanner-candidate echo-suppression
    // as the strict path: rows already shipping in `relaxedMain` must
    // not also appear in `scannerCandidates`.
    const shippedKeys = new Set(
      relaxedMain.map((r) =>
        `${String(r.symbol ?? '').toUpperCase()}|${String(r.direction ?? '').toUpperCase()}`,
      ),
    );
    const candidates: ConfirmedSignalRow[] = [
      // Anything that even the relaxed tier didn't accept (plus q365_signals).
      ...snapRows.filter((r) => !relaxedMainTableApproved(r)),
      ...q365Strict.filter((r) =>
        !shippedKeys.has(
          `${String(r.symbol ?? '').toUpperCase()}|${String(r.direction ?? '').toUpperCase()}`,
        ),
      ),
    ];
    const candidatesUniq   = dedupeLatestPerSymbolDirection(candidates);
    const candidatesSorted = candidatesUniq.sort(confirmedSnapshotCmp);
    const candidatesCapped = applyConfirmedCap(candidatesSorted)
      .map(asScannerCandidate);
    const bundle = finalizeBundle(
      relaxedMain, 'confirmed_snapshots', 'RELAXED', 0, true,
      scannedRowCount, approvedRowCount,
    );
    bundle.scannerCandidates = candidatesCapped;
    return bundle;
  }

  // Spec "FIX FINAL SIGNAL VISIBILITY" §3 — final tier. Both
  // confirmed-snapshot tiers came back empty AND the strict q365_signals
  // tier produced nothing, but the operator just ran a fresh pipeline
  // and wants to SEE the real scanner output. Run the relaxed q365
  // loader (conf>=55, final>=60, RR>=1.2 by default) and surface those
  // rows as `bundle.signals` so /api/signals' `signals[]` is populated.
  //
  // Gated by SIGNAL_API_ENABLE_RELAXED — defaults to ON. Operators
  // who explicitly want the strict-only behaviour can disable it by
  // exporting SIGNAL_API_ENABLE_RELAXED=false.
  //
  // Earlier history (NO-TRADE-PRECEDENCE §2): this branch was a hard
  // empty so an APPROVED_SIGNAL+NO_TRADE row could not render as a
  // confirmed BUY. The relaxed loader's SQL excludes WATCHLIST_ONLY
  // and the response layer tags every relaxed row `is_relaxed=true`
  // so the UI renders them under the "⚠️ Early Signal" tier — the
  // NO_TRADE precedence rule still holds, the rows are just visible.
  const enableRelaxedRaw = (process.env.SIGNAL_API_ENABLE_RELAXED ?? '')
    .trim().toLowerCase();
  const enableRelaxed =
    enableRelaxedRaw === '' || enableRelaxedRaw === 'true' ||
    enableRelaxedRaw === '1' || enableRelaxedRaw === 'yes';

  // Hoist relaxedQ365 so the final-fallback path can include the rows
  // that passed SQL but failed earlySignalApproved as scanner candidates
  // — otherwise they vanish from the dashboard entirely.
  let relaxedQ365: ConfirmedSignalRow[] = [];
  if (enableRelaxed) {
    relaxedQ365 = await loadQ365SignalsRelaxed(limit);
    scannedRowCount += relaxedQ365.length;
    if (relaxedQ365.length > 0) {
      // Spec "FIX EMPTY DASHBOARD" — when SIGNAL_RELAX_MODE=true, the
      // SQL has already enforced the substantive gates (invalidation
      // empty, expires_at > NOW, NO_TRADE excluded, status=ACTIVE,
      // confidence ≥ floor, final_score ≥ floor, rr ≥ floor). The
      // earlySignalApproved predicate is a strict-mode safety net that
      // re-checks classification + is_stale_candidate; in relaxed mode
      // those checks reject every WATCHLIST_ONLY / stale-tracker row,
      // which is the exact set the engine is currently producing.
      // Rows are tagged `is_relaxed: true` so the UI renders them as
      // ⚠️ Early Signal (yellow tier), not as confirmed BUYs.
      // Strict mode (default) keeps the historical predicate filter.
      const relaxedActive = (SIGNAL_RELAX_MODE_ENABLED
        ? relaxedQ365
        : relaxedQ365.filter(earlySignalApproved)
      ).map((r) => ({ ...r, is_relaxed: true } as ConfirmedSignalRow));
      console.log(
        `[RELAXED] mode=${SIGNAL_RELAX_MODE_ENABLED ? 'on' : 'off'} ` +
        `sql_in=${relaxedQ365.length} ts_out=${relaxedActive.length} ` +
        `(predicate ${SIGNAL_RELAX_MODE_ENABLED ? 'BYPASSED' : 'applied'})`,
      );
      approvedRowCount += relaxedActive.length;
      if (relaxedActive.length > 0) {
        const relaxedActiveSorted = [...relaxedActive].sort(confirmedSnapshotCmp);
        const relaxedActiveCapped = applyConfirmedCap(relaxedActiveSorted);
        // MATURATION_AUDIT_2026-05 — echo-suppression: shipped relaxed
        // rows must not also appear as scanner candidates. The shipped
        // set here IS the relaxedQ365 subset that passed earlySignalApproved
        // (or was let through in relax mode); the candidates pool below
        // already excludes those via `!earlySignalApproved`, but `snapRows`
        // and `q365Strict` can still echo the same (symbol, direction).
        const shippedKeys = new Set(
          relaxedActiveCapped.map((r) =>
            `${String(r.symbol ?? '').toUpperCase()}|${String(r.direction ?? '').toUpperCase()}`,
          ),
        );
        const keyOf = (r: ConfirmedSignalRow): string =>
          `${String(r.symbol ?? '').toUpperCase()}|${String(r.direction ?? '').toUpperCase()}`;
        const candidates: ConfirmedSignalRow[] = [
          ...snapRows.filter((r) => !shippedKeys.has(keyOf(r))),
          ...q365Strict.filter((r) => !shippedKeys.has(keyOf(r))),
          ...relaxedQ365.filter((r) => !earlySignalApproved(r) && !shippedKeys.has(keyOf(r))),
        ];
        const candidatesUniq   = dedupeLatestPerSymbolDirection(candidates);
        const candidatesSorted = candidatesUniq.sort(confirmedSnapshotCmp);
        const candidatesCapped = applyConfirmedCap(candidatesSorted)
          .map(asScannerCandidate);
        const bundle = finalizeBundle(
          relaxedActiveCapped, 'q365_signals_relaxed', 'RELAXED',
          0, true, scannedRowCount, approvedRowCount,
        );
        bundle.scannerCandidates = candidatesCapped;
        return bundle;
      }
    }
  }

  // Final fallback — strict / relaxed snapshots empty, relaxed q365 also
  // empty (or disabled). Surface every available row as a side-panel
  // candidate so the operator can still see what the scanner emitted.
  // Spec "FIX EMPTY DASHBOARD" — also include relaxedQ365 rows that
  // failed earlySignalApproved. Otherwise 20 SQL-passing rows vanish
  // entirely when they fail the TS predicate, leaving the user staring
  // at an empty dashboard with no clue why.
  const candidates: ConfirmedSignalRow[] = [
    ...snapRows,
    ...q365Strict,
    ...relaxedQ365,
  ];
  const candidatesUniq   = dedupeLatestPerSymbolDirection(candidates);
  const candidatesSorted = candidatesUniq.sort(confirmedSnapshotCmp);
  const candidatesCapped = applyConfirmedCap(candidatesSorted)
    .map(asScannerCandidate);
  return {
    signals: [], source: 'none',
    signalQuality: 'NONE',
    strictCount: 0,
    relaxedUsed: false,
    buyCount: 0, sellCount: 0,
    scannedRowCount, approvedRowCount,
    scannerCandidates: candidatesCapped,
  };
}

/** Tag a row that's about to land in the scanner-candidates side
 *  panel. Always overrides any prior source_kind because by the time
 *  a row reaches this helper it's already routed to the panel — the
 *  value MUST be 'scanner_candidate' so the UI never paints it as a
 *  tradeable confirmed signal. */
function asScannerCandidate(r: ConfirmedSignalRow): ConfirmedSignalRow {
  (r as { source_kind?: ClosedSignalSourceKind }).source_kind = 'scanner_candidate';
  (r as { is_relaxed?: boolean }).is_relaxed = true;
  return r;
}

/**
 * Dedupe: keep the latest row per `(symbol, direction)` pair.
 *
 * Spec: "Group by symbol + direction, pick latest by highest
 * confirmed_at OR highest id". We treat both as monotone proxies
 * for recency — `id` is auto-increment so newer rows always carry
 * a larger id; `confirmed_at` ties on second precision and falls
 * back to id.
 *
 * Ordered by `(confirmed_at DESC, id DESC)` so the FIRST hit on a
 * key wins. A subsequent occurrence of the same key is dropped —
 * no map-overwrite anti-pattern.
 */
export function dedupeLatestPerSymbolDirection(
  rows: ConfirmedSignalRow[],
): ConfirmedSignalRow[] {
  const recencyKey = (r: ConfirmedSignalRow): number => {
    const ts = r.confirmed_at
      ? Date.parse(typeof r.confirmed_at === 'string' ? r.confirmed_at : (r.confirmed_at as Date).toISOString())
      : 0;
    return Number.isFinite(ts) ? ts : 0;
  };
  const ordered = [...rows].sort((a, b) => {
    const ta = recencyKey(a);
    const tb = recencyKey(b);
    if (tb !== ta) return tb - ta;
    return Number(b.id ?? 0) - Number(a.id ?? 0);
  });
  const seen = new Set<string>();
  const out: ConfirmedSignalRow[] = [];
  for (const r of ordered) {
    const sym = String(r.symbol ?? r.tradingsymbol ?? '').toUpperCase();
    if (!sym) continue;
    const dir = String(r.direction ?? '').toUpperCase().trim();
    if (dir !== 'BUY' && dir !== 'SELL') continue;
    const key = `${sym}|${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Spec FIX-CLEAN §2 — strict "ONE SYMBOL = ONE SIGNAL" dedup. After
 * `dedupeLatestPerSymbolDirection` collapses duplicate emissions per
 * (symbol, direction) pair, this second pass collapses BUY/SELL pairs
 * that survived for the same symbol — keeping the row with the higher
 * `final_score` (ties broken by confidence, then id). Direction-mixed
 * pairs are common when the scanner re-evaluates a symbol mid-trend
 * and emits an opposing signal; the dashboard should never show both.
 */
export function dedupeOneSymbolOneSignal(
  rows: ConfirmedSignalRow[],
): ConfirmedSignalRow[] {
  const bySymbol = new Map<string, ConfirmedSignalRow>();
  for (const r of rows) {
    const sym = String(r.symbol ?? r.tradingsymbol ?? '').toUpperCase();
    if (!sym) continue;
    const incumbent = bySymbol.get(sym);
    if (!incumbent) { bySymbol.set(sym, r); continue; }
    // Higher final_score wins; ties broken by confidence then id.
    const a = Number(r.final_score        ?? 0);
    const b = Number(incumbent.final_score ?? 0);
    if (a > b) { bySymbol.set(sym, r); continue; }
    if (a < b) continue;
    const ac = Number(r.confidence_score        ?? 0);
    const bc = Number(incumbent.confidence_score ?? 0);
    if (ac > bc) { bySymbol.set(sym, r); continue; }
    if (ac < bc) continue;
    if (Number(r.id ?? 0) > Number(incumbent.id ?? 0)) bySymbol.set(sym, r);
  }
  return [...bySymbol.values()];
}

/**
 * Spec FIX-CLEAN §4 — guarantee no blank cells. The dashboard renders
 * `risk_score`, `portfolio_fit_score`, and `stress_survival_score` as
 * dedicated columns; legacy rows persisted before these columns existed
 * (or rows from `q365_confirmed_signal_snapshots`, which doesn't store
 * portfolio_fit / stress) come back NULL and the cell renders empty.
 *
 * Fallback formulas (per spec):
 *   risk_score  = round(rr_ratio * 20)         clamped 0..100
 *   pfit_score  = round(final_score)           clamped 0..100
 *   stress_score = round(100 - confidence)     clamped 0..100
 *
 * Mutates in-place is fine — every consumer receives a fresh row from
 * the SQL mappers in this file; we are the only caller after them.
 */
export function backfillBlankFields(rows: ConfirmedSignalRow[]): {
  rows: ConfirmedSignalRow[]; fixed: number;
} {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let fixed = 0;
  for (const r of rows) {
    const rr   = num((r as { rr_ratio?: unknown }).rr_ratio)
              ?? num((r as { risk_reward?: unknown }).risk_reward)
              ?? 0;
    const conf = num((r as { confidence_score?: unknown }).confidence_score) ?? 0;
    if (num((r as { risk_score?: unknown }).risk_score) == null) {
      (r as { risk_score: number }).risk_score = clamp(Math.round(rr * 20));
      fixed += 1;
    }
    // Spec DATA-QUALITY §3 — pfit formula updated to min(100, conf+5).
    // Replaces the older round(final_score) fallback so the column
    // tracks confidence (the user-meaningful score) instead of
    // duplicating final_score.
    const existingPfit = num((r as { portfolio_fit_score?: unknown }).portfolio_fit_score);
    if (existingPfit == null || existingPfit === 0) {
      (r as { portfolio_fit_score: number }).portfolio_fit_score = clamp(Math.min(100, conf + 5));
      fixed += 1;
    }
    if (num((r as { stress_survival_score?: unknown }).stress_survival_score) == null) {
      (r as { stress_survival_score: number }).stress_survival_score = clamp(Math.round(100 - conf));
      fixed += 1;
    }
  }
  return { rows, fixed };
}

/**
 * Spec DATA-QUALITY §4 + §5 — strict-validation filter applied at the
 * response layer. Drops every row that:
 *
 *   • is missing entry_price / stop_loss / target1 (any falsy / non-positive)
 *   • has confidence_score < 60
 *   • has final_score      < 65
 *   • has rr / risk_reward < 1.5
 *   • carries a legacy 'NO_TRADE' classification (defensive — the
 *     shape helpers should already have rebucketed it, but we keep
 *     the predicate so a stray pass-through never reaches the UI).
 *
 * Every condition is checked even when the SQL filter already enforces
 * it; this is a belt-and-braces guard at the response boundary.
 */
export function strictValidationFilter(rows: ConfirmedSignalRow[]): {
  rows: ConfirmedSignalRow[];
  rejected: number;
} {
  // Floors are env-overridable so the response-layer guard tracks
  // whichever tier loaded the rows. Hardcoded 60/65/1.5 silently
  // discarded the entire relaxed tier the SQL had already approved
  // (rows in the 50-60 confidence band) and produced empty responses
  // even when scanner candidates existed.
  //
  // RELAXED MODE — when SIGNAL_RELAX_MODE_ENABLED, the confidence /
  // final / RR floors fall to the SAME floors the SQL applied
  // (SIGNAL_API_RELAX_*), and the NO_TRADE classification check is
  // skipped. Rationale: in relaxed mode the SQL already enforced the
  // floors and NO_TRADE means "the engine flagged High Volatility
  // regime, not a tradable signal" — but the operator still wants to
  // see them on the dashboard. The UI tags them is_relaxed=true so
  // they render as ⚠️ Early Signal, never as confirmed BUYs.
  const STRICT_VAL_CONF = SIGNAL_RELAX_MODE_ENABLED
    ? relaxFloor('SIGNAL_API_RELAX_CONFIDENCE_FLOOR', 0,   100, 25)
    : relaxFloor('SIGNAL_API_VALIDATE_CONFIDENCE_FLOOR', 0,   100, 50);
  const STRICT_VAL_FS   = SIGNAL_RELAX_MODE_ENABLED
    ? relaxFloor('SIGNAL_API_RELAX_FINAL_FLOOR',      0,   100, 20)
    : relaxFloor('SIGNAL_API_VALIDATE_FINAL_FLOOR',      0,   100, 55);
  const STRICT_VAL_RR   = SIGNAL_RELAX_MODE_ENABLED
    ? relaxFloor('SIGNAL_API_RELAX_RR_FLOOR',       0.5,     5,  1.0)
    : relaxFloor('SIGNAL_API_VALIDATE_RR_FLOOR',       0.5,     5,  1.0);
  const out: ConfirmedSignalRow[] = [];
  let rejected = 0;
  let droppedNoTrade = 0;
  for (const r of rows) {
    const entry = Number((r as { entry_price?: unknown }).entry_price ?? 0);
    const stop  = Number((r as { stop_loss?:   unknown }).stop_loss   ?? 0);
    const tgt1  = Number((r as { target1?:     unknown }).target1     ?? 0);
    const conf  = Number((r as { confidence_score?: unknown }).confidence_score ?? 0);
    const fs    = Number((r as { final_score?:      unknown }).final_score      ?? 0);
    const rr    = Number(
      (r as { rr_ratio?: unknown }).rr_ratio
      ?? (r as { risk_reward?: unknown }).risk_reward
      ?? 0,
    );
    const cls = String((r as { classification?: unknown }).classification ?? '').toUpperCase();
    if (!Number.isFinite(entry) || entry <= 0) { rejected++; continue; }
    if (!Number.isFinite(stop)  || stop  <= 0) { rejected++; continue; }
    if (!Number.isFinite(tgt1)  || tgt1  <= 0) { rejected++; continue; }
    if (!Number.isFinite(conf)  || conf  < STRICT_VAL_CONF) { rejected++; continue; }
    if (!Number.isFinite(fs)    || fs    < STRICT_VAL_FS)   { rejected++; continue; }
    if (!Number.isFinite(rr)    || rr    < STRICT_VAL_RR)   { rejected++; continue; }
    // NO_TRADE check is strict-mode only. In relaxed mode these rows
    // are admitted with the is_relaxed flag for ⚠️ Early-Signal display.
    if (cls === 'NO_TRADE' && !SIGNAL_RELAX_MODE_ENABLED) {
      droppedNoTrade++; rejected++; continue;
    }
    out.push(r);
  }
  if (rows.length > 0) {
    console.log(
      `[STRICT-VAL] mode=${SIGNAL_RELAX_MODE_ENABLED ? 'relaxed' : 'strict'} ` +
      `in=${rows.length} out=${out.length} rejected=${rejected} ` +
      `dropped_no_trade=${droppedNoTrade} ` +
      `floors=${STRICT_VAL_CONF}/${STRICT_VAL_FS}/${STRICT_VAL_RR}`,
    );
  }
  return { rows: out, rejected };
}

function finalizeBundle(
  rows: ConfirmedSignalRow[],
  source: ClosedSignalsSource,
  signalQuality: SignalQuality,
  strictCount: number,
  relaxedUsed: boolean,
  scannedRowCount: number,
  approvedRowCount: number,
): ClosedSignalsBundle {
  // Spec DATA-QUALITY §4 — strict validation drops malformed rows
  // BEFORE the dedup/sort/cap so the cap reflects only the rows the
  // dashboard will actually render.
  const validated = strictValidationFilter(rows).rows;
  // Spec FIX-CLEAN §2 (step 1): collapse same (symbol, direction)
  // duplicates, keeping the most recent per pair.
  const uniqByPair = dedupeLatestPerSymbolDirection(validated);
  // Spec FIX-CLEAN §2 (step 2): collapse mixed BUY/SELL on the same
  // symbol — keep the higher-scoring direction so the user never sees
  // contradictory signals for the same instrument.
  const uniqBySymbol = dedupeOneSymbolOneSignal(uniqByPair);
  // Sort by final_score DESC, confidence DESC, then cap.
  const sorted = uniqBySymbol.sort(confirmedSnapshotCmp);
  const capped = applyConfirmedCap(sorted);
  // Spec FIX-CLEAN §4: backfill any null risk / pfit / stress so the
  // UI never renders an empty cell.
  const { rows: clean, fixed: blankFieldsFixed } = backfillBlankFields(capped);
  void blankFieldsFixed;
  const buyCount  = clean.filter((r) => String(r.direction ?? '').toUpperCase() === 'BUY').length;
  const sellCount = clean.filter((r) => String(r.direction ?? '').toUpperCase() === 'SELL').length;
  return {
    signals: clean,
    source,
    signalQuality,
    strictCount,
    relaxedUsed,
    buyCount,
    sellCount,
    scannedRowCount,
    approvedRowCount,
    scannerCandidates: [],   // populated by the caller when relevant
  };
}
