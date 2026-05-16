// ════════════════════════════════════════════════════════════════
//  Phase-11 Signal Serialization
//
//  Single round-trip pipeline for the canonical Phase-11 signal row:
//
//    DB row (MySQL)  ──┐
//    Phase11SignalRow ─┼─→  Redis (JSON string)
//                      ─┼─→  API response body
//                      ─└─→  Frontend types
//
//  Boundaries this file owns:
//
//    fromDbRow()         MySQL row → Phase11SignalRow.
//                        Reads the Phase-11 columns and JSON blobs
//                        added in migrateSignalEngine; tolerates
//                        legacy rows where the columns are NULL by
//                        substituting safe defaults.
//
//    serializeForCache() Phase11SignalRow → JSON-stringifiable object.
//                        The cache layer in src/lib/redis.ts already
//                        does JSON.stringify; this helper guarantees
//                        the input shape contains no Date / Map /
//                        Set / undefined fields that would silently
//                        coerce.
//
//    deserializeFromCache() inverse — fills missing fields with the
//                        same defaults fromDbRow uses, so a row
//                        cached before Phase-11 still parses.
//
//    toApiResponse()     Phase11SignalRow → the public API body
//                        shape. Always emits all 16 required fields,
//                        even when the underlying source had nulls.
//
//  Pure, synchronous, IO-free. The cache I/O still goes through
//  src/lib/redis.ts (cacheGet / cacheSet) — this file only handles
//  shape conversion.
// ════════════════════════════════════════════════════════════════

import type {
  Phase11SignalRow,
  FactorScores,
  SignalExplanation,
  SignalDirection,
  SignalStatus,
  SignalClassification,
} from '../types/phase11Signal';

// ── Defaults ────────────────────────────────────────────────────

const EMPTY_FACTOR_SCORES: FactorScores = {
  strategy_quality:    0,
  trend_alignment:     0,
  momentum:            0,
  volume_confirmation: 0,
  risk_reward:         0,
  liquidity:           0,
  market_regime:       0,
  portfolio_fit:       0,
};

const EMPTY_EXPLANATION: SignalExplanation = {
  summary_reason:             '',
  factor_score_explanation:   '',
  risk_explanation:           '',
  portfolio_explanation:      '',
  stress_explanation:         '',
  rejection_explanation:      '',
  final_decision_explanation: '',
};

// ── Helpers ─────────────────────────────────────────────────────

function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Same as toNumber but preserves null/undefined as null. Used for
 * Phase-11 fields that represent "not yet populated" (legacy rows
 * before the upstream phase is wired) — those need to round-trip
 * as null so the partition layer can treat them differently than
 * a real numeric 0.
 */
function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

function toNullableBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  if (typeof v === 'string')  return v === '1' || v.toLowerCase() === 'true';
  return null;
}

function toString(v: unknown, fallback = ''): string {
  return v === null || v === undefined ? fallback : String(v);
}

function toBool(v: unknown, fallback = false): boolean {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  if (typeof v === 'string')  return v === '1' || v.toLowerCase() === 'true';
  return fallback;
}

/** Parse a JSON column. Accepts string (MySQL JSON), object (mysql2 auto-parse), null. */
function parseJsonColumn<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object')          return v as T;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; }
    catch { return fallback; }
  }
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string') as string[];
}

/**
 * Derive a Phase-11 classification from final_score when the
 * column is null on a legacy row. Bands match the Phase-12
 * routing fallback so the two layers stay consistent — a row
 * with final_score 82 should land in the same bucket whether
 * it goes through fromDbRow → toApiResponse → partition or
 * straight from the raw row into the partition.
 *
 * NO_TRADE is NEVER synthesized — it must come from the engine's
 * explicit decision on the source row. Previously the lowest band
 * returned NO_TRADE; combined with `toNumber(null)===0`, every legacy
 * row with both `classification` AND `final_score` NULL got stamped
 * NO_TRADE, surfacing as the generic "No Trade" pill on the dashboard.
 * The floor now degrades to DEVELOPING_SETUP, the lowest legitimate
 * tradeable bucket; the strict / main-table predicates still gate by
 * score.
 */
function classificationFromFinalScore(score: number): SignalClassification {
  if (!Number.isFinite(score)) return 'DEVELOPING_SETUP';
  if (score >= 90) return 'INSTITUTIONAL_HIGH_CONVICTION';
  if (score >= 80) return 'HIGH_CONVICTION';
  if (score >= 50) return 'VALID_SIGNAL';
  return 'DEVELOPING_SETUP';
}

