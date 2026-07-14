// ════════════════════════════════════════════════════════════════
//  Apply MTF confirmation — once per candidate
// ════════════════════════════════════════════════════════════════

import type { StrategyCandidate, StrategyName } from '../types/signalEngine.types';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import {
  evaluateMultiTimeframeAlignment,
  applyAlignmentToConfidence,
  alignmentScoreToEnhancedProxy,
  type MultiTimeframeAlignmentResult,
  type StrategyMtfPolicy,
  MTF_POLICIES,
  DEFAULT_MTF_POLICY,
} from './multiTimeframeAlignment';
import type { Candle } from '../types/signalEngine.types';
import { getStrategyEntry } from '../strategies/strategyRegistry';
import { buildMtfExplainLines } from '../explain/buildMtfExplanation';

const APPLIED = new WeakSet<object>();

export function resolveMtfPolicy(strategy: StrategyName): StrategyMtfPolicy {
  const entry = getStrategyEntry(strategy);
  const fromRegistry = (entry as { mtfPolicyId?: string }).mtfPolicyId;
  if (fromRegistry && MTF_POLICIES[fromRegistry]) return MTF_POLICIES[fromRegistry];

  switch (entry.category) {
    case 'pullback':
      return strategy === 'fibonacci_pullback'
        ? MTF_POLICIES.fibonacci_pullback
        : MTF_POLICIES.bullish_pullback;
    case 'breakout':
    case 'intraday_breakout':
      return MTF_POLICIES.breakout;
    case 'momentum':
      return MTF_POLICIES.momentum;
    case 'mean_reversion':
    case 'reversal':
      return MTF_POLICIES.mean_reversion;
    default:
      return DEFAULT_MTF_POLICY;
  }
}

export interface ApplyMtfInput {
  candidate: StrategyCandidate;
  symbol: string;
  daily: Candle[];
  fourHour: Candle[] | null;
  oneHour: Candle[] | null;
  asOfMs?: number;
}

export interface ApplyMtfResult {
  candidate: StrategyCandidate;
  alignment: MultiTimeframeAlignmentResult;
  /** True when this call applied the score (false if already applied). */
  applied: boolean;
}

/**
 * Apply multi-timeframe confirmation exactly once to a strategy candidate.
 * multi_timeframe_alignment as a strategy name must never reach here as a
 * publisher of standalone actionable signals.
 */
export function applyMultiTimeframeConfirmation(input: ApplyMtfInput): ApplyMtfResult {
  const { candidate } = input;

  if (candidate.strategy === 'multi_timeframe_alignment') {
    // Hard stop — confirmation-only identifier, never actionable standalone
    return {
      candidate: {
        ...candidate,
        warnings: [
          ...candidate.warnings,
          'multi_timeframe_alignment is confirmation-only — not an actionable strategy',
        ],
      },
      alignment: evaluateMultiTimeframeAlignment({
        symbol: input.symbol,
        direction: 'BUY',
        strategy: candidate.strategy,
        daily: null,
        fourHour: null,
        oneHour: null,
      }),
      applied: false,
    };
  }

  if (APPLIED.has(candidate)) {
    // Already applied — return candidate unchanged (score applied exactly once)
    const alignment = evaluateMultiTimeframeAlignment({
      symbol: input.symbol,
      direction: BEARISH_STRATEGIES.has(candidate.strategy) ? 'SELL' : 'BUY',
      strategy: candidate.strategy,
      daily: input.daily,
      fourHour: input.fourHour,
      oneHour: input.oneHour,
      asOfMs: input.asOfMs,
      policy: resolveMtfPolicy(candidate.strategy),
    });
    return { candidate, alignment, applied: false };
  }

  const direction: 'BUY' | 'SELL' = BEARISH_STRATEGIES.has(candidate.strategy) ? 'SELL' : 'BUY';
  const policy = resolveMtfPolicy(candidate.strategy);
  const alignment = evaluateMultiTimeframeAlignment({
    symbol: input.symbol,
    direction,
    strategy: candidate.strategy,
    daily: input.daily,
    fourHour: input.fourHour,
    oneHour: input.oneHour,
    asOfMs: input.asOfMs,
    policy,
  });

  let finalScore = candidate.confidence.finalScore;
  const before = finalScore;

  // Missing/stale policy already forces score ≤ 0 for boost cases
  finalScore = applyAlignmentToConfidence(finalScore, alignment.timeframe_alignment_score);
  if (alignment.confidenceCap != null) {
    finalScore = Math.min(finalScore, alignment.confidenceCap);
  }
  if (!alignment.actionable) {
    // Non-actionable: do not boost; optionally soft-cap
    finalScore = Math.min(finalScore, before, alignment.confidenceCap ?? before);
  }

  const warnings = [
    ...candidate.warnings,
    ...alignment.warnings,
    ...buildMtfExplainLines(alignment),
  ];

  const features = candidate.features.enhanced
    ? {
        ...candidate.features,
        enhanced: {
          ...candidate.features.enhanced,
          // Replace daily proxy with real alignment (display / gates)
          multiTimeframeAlignment: alignmentScoreToEnhancedProxy(
            alignment.timeframe_alignment_score,
          ),
        },
      }
    : candidate.features;

  const explainability = candidate.explainability
    ? {
        ...candidate.explainability,
        confidenceExplanation: [
          ...candidate.explainability.confidenceExplanation,
          alignment.explanation,
        ],
        multiTimeframe: alignment.explain,
      }
    : {
        topContributingFeatures: [],
        confidenceExplanation: [alignment.explanation],
        riskExplanation: [],
        tradeRationale: [],
        rejectionReasons: [],
        multiTimeframe: alignment.explain,
      };

  const next: StrategyCandidate = {
    ...candidate,
    features,
    confidence: {
      ...candidate.confidence,
      finalScore,
    },
    warnings,
    explainability: explainability as StrategyCandidate['explainability'],
  };

  APPLIED.add(next);
  APPLIED.add(candidate);
  return { candidate: next, alignment, applied: true };
}
