// ════════════════════════════════════════════════════════════════
//  signalDueDiligence — PHASE_2_DUE_DILIGENCE_2026-05
//
//  Per-signal explainability + performance due diligence layer.
//
//  Inputs are real engine fields (factor_scores, rejection_reasons,
//  explanation block, entry/stop/target geometry, live price) — this
//  module DOES NOT fabricate indicator values it cannot read, and it
//  DOES NOT carry post-trade outcome data that the platform does not
//  yet persist. Missing slots are explicitly marked INSUFFICIENT_DATA
//  so the UI can render an honest "no review yet" state.
//
//  Pure module — no I/O, no DB, no env reads. Same input → same output.
//
//  CRITICAL SAFETY RULE — this engine EXPLAINS; it does not DECIDE.
//  Nothing in this file alters approval state, thresholds, scoring
//  weights, or whether a signal is tradable. The strict gate upstream
//  is the single source of truth for what ships in `approvedSignals`.
// ════════════════════════════════════════════════════════════════

import {
  APPROVAL_TARGET_FINAL_SCORE,
  APPROVAL_TARGET_CONFIDENCE,
  APPROVAL_TARGET_RISK_REWARD,
  calculateApprovalGap,
  getSignalFinalScore,
  getSignalConfidence,
  getSignalRiskReward,
  type RankableSignal,
} from '@/lib/signals/signalRanking';

// ── Public contract ─────────────────────────────────────────────

export type DueDiligenceStatus = 'PASSED' | 'FAILED' | 'PENDING' | 'NOT_AVAILABLE';
export type DueDiligenceSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DueDiligenceReview {
  status:               DueDiligenceStatus;
  summary:              string;
  primaryReason:        string;
  secondaryReasons:     string[];
  confirmationPassed:   string[];
  confirmationFailed:   string[];
  riskFindings:         string[];
  dataFindings:         string[];
  marketFindings:       string[];
  indicatorFindings:    string[];
  performanceFindings:  string[];
  learningNotes:        string[];
  nextAction:           string;
  severity:             DueDiligenceSeverity;
  /** 0–100 score of how thoroughly we could explain this signal —
   *  driven by how many findings the engine could populate from real
   *  fields (not a quality assessment of the signal itself). */
  explainabilityScore:  number;
}

export type PerformanceReviewStatus =
  | 'PENDING'
  | 'COMPLETED'
  | 'INSUFFICIENT_DATA';

export type PerformanceOutcome =
  | 'SUCCESS'
  | 'FAILED'
  | 'NEUTRAL'
  | 'PENDING'
  | 'UNKNOWN';

export type PerformanceReviewWindow =
  | '15M' | '30M' | '1H' | 'EOD' | 'MULTI_DAY' | null;

export interface PerformanceReview {
  reviewStatus:             PerformanceReviewStatus;
  entryPrice:               number | null;
  currentPrice:             number | null;
  targetPrice:              number | null;
  stopLoss:                 number | null;
  movePercent:              number | null;
  /** Max favourable excursion in percent. Requires per-signal price
   *  history which is not persisted yet — INSUFFICIENT_DATA marker. */
  maxFavorableMovePercent:  number | null;
  /** Max adverse excursion in percent. Same caveat as MFE. */
  maxAdverseMovePercent:    number | null;
  targetHit:                boolean | null;
  stopLossHit:              boolean | null;
  timeToTargetMinutes:      number | null;
  timeToStopMinutes:        number | null;
  reviewWindow:             PerformanceReviewWindow;
  outcome:                  PerformanceOutcome;
  /** Surface the cause when fields are null — keeps the UI honest. */
  insufficientDataReasons:  string[];
}

/** Per-tier semantic key — drives confirmationPassed/Failed phrasing. */
export type SignalTierContext =
  | 'approved'
  | 'high_potential'
  | 'watchlist'
  | 'developing'
  | 'scanner_candidate'
  | 'risk_restricted'
  | 'rejected'
  | 'nearest';

export interface DueDiligenceContext {
  tier:           SignalTierContext;
  marketOpen?:    boolean;
  marketLabel?:   string;
  isBootstrap?:   boolean;
  isFallback?:    boolean;
  freshnessMode?: 'NORMAL_OPERATION' | 'WATCHLIST_ONLY_MODE' | 'APPROVAL_FREEZE_MODE' | string;
  candleAgeMinutes?: number | null;
}

// ── Internals ───────────────────────────────────────────────────

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const num = (v: unknown): number => numOrNull(v) ?? 0;

const FACTOR_LABELS: Record<string, string> = {
  strategy_quality:    'Strategy quality',
  trend_alignment:     'Trend alignment',
  momentum:            'Momentum',
  volume_confirmation: 'Volume confirmation',
  risk_reward:         'Risk-reward factor',
  liquidity:           'Liquidity',
  market_regime:       'Market regime',
  portfolio_fit:       'Portfolio fit',
};