function normalizeFactorScores(raw: unknown): FactorScores {
  const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  return {
    strategy_quality:    toNumber(obj.strategy_quality),
    trend_alignment:     toNumber(obj.trend_alignment),
    momentum:            toNumber(obj.momentum),
    volume_confirmation: toNumber(obj.volume_confirmation),
    risk_reward:         toNumber(obj.risk_reward),
    liquidity:           toNumber(obj.liquidity),
    market_regime:       toNumber(obj.market_regime),
    portfolio_fit:       toNumber(obj.portfolio_fit),
  };
}

function normalizeExplanation(raw: unknown): SignalExplanation {
  const obj = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
  return {
    summary_reason:             toString(obj.summary_reason),
    factor_score_explanation:   toString(obj.factor_score_explanation),
    risk_explanation:           toString(obj.risk_explanation),
    portfolio_explanation:      toString(obj.portfolio_explanation),
    stress_explanation:         toString(obj.stress_explanation),
    rejection_explanation:      toString(obj.rejection_explanation),
    final_decision_explanation: toString(obj.final_decision_explanation),
  };
}

// ── DB → Phase11SignalRow ───────────────────────────────────────

/**
 * Build a canonical Phase11SignalRow from a raw q365_signals row.
 * Tolerates pre-Phase-11 rows by substituting empty-but-valid
 * defaults for the new columns/JSON blobs — readers don't need to
 * branch on row vintage.
 */
export function fromDbRow(r: Record<string, unknown>): Phase11SignalRow {
  const factorScores = normalizeFactorScores(
    parseJsonColumn(r.phase4_factor_scores_json ?? r.factor_scores_json, EMPTY_FACTOR_SCORES),
  );
  const explanation = normalizeExplanation(
    parseJsonColumn(r.explanation_json, EMPTY_EXPLANATION),
  );
  const rejectionCodes   = asStringArray(parseJsonColumn(r.rejection_codes_json,         []));
  const rejectionReasons = asStringArray(parseJsonColumn(r.rejection_reasons_json,       []));
  const liveReasons      = asStringArray(parseJsonColumn(r.live_validation_reasons_json, []));

  const finalScore = toNumber(r.final_score);
  const classification: SignalClassification = r.classification
    ? (toString(r.classification) as SignalClassification)
    : classificationFromFinalScore(finalScore);

  return {
    id:           r.id != null ? Number(r.id) : undefined,
    symbol:       toString(r.symbol),
    direction:    toString(r.direction || 'HOLD').toUpperCase() as SignalDirection,
    generated_at: r.generated_at instanceof Date
      ? r.generated_at.toISOString()
      : toString(r.generated_at),

    final_score:             finalScore,
    classification,
    confidence_score:        toNumber(r.confidence_score),
    risk_score:              toNumber(r.risk_score),
    portfolio_fit_score:     toNumber(r.portfolio_fit_score),
    risk_reward:             toNumber(r.risk_reward),
    stress_survival_score:   toNullableNumber(r.stress_survival_score),
    signal_status:           (toString(r.signal_status) || 'DEVELOPING_SETUP') as SignalStatus,
    rejection_codes:         rejectionCodes,
    rejection_reasons:       rejectionReasons,
    factor_scores:           factorScores,
    explanation,
    recommended_quantity:    toNumber(r.recommended_quantity),
    recommended_capital:     toNumber(r.recommended_capital),
    live_valid:              toNullableBool(r.live_valid),
    live_validation_reasons: liveReasons,
  };
}

// ── Redis cache round-trip ──────────────────────────────────────

/**
 * Project a row into a JSON-stringifiable payload for `cacheSet`.
 * Returned object contains primitives, plain arrays, and plain
 * objects only — safe for the generic JSON.stringify in src/lib/redis.ts.
 */
export function serializeForCache(row: Phase11SignalRow): Record<string, unknown> {
  return {
    id:           row.id ?? null,
    symbol:       row.symbol,
    direction:    row.direction,
    generated_at: row.generated_at,

    final_score:             row.final_score,
    classification:          row.classification,
    confidence_score:        row.confidence_score,
    risk_score:              row.risk_score,
    portfolio_fit_score:     row.portfolio_fit_score,
    risk_reward:             row.risk_reward,
    stress_survival_score:   row.stress_survival_score,
    signal_status:           row.signal_status,
    rejection_codes:         [...row.rejection_codes],
    rejection_reasons:       [...row.rejection_reasons],
    factor_scores:           { ...row.factor_scores },
    explanation:             { ...row.explanation },
    recommended_quantity:    row.recommended_quantity,
    recommended_capital:     row.recommended_capital,
    live_valid:              row.live_valid,
    live_validation_reasons: [...row.live_validation_reasons],
  };
}

