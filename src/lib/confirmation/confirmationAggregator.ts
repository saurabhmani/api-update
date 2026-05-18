// ════════════════════════════════════════════════════════════════
//  Confirmation Aggregator — Phase 5
//
//  Combines five institutional confirmation modules (sector,
//  options, news, manipulation, execution) plus the regime router
//  and Phase-2 strategy performance into a single
//  `ConfirmationAggregate` envelope.
//
//  Modules are NOT signal generators. Each one returns a typed
//  status that is one of:
//    CONFIRMED / NEUTRAL / WEAK / CONTRADICTING / BLOCKED /
//    UNAVAILABLE / INSUFFICIENT_DATA
//
//  Hard safety rules:
//   - No module fakes data. When the underlying provider is
//     missing or returns nothing, the module returns
//     UNAVAILABLE / INSUFFICIENT_DATA with a clear reason. Caller
//     must NEVER pretend that's a confirmation.
//   - The aggregator can only DEMOTE a signal. A WATCHLIST signal
//     can never be promoted to APPROVE on confirmation alone — that
//     is the strict gate's job and is not redefined here.
//
//  Pure module — DB/I-O happens in the calling route.
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import type { ManipulationRisk } from '@/lib/manipulation-engine/manipulationSignalRisk';

// ── Module statuses ──────────────────────────────────────────

export type ModuleStatus =
  | 'CONFIRMED'
  | 'NEUTRAL'
  | 'WEAK'
  | 'CONTRADICTING'
  | 'BLOCKED'
  | 'UNAVAILABLE'
  | 'INSUFFICIENT_DATA';

export type ApprovalRecommendation =
  | 'APPROVE'
  | 'WATCHLIST'
  | 'REJECT'
  | 'AVOID'
  | 'INSUFFICIENT_DATA';

export interface SectorConfirmation {
  status:               ModuleStatus;
  sector:               string | null;
  sectorTrend:          'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining' | null;
  sectorScore:          number | null;
  relativeStrengthRank: number | null;
  confidenceAdjustment: number;
  reason:               string;
}

export interface OptionsConfirmation {
  status:               ModuleStatus;
  optionsBias:          'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
  pcr:                  number | null;
  ivState:              'LOW' | 'NORMAL' | 'ELEVATED' | 'EXTREME' | null;
  keySupport:           number | null;
  keyResistance:        number | null;
  source:               'live' | 'estimated' | 'unavailable';
  confidenceAdjustment: number;
  reason:               string;
}

export interface NewsConfirmation {
  status:               ModuleStatus;
  sentiment:            'bullish' | 'bearish' | 'neutral' | null;
  catalystType:         string | null;
  impactScore:          number | null;
  freshness:            'fresh' | 'recent' | 'stale' | null;
  confidenceAdjustment: number;
  reason:               string;
}

export interface ManipulationConfirmation {
  status:               ModuleStatus;
  riskBand:             'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE' | 'UNKNOWN' | null;
  trapRiskType:         string | null;
  riskScore:            number | null;
  approvalImpact:       'NONE' | 'WATCHLIST' | 'BLOCK';
  confidenceAdjustment: number;
  reason:               string;
}

export interface ExecutionConfirmation {
  status:               ModuleStatus;
  executionQuality:     'EXCELLENT' | 'ACCEPTABLE' | 'WEAK' | 'BLOCKED' | 'INSUFFICIENT_DATA';
  slippageEstimateBps:  number | null;
  liquidityScore:       number | null;
  spreadRisk:           'LOW' | 'MEDIUM' | 'HIGH' | null;
  stopQuality:          'GOOD' | 'NARROW' | 'WIDE' | 'INVALID' | null;
  riskRewardQuality:    'STRONG' | 'ACCEPTABLE' | 'WEAK' | 'INSUFFICIENT' | null;
  approvalImpact:       'NONE' | 'REDUCE' | 'WATCHLIST' | 'BLOCK';
  confidenceAdjustment: number;
  reason:               string;
}

