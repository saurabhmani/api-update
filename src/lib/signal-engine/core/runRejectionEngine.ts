// ════════════════════════════════════════════════════════════════
//  Canonical Rejection Engine
//
//  Central authority for signal approval/rejection decisions.
//  All rejection gates run sequentially. A signal is blocked if
//  ANY gate fails. Every decision is traced for audit.
//
//  Gates (in order):
//    1. Data quality
//    2. Strategy match
//    3. Scenario gating
//    4. Market stance restriction
//    5. Regime compatibility
//    6. Risk-reward threshold
//    7. Confidence threshold
//    8. Risk score cap
//    9. Liquidity filter
//   10. Stop distance bounds
//   11. Portfolio fit
//   12. Manipulation penalty/rejection
//
//  RULE: This engine NEVER approves a signal. It can only reject
//  or allow-through. The signal must have already passed Phase 1-3
//  scoring before reaching this engine.
// ════════════════════════════════════════════════════════════════

import type { StrategyName } from '../types/signalEngine.types';
import type { PortfolioFitResult, ExecutionReadiness } from '../types/phase3.types';

// ── Decision Output ────────────────────────────────────────────

export type RejectionCode =
  | 'data_quality'
  | 'no_strategy'
  | 'scenario_blocked'
  | 'stance_restricted'
  | 'regime_incompatible'
  | 'risk_reward_insufficient'
  | 'confidence_below_threshold'
  | 'risk_score_exceeded'
  | 'liquidity_insufficient'
  | 'stop_distance_invalid'
  | 'portfolio_fit_rejected'
  | 'manipulation_rejected'
  | 'manipulation_penalized';

export interface RejectionGateResult {
  gate: string;
  passed: boolean;
  code?: RejectionCode;
  message?: string;
  snapshot?: Record<string, unknown>;
}

export interface RejectionDecision {
  finalDecision: 'approved' | 'rejected' | 'deferred';
  rejectionCode: RejectionCode | null;
  rejectionMessage: string | null;
  appliedRules: RejectionGateResult[];
  decisionTrace: string[];
  /** Snapshots at decision time for audit */
  thresholdSnapshot: Record<string, number>;
  stanceSnapshot: { stance: string; conviction: string } | null;
  scenarioSnapshot: { scenario: string; allowedStrategies: string[] } | null;
  manipulationSnapshot: { score: number; band: string; penalized: boolean; rejected: boolean } | null;
  portfolioFitSnapshot: { fitScore: number; decision: string } | null;
}

// ── Input for rejection evaluation ─────────────────────────────

export interface RejectionInput {
  symbol: string;
  strategy: StrategyName;
  confidenceScore: number;
  riskScore: number;
  rewardRisk: number;
  entryPrice: number;
  stopLoss: number;
  atrPct: number;
  volume: number;
  regime: string;
  sector: string;
  portfolioFit: PortfolioFitResult;
  executionReadiness: ExecutionReadiness;
  /** Optional manipulation context from the scanner */
  manipulationContext?: {
    score: number;
    band: string;
    shouldPenalize: boolean;
    shouldReject: boolean;
    warning: string | null;
  };
  /** Optional scenario context from scenarioEngine */
  scenarioContext?: {
    scenarioTag: string;
    allowedStrategies: string[];
    blockedStrategies: string[];
  };
  /** Optional stance context from marketStanceEngine */
  stanceContext?: {
    stance: string;
    conviction: string;
    riskMode: string;
    minConfidence: number;
    minRR: number;
    maxRiskScore: number;
  };
}

// ── Main Entry ─────────────────────────────────────────────────