/**
 * Inverse of serializeForCache. Tolerates partial / legacy payloads
 * by filling missing fields with the same defaults fromDbRow uses.
 */
export function deserializeFromCache(payload: unknown): Phase11SignalRow {
  if (!payload || typeof payload !== 'object') {
    throw new Error('phase11.deserializeFromCache: payload must be an object');
  }
  const p = payload as Record<string, unknown>;
  const finalScore = toNumber(p.final_score);
  const classification: SignalClassification = p.classification
    ? (toString(p.classification) as SignalClassification)
    : classificationFromFinalScore(finalScore);

  return {
    id:           p.id != null ? Number(p.id) : undefined,
    symbol:       toString(p.symbol),
    direction:    (toString(p.direction).toUpperCase() || 'HOLD') as SignalDirection,
    generated_at: toString(p.generated_at),

    final_score:             finalScore,
    classification,
    confidence_score:        toNumber(p.confidence_score),
    risk_score:              toNumber(p.risk_score),
    portfolio_fit_score:     toNumber(p.portfolio_fit_score),
    risk_reward:             toNumber(p.risk_reward),
    stress_survival_score:   toNullableNumber(p.stress_survival_score),
    signal_status:           (toString(p.signal_status) || 'DEVELOPING_SETUP') as SignalStatus,
    rejection_codes:         asStringArray(p.rejection_codes),
    rejection_reasons:       asStringArray(p.rejection_reasons),
    factor_scores:           normalizeFactorScores(p.factor_scores),
    explanation:             normalizeExplanation(p.explanation),
    recommended_quantity:    toNumber(p.recommended_quantity),
    recommended_capital:     toNumber(p.recommended_capital),
    live_valid:              toNullableBool(p.live_valid),
    live_validation_reasons: asStringArray(p.live_validation_reasons),
  };
}

// ── API response shape ──────────────────────────────────────────

/**
 * The body shape every API endpoint that returns a single signal
 * row should produce. Identical 16-field block as the cache payload,
 * plus identity fields. This is the contract the frontend types
 * mirror at src/types/phase11Signal.ts.
 */
export interface Phase11ApiSignalResponse {
  id:           number | null;
  symbol:       string;
  direction:    SignalDirection;
  generated_at: string;

  final_score:             number;
  classification:          SignalClassification;
  confidence_score:        number;
  risk_score:              number;
  portfolio_fit_score:     number;
  risk_reward:             number;
  stress_survival_score:   number | null;
  signal_status:           SignalStatus;
  rejection_codes:         string[];
  rejection_reasons:       string[];
  factor_scores:           FactorScores;
  explanation:             SignalExplanation;
  recommended_quantity:    number;
  recommended_capital:     number;
  live_valid:              boolean | null;
  live_validation_reasons: string[];
}

/**
 * Build the API response body from a canonical row. Same shape as
 * the cache payload — kept as a separate function so future
 * additions (e.g. live-price enrichment fields) don't leak into
 * the cached blob.
 */
export function toApiResponse(row: Phase11SignalRow): Phase11ApiSignalResponse {
  return {
    id:           row.id ?? null,
    symbol:       row.symbol,
    direction:    row.direction,
    generated_at: row.generated_at,

    final_score:             row.final_score,
    classification:          row.classification,
    confidence_score:        row.confidence_score,
    risk_score:              row.risk_score,
    portfolio_fit_score:     row.portfolio_fit_score,
    risk_reward:             row.risk_reward,
    stress_survival_score:   row.stress_survival_score,
    signal_status:           row.signal_status,
    rejection_codes:         [...row.rejection_codes],
    rejection_reasons:       [...row.rejection_reasons],
    factor_scores:           { ...row.factor_scores },
    explanation:             { ...row.explanation },
    recommended_quantity:    row.recommended_quantity,
    recommended_capital:     row.recommended_capital,
    live_valid:              row.live_valid,
    live_validation_reasons: [...row.live_validation_reasons],
  };
}

/**
 * Required-fields invariant. Returns the list of canonical Phase-11
 * keys that are present on `obj`. Used by the validation harness
 * (and any test) to assert "every Phase-11 field is populated".
 */
export const PHASE_11_REQUIRED_FIELDS: ReadonlyArray<keyof Phase11ApiSignalResponse> = [
  'final_score',
  'classification',
  'confidence_score',
  'risk_score',
  'portfolio_fit_score',
  'risk_reward',
  'stress_survival_score',
  'signal_status',
  'rejection_codes',
  'rejection_reasons',
  'factor_scores',
  'explanation',
  'recommended_quantity',
  'recommended_capital',
  'live_valid',
  'live_validation_reasons',
];