export interface ConfirmationAggregate {
  generatedAt:           string;
  signalId:              string | null;
  symbol:                string;
  strategyId:            string;
  strategyName:          string;
  /** 0..100 — weighted blend of module contributions. Never null. */
  confirmationScore:     number;
  approvalRecommendation: ApprovalRecommendation;
  boosters:              string[];
  blockers:              string[];
  neutralFactors:        string[];
  explanation:           string;
  modules: {
    sector:        SectorConfirmation;
    options:       OptionsConfirmation;
    news:          NewsConfirmation;
    manipulation:  ManipulationConfirmation;
    execution:     ExecutionConfirmation;
  };
  dataQuality: {
    modulesAvailable:   number;
    modulesUnavailable: number;
    warnings:           string[];
  };
}

// ── Module builders — each takes only the data it needs ──────

export interface SectorInput {
  sector:          string | null;
  sectorScore:     number | null;          // 0..100
  sectorTrend:     SectorConfirmation['sectorTrend'];
  relativeStrength: number | null;          // -100..+100
  direction:       'BUY' | 'SELL';
}

export function buildSectorConfirmation(input: SectorInput): SectorConfirmation {
  if (!input.sector) {
    return {
      status: 'UNAVAILABLE',
      sector: null, sectorTrend: null, sectorScore: null, relativeStrengthRank: null,
      confidenceAdjustment: 0,
      reason: 'Sector mapping unavailable for this symbol.',
    };
  }
  // Phase-5 hardening: a sector mapping alone isn't sector confirmation.
  // When the caller has a sector but no trend data (sectorTrend === null),
  // we honestly report UNAVAILABLE instead of fabricating a Neutral/50
  // reading. The standalone /api/signals/confirmation route now follows
  // this contract — it only passes a non-null sectorTrend when it has
  // real evidence (live signal pool cross-section or candle proxy).
  if (input.sectorTrend == null) {
    return {
      status: 'UNAVAILABLE',
      sector: input.sector, sectorTrend: null, sectorScore: input.sectorScore ?? null,
      relativeStrengthRank: input.relativeStrength,
      confidenceAdjustment: 0,
      reason: 'Sector mapping is available, but sector trend data is unavailable for this symbol.',
    };
  }
  const score = input.sectorScore ?? 50;
  const trend = input.sectorTrend;
  const directionAgrees =
    (input.direction === 'BUY'  && (trend === 'Strong' || trend === 'Positive')) ||
    (input.direction === 'SELL' && (trend === 'Weak'   || trend === 'Declining'));
  const directionFights =
    (input.direction === 'BUY'  && (trend === 'Weak'   || trend === 'Declining')) ||
    (input.direction === 'SELL' && (trend === 'Strong' || trend === 'Positive'));

  if (directionAgrees) {
    return {
      status: 'CONFIRMED', sector: input.sector, sectorTrend: trend, sectorScore: score,
      relativeStrengthRank: input.relativeStrength,
      confidenceAdjustment: +5,
      reason: `Stock is in a ${trend.toLowerCase()} sector — leadership supports the setup.`,
    };
  }
  if (directionFights) {
    return {
      status: 'CONTRADICTING', sector: input.sector, sectorTrend: trend, sectorScore: score,
      relativeStrengthRank: input.relativeStrength,
      confidenceAdjustment: -8,
      reason: `Sector trend is ${trend.toLowerCase()} — fighting the broader sector reduces approval confidence.`,
    };
  }
  return {
    status: 'NEUTRAL', sector: input.sector, sectorTrend: trend, sectorScore: score,
    relativeStrengthRank: input.relativeStrength,
    confidenceAdjustment: 0,
    reason: `Sector context is neutral for this setup.`,
  };
}

export interface OptionsInput {
  available:     boolean;
  source:        OptionsConfirmation['source'];
  optionsBias:   OptionsConfirmation['optionsBias'];
  pcr:           number | null;
  ivState:       OptionsConfirmation['ivState'];
  keySupport:    number | null;
  keyResistance: number | null;
  direction:     'BUY' | 'SELL';
}