export function runRejectionEngine(input: RejectionInput): RejectionDecision {
  const gates: RejectionGateResult[] = [];
  const trace: string[] = [];
  let finalDecision: RejectionDecision['finalDecision'] = 'approved';
  let rejectionCode: RejectionCode | null = null;
  let rejectionMessage: string | null = null;

  // ── Gate 1: Strategy match (must have a valid strategy) ──────
  {
    const passed = !!input.strategy;
    gates.push({ gate: 'strategy_match', passed, code: passed ? undefined : 'no_strategy', message: passed ? undefined : 'No strategy pattern matched' });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'no_strategy'; rejectionMessage = 'No strategy pattern matched'; trace.push('REJECTED: no strategy'); }
    else trace.push(`strategy=${input.strategy}`);
  }

  // ── Gate 2: Scenario gating ──────────────────────────────────
  if (finalDecision !== 'rejected' && input.scenarioContext) {
    const sc = input.scenarioContext;
    const blocked = sc.blockedStrategies.includes(input.strategy);
    const allowed = sc.allowedStrategies.length === 0 || sc.allowedStrategies.includes(input.strategy);
    const passed = !blocked && allowed;
    gates.push({ gate: 'scenario', passed, code: passed ? undefined : 'scenario_blocked',
      message: passed ? undefined : `Strategy ${input.strategy} blocked in scenario ${sc.scenarioTag}`,
      snapshot: { scenarioTag: sc.scenarioTag, blocked: sc.blockedStrategies } });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'scenario_blocked'; rejectionMessage = `Strategy blocked in ${sc.scenarioTag} scenario`; }
    trace.push(`scenario=${sc.scenarioTag} allowed=${passed}`);
  }

  // ── Gate 3: Market stance restriction ────────────────────────
  if (finalDecision !== 'rejected' && input.stanceContext) {
    const st = input.stanceContext;
    const passed = true; // Stance doesn't block strategies, it adjusts thresholds
    gates.push({ gate: 'stance', passed, snapshot: { stance: st.stance, conviction: st.conviction } });
    trace.push(`stance=${st.stance} conviction=${st.conviction}`);
  }

  // ── Gate 4: Regime compatibility ──────────────────────────────
  if (finalDecision !== 'rejected') {
    // List of strategies that are NOT treated as bullish for the
    // regime gate — these can run in Bearish / High Volatility
    // regimes without being rejected. Covers the three bearish
    // strategies (breakdown + overbought_reversal + weak_trend)
    // plus the two reversal-style strategies (mean_reversion_bounce
    // + volume_climax_reversal) that naturally fit bearish tapes.
    const isBullishStrategy = ![
      'bearish_breakdown',
      'overbought_reversal',
      'weak_trend_breakdown',
      'mean_reversion_bounce',
      'volume_climax_reversal',
    ].includes(input.strategy);
    const isBearishRegime = input.regime === 'Bearish' || input.regime === 'High Volatility Risk';
    const passed = !(isBullishStrategy && isBearishRegime);
    gates.push({ gate: 'regime', passed, code: passed ? undefined : 'regime_incompatible',
      message: passed ? undefined : `Bullish strategy ${input.strategy} incompatible with ${input.regime} regime` });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'regime_incompatible'; rejectionMessage = `Strategy incompatible with ${input.regime} regime`; }
    trace.push(`regime=${input.regime} strategy=${input.strategy} compatible=${passed}`);
  }

  // ── Gate 5: Risk-reward threshold ────────────────────────────
  if (finalDecision !== 'rejected') {
    const minRR = input.stanceContext?.minRR ?? 1.5;
    const passed = input.rewardRisk >= minRR;
    gates.push({ gate: 'risk_reward', passed, code: passed ? undefined : 'risk_reward_insufficient',
      message: passed ? undefined : `R:R ${input.rewardRisk} < min ${minRR}` });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'risk_reward_insufficient'; rejectionMessage = `R:R ${input.rewardRisk} below threshold ${minRR}`; }
    trace.push(`rr=${input.rewardRisk} min=${minRR} passed=${passed}`);
  }

  // ── Gate 5: Confidence threshold ─────────────────────────────
  if (finalDecision !== 'rejected') {
    const minConf = input.stanceContext?.minConfidence ?? 55;
    const passed = input.confidenceScore >= minConf;
    gates.push({ gate: 'confidence', passed, code: passed ? undefined : 'confidence_below_threshold',
      message: passed ? undefined : `Confidence ${input.confidenceScore} < min ${minConf}` });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'confidence_below_threshold'; rejectionMessage = `Confidence ${input.confidenceScore} below threshold ${minConf}`; }
    trace.push(`confidence=${input.confidenceScore} min=${minConf} passed=${passed}`);
  }

  // ── Gate 6: Risk score cap ───────────────────────────────────
  if (finalDecision !== 'rejected') {
    const maxRisk = input.stanceContext?.maxRiskScore ?? 80;
    const passed = input.riskScore <= maxRisk;
    gates.push({ gate: 'risk_score', passed, code: passed ? undefined : 'risk_score_exceeded',
      message: passed ? undefined : `Risk score ${input.riskScore} > max ${maxRisk}` });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'risk_score_exceeded'; rejectionMessage = `Risk score ${input.riskScore} exceeds cap ${maxRisk}`; }
    trace.push(`riskScore=${input.riskScore} max=${maxRisk} passed=${passed}`);
  }

  // ── Gate 9: Liquidity filter ─────────────────────────────────
  if (finalDecision !== 'rejected') {
    const minVolume = 100_000;
    const passed = input.volume >= minVolume;
    gates.push({ gate: 'liquidity', passed, code: passed ? undefined : 'liquidity_insufficient',
      message: passed ? undefined : `Volume ${input.volume} < min ${minVolume}` });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'liquidity_insufficient'; rejectionMessage = `Volume ${input.volume} below minimum ${minVolume}`; }
    trace.push(`volume=${input.volume} min=${minVolume} passed=${passed}`);
  }

  // ── Gate 10: Stop distance bounds ──────────────────────────────
  if (finalDecision !== 'rejected') {
    const stopPct = input.entryPrice > 0 ? Math.abs(input.entryPrice - input.stopLoss) / input.entryPrice * 100 : 0;
    const minStopAtr = 0.5;
    const maxStopAtr = 3.0;
    const stopAtrMultiple = input.atrPct > 0 ? stopPct / input.atrPct : 0;
    const passed = stopAtrMultiple >= minStopAtr && stopAtrMultiple <= maxStopAtr;
    gates.push({ gate: 'stop_distance', passed, code: passed ? undefined : 'stop_distance_invalid',
      message: passed ? undefined : `Stop distance ${stopAtrMultiple.toFixed(2)} ATR outside ${minStopAtr}-${maxStopAtr} range`,
      snapshot: { stopPct, stopAtrMultiple, atrPct: input.atrPct } });
    if (!passed) { finalDecision = 'rejected'; rejectionCode = 'stop_distance_invalid'; rejectionMessage = `Stop distance ${stopAtrMultiple.toFixed(2)} ATR outside valid range`; }
    trace.push(`stopAtr=${stopAtrMultiple.toFixed(2)} range=[${minStopAtr},${maxStopAtr}] passed=${passed}`);
  }

  // ── Gate 11: Portfolio fit ────────────────────────────────────
  if (finalDecision !== 'rejected') {
    const pf = input.portfolioFit;
    if (pf.portfolioDecision === 'rejected') {
      gates.push({ gate: 'portfolio_fit', passed: false, code: 'portfolio_fit_rejected',
        message: `Portfolio fit rejected: score ${pf.fitScore}`, snapshot: { fitScore: pf.fitScore, decision: pf.portfolioDecision } });
      finalDecision = 'rejected'; rejectionCode = 'portfolio_fit_rejected'; rejectionMessage = `Portfolio fit score ${pf.fitScore} — ${pf.penalties.join(', ')}`;
    } else if (pf.portfolioDecision === 'deferred') {
      gates.push({ gate: 'portfolio_fit', passed: true, snapshot: { fitScore: pf.fitScore, decision: 'deferred' } });
      if (finalDecision === 'approved') finalDecision = 'deferred';
    } else {
      gates.push({ gate: 'portfolio_fit', passed: true, snapshot: { fitScore: pf.fitScore, decision: pf.portfolioDecision } });
    }
    trace.push(`portfolioFit=${pf.fitScore} decision=${pf.portfolioDecision}`);
  }

  // ── Gate 8: Manipulation penalty/rejection ───────────────────
  if (finalDecision !== 'rejected' && input.manipulationContext) {
    const mc = input.manipulationContext;
    if (mc.shouldReject) {
      gates.push({ gate: 'manipulation', passed: false, code: 'manipulation_rejected',
        message: mc.warning ?? `Manipulation score ${mc.score} — signal rejected`,
        snapshot: { score: mc.score, band: mc.band } });
      finalDecision = 'rejected'; rejectionCode = 'manipulation_rejected'; rejectionMessage = mc.warning ?? `Manipulation rejection (score ${mc.score}, band ${mc.band})`;
    } else if (mc.shouldPenalize) {
      gates.push({ gate: 'manipulation', passed: true, code: 'manipulation_penalized',
        message: mc.warning ?? `Manipulation penalty applied (score ${mc.score})`,
        snapshot: { score: mc.score, band: mc.band } });
      trace.push(`manipulation: penalized (score=${mc.score} band=${mc.band})`);
    } else {
      gates.push({ gate: 'manipulation', passed: true, snapshot: { score: mc.score, band: mc.band } });
    }
    trace.push(`manipulation=${mc.score} band=${mc.band} reject=${mc.shouldReject} penalize=${mc.shouldPenalize}`);
  }

  // ── Build threshold snapshot ─────────────────────────────────
  const thresholdSnapshot: Record<string, number> = {
    minConfidence: input.stanceContext?.minConfidence ?? 55,
    minRR: input.stanceContext?.minRR ?? 1.5,
    maxRiskScore: input.stanceContext?.maxRiskScore ?? 80,
    confidenceScore: input.confidenceScore,
    riskScore: input.riskScore,
    rewardRisk: input.rewardRisk,
    portfolioFitScore: input.portfolioFit.fitScore,
  };

  return {
    finalDecision,
    rejectionCode,
    rejectionMessage,
    appliedRules: gates,
    decisionTrace: trace,
    thresholdSnapshot,
    stanceSnapshot: input.stanceContext ? { stance: input.stanceContext.stance, conviction: input.stanceContext.conviction } : null,
    scenarioSnapshot: input.scenarioContext ? { scenario: input.scenarioContext.scenarioTag, allowedStrategies: input.scenarioContext.allowedStrategies } : null,
    manipulationSnapshot: input.manipulationContext ? { score: input.manipulationContext.score, band: input.manipulationContext.band, penalized: input.manipulationContext.shouldPenalize, rejected: input.manipulationContext.shouldReject } : null,
    portfolioFitSnapshot: { fitScore: input.portfolioFit.fitScore, decision: input.portfolioFit.portfolioDecision },
  };
}
