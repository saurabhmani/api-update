// ════════════════════════════════════════════════════════════════
//  AI Explanation Engine — Phase 4 (Deterministic Layer)
//
//  Produces structured, factual explanations grounded entirely
//  in signal features, trade plan, and context. No hallucination.
// ════════════════════════════════════════════════════════════════

import type { AIExplanation, TraderNarrative, MacroContext, EventRiskSnapshot, SignalFreshness, NewsContext } from '../types/phase4.types';
import type { SignalFeatures, ConfidenceBreakdown, RiskBreakdown, StrategyName } from '../types/signalEngine.types';
import type { Phase3TradePlan, PortfolioFitResult, PositionSizingResult } from '../types/phase3.types';
import { round } from '../utils/math';

interface ExplanationInput {
  symbol: string;
  strategy: StrategyName;
  features: SignalFeatures;
  confidence: ConfidenceBreakdown;
  risk: RiskBreakdown;
  tradePlan: Phase3TradePlan;
  portfolioFit: PortfolioFitResult;
  sizing: PositionSizingResult;
  macro: MacroContext;
  eventRisk: EventRiskSnapshot;
  freshness: SignalFreshness;
  /** Phase 5: optional enriched news context for Dexter intelligence. */
  newsContext?: NewsContext;
}

const STRATEGY_LABELS: Record<string, string> = {
  bullish_breakout: 'bullish breakout continuation',
  bullish_pullback: 'trend pullback entry',
  bearish_breakdown: 'bearish breakdown',
  mean_reversion_bounce: 'mean reversion bounce',
};

