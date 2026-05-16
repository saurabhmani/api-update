// ════════════════════════════════════════════════════════════════
//  signalRanking — PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05
//
//  Universal helpers for sorting institutional signal lists by their
//  highest final score and for surfacing "closest to approval"
//  candidates when no approved signal is available.
//
//  Pure module — no I/O, no DB. The functions are deliberately wide:
//  they accept anything shaped roughly like a signal row so callers
//  (response assembler, route handler, page) can use the same logic.
//
//  CRITICAL: nothing in this file relaxes institutional approval
//  thresholds. The approval-gap output is purely for display and
//  explainability; the strict gate stays the single source of truth
//  for whether a signal is APPROVED.
// ════════════════════════════════════════════════════════════════

/** Institutional approval thresholds used by the gap calculation.
 *  These mirror the operator-defined institutional bar:
 *    final_score      >= 80
 *    confidence_score >= 75
 *    risk_reward      >= 2.0
 *  They are intentionally NOT imported from confirmedSignalPolicy —
 *  that module's elite floors are env-overridable and may be relaxed
 *  for the gate. This file exposes the "ideal institutional target"
 *  the operator stated, so the approval gap reflects what the user
 *  expects rather than the current env-tuned floor. */
export const APPROVAL_TARGET_FINAL_SCORE = 80;
export const APPROVAL_TARGET_CONFIDENCE  = 75;
export const APPROVAL_TARGET_RISK_REWARD = 2.0;

/** Wide row shape — every signal-list consumer reads a subset of these
 *  fields. Optional everywhere so the helpers work for both compact
 *  and full payloads. */
export interface RankableSignal {
  symbol?:                string | null;
  tradingsymbol?:         string | null;
  direction?:             string | null;
  final_score?:           number | null;
  composite_final_score?: number | null;
  institutional_score?:   number | null;
  confidence_score?:      number | null;
  confidence?:            number | null;
  risk_reward?:           number | null;
  rr_ratio?:              number | null;
  riskReward?:            number | null;
  generated_at?:          string | Date | null;
  last_updated_at?:       string | Date | null;
  updated_at?:            string | Date | null;
  created_at?:            string | Date | null;
  volume_confirmation?:   number | null;
  volume_score?:          number | null;
  freshness_state?:       string | null;
  decay_state?:           string | null;
  status?:                string | null;
  signal_status?:         string | null;
  classification?:        string | null;
  raw_classification?:    string | null;
  invalidation_reason?:   string | null;
  live_invalidated?:      boolean | null;
  execution_allowed?:     boolean | null;
  tradeability_status?:   string | null;
  is_relaxed?:            boolean | null;
  is_demoted?:            boolean | null;
  is_scanner_candidate?:  boolean | null;
  is_developing_setup?:   boolean | null;
  valid_until?:           string | Date | null;
  rejection_reason?:      string | null;
  rejection_codes?:       string[] | null;
}

const toNum = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toTime = (v: string | Date | null | undefined): number => {
  if (v == null) return 0;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
};

/** Read the dominant "final score" off a row, falling back through the
 *  documented aliases. Returns 0 when nothing usable is present. */
export function getSignalFinalScore(signal: RankableSignal | null | undefined): number {
  if (!signal) return 0;
  return toNum(
    signal.final_score
    ?? signal.composite_final_score
    ?? signal.institutional_score
    ?? signal.confidence_score
    ?? signal.confidence,
  );
}

/** Read the confidence score off a row with documented aliases. */
export function getSignalConfidence(signal: RankableSignal | null | undefined): number {
  if (!signal) return 0;
  return toNum(signal.confidence_score ?? signal.confidence);
}

/** Read the risk/reward off a row with documented aliases. */
export function getSignalRiskReward(signal: RankableSignal | null | undefined): number {
  if (!signal) return 0;
  return toNum(signal.risk_reward ?? signal.rr_ratio ?? signal.riskReward);
}

/** Read the most recent freshness timestamp off a row. */
export function getSignalFreshness(signal: RankableSignal | null | undefined): number {
  if (!signal) return 0;
  return toTime(
    signal.generated_at
    ?? signal.last_updated_at
    ?? signal.updated_at
    ?? signal.created_at,
  );
}

