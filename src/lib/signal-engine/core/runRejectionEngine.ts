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
  | 'manipulation_penalized'
  | 'signal_stale'
  // ── Phase-5 additions ──────────────────────────────────────
  /** Liquidity quality score (0-100) below the configured floor. */
  | 'liquidity_score_low'
  /** Decay state = 'expired' (signal aged out). */
  | 'decay_expired'
  /** applyLiveSanity flagged the row vs the live tape. */
  | 'live_invalidated'
  /** Current price has crossed the stop (BUY: ≤ stop, SELL: ≥ stop). */
  | 'stop_violated';

export interface RejectionGateResult {
  gate: string;
  passed: boolean;
  code?: RejectionCode;
  message?: string;
  snapshot?: Record<string, unknown>;
}

/**
 * Product-facing tri-state that replaces the binary approve/reject
 * split. Downstream consumers (UI, saved row, audit) should prefer
 * this over `finalDecision` when rendering — it's the operator-
 * readable classification of what the engine actually decided.
 *
 *   APPROVED_SIGNAL   — passed every gate, take the trade.
 *   DEVELOPING_SETUP  — a soft-reject the user can still watch:
 *                        confidence slightly below threshold, R:R
 *                        marginal, or no strategy matched YET but
 *                        the underlying conviction is there. Render
 *                        as "Setup is developing — wait for breakout".
 *   NO_TRADE          — a hard-reject with structural reasons
 *                        (liquidity, regime, manipulation, portfolio
 *                        fit, stop distance, risk-score cap, scenario
 *                        block). Render as "No trade — wait for setup".
 */
export type SignalStatus = 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE';

/** Phase-5 standardised "what was blocked" map. Each key is true
 *  when at least one rule in that category fired. Designed so a UI
 *  or audit consumer can render reject reasons without parsing the
 *  full appliedRules array. */
export interface RejectionBlockedBy {
  confidence:        boolean;
  risk:              boolean;
  risk_reward:       boolean;
  liquidity:         boolean;
  portfolio_fit:     boolean;
  manipulation:      boolean;
  staleness:         boolean;
  live_invalidated:  boolean;
  stop_violated:     boolean;
  regime:            boolean;
  scenario:          boolean;
  strategy:          boolean;
  data_quality:      boolean;
}

export interface RejectionDecision {
  finalDecision: 'approved' | 'rejected' | 'deferred';
  /** Product-facing tri-state (preferred). See SignalStatus docs. */
  signalStatus: SignalStatus;
  /** Phase-5 boolean — true iff finalDecision === 'rejected'. */
  rejected: boolean;
  /** First failed code (preserved for backward compat with single-code consumers). */
  rejectionCode: RejectionCode | null;
  /** First failed message (preserved for backward compat). */
  rejectionMessage: string | null;
  /** Phase-5: every code that fired, in gate-evaluation order. */
  rejection_codes: RejectionCode[];
  /** Phase-5: every reason message that fired, in gate-evaluation order. */
  rejection_reasons: string[];
  /** Phase-5: per-category boolean map. */
  blocked_by: RejectionBlockedBy;
  appliedRules: RejectionGateResult[];
  decisionTrace: string[];
  /** Snapshots at decision time for audit */
  thresholdSnapshot: Record<string, number>;
  stanceSnapshot: { stance: string; conviction: string } | null;
  scenarioSnapshot: { scenario: string; allowedStrategies: string[] } | null;
  manipulationSnapshot: { score: number; band: string; penalized: boolean; rejected: boolean } | null;
  portfolioFitSnapshot: { fitScore: number; decision: string } | null;
}

/**
 * Classify a rejection-engine outcome into the product tri-state.
 * Approved → APPROVED_SIGNAL. Deferred → DEVELOPING_SETUP (the
 * engine said "not yet"). Rejected splits into DEVELOPING_SETUP vs
 * NO_TRADE based on the rejection code — codes that are fundamentally
 * recoverable ("waiting for price/confidence") map to DEVELOPING_SETUP;
 * structural blocks map to NO_TRADE.
 *
 * Exported so save/read adapters can classify from DB fields when
 * they only have the rejection code (e.g. historic rows).
 */
