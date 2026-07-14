// ════════════════════════════════════════════════════════════════
//  Phase 9 — Product A Canonical Signal Contract
//
//  Single authoritative DTO for Manual Signal UI cards. Built from
//  existing confirmed-snapshot / mapped rows — never invents prices,
//  confidence, or trade-plan geometry. Expired / invalidated rows are
//  never marked actionable.
// ════════════════════════════════════════════════════════════════

import {
  buildWhyNotTradeReasons,
  buildWhyMayFail,
  type WhyNotTradeReason,
} from './whyNotTrade';
import {
  computeManualPositionSizing,
  PRODUCT_A_ALLOWED_ACTIONS,
  PRODUCT_A_PROHIBITED_ACTIONS,
  type ManualPositionSizing,
} from './manualExecutionSupport';

/** Client-safe display meta — do not import strategyRegistry (pulls DB via hub). */
function resolveStrategyDisplay(raw: string, explicitName?: string | null): {
  strategyId: string;
  strategyName: string;
} {
  const strategyId = raw || 'unclassified';
  if (explicitName && String(explicitName).trim()) {
    return { strategyId, strategyName: String(explicitName).trim() };
  }
  const strategyName = strategyId
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Unclassified';
  return { strategyId, strategyName };
}

export const PRODUCT_A_SIGNAL_CONTRACT_VERSION = '9.0.0';

export type ProductASignalState =
  | 'watchlist'
  | 'actionable'
  | 'elite'
  | 'expired'
  | 'invalidated';

export interface ProductAFactorLine {
  label: string;
  detail?: string;
}

/** Canonical Product A signal card — one contract everywhere. */
export interface ProductASignalCard {
  contractVersion: string;
  signalId: number | null;
  symbol: string;
  strategyId: string;
  strategyName: string;
  strategyVersion: string | null;
  direction: 'BUY' | 'SELL' | string;
  signalState: ProductASignalState;
  /** Actionable / elite only when true — never true for expired/invalidated. */
  executionAllowed: boolean;

  calibratedConfidence: number | null;
  evidenceSampleSize: number | null;
  setupScore: number | null;
  /** Phase-4 / institutional composite — clearly labelled as decision score. */
  compositeDecisionScore: number | null;

  entryZone: { low: number | null; high: number | null; reference: number | null };
  currentPrice: number | null;
  distanceFromEntryPct: number | null;
  distanceFromEntryR: number | null;

  stopLoss: number | null;
  invalidationReason: string | null;
  target1: number | null;
  target2: number | null;
  target3: number | null;
  rewardRisk: number | null;

  suggestedRiskPct: number;
  illustrativeSizing: ManualPositionSizing | null;

  generatedAt: string | null;
  dataTimestamp: string | null;
  validUntil: string | null;

  marketRegime: string | null;
  sectorStrength: string | null;
  multiTimeframeAlignment: string | null;

  topPositiveFactors: ProductAFactorLine[];
  topRisks: ProductAFactorLine[];
  whyMayFail: string[];
  whyTrade: string | null;
  whyNotTrade: WhyNotTradeReason[];

  auditSnapshotId: string | null;
  reproducible: boolean;

  allowedActions: readonly string[];
  prohibitedActions: readonly string[];
}

export interface BuildProductACardInput {
  id?: number | null;
  symbol?: string | null;
  tradingsymbol?: string | null;
  direction?: string | null;
  strategy?: string | null;
  strategyId?: string | null;
  signal_type?: string | null;
  strategyName?: string | null;
  strategyVersion?: string | null;

  confidence?: number | null;
  confidence_score?: number | null;
  calibration_sample_size?: number | null;
  evidence_sample_size?: number | null;
  final_score?: number | null;
  institutional_score?: number | null;
  maturity_score?: number | null;
  setup_score?: number | null;

  entry_price?: number | string | null;
  entry_low?: number | string | null;
  entry_high?: number | string | null;
  stop_loss?: number | string | null;
  target1?: number | string | null;
  target?: number | string | null;
  target2?: number | string | null;
  target3?: number | string | null;
  risk_reward?: number | null;
  rr_ratio?: number | null;

  livePrice?: number | null;
  ltp?: number | null;
  current_price?: number | null;

  status?: string | null;
  signal_status?: string | null;
  classification?: string | null;
  execution_allowed?: boolean | null;
  live_invalidated?: boolean | null;
  invalidation_reason?: string | null;
  rejection_reason?: string | null;
  rejection_codes?: string[] | null;
  display_reason?: string | null;
  missing_approval_factors?: string[] | null;
  demotionReason?: string | null;
  demoted_reason?: string | null;

  generated_at?: string | Date | null;
  confirmed_at?: string | Date | null;
  data_timestamp?: string | Date | null;
  valid_until?: string | Date | null;

  regime?: string | null;
  market_regime?: string | null;
  sector?: string | null;
  sector_strength?: string | null;
  mtf_alignment?: string | null;
  multi_timeframe_alignment?: string | null;