const getVolumeStrength = (signal: RankableSignal | null | undefined): number => {
  if (!signal) return 0;
  return toNum(signal.volume_confirmation ?? signal.volume_score);
};

/** Universal institutional ranking comparator. Highest final score
 *  wins; ties broken by confidence, then risk/reward, then freshness,
 *  then volume confirmation strength. Same input → same output. */
export function rankSignalsByInstitutionalScore<T extends RankableSignal>(
  signals: readonly T[] | null | undefined,
): T[] {
  if (!signals || signals.length === 0) return [];
  return [...signals].sort((a, b) => {
    const fb = getSignalFinalScore(b);
    const fa = getSignalFinalScore(a);
    if (fb !== fa) return fb - fa;
    const cb = getSignalConfidence(b);
    const ca = getSignalConfidence(a);
    if (cb !== ca) return cb - ca;
    const rb = getSignalRiskReward(b);
    const ra = getSignalRiskReward(a);
    if (rb !== ra) return rb - ra;
    const tb = getSignalFreshness(b);
    const ta = getSignalFreshness(a);
    if (tb !== ta) return tb - ta;
    const vb = getVolumeStrength(b);
    const va = getVolumeStrength(a);
    if (vb !== va) return vb - va;
    return 0;
  });
}

const STALE_DECAY = new Set(['stale', 'aging', 'expired']);
const STALE_FRESH = new Set(['STALE', 'AGING', 'EXPIRED']);

const isStaleSignal = (signal: RankableSignal): boolean => {
  const fresh = String(signal.freshness_state ?? '').toUpperCase();
  if (fresh && STALE_FRESH.has(fresh)) return true;
  const decay = String(signal.decay_state ?? '').toLowerCase();
  if (decay && STALE_DECAY.has(decay)) return true;
  return false;
};

const HARD_REJECTION_REASON = /invalidated|expired|stop[_ ]?loss|severe|corrupt|execution[_ ]?blocked/i;

/** True when the signal carries a HARD rejection that disqualifies it
 *  from being shown anywhere — invalidated setup, expired, stop loss
 *  breached, execution blocked, severe liquidity failure, etc.
 *
 *  Soft rejections (final/confidence/RR slightly below floor, awaiting
 *  volume confirmation, market closed confirmation pending) are NOT
 *  caught here — those rows are valid "closest to approval" candidates. */
export function isHardInvalidated(signal: RankableSignal | null | undefined): boolean {
  if (!signal) return true;
  if (signal.live_invalidated === true) return true;
  if (signal.execution_allowed === false) return true;
  if (signal.invalidation_reason && String(signal.invalidation_reason).trim() !== '') return true;

  const tradeability = String(signal.tradeability_status ?? '').toLowerCase();
  if (tradeability === 'blocked' || tradeability === 'restricted') return true;

  const lifecycle = String(signal.status ?? '').toUpperCase();
  if (lifecycle === 'INVALIDATED' || lifecycle === 'EXPIRED' || lifecycle === 'STOP_LOSS_HIT'
      || lifecycle === 'TARGET_HIT' || lifecycle === 'CLOSED' || lifecycle === 'TERMINATED'
      || lifecycle === 'CANCELLED') {
    return true;
  }

  const reason = String(signal.rejection_reason ?? '');
  if (reason && HARD_REJECTION_REASON.test(reason)) return true;

  if (Array.isArray(signal.rejection_codes)) {
    for (const code of signal.rejection_codes) {
      const upper = String(code ?? '').toUpperCase();
      if (upper.includes('INVALIDATED') || upper.includes('EXPIRED')
          || upper.includes('STOP_LOSS') || upper.includes('EXECUTION_BLOCKED')) {
        return true;
      }
    }
  }

  return false;
}

export interface ApprovalGapResult {
  approvalGap:               number;
  approvalGapPercent:        number;
  missingApprovalFactors:    string[];
}

/** Calculate how far a candidate is from clearing the institutional
 *  approval bar. Lower gap = closer to approved. The percent field is
 *  the gap expressed as a fraction of the maximum theoretical gap
 *  (300+), capped at 100 for UI safety. */