export function buildOptionsConfirmation(input: OptionsInput): OptionsConfirmation {
  if (!input.available) {
    return {
      status: 'UNAVAILABLE',
      optionsBias: null, pcr: null, ivState: null, keySupport: null, keyResistance: null,
      source: 'unavailable',
      confidenceAdjustment: 0,
      reason: 'Option-chain provider unavailable — no F&O confirmation applied.',
    };
  }
  const bias = input.optionsBias ?? 'NEUTRAL';
  const agrees =
    (input.direction === 'BUY'  && bias === 'BULLISH') ||
    (input.direction === 'SELL' && bias === 'BEARISH');
  const fights =
    (input.direction === 'BUY'  && bias === 'BEARISH') ||
    (input.direction === 'SELL' && bias === 'BULLISH');

  if (agrees) {
    return {
      status: 'CONFIRMED', optionsBias: bias, pcr: input.pcr, ivState: input.ivState,
      keySupport: input.keySupport, keyResistance: input.keyResistance,
      source: input.source, confidenceAdjustment: +4,
      reason: `Option flow is ${bias.toLowerCase()} and supports the technical setup.`,
    };
  }
  if (fights) {
    return {
      status: 'CONTRADICTING', optionsBias: bias, pcr: input.pcr, ivState: input.ivState,
      keySupport: input.keySupport, keyResistance: input.keyResistance,
      source: input.source, confidenceAdjustment: -6,
      reason: `Option flow is ${bias.toLowerCase()} and contradicts the technical direction.`,
    };
  }
  return {
    status: 'NEUTRAL', optionsBias: bias, pcr: input.pcr, ivState: input.ivState,
    keySupport: input.keySupport, keyResistance: input.keyResistance,
    source: input.source, confidenceAdjustment: 0,
    reason: 'Option flow is neutral — no directional confirmation.',
  };
}

export interface NewsInput {
  available:    boolean;
  sentiment:    NewsConfirmation['sentiment'];
  catalystType: string | null;
  impactScore:  number | null;
  freshness:    NewsConfirmation['freshness'];
  direction:    'BUY' | 'SELL';
  highEventRisk: boolean;
}

export function buildNewsConfirmation(input: NewsInput): NewsConfirmation {
  if (!input.available) {
    // Per spec: do NOT reduce confidence simply because there's no
    // news — use a neutral state.
    return {
      status: 'NEUTRAL', sentiment: null, catalystType: null, impactScore: null,
      freshness: null, confidenceAdjustment: 0,
      reason: 'No news catalyst found — treating as neutral.',
    };
  }
  if (input.highEventRisk) {
    return {
      status: 'BLOCKED', sentiment: input.sentiment, catalystType: input.catalystType,
      impactScore: input.impactScore, freshness: input.freshness,
      confidenceAdjustment: -15,
      reason: 'News risk detected — approval restricted pending event resolution.',
    };
  }
  const sentiment = input.sentiment ?? 'neutral';
  const agrees =
    (input.direction === 'BUY'  && sentiment === 'bullish') ||
    (input.direction === 'SELL' && sentiment === 'bearish');
  const fights =
    (input.direction === 'BUY'  && sentiment === 'bearish') ||
    (input.direction === 'SELL' && sentiment === 'bullish');

  if (agrees) {
    return {
      status: 'CONFIRMED', sentiment, catalystType: input.catalystType, impactScore: input.impactScore,
      freshness: input.freshness, confidenceAdjustment: +5,
      reason: 'Recent news catalyst supports the technical setup.',
    };
  }
  if (fights) {
    return {
      status: 'CONTRADICTING', sentiment, catalystType: input.catalystType, impactScore: input.impactScore,
      freshness: input.freshness, confidenceAdjustment: -8,
      reason: 'Recent news sentiment is contradicting the technical direction.',
    };
  }
  return {
    status: 'NEUTRAL', sentiment, catalystType: input.catalystType, impactScore: input.impactScore,
    freshness: input.freshness, confidenceAdjustment: 0,
    reason: 'News flow is neutral — no directional pressure.',
  };
}