const STRONG_FACTOR_FLOOR = 70;
const WEAK_FACTOR_CEIL    = 55;

const isStaleByFreshness = (s: RankableSignal): boolean => {
  const f = String(s.freshness_state ?? '').toUpperCase();
  const d = String(s.decay_state ?? '').toLowerCase();
  return f === 'STALE' || f === 'AGING' || d === 'stale' || d === 'aging';
};

const isExpiredByFreshness = (s: RankableSignal): boolean => {
  const f = String(s.freshness_state ?? '').toUpperCase();
  const d = String(s.decay_state ?? '').toLowerCase();
  return f === 'EXPIRED' || d === 'expired' || d === 'frozen';
};

const readFactorScores = (s: any): Record<string, number | null> => {
  const fs = s?.factor_scores;
  const out: Record<string, number | null> = {};
  if (fs && typeof fs === 'object') {
    for (const key of Object.keys(FACTOR_LABELS)) {
      out[key] = numOrNull((fs as any)[key]);
    }
  }
  // Mirror the flat per-factor columns the elite gate flattens.
  out.portfolio_fit    = out.portfolio_fit    ?? numOrNull(s?.portfolio_fit_score);
  out.liquidity        = out.liquidity        ?? numOrNull(s?.liquidity_score);
  out.market_regime    = out.market_regime    ?? numOrNull(s?.market_regime_score);
  // stress_survival_score sits outside factor_scores per Phase-4 contract.
  out.stress_survival  = numOrNull(s?.stress_survival_score);
  return out;
};

// ── Confirmation findings ────────────────────────────────────────

export function buildConfirmationFindings(
  signal: RankableSignal,
  context: DueDiligenceContext,
): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];

  const finalScore = getSignalFinalScore(signal);
  const confidence = getSignalConfidence(signal);
  const rr         = getSignalRiskReward(signal);

  if (finalScore > 0) {
    if (finalScore >= APPROVAL_TARGET_FINAL_SCORE) {
      passed.push(`Final score ${finalScore.toFixed(1)} ≥ ${APPROVAL_TARGET_FINAL_SCORE}`);
    } else {
      failed.push(`Final score ${finalScore.toFixed(1)} below ${APPROVAL_TARGET_FINAL_SCORE}`);
    }
  }
  if (confidence > 0) {
    if (confidence >= APPROVAL_TARGET_CONFIDENCE) {
      passed.push(`Confidence ${confidence.toFixed(1)} ≥ ${APPROVAL_TARGET_CONFIDENCE}`);
    } else {
      failed.push(`Confidence ${confidence.toFixed(1)} below ${APPROVAL_TARGET_CONFIDENCE}`);
    }
  }
  if (rr > 0) {
    if (rr >= APPROVAL_TARGET_RISK_REWARD) {
      passed.push(`Risk-reward ${rr.toFixed(2)} ≥ ${APPROVAL_TARGET_RISK_REWARD.toFixed(1)}`);
    } else {
      failed.push(`Risk-reward ${rr.toFixed(2)} below ${APPROVAL_TARGET_RISK_REWARD.toFixed(1)}`);
    }
  }

  // Factor-level confirmation — only added when the factor is present.
  const factors = readFactorScores(signal);
  for (const [key, label] of Object.entries(FACTOR_LABELS)) {
    const v = factors[key];
    if (v == null) continue;
    if (v >= STRONG_FACTOR_FLOOR) {
      passed.push(`${label} strong (${v.toFixed(0)})`);
    } else if (v < WEAK_FACTOR_CEIL) {
      failed.push(`${label} weak (${v.toFixed(0)})`);
    }
  }

  // Lifecycle / state-level signals.
  const sigStatus = String((signal as any).signal_status ?? '').toUpperCase();
  if (sigStatus === 'APPROVED_SIGNAL' || sigStatus === 'VALID_SIGNAL') {
    passed.push('Signal status: APPROVED');
  } else if (sigStatus === 'DEVELOPING_SETUP') {
    failed.push('Signal status: developing — awaiting maturity');
  }

  if (signal.live_invalidated === true) {
    failed.push('Live revalidation invalidated the setup');
  }
  if (signal.execution_allowed === false) {
    failed.push('Execution blocked by engine');
  }
  if (signal.invalidation_reason && String(signal.invalidation_reason).trim() !== '') {
    failed.push(`Invalidation: ${signal.invalidation_reason}`);
  }

  if (context.tier === 'approved') {
    passed.push('Cleared institutional approval gate');
  } else if (context.tier === 'high_potential') {
    failed.push('Did not clear strict approval gate — promoted via conditional fallback');
  } else if (context.tier === 'watchlist' || context.tier === 'developing' || context.tier === 'scanner_candidate') {
    failed.push('Not yet promoted — engine is monitoring this setup');
  } else if (context.tier === 'risk_restricted' || context.tier === 'rejected') {
    failed.push('Engine rejected this candidate at the institutional gate');
  } else if (context.tier === 'nearest') {
    failed.push('Surfaced as closest-to-approval — institutional bar not met');
  }

  return { passed, failed };
}