export function calculateApprovalGap(signal: RankableSignal | null | undefined): ApprovalGapResult {
  if (!signal) {
    return { approvalGap: 100, approvalGapPercent: 100, missingApprovalFactors: ['Signal missing'] };
  }
  const finalScore = getSignalFinalScore(signal);
  const confidence = getSignalConfidence(signal);
  const riskReward = getSignalRiskReward(signal);

  const finalGap      = Math.max(0, APPROVAL_TARGET_FINAL_SCORE - finalScore);
  const confidenceGap = Math.max(0, APPROVAL_TARGET_CONFIDENCE  - confidence);
  const rrGap         = Math.max(0, APPROVAL_TARGET_RISK_REWARD - riskReward) * 10;
  const stalePenalty  = isStaleSignal(signal) ? 10 : 0;
  const invalidationPenalty = (signal.live_invalidated === true
                            || (signal.invalidation_reason && String(signal.invalidation_reason).trim() !== ''))
                            ? 100 : 0;
  const executionPenalty    = signal.execution_allowed === false ? 100 : 0;

  const approvalGap = finalGap + confidenceGap + rrGap + stalePenalty
                    + invalidationPenalty + executionPenalty;

  const approvalGapPercent = Math.min(100, Math.round((approvalGap / 100) * 100));

  return {
    approvalGap: Math.round(approvalGap * 100) / 100,
    approvalGapPercent,
    missingApprovalFactors: buildMissingApprovalFactors(signal),
  };
}

/** Human-readable explanation of WHY a candidate is not yet approved.
 *  Returns the empty array when the signal already meets the bar. */
export function buildMissingApprovalFactors(signal: RankableSignal | null | undefined): string[] {
  if (!signal) return ['Signal missing'];
  const reasons: string[] = [];

  const finalScore = getSignalFinalScore(signal);
  const confidence = getSignalConfidence(signal);
  const riskReward = getSignalRiskReward(signal);

  if (finalScore > 0 && finalScore < APPROVAL_TARGET_FINAL_SCORE) {
    reasons.push(`Final score below ${APPROVAL_TARGET_FINAL_SCORE}`);
  }
  if (confidence > 0 && confidence < APPROVAL_TARGET_CONFIDENCE) {
    reasons.push(`Confidence below ${APPROVAL_TARGET_CONFIDENCE}`);
  }
  if (riskReward > 0 && riskReward < APPROVAL_TARGET_RISK_REWARD) {
    reasons.push(`Risk reward below ${APPROVAL_TARGET_RISK_REWARD.toFixed(1)}`);
  }
  if (isStaleSignal(signal)) {
    reasons.push('Provider data is stale — awaiting fresh tick confirmation');
  }
  if (signal.is_developing_setup === true || String(signal.signal_status ?? '').toUpperCase() === 'DEVELOPING_SETUP') {
    reasons.push('Awaiting breakout confirmation');
  }
  if (signal.is_scanner_candidate === true) {
    reasons.push('Awaiting maturity confirmation');
  }
  if (signal.is_relaxed === true) {
    reasons.push('Cleared relaxed gate only — strict floors pending');
  }
  if (signal.live_invalidated === true) {
    reasons.push('Setup invalidated');
  }
  if (signal.execution_allowed === false) {
    reasons.push('Execution blocked');
  }
  const cls = String(signal.classification ?? signal.raw_classification ?? '').toUpperCase();
  if (cls === 'WATCHLIST_ONLY' || cls === 'WATCHLIST') {
    reasons.push('Classified as watchlist — monitoring only');
  }

  if (reasons.length === 0) {
    reasons.push('Awaiting institutional confirmation');
  }
  return reasons;
}

export interface NearestSignal<T extends RankableSignal = RankableSignal> {
  signal:                  T;
  approvalGap:             number;
  approvalGapPercent:      number;
  missingApprovalFactors:  string[];
  nearestSignalRank:       number;
  sourceTier:              SignalSourceTier;
  isClosestToApproval:     boolean;
}

export type SignalSourceTier =
  | 'high_potential'
  | 'watchlist'
  | 'developing'
  | 'scanner_candidate'
  | 'rejected_soft';