export interface ManipulationInput {
  available: boolean;
  risk:      ManipulationRisk | null;
}

export function buildManipulationConfirmation(input: ManipulationInput): ManipulationConfirmation {
  if (!input.available || !input.risk) {
    return {
      status: 'INSUFFICIENT_DATA',
      riskBand: null, trapRiskType: null, riskScore: null,
      approvalImpact: 'NONE', confidenceAdjustment: 0,
      reason: 'Manipulation surveillance data unavailable for this symbol.',
    };
  }
  const r = input.risk;
  // Upstream ManipulationRisk can carry an 'ELEVATED' band that this
  // module doesn't surface verbatim — we map it to 'MEDIUM' below.
  // Keep the raw string for the comparison and let the assignment
  // pick the narrowed `riskBand` value.
  const rawBand = String((r as { band?: string }).band ?? 'UNKNOWN').toUpperCase();
  const band: ManipulationConfirmation['riskBand'] =
    rawBand === 'SEVERE' || rawBand === 'HIGH' || rawBand === 'MEDIUM' || rawBand === 'LOW'
      ? (rawBand as ManipulationConfirmation['riskBand'])
      : 'UNKNOWN';
  if (rawBand === 'SEVERE') {
    return {
      status: 'BLOCKED', riskBand: band, trapRiskType: 'severe_manipulation', riskScore: r.score ?? null,
      approvalImpact: 'BLOCK', confidenceAdjustment: -25,
      reason: 'Approval restricted due to severe manipulation / trap risk on this symbol.',
    };
  }
  if (rawBand === 'HIGH') {
    return {
      status: 'WEAK', riskBand: band, trapRiskType: 'elevated_manipulation', riskScore: r.score ?? null,
      approvalImpact: 'WATCHLIST', confidenceAdjustment: -12,
      reason: 'Possible trap behaviour detected — watchlist until conditions improve.',
    };
  }
  if (rawBand === 'ELEVATED') {
    return {
      status: 'NEUTRAL', riskBand: 'MEDIUM', trapRiskType: 'mild_anomaly', riskScore: r.score ?? null,
      approvalImpact: 'NONE', confidenceAdjustment: -3,
      reason: 'Mild manipulation signature observed — proceeding with caution.',
    };
  }
  return {
    status: 'CONFIRMED', riskBand: 'LOW', trapRiskType: null, riskScore: r.score ?? null,
    approvalImpact: 'NONE', confidenceAdjustment: +2,
    reason: 'No elevated manipulation risk detected.',
  };
}

export interface ExecutionInput {
  liquidityScore:      number | null;   // 0..100
  spreadBps:           number | null;
  stopDistancePct:     number | null;
  riskReward:          number | null;
  avgVolume:           number | null;
  slippageEstimateBps: number | null;
}