export function classifySignalStatus(args: {
  finalDecision: 'approved' | 'rejected' | 'deferred';
  rejectionCode: RejectionCode | null;
  confidenceScore: number;
  minConfidence?: number;
}): SignalStatus {
  if (args.finalDecision === 'approved') return 'APPROVED_SIGNAL';
  if (args.finalDecision === 'deferred') return 'DEVELOPING_SETUP';

  // Rejected — classify by the specific code.
  const code = args.rejectionCode;
  if (!code) return 'NO_TRADE';

  // Soft-reject codes: the underlying market condition hasn't
  // confirmed yet, but could still develop into a trade.
  const softRejects: RejectionCode[] = [
    'confidence_below_threshold',
    'risk_reward_insufficient',
    'no_strategy',
  ];
  if (softRejects.includes(code)) {
    // Very-low-confidence rows are NO_TRADE even under a soft code —
    // "setup is developing" is misleading when nothing is close.
    const minConf = args.minConfidence ?? 60;
    if (code === 'confidence_below_threshold' && args.confidenceScore < minConf - 15) {
      return 'NO_TRADE';
    }
    return 'DEVELOPING_SETUP';
  }

  // Hard structural rejects: liquidity, regime, manipulation,
  // scenario, portfolio fit, stop distance, risk score, stance,
  // staleness. All of these mean the trade cannot be taken as-is.
  return 'NO_TRADE';
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
    /** When true, gate 4 (regime compatibility) does NOT reject
     *  bullish strategies in 'High Volatility Risk' regimes — it
     *  emits a soft-warn trace instead and lets the row through to
     *  downstream gates (RR, risk score, liquidity). Off by default
     *  per institutional spec. Plumbed from getStrategyRelaxConfig
     *  via SIGNAL_ENGINE_ALLOW_HIGH_VOL_REGIME / SIGNAL_RELAX_MODE. */
    allowHighVolRegime?: boolean;
  };
  /** ISO or MySQL-datetime timestamp of when the signal was generated.
   *  When supplied, the freshness gate rejects rows older than
   *  `maxSignalAgeHours`. Omit to skip the staleness check. */
  generatedAt?: string;
  /** Max signal age in hours before the freshness gate rejects.
   *  Defaults to 20h, aligned with postSignalValidator.structureBreakAgeHrs. */
  maxSignalAgeHours?: number;

  // ── Phase-5 inputs (all optional — gates self-skip if absent) ──
  /** Liquidity quality score 0-100 (NOT the raw `volume` count).
   *  Phase-5 rejects when this is below `minLiquidityScore` (default 50). */
  liquidityScore?: number | null;
  /** Floor for `liquidityScore`. Default 50. */
  minLiquidityScore?: number;
  /** Numeric floor for `portfolioFit.fitScore`. Default 50.
   *  Distinct from the existing `portfolioDecision === 'rejected'` gate —
   *  this fires even when the upstream evaluator flagged the row only
   *  as `acceptable` but the score is still below floor. */
  minPortfolioFit?: number;
  /** Phase-5 manipulation-score floor. When `manipulationContext.score`
   *  exceeds this (default 60), the gate rejects regardless of the
   *  upstream `shouldReject` flag. */
  maxManipulationRisk?: number;
  /** Decay state from freshnessEngine. 'stale' or 'expired' rejects. */
  decayState?: 'fresh' | 'stale' | 'expired' | string | null;
  /** applyLiveSanity flag — true means the live tape disagrees with the
   *  frozen entry/stop, signal is structurally invalidated. */
  liveInvalidated?: boolean | null;
  /** Current live price. Combined with `direction`, the BUY/SELL
   *  stop-violated check fires when price has crossed the stop. */
  currentPrice?: number | null;
  /** Trade direction, required for the stop-violated check. */
  direction?: 'BUY' | 'SELL' | null;
}

/** Default staleness cutoff — matches postSignalValidator's structure-
 *  break age so both engines retire signals on the same schedule. */
const DEFAULT_MAX_SIGNAL_AGE_HOURS = 20;