export interface SignalPoolsForClosest<T extends RankableSignal> {
  highPotential?:    readonly T[];
  watchlist?:        readonly T[];
  developing?:       readonly T[];
  scannerCandidates?: readonly T[];
  rejected?:         readonly T[];
}

interface AnnotatedCandidate<T extends RankableSignal> {
  signal:                 T;
  approvalGap:            number;
  approvalGapPercent:     number;
  missingApprovalFactors: string[];
  sourceTier:             SignalSourceTier;
}

/** Default size for the "Closest to Approval" surface. */
export const CLOSEST_TO_APPROVAL_MAX = 5;

/** Build the Closest-to-Approval set from the available signal pools.
 *  Priority: highPotential → watchlist → developing → scanner_candidate
 *  → rejected (soft only). Hard-invalidated rows are excluded. */
export function buildClosestToApprovalSignals<T extends RankableSignal>(
  pools: SignalPoolsForClosest<T>,
  maxRows: number = CLOSEST_TO_APPROVAL_MAX,
): NearestSignal<T>[] {
  const cap = Math.max(1, Math.min(10, maxRows));
  const seenSymbols = new Set<string>();
  const annotated: AnnotatedCandidate<T>[] = [];

  const pushPool = (rows: readonly T[] | undefined, tier: SignalSourceTier, allowSoftReject: boolean) => {
    if (!rows || rows.length === 0) return;
    for (const row of rows) {
      if (!row) continue;
      if (!hasMinimumData(row)) continue;
      if (isHardInvalidated(row)) continue;
      if (tier === 'rejected_soft' && !allowSoftReject) continue;
      const symKey = String(row.symbol ?? row.tradingsymbol ?? '').toUpperCase();
      if (!symKey) continue;
      if (seenSymbols.has(symKey)) continue;
      const gap = calculateApprovalGap(row);
      annotated.push({
        signal:                 row,
        approvalGap:            gap.approvalGap,
        approvalGapPercent:     gap.approvalGapPercent,
        missingApprovalFactors: gap.missingApprovalFactors,
        sourceTier:             tier,
      });
      seenSymbols.add(symKey);
    }
  };

  pushPool(pools.highPotential,     'high_potential',    false);
  pushPool(pools.watchlist,         'watchlist',         false);
  pushPool(pools.developing,        'developing',        false);
  pushPool(pools.scannerCandidates, 'scanner_candidate', false);
  pushPool(pools.rejected,          'rejected_soft',     true);

  annotated.sort((a, b) => {
    if (a.approvalGap !== b.approvalGap) return a.approvalGap - b.approvalGap;
    const fb = getSignalFinalScore(b.signal);
    const fa = getSignalFinalScore(a.signal);
    if (fb !== fa) return fb - fa;
    const cb = getSignalConfidence(b.signal);
    const ca = getSignalConfidence(a.signal);
    if (cb !== ca) return cb - ca;
    const rb = getSignalRiskReward(b.signal);
    const ra = getSignalRiskReward(a.signal);
    if (rb !== ra) return rb - ra;
    const tb = getSignalFreshness(b.signal);
    const ta = getSignalFreshness(a.signal);
    return tb - ta;
  });

  const sliced = annotated.slice(0, cap);
  return sliced.map((c, idx) => ({
    signal:                 c.signal,
    approvalGap:            c.approvalGap,
    approvalGapPercent:     c.approvalGapPercent,
    missingApprovalFactors: c.missingApprovalFactors,
    nearestSignalRank:      idx + 1,
    sourceTier:             c.sourceTier,
    isClosestToApproval:    true,
  }));
}

/** Data-quality guard — a row must have a symbol and at least one
 *  numeric score field for us to consider it in the nearest set. */
function hasMinimumData(signal: RankableSignal): boolean {
  const symbol = String(signal.symbol ?? signal.tradingsymbol ?? '').trim();
  if (!symbol) return false;
  const finalScore = toNum(signal.final_score ?? signal.composite_final_score ?? signal.institutional_score);
  const confidence = toNum(signal.confidence_score ?? signal.confidence);
  if (finalScore === 0 && confidence === 0) return false;
  return true;
}