  top_positive_factors?: Array<string | ProductAFactorLine> | null;
  top_risks?: Array<string | ProductAFactorLine> | null;
  why_this_signal?: string | null;
  explanation?: Record<string, unknown> | string | null;

  audit_snapshot_id?: string | number | null;
  snapshot_id?: string | number | null;
  factor_scores?: Record<string, unknown> | null;

  /** Optional subscriber capital for illustrative quantity. */
  capitalInr?: number | null;
  suggestedRiskPct?: number | null;
  is_elite?: boolean | null;
  tier?: string | null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  return s || null;
}

function toFactorLines(
  items: Array<string | ProductAFactorLine> | null | undefined,
): ProductAFactorLine[] {
  if (!items?.length) return [];
  return items.slice(0, 5).map((x) =>
    typeof x === 'string' ? { label: x } : { label: x.label, detail: x.detail },
  );
}

function factorsFromExplanation(
  explanation: Record<string, unknown> | string | null | undefined,
): { positive: ProductAFactorLine[]; risks: ProductAFactorLine[]; whyTrade: string | null } {
  if (!explanation || typeof explanation === 'string') {
    return {
      positive: [],
      risks: [],
      whyTrade: typeof explanation === 'string' ? explanation : null,
    };
  }
  const pick = (key: string): ProductAFactorLine[] => {
    const raw = explanation[key];
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 5).map((x) => {
      if (typeof x === 'string') return { label: x };
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        return {
          label: String(o.label ?? o.feature ?? o.name ?? o.reason ?? 'Factor'),
          detail: o.detail != null ? String(o.detail) : o.score != null ? String(o.score) : undefined,
        };
      }
      return { label: String(x) };
    });
  };
  const whyTrade =
    (typeof explanation.whyThisSignal === 'string' && explanation.whyThisSignal)
    || (typeof explanation.summary === 'string' && explanation.summary)
    || (typeof explanation.narrative === 'string' && explanation.narrative)
    || null;
  return {
    positive: pick('topPositiveFactors').length
      ? pick('topPositiveFactors')
      : pick('reasons').length
        ? pick('reasons')
        : pick('boosters'),
    risks: pick('topRisks').length
      ? pick('topRisks')
      : pick('warnings').length
        ? pick('warnings')
        : pick('blockers'),
    whyTrade,
  };
}

function resolveSignalState(input: BuildProductACardInput): ProductASignalState {
  const status = String(input.status ?? '').toUpperCase();
  const signalStatus = String(input.signal_status ?? '').toUpperCase();
  const classification = String(input.classification ?? '').toUpperCase();
  const invalidated =
    input.live_invalidated === true
    || !!input.invalidation_reason
    || status === 'INVALIDATED'
    || signalStatus === 'INVALIDATED';
  if (invalidated) return 'invalidated';
  if (
    status === 'EXPIRED'
    || signalStatus === 'EXPIRED'
    || classification === 'EXPIRED'
  ) {
    return 'expired';
  }

  const exec = input.execution_allowed !== false
    && !invalidated
    && status !== 'EXPIRED';

  if (exec && (input.is_elite === true || classification.includes('INSTITUTIONAL') || classification === 'HIGH_CONVICTION')) {
    return 'elite';
  }
  if (exec && (signalStatus === 'APPROVED_SIGNAL' || classification === 'CONFIRMED' || classification === 'VALID_SIGNAL')) {
    return 'actionable';
  }
  return 'watchlist';
}

/**
 * Build the canonical Product A card. Pure — same input → same output.
 */