// ── Risk findings ────────────────────────────────────────────────

export function buildRiskFindings(
  signal: RankableSignal,
  _context: DueDiligenceContext,
): string[] {
  void _context;
  const out: string[] = [];
  const entry  = numOrNull((signal as any).entry_price);
  const stop   = numOrNull((signal as any).stop_loss);
  const target = numOrNull((signal as any).target1);
  const rr     = getSignalRiskReward(signal);
  const direction = String(signal.direction ?? '').toUpperCase();

  if (entry != null && stop != null && entry > 0) {
    const stopDistPct = Math.abs((entry - stop) / entry) * 100;
    out.push(`Stop distance ${stopDistPct.toFixed(2)}% from entry`);
    if (stopDistPct > 8) {
      out.push('Stop is wide — drawdown exposure above 8% of entry');
    } else if (stopDistPct < 0.5) {
      out.push('Stop is tight — risk of premature invalidation on noise');
    }
  }
  if (entry != null && target != null && entry > 0) {
    const tgtDistPct = Math.abs((target - entry) / entry) * 100;
    out.push(`Target distance ${tgtDistPct.toFixed(2)}% from entry`);
  }
  if (rr > 0 && rr < APPROVAL_TARGET_RISK_REWARD) {
    out.push(`Reward-to-risk ${rr.toFixed(2)} is below institutional minimum ${APPROVAL_TARGET_RISK_REWARD.toFixed(1)}`);
  }

  const liquidity = numOrNull((signal as any).liquidity_score)
    ?? numOrNull(((signal as any)?.factor_scores as any)?.liquidity);
  if (liquidity != null && liquidity < 50) {
    out.push(`Liquidity score ${liquidity.toFixed(0)} below institutional floor — execution slippage risk`);
  }
  const stress = numOrNull((signal as any).stress_survival_score);
  if (stress != null && stress < 60) {
    out.push(`Stress survival score ${stress.toFixed(0)} — setup may not hold under volatility shocks`);
  }
  if (signal.execution_allowed === false) {
    out.push('Execution explicitly blocked — broker/engine veto');
  }

  if (entry != null && stop != null && target != null && direction) {
    if (direction === 'BUY' && (stop >= entry || target <= entry)) {
      out.push('Trade geometry inconsistent for BUY (stop must be below entry, target above)');
    } else if (direction === 'SELL' && (stop <= entry || target >= entry)) {
      out.push('Trade geometry inconsistent for SELL (stop must be above entry, target below)');
    }
  }

  if (out.length === 0) out.push('Risk profile within institutional bounds');
  return out;
}

// ── Data-freshness findings ──────────────────────────────────────

export function buildDataFreshnessFindings(
  signal: RankableSignal,
  context: DueDiligenceContext,
): string[] {
  const out: string[] = [];
  if (context.marketOpen === false) {
    out.push('Market closed — live confirmation not available this cycle');
  }
  if (context.isBootstrap === true) {
    out.push('Operating on bootstrap-seeded data — not a live broker feed');
  }
  if (context.isFallback === true) {
    out.push('Provider in fallback mode — quality degraded');
  }
  if (context.freshnessMode && context.freshnessMode !== 'NORMAL_OPERATION') {
    if (context.freshnessMode === 'APPROVAL_FREEZE_MODE') {
      out.push('Approval freeze active — feed stale beyond 45m, no new approvals issued');
    } else if (context.freshnessMode === 'WATCHLIST_ONLY_MODE') {
      out.push('Feed aging beyond 15m — engine demoted approvals to watchlist');
    }
  }
  if (context.candleAgeMinutes != null && context.candleAgeMinutes > 30) {
    out.push(`Candle feed ${context.candleAgeMinutes}m old — confirmation lag risk`);
  }
  if (isStaleByFreshness(signal)) {
    out.push('Row-level freshness flag: stale / aging — awaiting fresh tick');
  }
  if (isExpiredByFreshness(signal)) {
    out.push('Row marked expired — must be re-validated before action');
  }
  const dq = numOrNull((signal as any).data_quality_score);
  if (dq != null && dq < 70) {
    out.push(`Data quality score ${dq.toFixed(0)} below institutional floor`);
  }
  if (out.length === 0) out.push('Data path is healthy and within freshness limits');
  return out;
}