export function buildExecutionConfirmation(input: ExecutionInput): ExecutionConfirmation {
  const hasAny =
    input.liquidityScore != null || input.spreadBps != null ||
    input.stopDistancePct != null || input.riskReward != null;
  if (!hasAny) {
    return {
      status: 'INSUFFICIENT_DATA', executionQuality: 'INSUFFICIENT_DATA',
      slippageEstimateBps: null, liquidityScore: null, spreadRisk: null,
      stopQuality: null, riskRewardQuality: null,
      approvalImpact: 'NONE', confidenceAdjustment: 0,
      reason: 'Execution quality unavailable — no liquidity / spread / R:R inputs.',
    };
  }
  const stopQuality: ExecutionConfirmation['stopQuality'] =
    input.stopDistancePct == null ? null
    : input.stopDistancePct <= 0 ? 'INVALID'
    : input.stopDistancePct < 0.5 ? 'NARROW'
    : input.stopDistancePct > 10  ? 'WIDE'
    : 'GOOD';
  const rrQuality: ExecutionConfirmation['riskRewardQuality'] =
    input.riskReward == null ? null
    : input.riskReward >= 2.0 ? 'STRONG'
    : input.riskReward >= 1.2 ? 'ACCEPTABLE'
    : input.riskReward >  0   ? 'WEAK'
                              : 'INSUFFICIENT';
  const spreadRisk: ExecutionConfirmation['spreadRisk'] =
    input.spreadBps == null ? null
    : input.spreadBps <  15 ? 'LOW'
    : input.spreadBps <  40 ? 'MEDIUM'
                            : 'HIGH';

  // Block on truly invalid plans.
  if (stopQuality === 'INVALID') {
    return {
      status: 'BLOCKED', executionQuality: 'BLOCKED',
      slippageEstimateBps: input.slippageEstimateBps, liquidityScore: input.liquidityScore,
      spreadRisk, stopQuality, riskRewardQuality: rrQuality,
      approvalImpact: 'BLOCK', confidenceAdjustment: -25,
      reason: 'Trade plan blocked because stop-loss distance is structurally invalid.',
    };
  }
  if (rrQuality === 'INSUFFICIENT' || (rrQuality === 'WEAK' && stopQuality === 'NARROW')) {
    return {
      status: 'WEAK', executionQuality: 'WEAK',
      slippageEstimateBps: input.slippageEstimateBps, liquidityScore: input.liquidityScore,
      spreadRisk, stopQuality, riskRewardQuality: rrQuality,
      approvalImpact: 'WATCHLIST', confidenceAdjustment: -10,
      reason: 'Execution quality is below approval threshold — watchlist only.',
    };
  }
  if (spreadRisk === 'HIGH' || (input.liquidityScore != null && input.liquidityScore < 30)) {
    return {
      status: 'WEAK', executionQuality: 'WEAK',
      slippageEstimateBps: input.slippageEstimateBps, liquidityScore: input.liquidityScore,
      spreadRisk, stopQuality, riskRewardQuality: rrQuality,
      approvalImpact: 'REDUCE', confidenceAdjustment: -7,
      reason: 'Liquidity / spread is weak — execution friction reduces approval confidence.',
    };
  }
  const isStrong = (stopQuality === 'GOOD' && rrQuality === 'STRONG' && spreadRisk !== 'MEDIUM');
  return {
    status: isStrong ? 'CONFIRMED' : 'NEUTRAL',
    executionQuality: isStrong ? 'EXCELLENT' : 'ACCEPTABLE',
    slippageEstimateBps: input.slippageEstimateBps, liquidityScore: input.liquidityScore,
    spreadRisk, stopQuality, riskRewardQuality: rrQuality,
    approvalImpact: 'NONE', confidenceAdjustment: isStrong ? +5 : +1,
    reason: isStrong
      ? 'Execution quality is strong — tight spread, healthy R:R, valid stop.'
      : 'Execution quality is acceptable.',
  };
}

// ── Top-level aggregator ─────────────────────────────────────

export interface AggregateInput {
  signalId:        string | null;
  symbol:          string;
  strategyId:      string;
  direction:       'BUY' | 'SELL';
  /** Existing signal action coming into the aggregator. */
  currentAction:   'APPROVED' | 'WATCHLIST' | 'REJECTED' | null;
  modules: {
    sector:       SectorConfirmation;
    options:      OptionsConfirmation;
    news:         NewsConfirmation;
    manipulation: ManipulationConfirmation;
    execution:    ExecutionConfirmation;
  };
}