export function buildProductASignalCard(input: BuildProductACardInput): ProductASignalCard {
  const symbol = String(input.symbol ?? input.tradingsymbol ?? '').toUpperCase() || 'UNKNOWN';
  const strategyRaw = String(input.strategyId ?? input.strategy ?? input.signal_type ?? 'unknown');
  const { strategyId, strategyName } = resolveStrategyDisplay(strategyRaw, input.strategyName);
  const signalState = resolveSignalState(input);
  const actionable = signalState === 'elite' || signalState === 'actionable';

  const entryRef = num(input.entry_price);
  const entryLow = num(input.entry_low) ?? entryRef;
  const entryHigh = num(input.entry_high) ?? entryRef;
  const stop = num(input.stop_loss);
  const t1 = num(input.target1) ?? num(input.target);
  const t2 = num(input.target2);
  const t3 = num(input.target3);
  const price = num(input.current_price) ?? num(input.livePrice) ?? num(input.ltp);
  const rr = num(input.risk_reward) ?? num(input.rr_ratio);

  let distanceFromEntryPct: number | null = null;
  let distanceFromEntryR: number | null = null;
  if (price != null && entryRef != null && entryRef > 0) {
    const dir = String(input.direction ?? 'BUY').toUpperCase() === 'SELL' ? -1 : 1;
    distanceFromEntryPct = Math.round(((price - entryRef) / entryRef) * dir * 10000) / 100;
    if (stop != null && Math.abs(entryRef - stop) > 0) {
      distanceFromEntryR =
        Math.round(((price - entryRef) * dir) / Math.abs(entryRef - stop) * 100) / 100;
    }
  }

  const confidence = num(input.confidence_score) ?? num(input.confidence);
  const decisionScore = num(input.institutional_score) ?? num(input.final_score);
  const setupScore = num(input.setup_score) ?? num(input.maturity_score);
  const evidenceN = num(input.evidence_sample_size) ?? num(input.calibration_sample_size);

  const fromExplain = factorsFromExplanation(input.explanation);
  const positive = toFactorLines(input.top_positive_factors).length
    ? toFactorLines(input.top_positive_factors)
    : fromExplain.positive;
  const risks = toFactorLines(input.top_risks).length
    ? toFactorLines(input.top_risks)
    : fromExplain.risks;

  const suggestedRiskPct = input.suggestedRiskPct ?? 1;
  const illustrativeSizing =
    input.capitalInr != null && entryRef != null && stop != null
      ? computeManualPositionSizing({
          capitalInr: input.capitalInr,
          entry: entryRef,
          stopLoss: stop,
          riskPct: suggestedRiskPct,
        })
      : null;

  const whyNotTrade = buildWhyNotTradeReasons({
    signalState,
    executionAllowed: actionable,
    distanceFromEntryR,
    rewardRisk: rr,
    rejectionReason: input.rejection_reason ?? input.display_reason ?? input.demotionReason ?? input.demoted_reason,
    rejectionCodes: input.rejection_codes ?? undefined,
    missingFactors: input.missing_approval_factors ?? undefined,
    invalidationReason: input.invalidation_reason,
    mtfAlignment: input.multi_timeframe_alignment ?? input.mtf_alignment,
    regime: input.market_regime ?? input.regime,
  });

  const auditId =
    input.audit_snapshot_id != null
      ? String(input.audit_snapshot_id)
      : input.snapshot_id != null
        ? String(input.snapshot_id)
        : input.id != null
          ? String(input.id)
          : null;

  return {
    contractVersion: PRODUCT_A_SIGNAL_CONTRACT_VERSION,
    signalId: input.id ?? null,
    symbol,
    strategyId,
    strategyName,
    strategyVersion: input.strategyVersion ?? null,
    direction: (String(input.direction ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY'),
    signalState,
    executionAllowed: actionable,

    calibratedConfidence: confidence,
    evidenceSampleSize: evidenceN,
    setupScore,
    compositeDecisionScore: decisionScore,

    entryZone: { low: entryLow, high: entryHigh, reference: entryRef },
    currentPrice: price,
    distanceFromEntryPct,
    distanceFromEntryR,

    stopLoss: stop,
    invalidationReason: input.invalidation_reason ?? null,
    target1: t1,
    target2: t2,
    target3: t3,
    rewardRisk: rr,

    suggestedRiskPct,
    illustrativeSizing,

    generatedAt: iso(input.generated_at) ?? iso(input.confirmed_at),
    dataTimestamp: iso(input.data_timestamp) ?? iso(input.confirmed_at) ?? iso(input.generated_at),
    validUntil: iso(input.valid_until),

    marketRegime: input.market_regime ?? input.regime ?? null,
    sectorStrength: input.sector_strength ?? input.sector ?? null,
    multiTimeframeAlignment: input.multi_timeframe_alignment ?? input.mtf_alignment ?? null,

    topPositiveFactors: positive,
    topRisks: risks,
    whyMayFail: buildWhyMayFail({
      invalidationReason: input.invalidation_reason,
      risks: risks.map((r) => r.label),
      regime: input.market_regime ?? input.regime,
      distanceFromEntryR,
      rewardRisk: rr,
    }),
    whyTrade: input.why_this_signal ?? fromExplain.whyTrade,
    whyNotTrade,

    auditSnapshotId: auditId,
    reproducible: auditId != null,

    allowedActions: PRODUCT_A_ALLOWED_ACTIONS,
    prohibitedActions: PRODUCT_A_PROHIBITED_ACTIONS,
  };
}

/** Assert Product A consistency: expired/invalidated cannot be actionable. */
export function assertProductACardInvariants(card: ProductASignalCard): string[] {
  const errs: string[] = [];
  if ((card.signalState === 'expired' || card.signalState === 'invalidated') && card.executionAllowed) {
    errs.push('Expired/invalidated signals cannot be actionable');
  }
  if (card.executionAllowed && (card.signalState !== 'elite' && card.signalState !== 'actionable')) {
    errs.push('executionAllowed only for elite/actionable states');
  }
  if (card.signalState === 'elite' && !card.executionAllowed) {
    errs.push('elite must be executionAllowed');
  }
  return errs;
}