// ── Market-condition findings ────────────────────────────────────

export function buildMarketConditionFindings(
  signal: RankableSignal,
  context: DueDiligenceContext,
): string[] {
  const out: string[] = [];
  if (context.marketOpen === false) {
    out.push(`${context.marketLabel ?? 'Market'} closed — broader index direction not currently tradable`);
  }
  const factors = readFactorScores(signal);
  const regime = factors.market_regime;
  if (regime != null) {
    if (regime < 50) out.push(`Market regime score ${regime.toFixed(0)} — index/regime not supportive`);
    else if (regime < 70) out.push(`Market regime score ${regime.toFixed(0)} — neutral / mixed regime`);
    else out.push(`Market regime score ${regime.toFixed(0)} — regime supportive of trade direction`);
  } else {
    out.push('Market-regime factor not populated for this row (INSUFFICIENT_DATA)');
  }

  const portfolioFit = factors.portfolio_fit;
  if (portfolioFit != null && portfolioFit < 60) {
    out.push(`Portfolio fit ${portfolioFit.toFixed(0)} — sector/correlation overlap risk`);
  }

  const conviction = String((signal as any).conviction_band ?? '').toLowerCase();
  if (conviction === 'avoid') out.push('Conviction band tagged AVOID by Phase-4 scorer');
  else if (conviction === 'medium') out.push('Conviction band: medium — mixed market signals');
  else if (conviction === 'high') out.push('Conviction band: high — coherent market signals');

  if (out.length === 0) out.push('Market context inputs were neutral');
  return out;
}

// ── Indicator findings ───────────────────────────────────────────
// IMPORTANT: We do NOT fabricate RSI/MACD/VWAP values. The platform's
// Phase-4 scorer aggregates indicator inputs into the 8 factor_scores
// numerics. We surface those scores directly and translate them into
// the operator's vocabulary (trend / momentum / volume / regime) so
// the UI explains "what the indicator stack said" without inventing
// raw indicator readings the engine does not currently expose.

export function buildIndicatorFindings(
  signal: RankableSignal,
  _context: DueDiligenceContext,
): string[] {
  void _context;
  const out: string[] = [];
  const factors = readFactorScores(signal);
  const label = (k: keyof typeof FACTOR_LABELS): string => FACTOR_LABELS[k];

  const interpret = (key: keyof typeof FACTOR_LABELS): void => {
    const v = factors[key];
    if (v == null) {
      out.push(`${label(key)}: INSUFFICIENT_DATA`);
      return;
    }
    if (v >= 80)      out.push(`${label(key)} very strong (${v.toFixed(0)})`);
    else if (v >= 70) out.push(`${label(key)} strong (${v.toFixed(0)})`);
    else if (v >= 55) out.push(`${label(key)} moderate (${v.toFixed(0)})`);
    else              out.push(`${label(key)} weak (${v.toFixed(0)}) — below confirmation floor`);
  };

  interpret('trend_alignment');
  interpret('momentum');
  interpret('volume_confirmation');
  interpret('strategy_quality');

  // Surface the Phase-10 narrative explanation when present — this is
  // engine output, not synthesised here.
  const expl = (signal as any).explanation;
  if (expl && typeof expl === 'object') {
    const fse = String((expl as any).factor_score_explanation ?? '').trim();
    if (fse) out.push(`Engine note: ${fse}`);
  }

  return out;
}

// ── Performance findings ─────────────────────────────────────────

export function buildPerformanceFindings(
  review: PerformanceReview,
  context: DueDiligenceContext,
): string[] {
  const out: string[] = [];
  if (review.reviewStatus === 'INSUFFICIENT_DATA') {
    if (review.insufficientDataReasons.length > 0) {
      out.push(`Insufficient data for performance review (${review.insufficientDataReasons.join('; ')})`);
    } else {
      out.push('Insufficient data for performance review');
    }
    return out;
  }
  if (review.reviewStatus === 'PENDING') {
    out.push('Performance review pending — signal still active');
  }
  if (review.entryPrice != null && review.currentPrice != null) {
    out.push(`Entry ${review.entryPrice} → current ${review.currentPrice}`);
  }
  if (review.movePercent != null) {
    out.push(`Move since signal: ${review.movePercent.toFixed(2)}%`);
  }
  if (review.targetHit === true)  out.push('Target reached');
  if (review.stopLossHit === true) out.push('Stop loss breached');
  if (review.outcome && review.outcome !== 'PENDING' && review.outcome !== 'UNKNOWN') {
    out.push(`Outcome classification: ${review.outcome}`);
  }
  if (context.marketOpen === false) {
    out.push('Market closed — current move reflects last-close, not live trade');
  }
  return out;
}