export function buildExplanation(input: ExplanationInput): AIExplanation {
  const { symbol, strategy, features, confidence, risk, tradePlan, portfolioFit, sizing, macro, eventRisk, freshness, newsContext } = input;
  const { trend, momentum, volume, volatility, structure } = features;
  const label = STRATEGY_LABELS[strategy] || strategy;

  // ── Summary ───────────────────────────────────────────────
  const confWord = confidence.finalScore >= 85 ? 'high-conviction' : confidence.finalScore >= 70 ? 'actionable' : 'watchlist-grade';
  const trendWord = trend.ema20Above50 ? 'positive trend structure' : 'mixed trend';
  const volWord = volume.volumeVs20dAvg >= 1.5 ? 'supportive volume' : 'below-average volume';

  const summary = `${symbol} presents a ${confWord} ${label} setup. Price action shows ${trendWord} with ${volWord} (${round(volume.volumeVs20dAvg, 1)}x 20-day avg). RSI at ${round(momentum.rsi14)} confirms ${momentum.rsi14 > 60 ? 'healthy momentum' : momentum.rsi14 < 40 ? 'oversold conditions' : 'neutral momentum'}. Risk is ${risk.band.toLowerCase()}.`;

  // ── Why Now ───────────────────────────────────────────────
  const whyParts: string[] = [];
  if (strategy === 'bullish_breakout' && structure.breakoutDistancePct > 0) {
    whyParts.push(`price just cleared ${round(structure.recentResistance20)} resistance by ${round(structure.breakoutDistancePct, 1)}%`);
  }
  if (strategy === 'bullish_pullback') {
    whyParts.push(`price has pulled back to ${round(trend.distanceFrom20EmaPct, 1)}% from 20 EMA in an intact uptrend`);
  }
  if (strategy === 'bearish_breakdown') {
    whyParts.push(`price broke below ${round(structure.recentSupport20)} support with confirming volume`);
  }
  if (strategy === 'mean_reversion_bounce') {
    whyParts.push(`oversold RSI at ${round(momentum.rsi14)} near structural support suggests bounce potential`);
  }
  if (macro.marketTone === 'constructive' || macro.marketTone === 'strongly_constructive') {
    whyParts.push('market backdrop is supportive');
  }
  // News catalyst context
  if (newsContext && newsContext.symbolImpactScore !== undefined) {
    const impact = newsContext.symbolImpactScore;
    const directness = newsContext.directnessScore ?? 0;
    if (impact > 0.5 && directness > 0.5 && newsContext.bias === 'positive') {
      whyParts.push(`direct positive news catalyst (impact ${Math.round(impact * 100)}%)`);
    } else if (impact > 0.3 && newsContext.bias === 'negative') {
      whyParts.push(`negative news headwind present (impact ${Math.round(impact * 100)}%)`);
    }
  }
  const whyNow = whyParts.length > 0 ? `Opportunity exists now because ${whyParts.join(', ')}.` : 'Setup conditions aligned on the latest bar.';

  // ── Decision Narrative ────────────────────────────────────
  const fitWord = portfolioFit.portfolioDecision === 'approved' ? 'clean' : portfolioFit.portfolioDecision === 'approved_with_penalty' ? 'acceptable with constraints' : 'challenging';
  const eventWord = eventRisk.eventRiskBand === 'low' ? '' : ` Near-term event risk is ${eventRisk.eventRiskBand}, which warrants ${eventRisk.eventRiskBand === 'high' ? 'significant caution' : 'measured sizing'}.`;
  const decisionNarrative = `This is a risk-defined ${label} with ${tradePlan.rrTarget1}:1 reward-to-risk at target 1. Portfolio fit is ${fitWord}.${eventWord} ${freshness.decayState === 'fresh' ? 'The signal is fresh and actionable.' : freshness.decayState === 'stale' ? 'The signal is aging — avoid chasing.' : ''}`;

  // ── Trader Guidance ───────────────────────────────────────
  const guidance: string[] = [];
  if (strategy === 'bullish_breakout') guidance.push('Prefer confirmation close above breakout zone before full entry.');
  if (strategy === 'bullish_pullback') guidance.push('Enter near EMA support — avoid chasing if price bounces aggressively before entry.');
  if (strategy === 'bearish_breakdown') guidance.push('Wait for retest of broken support from below before shorting.');
  if (strategy === 'mean_reversion_bounce') guidance.push('Use smaller position size — reversal trades carry higher failure risk.');

  if (eventRisk.eventRiskBand !== 'low') guidance.push(`Reduce size or wait: event risk is ${eventRisk.eventRiskBand}.`);
  if (portfolioFit.sectorExposureImpact !== 'acceptable') guidance.push(`Sector exposure already ${portfolioFit.sectorExposureImpact} — consider smaller allocation.`);
  if (volatility.atrPct > 3) guidance.push(`Volatility is elevated (ATR ${round(volatility.atrPct, 1)}%) — wider stops required, smaller size.`);
  if (freshness.decayState !== 'fresh') guidance.push(`Signal generated ${freshness.ageBars} bars ago — freshness is ${freshness.decayState}.`);
  // News-informed guidance
  if (newsContext && newsContext.manipulationSuspicion !== undefined && newsContext.manipulationSuspicion > 0.4) {
    guidance.push('Manipulation suspicion elevated — wait for official confirmation before committing full size.');
  }
  if (newsContext && newsContext.eventRiskScore !== undefined && newsContext.eventRiskScore > 0.6) {
    guidance.push('High news-driven event risk — consider half-sizing or waiting for post-event clarity.');
  }

  // ── Risk Highlights ───────────────────────────────────────
  const riskHighlights: string[] = [];
  if (volatility.atrPct > 2.5) riskHighlights.push(`Daily volatility ${round(volatility.atrPct, 1)}% is above average`);
  if (Math.abs(volatility.gapPct) > 1.5) riskHighlights.push(`Opening gap of ${round(volatility.gapPct, 1)}% increases execution risk`);
  if (eventRisk.eventRiskScore > 30) riskHighlights.push(`Event risk: ${eventRisk.comment}`);
  if (portfolioFit.correlationPenalty > 5) riskHighlights.push(`Correlated exposure in ${portfolioFit.correlationCluster} sector`);
  if (sizing.validationStatus === 'capped') riskHighlights.push('Position size was capped due to exposure limits');
  // News-driven risk highlights from scoreCard
  if (newsContext) {
    const manipulation = newsContext.manipulationSuspicion ?? 0;
    const newsEventRisk = newsContext.eventRiskScore ?? 0;
    if (manipulation > 0.5) riskHighlights.push(`News manipulation suspicion: ${Math.round(manipulation * 100)}% — treat headline impact cautiously`);
    if (newsEventRisk > 0.6) riskHighlights.push(`News-driven event risk: ${Math.round(newsEventRisk * 100)}% — elevated uncertainty`);
    if (newsContext.scoreCard) {
      const sc = newsContext.scoreCard;
      if (sc.sourceReliability < 0.3) riskHighlights.push('News source reliability is low — confirmation needed from official sources');
      if (sc.novelty < 0.3 && newsContext.strength > 0.3) riskHighlights.push('News is mostly rehashed — limited new information driving price action');
    }
  }

  // ── Invalidation ──────────────────────────────────────────
  const invalidation: string[] = [];
  invalidation.push(`Stop at ${tradePlan.stopLoss} — exit immediately if breached`);
  if (strategy === 'bullish_breakout') invalidation.push(`Invalidated if price closes back below ${round(structure.recentResistance20)}`);
  if (strategy === 'bullish_pullback') invalidation.push(`Invalidated if EMA20 crosses below EMA50`);
  if (strategy === 'bearish_breakdown') invalidation.push(`Invalidated if price recovers above ${round(structure.recentResistance20)}`);
  if (strategy === 'mean_reversion_bounce') invalidation.push(`Invalidated if price makes new low below ${round(structure.recentLow20)}`);
  invalidation.push(`Setup expires if no entry trigger within ${freshness.decayState === 'fresh' ? '3-5 bars' : '1-2 bars'}`);

  // ── Why Not Oversize ──────────────────────────────────────
  const whyNotParts: string[] = [];
  if (risk.totalScore > 40) whyNotParts.push(`risk score is ${risk.totalScore} (${risk.band})`);
  if (eventRisk.eventRiskScore > 20) whyNotParts.push('near-term event risk is non-trivial');
  if (portfolioFit.fitScore < 70) whyNotParts.push(`portfolio fit score is only ${portfolioFit.fitScore}`);
  if (confidence.finalScore < 80) whyNotParts.push('confidence is below high-conviction threshold');
  const whyNotOversize = whyNotParts.length > 0
    ? `Standard sizing recommended because ${whyNotParts.join(', ')}.`
    : 'Standard sizing is appropriate for this setup profile.';

  return { summary, whyNow, decisionNarrative, traderGuidance: guidance, riskHighlights, whatWouldInvalidate: invalidation, whyNotOversize };
}

export function buildTraderNarrative(explanation: AIExplanation, strategy: string): TraderNarrative {
  return {
    shortSummary: explanation.summary.split('.').slice(0, 2).join('.') + '.',
    fullNarrative: explanation.decisionNarrative,
    guidanceBullets: explanation.traderGuidance,
    invalidationSummary: explanation.whatWouldInvalidate.join(' '),
  };
}