/** Parse both ISO and MySQL-datetime timestamps (no TZ = UTC). */
function parseSignalTimestamp(ts: string): number {
  const withT = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`;
  return Date.parse(withZ);
}

// ── Main Entry ─────────────────────────────────────────────────

export function runRejectionEngine(input: RejectionInput): RejectionDecision {
  const gates: RejectionGateResult[] = [];
  const trace: string[] = [];
  let finalDecision: RejectionDecision['finalDecision'] = 'approved';
  let rejectionCode: RejectionCode | null = null;
  let rejectionMessage: string | null = null;

  // Phase-5: accumulate every violation. The first failure is still
  // surfaced via rejectionCode/rejectionMessage for backward compat
  // with consumers that expect a single primary cause; the arrays
  // below carry the full list so a UI can render every reason.
  const rejection_codes:   RejectionCode[] = [];
  const rejection_reasons: string[]        = [];
  const blocked_by: RejectionBlockedBy = {
    confidence:       false,
    risk:             false,
    risk_reward:      false,
    liquidity:        false,
    portfolio_fit:    false,
    manipulation:     false,
    staleness:        false,
    live_invalidated: false,
    stop_violated:    false,
    regime:           false,
    scenario:         false,
    strategy:         false,
    data_quality:     false,
  };

  /** Record a rule failure — pushes to gate trace, the new arrays,
   *  and (only if not already set) the legacy single-code/message
   *  fields. Sets finalDecision='rejected' on first failure. */
  function recordFailure(
    gateName: string,
    code:     RejectionCode,
    message:  string,
    blockedKey: keyof RejectionBlockedBy,
    snapshot?: Record<string, unknown>,
  ): void {
    gates.push({ gate: gateName, passed: false, code, message, snapshot });
    rejection_codes.push(code);
    rejection_reasons.push(message);
    blocked_by[blockedKey] = true;
    if (rejectionCode === null) {
      rejectionCode    = code;
      rejectionMessage = message;
    }
    if (finalDecision !== 'rejected') finalDecision = 'rejected';
  }

  // ── Gate 1: Strategy match (must have a valid strategy) ──────
  // Hard prerequisite — without a strategy, downstream gates that
  // depend on strategy (regime, scenario) cannot evaluate cleanly.
  // We DO short-circuit here: skip all gates 2+ because they would
  // produce noise. Other gates collect failures and continue.
  if (!input.strategy) {
    recordFailure('strategy_match', 'no_strategy', 'No strategy pattern matched', 'strategy');
    trace.push('REJECTED early: no strategy — downstream gates skipped');
  } else {
    gates.push({ gate: 'strategy_match', passed: true });
    trace.push(`strategy=${input.strategy}`);

  // ── Gate 2: Freshness (stale-signal rejection) ───────────────
  if (input.generatedAt) {
    const maxAgeHrs = input.maxSignalAgeHours ?? DEFAULT_MAX_SIGNAL_AGE_HOURS;
    const genMs     = parseSignalTimestamp(input.generatedAt);
    const ageHours  = Number.isFinite(genMs)
      ? (Date.now() - genMs) / 3_600_000
      : Infinity;
    const passed = ageHours <= maxAgeHrs;
    if (passed) {
      gates.push({ gate: 'freshness', passed: true, snapshot: { ageHours, maxAgeHrs } });
    } else {
      recordFailure(
        'freshness', 'signal_stale',
        `Signal age ${ageHours.toFixed(1)}h exceeds ${maxAgeHrs}h cutoff`,
        'staleness', { ageHours, maxAgeHrs },
      );
    }
    trace.push(`age=${ageHours.toFixed(1)}h max=${maxAgeHrs}h passed=${passed}`);
  }

  // ── Phase-5 Gate 2b: Decay state (expired/stale) ─────────────
  // Distinct from time-based age: an explicit `decay_state` of
  // 'expired' or 'stale' from the freshness engine should reject
  // even if the time-based age is within the window.
  if (input.decayState != null) {
    const decay = String(input.decayState).toLowerCase();
    if (decay === 'expired') {
      recordFailure(
        'decay_state', 'decay_expired',
        `Decay state is 'expired' — signal aged out`,
        'staleness', { decayState: decay },
      );
    } else if (decay === 'stale') {
      recordFailure(
        'decay_state', 'signal_stale',
        `Decay state is 'stale' — signal past freshness window`,
        'staleness', { decayState: decay },
      );
    } else {
      gates.push({ gate: 'decay_state', passed: true, snapshot: { decayState: decay } });
    }
    trace.push(`decayState=${decay}`);
  }

  // ── Phase-5 Gate 2c: live_invalidated ────────────────────────
  // Hard reject when applyLiveSanity has flagged the row vs the
  // live tape. Frozen entry no longer matches the market.
  if (input.liveInvalidated === true) {
    recordFailure(
      'live_invalidated', 'live_invalidated',
      'Live tape has invalidated this signal (entry/stop crossed by market)',
      'live_invalidated',
    );
    trace.push('liveInvalidated=true');
  } else if (input.liveInvalidated === false) {
    gates.push({ gate: 'live_invalidated', passed: true });
  }

  // ── Phase-5 Gate 2d: Stop violated (current price vs stop) ───
  // For BUY: reject when currentPrice <= stopLoss.
  // For SELL: reject when currentPrice >= stopLoss.
  // Both directions guarded — one missing field skips the gate.
  if (
    input.currentPrice != null && Number.isFinite(input.currentPrice) &&
    input.direction != null && input.stopLoss > 0
  ) {
    const cp  = Number(input.currentPrice);
    const sl  = input.stopLoss;
    const dir = input.direction;
    const violated =
      (dir === 'BUY'  && cp <= sl) ||
      (dir === 'SELL' && cp >= sl);
    if (violated) {
      recordFailure(
        'stop_violated', 'stop_violated',
        dir === 'BUY'
          ? `BUY stop violated: current ${cp} <= stop ${sl}`
          : `SELL stop violated: current ${cp} >= stop ${sl}`,
        'stop_violated', { direction: dir, currentPrice: cp, stopLoss: sl },
      );
    } else {
      gates.push({
        gate: 'stop_violated', passed: true,
        snapshot: { direction: dir, currentPrice: cp, stopLoss: sl },
      });
    }
    trace.push(`stop_violated=${violated} dir=${dir} cp=${cp} sl=${sl}`);
  }

  // ── Gate 3: Scenario gating ──────────────────────────────────
  if (input.scenarioContext) {
    const sc = input.scenarioContext;
    const blocked = sc.blockedStrategies.includes(input.strategy);
    const allowed = sc.allowedStrategies.length === 0 || sc.allowedStrategies.includes(input.strategy);
    const passed = !blocked && allowed;
    if (passed) {
      gates.push({ gate: 'scenario', passed: true,
        snapshot: { scenarioTag: sc.scenarioTag, blocked: sc.blockedStrategies } });
    } else {
      recordFailure(
        'scenario', 'scenario_blocked',
        `Strategy ${input.strategy} blocked in scenario ${sc.scenarioTag}`,
        'scenario', { scenarioTag: sc.scenarioTag, blocked: sc.blockedStrategies },
      );
    }
    trace.push(`scenario=${sc.scenarioTag} allowed=${passed}`);
  }

  // ── Gate 3b: Market stance (informational, never blocks) ─────
  if (input.stanceContext) {
    const st = input.stanceContext;
    gates.push({ gate: 'stance', passed: true, snapshot: { stance: st.stance, conviction: st.conviction } });
    trace.push(`stance=${st.stance} conviction=${st.conviction}`);
  }

  // ── Gate 4: Regime compatibility ──────────────────────────────
  // Hard rule: a bullish strategy entering during a 'Bearish' or
  // 'High Volatility Risk' regime has poor base rates — losses
  // dominate the win rate even when the per-symbol setup looks clean.
  //
  // Soft override: when `stanceContext.allowHighVolRegime=true` (set
  // via SIGNAL_ENGINE_ALLOW_HIGH_VOL_REGIME / SIGNAL_RELAX_MODE), the
  // 'High Volatility Risk' branch becomes a trace warning instead of
  // a reject. 'Bearish' remains a hard reject — entering long during
  // an actively bearish regime is a different (worse) decision than
  // entering during high vol with no directional conviction.
  {
    const isBullishStrategy = ![
      'bearish_breakdown',
      'overbought_reversal',
      'weak_trend_breakdown',
      'mean_reversion_bounce',
      'volume_climax_reversal',
    ].includes(input.strategy);
    const isBearishRegime    = input.regime === 'Bearish';
    const isHighVolRegime    = input.regime === 'High Volatility Risk';
    const allowHighVol       = input.stanceContext?.allowHighVolRegime === true;
    const blocksByHighVol    = isHighVolRegime && !allowHighVol;
    const blocksByBearish    = isBearishRegime;
    const passed = !(isBullishStrategy && (blocksByBearish || blocksByHighVol));
    if (passed) {
      gates.push({ gate: 'regime', passed: true });
      if (isBullishStrategy && isHighVolRegime && allowHighVol) {
        // Soft-warn trace: row goes through but the operator's logs
        // record that we KNOWINGLY accepted a vol-regime entry.
        trace.push(`regime=high_vol_warn strategy=${input.strategy} relaxed=true`);
      }
    } else {
      recordFailure(
        'regime', 'regime_incompatible',
        `Bullish strategy ${input.strategy} incompatible with ${input.regime} regime`,
        'regime',
      );
    }
    trace.push(`regime=${input.regime} strategy=${input.strategy} compatible=${passed}`);
  }

  // ── Gate 5: Risk-reward threshold ────────────────────────────
  {
    const minRR = input.stanceContext?.minRR ?? 1.3;
    const passed = input.rewardRisk >= minRR;
    if (passed) {
      gates.push({ gate: 'risk_reward', passed: true });
    } else {
      recordFailure(
        'risk_reward', 'risk_reward_insufficient',
        `R:R ${input.rewardRisk} below threshold ${minRR}`,
        'risk_reward',
      );
    }
    trace.push(`rr=${input.rewardRisk} min=${minRR} passed=${passed}`);
  }

  // ── Gate 6: Confidence threshold ─────────────────────────────
  {
    const minConf = input.stanceContext?.minConfidence ?? 55;
    const passed = input.confidenceScore >= minConf;
    if (passed) {
      gates.push({ gate: 'confidence', passed: true });
    } else {
      recordFailure(
        'confidence', 'confidence_below_threshold',
        `Confidence ${input.confidenceScore} below threshold ${minConf}`,
        'confidence',
      );
    }
    trace.push(`confidence=${input.confidenceScore} min=${minConf} passed=${passed}`);
  }

  // ── Gate 7: Risk score cap ───────────────────────────────────
  {
    const maxRisk = input.stanceContext?.maxRiskScore ?? 70;
    const passed = input.riskScore <= maxRisk;
    if (passed) {
      gates.push({ gate: 'risk_score', passed: true });
    } else {
      recordFailure(
        'risk_score', 'risk_score_exceeded',
        `Risk score ${input.riskScore} exceeds cap ${maxRisk}`,
        'risk',
      );
    }
    trace.push(`riskScore=${input.riskScore} max=${maxRisk} passed=${passed}`);
  }

  // ── Gate 8: Liquidity (raw volume floor) ─────────────────────
  // Recalibrated 2026-05: 100_000 cut a meaningful tail of NIFTY 500
  // mid/small caps whose median daily volume sits in the 50–100k band.
  // 50_000 is below the smallest sustainable liquidity for a retail
  // entry; below that, slippage on a 1% position dominates the edge.
  // Env-tunable so an operator can re-tighten if a lower-liquidity
  // strategy is being calibrated.
  {
    const envFloor = Number(process.env.SIGNAL_ENGINE_MIN_RAW_VOLUME);
    const minVolume = Number.isFinite(envFloor) && envFloor > 0
      ? Math.floor(envFloor)
      : 50_000;
    const passed = input.volume >= minVolume;
    if (passed) {
      gates.push({ gate: 'liquidity', passed: true });
    } else {
      recordFailure(
        'liquidity', 'liquidity_insufficient',
        `Volume ${input.volume} below minimum ${minVolume}`,
        'liquidity',
      );
    }
    trace.push(`volume=${input.volume} min=${minVolume} passed=${passed}`);
  }

  // ── Phase-5 Gate 8b: Liquidity SCORE (0-100 quality floor) ───
  // Distinct from raw volume: this is the 0-100 liquidity quality
  // score from the scoring engine. Phase-5 spec demands a numeric
  // floor of 50 — fires even when raw volume passes the count gate.
  if (input.liquidityScore != null) {
    // Recalibrated 2026-05: liquidity QUALITY score (0–100) floor moves
    // 50→40. The raw-volume gate above is the hard liquidity bound;
    // this score penalises spread + book depth + recency-of-fill on
    // top, and 50 was disqualifying liquid mid-caps whose orderbook
    // happens to be thin at the close. 40 still rejects the bottom
    // quintile — illiquid microcaps still fail.
    const minLiqScore = input.minLiquidityScore ?? 40;
    const score = Number(input.liquidityScore);
    const passed = score >= minLiqScore;
    if (passed) {
      gates.push({ gate: 'liquidity_score', passed: true,
        snapshot: { liquidityScore: score, min: minLiqScore } });
    } else {
      recordFailure(
        'liquidity_score', 'liquidity_score_low',
        `Liquidity score ${score} below floor ${minLiqScore}`,
        'liquidity', { liquidityScore: score, min: minLiqScore },
      );
    }
    trace.push(`liquidityScore=${score} min=${minLiqScore} passed=${passed}`);
  }

  // ── Gate 9: Stop distance bounds ──────────────────────────────
  {
    const stopPct = input.entryPrice > 0 ? Math.abs(input.entryPrice - input.stopLoss) / input.entryPrice * 100 : 0;
    const minStopAtr = 0.5;
    const maxStopAtr = 3.0;
    const stopAtrMultiple = input.atrPct > 0 ? stopPct / input.atrPct : 0;
    const passed = stopAtrMultiple >= minStopAtr && stopAtrMultiple <= maxStopAtr;
    if (passed) {
      gates.push({ gate: 'stop_distance', passed: true,
        snapshot: { stopPct, stopAtrMultiple, atrPct: input.atrPct } });
    } else {
      recordFailure(
        'stop_distance', 'stop_distance_invalid',
        `Stop distance ${stopAtrMultiple.toFixed(2)} ATR outside ${minStopAtr}-${maxStopAtr} range`,
        'risk', { stopPct, stopAtrMultiple, atrPct: input.atrPct },
      );
    }
    trace.push(`stopAtr=${stopAtrMultiple.toFixed(2)} range=[${minStopAtr},${maxStopAtr}] passed=${passed}`);
  }

  // ── Gate 10: Portfolio fit (decision + numeric floor) ────────
  // Phase-5 extends the existing decision-based gate: it now also
  // rejects when fitScore is below the explicit numeric floor
  // (default 50), even if the upstream evaluator marked the row
  // as 'acceptable'. Two fail conditions, one combined gate.
  {
    const pf = input.portfolioFit;
    // Recalibrated 2026-05: 50 → 40. evaluatePortfolioFit already maps
    // <30→rejected and <50→deferred; the 50 floor here was a third
    // reject layer that disqualified rows the upstream evaluator only
    // marked as 'approved_with_penalty'. 40 keeps the structural reject
    // (correlation cluster, capital exhausted) intact while letting
    // mildly-penalised setups through.
    const minFit = input.minPortfolioFit ?? 40;
    let pfRejected = false;
    if (pf.portfolioDecision === 'rejected') {
      recordFailure(
        'portfolio_fit', 'portfolio_fit_rejected',
        `Portfolio fit rejected: score ${pf.fitScore} — ${pf.penalties.join(', ')}`,
        'portfolio_fit', { fitScore: pf.fitScore, decision: pf.portfolioDecision },
      );
      pfRejected = true;
    }
    if (pf.fitScore < minFit) {
      recordFailure(
        'portfolio_fit_score', 'portfolio_fit_rejected',
        `Portfolio fit score ${pf.fitScore} below floor ${minFit}`,
        'portfolio_fit', { fitScore: pf.fitScore, minFit },
      );
      pfRejected = true;
    }
    if (!pfRejected) {
      if (pf.portfolioDecision === 'deferred') {
        gates.push({ gate: 'portfolio_fit', passed: true,
          snapshot: { fitScore: pf.fitScore, decision: 'deferred' } });
        if (finalDecision === 'approved') finalDecision = 'deferred';
      } else {
        gates.push({ gate: 'portfolio_fit', passed: true,
          snapshot: { fitScore: pf.fitScore, decision: pf.portfolioDecision } });
      }
    }
    trace.push(`portfolioFit=${pf.fitScore} min=${minFit} decision=${pf.portfolioDecision}`);
  }

  // ── Gate 11: Manipulation penalty/rejection (+ Phase-5 floor) ─
  // Original: shouldReject flag rejects, shouldPenalize logs only.
  // Phase-5 addition: a numeric score above maxManipulationRisk
  // (default 60) rejects even when the upstream `shouldReject` flag
  // is false — the spec's hard floor.
  if (input.manipulationContext) {
    const mc = input.manipulationContext;
    const maxManip = input.maxManipulationRisk ?? 60;
    let manipRejected = false;
    if (mc.shouldReject) {
      recordFailure(
        'manipulation', 'manipulation_rejected',
        mc.warning ?? `Manipulation rejection (score ${mc.score}, band ${mc.band})`,
        'manipulation', { score: mc.score, band: mc.band },
      );
      manipRejected = true;
    } else if (mc.score > maxManip) {
      recordFailure(
        'manipulation_score', 'manipulation_rejected',
        `Manipulation score ${mc.score} exceeds floor ${maxManip} (band ${mc.band})`,
        'manipulation', { score: mc.score, band: mc.band, max: maxManip },
      );
      manipRejected = true;
    }
    if (!manipRejected) {
      if (mc.shouldPenalize) {
        gates.push({ gate: 'manipulation', passed: true, code: 'manipulation_penalized',
          message: mc.warning ?? `Manipulation penalty applied (score ${mc.score})`,
          snapshot: { score: mc.score, band: mc.band } });
        trace.push(`manipulation: penalized (score=${mc.score} band=${mc.band})`);
      } else {
        gates.push({ gate: 'manipulation', passed: true, snapshot: { score: mc.score, band: mc.band } });
      }
    }
    trace.push(`manipulation=${mc.score} band=${mc.band} reject=${mc.shouldReject} penalize=${mc.shouldPenalize} max=${maxManip}`);
  }

  } // ← end of `else` (strategy present) block

  // ── Build threshold snapshot ─────────────────────────────────
  // Default fallbacks held in lock-step with getStrategyRelaxConfig's
  // strict baselines (signalEngine.constants.ts) — recalibrated 2026-05.
  const thresholdSnapshot: Record<string, number> = {
    minConfidence: input.stanceContext?.minConfidence ?? 55,
    minRR: input.stanceContext?.minRR ?? 1.3,
    maxRiskScore: input.stanceContext?.maxRiskScore ?? 70,
    maxSignalAgeHours: input.maxSignalAgeHours ?? DEFAULT_MAX_SIGNAL_AGE_HOURS,
    confidenceScore: input.confidenceScore,
    riskScore: input.riskScore,
    rewardRisk: input.rewardRisk,
    portfolioFitScore: input.portfolioFit.fitScore,
  };

  // ── Derive the product-facing tri-state ──────────────────────
  // This is the authoritative classification for UI/persistence.
  // Persisted to q365_signals.signal_status so downstream reads
  // don't need to re-derive from the raw codes.
  const signalStatus = classifySignalStatus({
    finalDecision,
    rejectionCode,
    confidenceScore: input.confidenceScore,
    minConfidence: input.stanceContext?.minConfidence,
  });
  trace.push(`signalStatus=${signalStatus}`);

  return {
    finalDecision,
    signalStatus,
    rejected: rejection_codes.length > 0,
    rejectionCode,
    rejectionMessage,
    rejection_codes,
    rejection_reasons,
    blocked_by,
    appliedRules: gates,
    decisionTrace: trace,
    thresholdSnapshot,
    stanceSnapshot: input.stanceContext ? { stance: input.stanceContext.stance, conviction: input.stanceContext.conviction } : null,
    scenarioSnapshot: input.scenarioContext ? { scenario: input.scenarioContext.scenarioTag, allowedStrategies: input.scenarioContext.allowedStrategies } : null,
    manipulationSnapshot: input.manipulationContext ? { score: input.manipulationContext.score, band: input.manipulationContext.band, penalized: input.manipulationContext.shouldPenalize, rejected: input.manipulationContext.shouldReject } : null,
    portfolioFitSnapshot: { fitScore: input.portfolioFit.fitScore, decision: input.portfolioFit.portfolioDecision },
  };
}