// ── Learning notes ───────────────────────────────────────────────
// Generates operator-facing observations based on the actual signal
// fingerprint — NEVER instructs automated model changes (per spec).

export function buildLearningNotes(
  signal: RankableSignal,
  context: DueDiligenceContext,
): string[] {
  const out: string[] = [];
  const finalScore = getSignalFinalScore(signal);
  const confidence = getSignalConfidence(signal);
  const rr         = getSignalRiskReward(signal);
  const factors    = readFactorScores(signal);

  // High final but failed strict — diagnose dominant near-miss factor.
  if (finalScore >= 70 && context.tier !== 'approved') {
    const trend  = factors.trend_alignment;
    const mom    = factors.momentum;
    const vol    = factors.volume_confirmation;
    if (vol != null && vol < WEAK_FACTOR_CEIL && (trend ?? 0) >= STRONG_FACTOR_FLOOR) {
      out.push('Observation: high score driven by trend, but volume confirmation lagged — review whether volume weight should be reinforced for similar setups.');
    } else if (mom != null && mom >= STRONG_FACTOR_FLOOR && rr < APPROVAL_TARGET_RISK_REWARD) {
      out.push('Observation: strong momentum did not translate into adequate reward-to-risk — review target geometry for momentum-heavy setups.');
    } else if (rr >= APPROVAL_TARGET_RISK_REWARD && confidence < APPROVAL_TARGET_CONFIDENCE) {
      out.push('Observation: payoff geometry strong but confidence floor missed — review whether confidence model is under-weighting trend+regime alignment.');
    } else {
      out.push('Observation: high score, multi-factor near-miss — capture as a candidate for the daily review queue.');
    }
  }

  if (context.freshnessMode && context.freshnessMode !== 'NORMAL_OPERATION') {
    out.push('Observation: setup was visible during a stale-feed freshness mode — re-evaluate when the live feed normalises.');
  }
  if (context.isBootstrap === true) {
    out.push('Observation: row sourced from bootstrap seed — do not generalise outcome until live broker feed validates.');
  }
  if (signal.live_invalidated === true) {
    out.push('Observation: live revalidation killed the row — capture invalidation cause for the failure-mode log.');
  }

  if (out.length === 0) {
    out.push('No additional learning signal identified for this row.');
  }
  return out;
}

// ── Performance review builder ───────────────────────────────────

export function buildPerformanceReview(
  signal: RankableSignal,
  context: DueDiligenceContext,
): PerformanceReview {
  const entry   = numOrNull((signal as any).entry_price);
  const stop    = numOrNull((signal as any).stop_loss);
  const target  = numOrNull((signal as any).target1);
  const current = numOrNull((signal as any).livePrice ?? (signal as any).ltp ?? (signal as any).current_price);
  const direction = String(signal.direction ?? '').toUpperCase();

  const insufficient: string[] = [];

  let movePercent: number | null = null;
  if (entry != null && current != null && entry > 0) {
    const raw = ((current - entry) / entry) * 100;
    movePercent = direction === 'SELL' ? -raw : raw;
  }

  let targetHit:   boolean | null = null;
  let stopLossHit: boolean | null = null;
  if (entry != null && current != null && target != null && stop != null) {
    if (direction === 'BUY') {
      targetHit   = current >= target;
      stopLossHit = current <= stop;
    } else if (direction === 'SELL') {
      targetHit   = current <= target;
      stopLossHit = current >= stop;
    }
  } else {
    if (entry == null)   insufficient.push('entry price missing');
    if (current == null) insufficient.push('current price unavailable');
    if (target == null)  insufficient.push('target missing');
    if (stop == null)    insufficient.push('stop loss missing');
  }

  // MFE/MAE require per-signal price history — not persisted yet.
  // Surface as INSUFFICIENT_DATA rather than fabricating values.
  insufficient.push('per-signal price history not persisted yet (MFE/MAE/time-to-target unavailable)');

  // Determine review status + outcome from what we DO have.
  let reviewStatus: PerformanceReviewStatus = 'INSUFFICIENT_DATA';
  let outcome: PerformanceOutcome = 'UNKNOWN';
  if (entry != null && current != null) {
    if (targetHit === true) {
      reviewStatus = 'COMPLETED';
      outcome      = 'SUCCESS';
    } else if (stopLossHit === true) {
      reviewStatus = 'COMPLETED';
      outcome      = 'FAILED';
    } else {
      reviewStatus = 'PENDING';
      outcome      = 'PENDING';
    }
  }
  if (context.marketOpen === false && reviewStatus === 'PENDING') {
    // Closed market — the live move is a "last close" snapshot, not
    // an active trade outcome.
    outcome = movePercent != null
      ? (Math.abs(movePercent) < 0.2 ? 'NEUTRAL' : (movePercent > 0 ? 'PENDING' : 'PENDING'))
      : 'PENDING';
  }

  return {
    reviewStatus,
    entryPrice:               entry,
    currentPrice:             current,
    targetPrice:              target,
    stopLoss:                 stop,
    movePercent,
    maxFavorableMovePercent:  null,
    maxAdverseMovePercent:    null,
    targetHit,
    stopLossHit,
    timeToTargetMinutes:      null,
    timeToStopMinutes:        null,
    reviewWindow:             null,
    outcome,
    insufficientDataReasons:  insufficient,
  };
}