export function aggregateConfirmation(input: AggregateInput): ConfirmationAggregate {
  const meta = getStrategyMeta(input.strategyId);
  const { modules } = input;

  const boosters: string[]       = [];
  const blockers: string[]       = [];
  const neutralFactors: string[] = [];

  for (const [_name, m] of Object.entries(modules) as Array<[string, { status: ModuleStatus; reason: string }]>) {
    if (m.status === 'CONFIRMED')                          boosters.push(m.reason);
    else if (m.status === 'WEAK' || m.status === 'CONTRADICTING') blockers.push(m.reason);
    else if (m.status === 'BLOCKED')                       blockers.push(m.reason);
    else                                                    neutralFactors.push(m.reason);
  }

  // Confirmation score — start at 50 (neutral) and stack the
  // module confidence adjustments capped to [0..100].
  let raw = 50;
  for (const m of Object.values(modules)) raw += m.confidenceAdjustment;
  const confirmationScore = Math.max(0, Math.min(100, Math.round(raw)));

  // Approval recommendation
  let approvalRecommendation: ApprovalRecommendation = 'WATCHLIST';
  const anyBlock = modules.manipulation.approvalImpact === 'BLOCK'
    || modules.execution.approvalImpact === 'BLOCK';
  const anyWatchlist = modules.manipulation.approvalImpact === 'WATCHLIST'
    || modules.execution.approvalImpact === 'WATCHLIST'
    || modules.news.status === 'BLOCKED';

  if (anyBlock) {
    approvalRecommendation = 'AVOID';
  } else if (input.currentAction === 'REJECTED') {
    approvalRecommendation = 'REJECT';
  } else if (anyWatchlist) {
    approvalRecommendation = 'WATCHLIST';
  } else if (input.currentAction === 'APPROVED' && confirmationScore >= 65) {
    approvalRecommendation = 'APPROVE';
  } else if (confirmationScore >= 75) {
    // Confirmation never promotes a non-approved signal to APPROVE.
    // The strict gate owns that decision. Confirmation can only
    // suggest WATCHLIST.
    approvalRecommendation = 'WATCHLIST';
  }

  // If every module is INSUFFICIENT_DATA / UNAVAILABLE, we are
  // honest about it instead of confidently saying WATCHLIST.
  const unknownCount = Object.values(modules).filter(
    (m) => m.status === 'UNAVAILABLE' || m.status === 'INSUFFICIENT_DATA',
  ).length;
  if (unknownCount >= 4 && !anyBlock) {
    approvalRecommendation = 'INSUFFICIENT_DATA';
  }

  const explanation = composeExplanation(
    meta.strategyName, approvalRecommendation, confirmationScore,
    boosters, blockers, neutralFactors,
  );

  return {
    generatedAt:           new Date().toISOString(),
    signalId:              input.signalId,
    symbol:                input.symbol,
    strategyId:            meta.strategyId,
    strategyName:          meta.strategyName,
    confirmationScore,
    approvalRecommendation,
    boosters,
    blockers,
    neutralFactors,
    explanation,
    modules,
    dataQuality: {
      modulesAvailable:   5 - unknownCount,
      modulesUnavailable: unknownCount,
      warnings:           unknownCount >= 3
        ? ['Several confirmation modules are unavailable — recommendation is less reliable.']
        : [],
    },
  };
}

function composeExplanation(
  strategyName: string,
  rec: ApprovalRecommendation,
  score: number,
  boosters: string[],
  blockers: string[],
  neutralFactors: string[],
): string {
  if (rec === 'AVOID') {
    return `${strategyName} setup detected but approval is blocked — ${blockers[0] ?? 'critical confirmation module reported a block.'}`;
  }
  if (rec === 'INSUFFICIENT_DATA') {
    return `${strategyName} setup detected but most confirmation modules are unavailable — recommendation withheld.`;
  }
  if (rec === 'APPROVE') {
    return `${strategyName} setup confirmed (score ${score}). ${boosters.length} supporting factor${boosters.length === 1 ? '' : 's'}.`;
  }
  if (rec === 'REJECT') {
    return `${strategyName} setup rejected upstream — confirmation layer did not override.`;
  }
  // WATCHLIST
  const lead = blockers[0] ?? neutralFactors[0] ?? 'awaiting stronger confirmation conditions';
  return `${strategyName} setup is valid (score ${score}), but approval is restricted until ${lead.toLowerCase().replace(/\.$/, '')}.`;
}