// ── Master due-diligence builder ────────────────────────────────

export function buildSignalDueDiligence(
  signal: RankableSignal,
  context: DueDiligenceContext,
  performance?: PerformanceReview,
): DueDiligenceReview {
  const tier = context.tier;
  const review = performance ?? buildPerformanceReview(signal, context);

  const conf = buildConfirmationFindings(signal, context);
  const risk = buildRiskFindings(signal, context);
  const data = buildDataFreshnessFindings(signal, context);
  const market = buildMarketConditionFindings(signal, context);
  const indicators = buildIndicatorFindings(signal, context);
  const performanceFindings = buildPerformanceFindings(review, context);
  const learning = buildLearningNotes(signal, context);

  // ── PHASE_B_MANIPULATION_FINDINGS ────────────────────────────
  // Inject manipulation-engine findings into the existing buckets so
  // the DD pane explains how Manipulation Watch did or did not affect
  // approval. Safe-wording is enforced by the envelope's `explanation`
  // / `evidence` strings — we just route them into the right bucket.
  //
  // Fresh + canAffectApproval: hard rejection logged into riskFindings
  // and confirmationFailed so the summary picks up the cause.
  // Stale / no-data / partial: warning into riskFindings only — never
  // counted as a confirmation failure (would falsely block approval).
  const mr = (signal as { manipulationRisk?: import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk })
    .manipulationRisk;
  let manipulationStaleSummary: string | null = null;
  if (mr && mr.band !== 'UNKNOWN' && mr.band !== 'LOW') {
    if (mr.freshnessStatus === 'FRESH') {
      if (mr.canAffectApproval) {
        // Fresh + ≥ELEVATED.
        risk.push(`Fresh manipulation risk detected (band ${mr.band}, score ${mr.score ?? '—'})`);
        if (mr.recommendedAction === 'BLOCK_APPROVAL') {
          risk.push('Signal approval blocked due to abnormal activity');
          conf.failed.push('Manipulation risk gate failed');
        } else if (mr.recommendedAction === 'RISK_RESTRICT') {
          risk.push('Signal risk-restricted; manual review required');
          conf.failed.push('Manipulation risk gate failed');
        } else if (mr.recommendedAction === 'PENALIZE') {
          risk.push('Elevated manipulation risk — warning attached, approval thresholds not modified');
        }
        if (mr.evidence.length > 0) {
          for (const e of mr.evidence) data.push(e);
        }
        learning.push('Review whether this symbol repeatedly produces technical setups with manipulation risk.');
      } else {
        // FRESH but WATCH band — warning only.
        risk.push(`Manipulation watch flag on ${signal.symbol ?? signal.tradingsymbol ?? 'this symbol'} (band ${mr.band})`);
      }
    } else {
      // Stale / no-data / partial — warning bucket only; never failure.
      risk.push('Historical manipulation risk exists');
      data.push(`Manipulation data is ${mr.freshnessStatus.toLowerCase()}; warning-only mode active`);
      manipulationStaleSummary =
        'Historical manipulation risk exists, but the data is stale. ' +
        'No hard rejection was applied. Fresh scan required before manipulation risk can block approval.';
    }
  }
  // Stash the explanation for the summary phase below.
  const manipulationSummaryOverride: string | null =
    mr && mr.canAffectApproval && mr.freshnessStatus === 'FRESH'
      ? mr.explanation
      : null;

  // Status by tier semantics.
  let status: DueDiligenceStatus;
  if (tier === 'approved') status = 'PASSED';
  else if (tier === 'high_potential' || tier === 'developing'
         || tier === 'watchlist' || tier === 'scanner_candidate'
         || tier === 'nearest') status = 'PENDING';
  else if (tier === 'risk_restricted' || tier === 'rejected') status = 'FAILED';
  else status = 'NOT_AVAILABLE';

  // Severity by hard signal state — defaults LOW when row is healthy.
  let severity: DueDiligenceSeverity = 'LOW';
  if (signal.live_invalidated === true || signal.execution_allowed === false) {
    severity = 'CRITICAL';
  } else if (tier === 'risk_restricted' || tier === 'rejected') {
    severity = 'HIGH';
  } else if (tier === 'high_potential' || tier === 'developing'
           || tier === 'scanner_candidate' || tier === 'watchlist' || tier === 'nearest') {
    severity = 'MEDIUM';
  }

  // Primary + secondary reasons — use explicit fields when present.
  const enginePrimary = (() => {
    const r = (signal as any).rejection_reason;
    if (typeof r === 'string' && r.trim() !== '') return r.trim();
    const reasons = (signal as any).rejection_reasons;
    if (Array.isArray(reasons) && reasons.length > 0 && typeof reasons[0] === 'string') {
      return reasons[0];
    }
    return null;
  })();

  let primaryReason: string;
  if (tier === 'approved') {
    primaryReason = 'All institutional gates cleared';
  } else if (enginePrimary) {
    primaryReason = enginePrimary;
  } else if (conf.failed.length > 0) {
    primaryReason = conf.failed[0];
  } else {
    primaryReason = 'Awaiting institutional confirmation';
  }

  const secondaryReasons: string[] = [];
  const seen = new Set<string>([primaryReason]);
  const addSecondary = (s: string) => {
    if (!s) return;
    const key = s.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    secondaryReasons.push(key);
  };
  for (const r of conf.failed) addSecondary(r);
  const engineSecondary = (signal as any).rejection_reasons;
  if (Array.isArray(engineSecondary)) {
    for (const r of engineSecondary) {
      if (typeof r === 'string') addSecondary(r);
    }
  }

  // Approval-gap echo for non-approved tiers.
  if (tier !== 'approved' && tier !== 'risk_restricted' && tier !== 'rejected') {
    const gap = calculateApprovalGap(signal);
    if (gap.missingApprovalFactors.length > 0) {
      for (const factor of gap.missingApprovalFactors) addSecondary(factor);
    }
  }

  // Summary — single human sentence built from real data.
  const finalScore = getSignalFinalScore(signal);
  const confidence = getSignalConfidence(signal);
  const rr         = getSignalRiskReward(signal);
  const sym        = String(signal.symbol ?? signal.tradingsymbol ?? 'this symbol');
  let summary: string;
  if (tier === 'approved') {
    summary = `${sym} cleared institutional approval: final ${finalScore.toFixed(1)}, confidence ${confidence.toFixed(1)}, RR ${rr.toFixed(2)}.`;
  } else if (tier === 'risk_restricted' || tier === 'rejected') {
    summary = `${sym} was rejected by the institutional gate. ${primaryReason}.`;
  } else if (tier === 'nearest' || tier === 'high_potential') {
    summary = `${sym} is close to approval (final ${finalScore.toFixed(1)}). ${primaryReason}.`;
  } else {
    summary = `${sym} is on the ${tier} tier. ${primaryReason}.`;
  }
  if (context.marketOpen === false) {
    summary += ' Market is currently closed — awaiting fresh confirmation.';
  } else if (context.freshnessMode && context.freshnessMode !== 'NORMAL_OPERATION') {
    summary += ` Feed state: ${context.freshnessMode}.`;
  }
  // PHASE_B — when manipulation gate triggered a hard demotion, replace
  // the institutional-gate summary with the manipulation-specific one
  // so the operator sees the actual cause. Stale-only case appends a
  // disclaimer instead of overriding.
  if (manipulationSummaryOverride) {
    summary = manipulationSummaryOverride;
  } else if (manipulationStaleSummary) {
    summary += ' ' + manipulationStaleSummary;
  }

  // Next action — short, neutral, never trading advice.
  let nextAction: string;
  if (tier === 'approved') {
    nextAction = 'Monitor live revalidation and freshness; no further gate action required.';
  } else if (tier === 'risk_restricted' || tier === 'rejected') {
    nextAction = 'No action — rejection logged for audit.';
  } else if (tier === 'high_potential' || tier === 'nearest') {
    nextAction = 'Re-evaluate on next pipeline cycle; promote only if strict gate passes.';
  } else if (context.marketOpen === false) {
    nextAction = 'Awaiting market open and fresh tick to re-evaluate.';
  } else {
    nextAction = 'Continue monitoring — engine will re-evaluate every poll.';
  }

  // Explainability score — how much we could populate from real fields.
  // Capped at 100; pure provenance metric, not a quality assessment.
  const populatedBuckets =
    (conf.passed.length + conf.failed.length > 0 ? 1 : 0) +
    (risk.length > 0 ? 1 : 0) +
    (data.length > 0 ? 1 : 0) +
    (market.length > 0 ? 1 : 0) +
    (indicators.length > 0 ? 1 : 0) +
    (performanceFindings.length > 0 ? 1 : 0) +
    (learning.length > 0 ? 1 : 0);
  const explainabilityScore = Math.round((populatedBuckets / 7) * 100);

  return {
    status,
    summary,
    primaryReason,
    secondaryReasons,
    confirmationPassed:  conf.passed,
    confirmationFailed:  conf.failed,
    riskFindings:        risk,
    dataFindings:        data,
    marketFindings:      market,
    indicatorFindings:   indicators,
    performanceFindings,
    learningNotes:       learning,
    nextAction,
    severity,
    explainabilityScore,
  };
}

// ── Daily due-diligence summary aggregator ──────────────────────

export interface DueDiligenceBlockedReason {
  reason: string;
  count:  number;
}

export interface DueDiligenceSummary {
  totalReviewed:              number;
  approvedReviewed:           number;
  highPotentialReviewed:      number;
  watchlistReviewed:          number;
  rejectedReviewed:           number;
  topBlockReasons:            DueDiligenceBlockedReason[];
  highScoreNotApproved:       number;
  staleBlocked:               number;
  lowRiskRewardBlocked:       number;
  volumePending:              number;
  marketConfirmationPending:  number;
  dataQualityWarnings:        number;
}

export interface ReviewedSignalGroup {
  signals:    RankableSignal[];
  tier:       SignalTierContext;
  reviews?:   DueDiligenceReview[];
}

export function buildDueDiligenceSummary(
  groups: ReviewedSignalGroup[],
  context: DueDiligenceContext,
): DueDiligenceSummary {
  let approvedReviewed      = 0;
  let highPotentialReviewed = 0;
  let watchlistReviewed     = 0;
  let rejectedReviewed      = 0;
  let highScoreNotApproved  = 0;
  let staleBlocked          = 0;
  let lowRiskRewardBlocked  = 0;
  let volumePending         = 0;
  let marketConfirmationPending = 0;
  let dataQualityWarnings   = 0;

  const reasonCounts = new Map<string, number>();

  const bump = (reason: string) => {
    if (!reason) return;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };

  for (const group of groups) {
    for (let i = 0; i < group.signals.length; i++) {
      const sig = group.signals[i];
      const tierCtx: DueDiligenceContext = { ...context, tier: group.tier };
      const review = group.reviews?.[i] ?? buildSignalDueDiligence(sig, tierCtx);

      if (group.tier === 'approved')                   approvedReviewed++;
      else if (group.tier === 'high_potential')        highPotentialReviewed++;
      else if (group.tier === 'watchlist'
            || group.tier === 'developing'
            || group.tier === 'scanner_candidate'
            || group.tier === 'nearest')               watchlistReviewed++;
      else if (group.tier === 'rejected'
            || group.tier === 'risk_restricted')       rejectedReviewed++;

      // Bucketed counters.
      const factors = readFactorScores(sig);
      const finalScore = getSignalFinalScore(sig);
      const rr         = getSignalRiskReward(sig);

      if (finalScore >= 70 && group.tier !== 'approved') highScoreNotApproved++;
      if (isStaleByFreshness(sig)) staleBlocked++;
      if (rr > 0 && rr < APPROVAL_TARGET_RISK_REWARD && group.tier !== 'approved') {
        lowRiskRewardBlocked++;
      }
      const vol = factors.volume_confirmation;
      if (vol != null && vol < WEAK_FACTOR_CEIL && group.tier !== 'approved') volumePending++;
      if (context.marketOpen === false && group.tier !== 'rejected' && group.tier !== 'risk_restricted') {
        marketConfirmationPending++;
      }
      const dq = numOrNull((sig as any).data_quality_score);
      if (dq != null && dq < 70) dataQualityWarnings++;

      // Reason histogram — prefer engine rejection_codes when present.
      const codes: string[] = Array.isArray((sig as any).rejection_codes)
        ? (sig as any).rejection_codes as string[]
        : [];
      if (group.tier !== 'approved') {
        if (codes.length > 0) {
          for (const c of codes) bump(String(c ?? '').toUpperCase());
        } else if (review.primaryReason && review.primaryReason !== 'All institutional gates cleared') {
          bump(review.primaryReason);
        }
      }
    }
  }

  const topBlockReasons: DueDiligenceBlockedReason[] = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const totalReviewed = approvedReviewed + highPotentialReviewed + watchlistReviewed + rejectedReviewed;

  return {
    totalReviewed,
    approvedReviewed,
    highPotentialReviewed,
    watchlistReviewed,
    rejectedReviewed,
    topBlockReasons,
    highScoreNotApproved,
    staleBlocked,
    lowRiskRewardBlocked,
    volumePending,
    marketConfirmationPending,
    dataQualityWarnings,
  };
}
