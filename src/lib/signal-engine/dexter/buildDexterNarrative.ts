// ════════════════════════════════════════════════════════════════
//  Dexter AI — Live Signal Narrative Engine
//
//  Generates per-signal intelligence narratives that explain:
//    1. WHY this setup exists (explanation)
//    2. WHAT risks to watch (risk highlights)
//    3. HOW news affects the trade (why news matters)
//    4. WHY caution may be required (caution reasons)
//
//  Now consumes full enriched NewsContext fields:
//    - eventType, directnessScore, noveltyScore
//    - manipulationSuspicion, sentimentScore
//    - symbolImpactScore, eventRiskScore, sourceTier
//
//  RULE:
//    News must ENHANCE decision quality, NOT replace system logic.
//    All narratives are deterministic and auditable.
// ═════════���═══════════════════════════���══════════════════════════

import type {
  Phase4SignalEnvelope,
  MacroContext,
  NewsContext,
  EventRiskSnapshot,
  ContextualModifierBreakdown,
  FeedbackState,
  SignalFreshness,
} from '../types/phase4.types';

// ── Dexter Intelligence Output ─────────��────────────────────

/** How news aligns (or conflicts) with the technical setup. */
export type NewsAlignmentVerdict =
  | 'confirms_technical'
  | 'weakly_supports_technical'
  | 'conflicts_with_technical'
  | 'insufficient_news_quality'
  | 'no_news';

/** Dexter's final action stance after combining all factors. */
export type DexterActionStance =
  | 'strong_buy'
  | 'buy'
  | 'cautious_buy'
  | 'hold'
  | 'avoid'
  | 'reject';

export interface DexterSignalIntelligence {
  /** The symbol this intelligence is for. */
  symbol: string;
  /** One-sentence Dexter verdict. The "headline" for the trade. */
  verdict: string;
  /** Conviction level derived from all factors. */
  conviction: 'high' | 'moderate' | 'low' | 'avoid';
  /** Dexter's final action stance (deterministic, rule-based). */
  actionStance: DexterActionStance;
  /** Structured explanation sections. */
  explanation: {
    /** Why this setup exists right now. */
    setupReason: string;
    /** Technical context summary. */
    technicalContext: string;
    /** How news affects this trade. */
    newsImpact: string;
    /** Explicit news vs technical alignment check. */
    conflictCheck: string;
    /** News alignment classification. */
    newsAlignment: NewsAlignmentVerdict;
    /** Risk view combining all risk factors. */
    riskView: string;
    /** Why caution is required (if any). */
    cautionReason: string | null;
    /** Risk highlights the trader must be aware of. */
    riskHighlights: string[];
    /** What would invalidate this trade. */
    invalidators: string[];
    /** Final action stance reasoning. */
    stanceReasoning: string;
  };
  /** Full 7-dimension score breakdown from news intelligence (all 0-1). */
  scoreBreakdown: {
    sourceReliability: number;
    recency: number;
    sentiment: number;
    novelty: number;
    directness: number;
    manipulationRisk: number;
    finalSymbolImpact: number;
    finalEventRisk: number;
  } | null;
  /** Modifier breakdown for transparency. */
  modifiers: {
    news: number;
    macro: number;
    eventRisk: number;
    sectorLeadership: number;
    strategyFit: number;
    freshness: number;
    feedbackCalibration: number;
    totalAdjustment: number;
  };
  /** Calibration context from the learning loop. */
  calibration: {
    strategyWinRate: number | null;
    strategyFit: string;
    confidenceCalibration: string;
    feedbackNote: string | null;
  };
  /** Structured decision reasoning — WHY the trade was allowed/suppressed. */
  decisionReasoning: {
    /** WHY the trade is allowed or suppressed. */
    tradeDecision: string;
    /** NEWS vs TECHNICAL conflict analysis. */
    newsVsTechnical: string;
    /** RISK interpretation from all sources. */
    riskInterpretation: string;
    /** MANIPULATION assessment with source quality. */
    manipulationAssessment: string;
    /** Key factors that drove the final stance. */
    keyFactors: string[];
  };
  /** Actionable guidance bullets. */
  guidance: string[];
}

// ── Main Builder ──────────���─────────────────────────────────

export function buildDexterNarrative(
  signal: Phase4SignalEnvelope,
): DexterSignalIntelligence {
  const mod = signal.contextualModifiers;
  const news = signal.newsContext;
  const macro = signal.macroContext;
  const eventRisk = signal.eventRisk;
  const feedback = signal.feedbackState;
  const freshness = signal.freshness;

  // ── Build explanation sections ──��───────────────────────────
  const setupReason = buildSetupReason(signal);
  const technicalContext = buildTechnicalContext(signal);
  const newsImpact = buildNewsImpact(news, mod);
  const newsAlignment = determineNewsAlignment(signal, news);
  const conflictCheck = buildConflictCheck(signal, news, newsAlignment);
  const riskView = buildRiskView(signal, news, eventRisk, macro);
  const cautionReason = buildCautionReason(signal, macro, eventRisk, feedback, freshness);
  const riskHighlights = buildRiskHighlights(signal, eventRisk, macro);
  const invalidators = signal.aiExplanation.whatWouldInvalidate;

  // ── Deterministic action stance (rules before narrative) ──────
  const actionStance = deriveActionStance(signal, news, newsAlignment, eventRisk, macro);
  const stanceReasoning = buildStanceReasoning(signal, news, newsAlignment, actionStance);

  // ── Build verdict (the one-liner) ─────────────────────────────
  const verdict = buildVerdict(signal, newsImpact, cautionReason);

  // ── Derive conviction ─────────────────────────────────────────
  const conviction = deriveConviction(signal);

  // ── Calibration context ───────────────────────────────────────
  const calibration = buildCalibrationContext(feedback, signal);

  // ── Actionable guidance ───────────────────────────────────────
  const guidance = buildGuidance(signal, conviction, cautionReason);

  // ── Score breakdown from scoreCard ─────────────────────────────
  const scoreBreakdown = buildScoreBreakdown(signal);

  // ── Structured decision reasoning ────────────────────────────
  const decisionReasoning = buildDecisionReasoning(signal, news, newsAlignment, actionStance, eventRisk);

  return {
    symbol: signal.symbol,
    verdict,
    conviction,
    actionStance,
    explanation: {
      setupReason,
      technicalContext,
      newsImpact,
      conflictCheck,
      newsAlignment,
      riskView,
      cautionReason,
      riskHighlights,
      invalidators,
      stanceReasoning,
    },
    scoreBreakdown,
    decisionReasoning,
    modifiers: {
      news: mod.newsModifier,
      macro: mod.macroModifier,
      eventRisk: mod.eventRiskPenalty,
      sectorLeadership: mod.sectorNarrativeModifier,
      strategyFit: mod.strategyFitModifier,
      freshness: mod.freshnessPenalty,
      feedbackCalibration: mod.feedbackCalibrationModifier,
      totalAdjustment: mod.cappedAdaptiveAdjustment,
    },
    calibration,
    guidance,
  };
}

// ── Setup Reason ──────────────────────────────────────────────

function buildSetupReason(sig: Phase4SignalEnvelope): string {
  const strategy = formatStrategy(sig.signalType);
  const regime = sig.marketRegime;
  const conf = sig.adjustedConfidenceScore;
  const band = sig.confidenceBand;

  const parts: string[] = [];
  parts.push(`${strategy} setup detected in ${regime} regime`);
  parts.push(`confidence ${conf}/100 (${band})`);

  if (sig.tradePlan) {
    const rr = sig.tradePlan.rrTarget1;
    if (rr >= 2) parts.push(`favorable R:R of ${rr.toFixed(1)}:1`);
    else if (rr >= 1.5) parts.push(`acceptable R:R of ${rr.toFixed(1)}:1`);
  }

  if (sig.portfolioFit && sig.portfolioFit.fitScore >= 80) {
    parts.push('strong portfolio fit');
  }

  return parts.join(', ') + '.';
}

// ── News Impact ───────────────────────────────────────────────

function buildNewsImpact(news: NewsContext, mod: ContextualModifierBreakdown): string {
  if (mod.newsModifier === 0 && news.strength < 0.1) {
    return 'No significant news activity for this symbol.';
  }

  const parts: string[] = [];
  const isEnriched = news.symbolImpactScore !== undefined;

  if (isEnriched) {
    // ── Enriched path: precise descriptions based on event type ──
    const eventType = news.eventType ?? 'general';
    const directness = news.directnessScore ?? 0;
    const manipulation = news.manipulationSuspicion ?? 0;
    const sourceTier = news.sourceTier ?? 'unknown';
    const impact = news.symbolImpactScore ?? 0;

    // Describe the catalyst type
    if (directness > 0.7) {
      // Direct symbol-specific catalyst
      const eventLabel = formatEventType(eventType);
      if (news.bias === 'positive' && news.strength > 0.3) {
        parts.push(`Direct ${eventLabel} catalyst (impact ${pct(impact)}, ${sourceTier} source reliability)`);
      } else if (news.bias === 'negative') {
        parts.push(`Direct ${eventLabel} headwind (impact ${pct(impact)}, ${sourceTier} source reliability)`);
      } else {
        parts.push(`Direct ${eventLabel} event detected (neutral impact)`);
      }
    } else if (directness > 0.3) {
      // Sector-level influence
      parts.push(`Sector-wide ${formatEventType(eventType)} context (indirect relevance ${pct(directness)})`);
    } else if (news.strength > 0.2) {
      // Market-wide background
      parts.push(`Market-wide news context (low direct relevance)`);
    }

    // Manipulation warning — Dexter explicitly warns
    if (manipulation > 0.5) {
      parts.push(`elevated manipulation suspicion (${pct(manipulation)}) — treat headline impact cautiously`);
    } else if (manipulation > 0.3) {
      parts.push(`moderate manipulation indicators present`);
    }

    // Source reliability context
    if (sourceTier === 'low') {
      parts.push('low source reliability — confirmation needed');
    }

    // Event risk from news
    const eventRisk = news.eventRiskScore ?? 0;
    if (eventRisk > 0.6) {
      parts.push(`high news-driven event risk (${pct(eventRisk)})`);
    }
  } else {
    // ── Legacy path: basic headline descriptions ────────────────
    if (news.bias === 'positive' && news.strength > 0.5) {
      const tags = news.eventTags.filter(t => t !== 'none' && t !== 'general');
      if (tags.length > 0) {
        parts.push(`Supported by ${tags.join(', ')} news (${news.bias} bias, strength ${pct(news.strength)})`);
      } else {
        parts.push(`Positive news flow (strength ${pct(news.strength)})`);
      }
    } else if (news.bias === 'negative') {
      parts.push(`Negative news pressure (strength ${pct(news.strength)})`);
    } else if (news.strength > 0.3) {
      parts.push(`Mixed/neutral news flow (strength ${pct(news.strength)})`);
    }
  }

  // Describe the modifier effect
  if (mod.newsModifier > 0) {
    parts.push(`news boosted confidence by +${mod.newsModifier}`);
  } else if (mod.newsModifier < 0) {
    parts.push(`news reduced confidence by ${mod.newsModifier}`);
  }

  // Source confidence
  if (news.sourceConfidence < 0.3) {
    parts.push('low source reliability');
  } else if (news.sourceConfidence > 0.7) {
    parts.push('high source reliability');
  }

  // Freshness
  if (news.freshnessHours > 48) {
    parts.push('news is aging (>48h old)');
  }

  if (news.headline) {
    parts.push(`headline: "${truncate(news.headline, 80)}"`);
  }

  return parts.join('; ') + '.';
}

// ── Caution Reason ────────��───────────────────────────────────

function buildCautionReason(
  sig: Phase4SignalEnvelope,
  macro: MacroContext,
  eventRisk: EventRiskSnapshot,
  feedback: FeedbackState,
  freshness: SignalFreshness,
): string | null {
  const cautions: string[] = [];

  // Macro tone warning
  if (macro.marketTone === 'hostile') {
    cautions.push('hostile market environment');
  } else if (macro.marketTone === 'cautious') {
    cautions.push('cautious market tone');
  }

  // Sector weakness
  if (macro.sectorLeadership.length === 0) {
    cautions.push('no sector leadership');
  }

  // Event risk
  if (eventRisk.eventRiskBand === 'high' || eventRisk.eventRiskBand === 'elevated') {
    const tags = eventRisk.eventTags.filter(t => t !== 'none');
    if (tags.length > 0) {
      cautions.push(`${eventRisk.eventRiskBand} event risk (${tags.join(', ')})`);
    } else {
      cautions.push(`${eventRisk.eventRiskBand} event risk`);
    }
  }

  // Strategy performance warning
  if (feedback.strategyEnvironmentFit === 'poor') {
    cautions.push('strategy historically underperforms in this environment');
  }

  // Overconfidence warning
  if (feedback.confidenceCalibrationState === 'overconfident') {
    cautions.push('confidence model is overconfident in this band');
  }

  // Freshness
  if (freshness.decayState === 'stale' || freshness.decayState === 'expired') {
    cautions.push(`signal is ${freshness.decayState}`);
  }

  // Risk score
  if (sig.riskScore >= 70) {
    cautions.push('elevated standalone risk');
  }

  // News-driven caution using enriched fields
  const news = sig.newsContext;
  if (news.manipulationSuspicion !== undefined && news.manipulationSuspicion > 0.4) {
    cautions.push(`manipulation suspicion elevated (${pct(news.manipulationSuspicion)})`);
  } else if (news.bias === 'negative' && news.strength > 0.5) {
    cautions.push('negative news pressure');
  }

  if (cautions.length === 0) return null;
  return 'Caution due to ' + cautions.join(', ') + '.';
}

// ── Risk Highlights ───────���───────────────────────────────────

function buildRiskHighlights(
  sig: Phase4SignalEnvelope,
  eventRisk: EventRiskSnapshot,
  macro: MacroContext,
): string[] {
  const highlights: string[] = [];

  // From AI explanation
  if (sig.aiExplanation.riskHighlights) {
    highlights.push(...sig.aiExplanation.riskHighlights);
  }

  // Event risk
  if (eventRisk.eventRiskScore >= 50) {
    highlights.push(`Event risk score ${eventRisk.eventRiskScore}/100: ${eventRisk.comment}`);
  }

  // Macro risk mode
  if (macro.riskMode === 'risk_off') {
    highlights.push('Market in risk-off mode — defensive positioning recommended');
  }

  // Macro event proximity
  if (macro.macroEventProximity === 'high') {
    highlights.push('Major macro event imminent — position sizing should be conservative');
  }

  // Enriched news-driven risk highlights
  const news = sig.newsContext;
  if (news.eventRiskScore !== undefined && news.eventRiskScore > 0.6) {
    highlights.push(`News-driven event risk: ${pct(news.eventRiskScore)} — elevated uncertainty`);
  }
  if (news.manipulationSuspicion !== undefined && news.manipulationSuspicion > 0.5) {
    highlights.push(`Manipulation suspicion: ${pct(news.manipulationSuspicion)} — headline impact may be unreliable`);
  }

  // From warnings
  for (const w of sig.warnings) {
    if (w.includes('NEWS:') || w.includes('Manipulation') || w.includes('SUPPRESSED')) {
      highlights.push(w);
    }
  }

  return highlights;
}

// ── Verdict Builder ───────���──────────────────────────────────

function buildVerdict(
  sig: Phase4SignalEnvelope,
  newsImpact: string,
  cautionReason: string | null,
): string {
  const strategy = formatStrategy(sig.signalType);
  const parts: string[] = [];

  // Setup quality
  if (sig.adjustedConfidenceScore >= 85) {
    parts.push(`Strong ${strategy} setup`);
  } else if (sig.adjustedConfidenceScore >= 70) {
    parts.push(`${strategy} setup with good conviction`);
  } else if (sig.adjustedConfidenceScore >= 55) {
    parts.push(`${strategy} setup on watchlist`);
  } else {
    parts.push(`Weak ${strategy} setup`);
  }

  // News support — use enriched fields for precise language
  const news = sig.newsContext;
  if (news.symbolImpactScore !== undefined && news.directnessScore !== undefined) {
    // Enriched path
    if (news.bias === 'positive' && news.directnessScore > 0.7 && news.strength > 0.3) {
      const eventLabel = formatEventType(news.eventType ?? 'general');
      parts.push(`supported by direct ${eventLabel} catalyst`);
    } else if (news.bias === 'positive' && news.strength > 0.3) {
      parts.push('supported by sector/market tailwind');
    } else if (news.bias === 'negative' && news.strength > 0.3) {
      if (news.directnessScore > 0.7) {
        parts.push('facing direct negative catalyst');
      } else {
        parts.push('facing negative news headwind');
      }
    }
    // Manipulation caveat in verdict
    if (news.manipulationSuspicion !== undefined && news.manipulationSuspicion > 0.5) {
      parts.push('but suspected hype — verify independently');
    }
  } else {
    // Legacy path
    if (news.bias === 'positive' && news.strength > 0.5) {
      const tags = news.eventTags.filter(t => t !== 'none' && t !== 'general');
      if (tags.length > 0) {
        parts.push(`supported by ${tags[0]} news`);
      } else {
        parts.push('supported by positive news');
      }
    } else if (news.bias === 'negative' && news.strength > 0.3) {
      parts.push('facing negative news headwind');
    }
  }

  // Caution
  if (cautionReason) {
    const match = cautionReason.match(/Caution due to ([^,.]+)/);
    if (match) {
      parts.push(`but caution due to ${match[1]}`);
    }
  }

  return parts.join(' ') + '.';
}

// ── Conviction ───────────────────────────────────────────────

function deriveConviction(sig: Phase4SignalEnvelope): DexterSignalIntelligence['conviction'] {
  const conf = sig.adjustedConfidenceScore;
  const risk = sig.riskScore;

  if (conf >= 80 && risk <= 40) return 'high';
  if (conf >= 65 && risk <= 60) return 'moderate';
  if (conf >= 55) return 'low';
  return 'avoid';
}

// ── Calibration Context ────────��─────────────────────────────

function buildCalibrationContext(
  feedback: FeedbackState,
  sig: Phase4SignalEnvelope,
): DexterSignalIntelligence['calibration'] {
  let feedbackNote: string | null = null;

  if (feedback.strategyRecentWinRate != null) {
    const winPct = (feedback.strategyRecentWinRate * 100).toFixed(0);
    if (feedback.strategyRecentWinRate >= 0.6) {
      feedbackNote = `${formatStrategy(sig.signalType)} is running hot: ${winPct}% win rate recently.`;
    } else if (feedback.strategyRecentWinRate < 0.4) {
      feedbackNote = `${formatStrategy(sig.signalType)} is underperforming: only ${winPct}% win rate recently. Reduce size.`;
    }
  }

  if (feedback.confidenceCalibrationState === 'overconfident') {
    feedbackNote = (feedbackNote ?? '') + ' Confidence model is overconfident — expect lower hit rates than score suggests.';
  } else if (feedback.confidenceCalibrationState === 'underconfident') {
    feedbackNote = (feedbackNote ?? '') + ' Confidence model is underconfident — actual results are better than score suggests.';
  }

  return {
    strategyWinRate: feedback.strategyRecentWinRate,
    strategyFit: feedback.strategyEnvironmentFit,
    confidenceCalibration: feedback.confidenceCalibrationState,
    feedbackNote: feedbackNote?.trim() ?? null,
  };
}

// ── Guidance ─────────���──────────────────────────��─────────────

function buildGuidance(
  sig: Phase4SignalEnvelope,
  conviction: DexterSignalIntelligence['conviction'],
  cautionReason: string | null,
): string[] {
  const guidance: string[] = [];

  // From AI explanation
  if (sig.aiExplanation.traderGuidance) {
    guidance.push(...sig.aiExplanation.traderGuidance.slice(0, 3));
  }

  // Conviction-based guidance
  if (conviction === 'high') {
    guidance.push('Full position size appropriate given high conviction.');
  } else if (conviction === 'moderate') {
    guidance.push('Standard position size — monitor closely for invalidation.');
  } else if (conviction === 'low') {
    guidance.push('Reduced position size recommended — setup is marginal.');
  } else {
    guidance.push('Avoid this trade — conviction too low for capital deployment.');
  }

  // Enriched news-specific guidance
  const news = sig.newsContext;
  if (news.manipulationSuspicion !== undefined && news.manipulationSuspicion > 0.4) {
    guidance.push('Manipulation suspicion elevated — wait for official confirmation before committing.');
  }
  if (news.eventRiskScore !== undefined && news.eventRiskScore > 0.6) {
    guidance.push('High news-driven event risk — consider half-sizing or waiting for post-event clarity.');
  }

  // Caution-specific guidance
  if (cautionReason) {
    if (cautionReason.includes('event risk')) {
      guidance.push('Consider waiting until after the event to reduce gap risk.');
    }
    if (cautionReason.includes('hostile') || cautionReason.includes('cautious')) {
      guidance.push('Tighten stops and reduce exposure — macro headwinds present.');
    }
    if (cautionReason.includes('stale') || cautionReason.includes('expired')) {
      guidance.push('Signal is aging — verify setup is still intact before entry.');
    }
  }

  return guidance;
}

// ── Technical Context ────────────────────────────────────────

function buildTechnicalContext(sig: Phase4SignalEnvelope): string {
  const strategy = formatStrategy(sig.signalType);
  const regime = sig.marketRegime;
  const conf = sig.confidenceScore;
  const adjConf = sig.adjustedConfidenceScore;
  const risk = sig.riskScore;

  const parts: string[] = [];
  parts.push(`${strategy} pattern in ${regime} regime`);
  parts.push(`raw confidence ${conf}/100`);
  if (adjConf !== conf) parts.push(`adjusted to ${adjConf}/100 after modifiers`);
  parts.push(`risk score ${risk}/100`);

  if (sig.tradePlan) {
    const rr = sig.tradePlan.rrTarget1;
    if (rr > 0) parts.push(`R:R ${rr.toFixed(1)}:1`);
  }

  const band = sig.confidenceBand;
  if (band === 'High Conviction') parts.push('HIGH CONVICTION band');
  else if (band === 'Actionable') parts.push('actionable band');
  else if (band === 'Watchlist') parts.push('watchlist band');
  else parts.push('below actionable threshold');

  return parts.join(', ') + '.';
}

// ── News Alignment (deterministic) ──────────────────────────

function determineNewsAlignment(
  sig: Phase4SignalEnvelope,
  news: NewsContext,
): NewsAlignmentVerdict {
  const isEnriched = news.symbolImpactScore !== undefined;

  // No news at all
  if (news.strength < 0.1 && !isEnriched) return 'no_news';

  // Insufficient quality: low source confidence or high manipulation
  if (news.sourceConfidence < 0.2) return 'insufficient_news_quality';
  if ((news.manipulationSuspicion ?? 0) > 0.6) return 'insufficient_news_quality';

  // Determine technical direction from signal type
  const isBullishTechnical = sig.signalType.toLowerCase().includes('bull')
    || sig.signalType.toLowerCase().includes('breakout')
    || sig.signalType.toLowerCase().includes('momentum')
    || sig.adjustedConfidenceScore >= 55; // broad assumption: approved signal = bullish

  const isBullishNews = news.bias === 'positive' && news.strength > 0.2;
  const isBearishNews = news.bias === 'negative' && news.strength > 0.2;

  if (isBullishTechnical && isBullishNews) {
    return news.strength > 0.5 && (news.directnessScore ?? 0) > 0.5
      ? 'confirms_technical'
      : 'weakly_supports_technical';
  }

  if (isBullishTechnical && isBearishNews) return 'conflicts_with_technical';

  // Neutral news
  if (!isBearishNews && !isBullishNews) return 'weakly_supports_technical';

  return 'weakly_supports_technical';
}

// ── Conflict Check ──────────────────────────────────────────

function buildConflictCheck(
  sig: Phase4SignalEnvelope,
  news: NewsContext,
  alignment: NewsAlignmentVerdict,
): string {
  switch (alignment) {
    case 'confirms_technical':
      return `News confirms technical trend — ${news.bias} news (strength ${pct(news.strength)}) aligns with ${formatStrategy(sig.signalType)} setup. Higher conviction justified.`;
    case 'weakly_supports_technical':
      return `News weakly supports technical trend — ${news.bias} news with limited direct relevance or moderate strength.`;
    case 'conflicts_with_technical':
      return `News conflicts with technical trend — ${news.bias} news (strength ${pct(news.strength)}) opposes ${formatStrategy(sig.signalType)} setup. Elevated caution warranted.`;
    case 'insufficient_news_quality':
      return 'News quality is insufficient — low source reliability or elevated manipulation suspicion. Decision remains primarily technical.';
    case 'no_news':
      return 'No significant news activity — decision is purely technical.';
  }
}

// ── Risk View ───────────────────────────────────────────────

function buildRiskView(
  sig: Phase4SignalEnvelope,
  news: NewsContext,
  eventRisk: EventRiskSnapshot,
  macro: MacroContext,
): string {
  const parts: string[] = [];

  // Standalone risk
  if (sig.riskScore >= 70) parts.push(`elevated standalone risk (${sig.riskScore}/100)`);
  else if (sig.riskScore >= 40) parts.push(`moderate standalone risk (${sig.riskScore}/100)`);
  else parts.push(`controlled standalone risk (${sig.riskScore}/100)`);

  // Event risk
  if (eventRisk.eventRiskScore >= 50) {
    parts.push(`event risk ${eventRisk.eventRiskBand} (${eventRisk.eventRiskScore}/100)`);
  }

  // News-driven risk
  const newsEventRisk = news.eventRiskScore ?? 0;
  const manipulation = news.manipulationSuspicion ?? 0;
  if (newsEventRisk > 0.5) parts.push(`news event risk ${pct(newsEventRisk)}`);
  if (manipulation > 0.4) parts.push(`manipulation suspicion ${pct(manipulation)}`);

  // Macro risk
  if (macro.riskMode === 'risk_off') parts.push('market in risk-off mode');
  if (macro.marketTone === 'hostile') parts.push('hostile market tone');

  return parts.join('; ') + '.';
}

// ── Action Stance (deterministic rules) ─────────────────────

function deriveActionStance(
  sig: Phase4SignalEnvelope,
  news: NewsContext,
  alignment: NewsAlignmentVerdict,
  eventRisk: EventRiskSnapshot,
  macro: MacroContext,
): DexterActionStance {
  const conf = sig.adjustedConfidenceScore;
  const risk = sig.riskScore;
  const newsEventRisk = news.eventRiskScore ?? 0;
  const manipulation = news.manipulationSuspicion ?? 0;

  // Rule 1: If technical is weak AND news is manipulative/hype-heavy → reject
  if (conf < 55 && manipulation > 0.5) return 'reject';

  // Rule 2: If technical is weak overall → avoid
  if (conf < 50) return 'avoid';

  // Rule 3: If event risk is very high → cautious at best
  if (newsEventRisk > 0.7 || eventRisk.eventRiskScore >= 70) {
    if (conf >= 80) return 'cautious_buy';
    return 'hold';
  }

  // Rule 4: If news conflicts with technical → downgrade
  if (alignment === 'conflicts_with_technical') {
    if (conf >= 80 && risk <= 40) return 'cautious_buy';
    return 'hold';
  }

  // Rule 5: Hostile macro → cap at cautious_buy
  if (macro.marketTone === 'hostile') {
    if (conf >= 80 && risk <= 30) return 'cautious_buy';
    return 'hold';
  }

  // Rule 6: Strong alignment + strong technical → strong_buy
  if (alignment === 'confirms_technical' && conf >= 80 && risk <= 40) {
    return 'strong_buy';
  }

  // Rule 7: Good technical with supportive context
  if (conf >= 80 && risk <= 40) return 'buy';
  if (conf >= 65 && risk <= 60) return 'buy';
  if (conf >= 55) return 'cautious_buy';

  return 'hold';
}

// ── Stance Reasoning ────────────────────────────────────────

function buildStanceReasoning(
  sig: Phase4SignalEnvelope,
  news: NewsContext,
  alignment: NewsAlignmentVerdict,
  stance: DexterActionStance,
): string {
  const parts: string[] = [];
  const strategy = formatStrategy(sig.signalType);

  parts.push(`Stance: ${stance.replace(/_/g, ' ').toUpperCase()}.`);

  // Technical basis
  parts.push(`Technical: ${strategy} at ${sig.adjustedConfidenceScore}/100 confidence, ${sig.riskScore}/100 risk.`);

  // News basis
  const newsDirectionLabel = news.bias === 'positive' ? 'bullish' : news.bias === 'negative' ? 'bearish' : 'neutral';
  if (alignment !== 'no_news') {
    parts.push(`News: ${newsDirectionLabel} bias (strength ${pct(news.strength)}).`);
  }

  // Impact strength
  if (news.symbolImpactScore !== undefined && news.symbolImpactScore > 0.3) {
    parts.push(`Impact: ${pct(news.symbolImpactScore)} symbol impact.`);
  }

  // Event risk
  if ((news.eventRiskScore ?? 0) > 0.4) {
    parts.push(`Event risk: ${pct(news.eventRiskScore ?? 0)}.`);
  }

  // Manipulation
  if ((news.manipulationSuspicion ?? 0) > 0.3) {
    parts.push(`Manipulation suspicion: ${pct(news.manipulationSuspicion ?? 0)}.`);
  }

  // Alignment conclusion
  switch (alignment) {
    case 'confirms_technical':
      parts.push('News confirms technical setup — conviction reinforced.');
      break;
    case 'weakly_supports_technical':
      parts.push('News provides weak support — conviction unchanged.');
      break;
    case 'conflicts_with_technical':
      parts.push('News conflicts with technical setup — conviction downgraded.');
      break;
    case 'insufficient_news_quality':
      parts.push('News quality insufficient to influence decision — technical analysis governs.');
      break;
    case 'no_news':
      parts.push('No news — purely technical decision.');
      break;
  }

  return parts.join(' ');
}

// ── Decision Reasoning (structured WHY blocks) ────────────────

function buildDecisionReasoning(
  sig: Phase4SignalEnvelope,
  news: NewsContext,
  alignment: NewsAlignmentVerdict,
  stance: DexterActionStance,
  eventRisk: EventRiskSnapshot,
): DexterSignalIntelligence['decisionReasoning'] {
  const conf = sig.adjustedConfidenceScore;
  const risk = sig.riskScore;
  const manipulation = news.manipulationSuspicion ?? 0;
  const newsEventRisk = news.eventRiskScore ?? 0;
  const sc = sig.scoreCard ?? sig.newsContext.scoreCard;
  const ib = sig.impactBreakdown ?? sig.newsContext.impactBreakdown;

  // ── WHY trade allowed/suppressed ──
  let tradeDecision: string;
  if (stance === 'reject') {
    tradeDecision = `REJECTED: Confidence ${conf}/100 is below threshold and manipulation suspicion at ${pct(manipulation)} makes this signal unreliable. Technical setup is insufficient to overcome news-driven risk.`;
  } else if (stance === 'avoid') {
    tradeDecision = `AVOIDED: Adjusted confidence ${conf}/100 is too low for capital deployment. Risk score ${risk}/100 does not justify entry.`;
  } else if (stance === 'hold') {
    tradeDecision = `HOLD: Signal detected but context warrants waiting. ${alignment === 'conflicts_with_technical' ? 'News conflicts with technical setup.' : eventRisk.eventRiskBand === 'high' ? 'Event risk too high for immediate entry.' : 'Insufficient conviction for entry.'}`;
  } else if (stance === 'strong_buy') {
    tradeDecision = `ALLOWED (STRONG): Technical confidence ${conf}/100 is high, risk ${risk}/100 is controlled, and news confirms the technical setup. All factors aligned.`;
  } else if (stance === 'buy') {
    tradeDecision = `ALLOWED: Technical confidence ${conf}/100 with manageable risk ${risk}/100. ${alignment === 'weakly_supports_technical' ? 'News provides weak support.' : 'Context is supportive.'}`;
  } else {
    tradeDecision = `ALLOWED WITH CAUTION: Confidence ${conf}/100 is marginal. ${newsEventRisk > 0.5 ? 'News-driven event risk suggests reduced sizing.' : 'Monitor closely for invalidation.'}`;
  }

  // ── NEWS vs TECHNICAL conflict ──
  let newsVsTechnical: string;
  if (alignment === 'no_news') {
    newsVsTechnical = 'No news data available. Decision is purely technical.';
  } else if (alignment === 'confirms_technical') {
    newsVsTechnical = `News CONFIRMS technical: ${news.bias} news (strength ${pct(news.strength)}) aligns with ${formatStrategy(sig.signalType)} setup. ${sc ? `Source reliability ${pct(sc.sourceReliability)}, directness ${pct(sc.directness)}.` : ''}`;
  } else if (alignment === 'conflicts_with_technical') {
    newsVsTechnical = `News CONFLICTS with technical: ${news.bias} news (strength ${pct(news.strength)}) opposes the ${formatStrategy(sig.signalType)} setup. ${sc ? `Impact ${pct(sc.finalSymbolImpact)}, event risk ${pct(sc.finalEventRisk)}.` : ''} Conviction downgraded.`;
  } else if (alignment === 'insufficient_news_quality') {
    newsVsTechnical = `News quality INSUFFICIENT: ${manipulation > 0.5 ? `manipulation suspicion ${pct(manipulation)} is too high` : `source reliability ${pct(news.sourceConfidence)} is too low`}. Decision defaults to technical analysis.`;
  } else {
    newsVsTechnical = `News WEAKLY supports technical: ${news.bias} news present but limited direct relevance or moderate strength.`;
  }

  // ── RISK interpretation ──
  const riskParts: string[] = [];
  riskParts.push(`Standalone risk: ${risk}/100 (${risk >= 70 ? 'elevated' : risk >= 40 ? 'moderate' : 'controlled'})`);
  if (eventRisk.eventRiskScore >= 30) {
    riskParts.push(`Event risk: ${eventRisk.eventRiskBand} (${eventRisk.comment})`);
  }
  if (newsEventRisk > 0.4) {
    riskParts.push(`News event risk: ${pct(newsEventRisk)}`);
  }
  if (ib) {
    riskParts.push(`Impact breakdown: symbol ${pct(ib.symbolImpact)}, sector ${pct(ib.sectorImpact)}, market ${pct(ib.marketImpact)}`);
  }
  const riskInterpretation = riskParts.join('. ') + '.';

  // ── MANIPULATION assessment ──
  let manipulationAssessment: string;
  if (manipulation > 0.6) {
    manipulationAssessment = `HIGH manipulation suspicion (${pct(manipulation)}). ${sc ? `Source reliability only ${pct(sc.sourceReliability)}, novelty ${pct(sc.novelty)}.` : ''} Headline-driven price action should be treated as unreliable. Recommend waiting for official confirmation.`;
  } else if (manipulation > 0.3) {
    manipulationAssessment = `MODERATE manipulation indicators (${pct(manipulation)}). ${sc ? `Source reliability ${pct(sc.sourceReliability)}.` : ''} Some caution warranted but technical setup takes precedence.`;
  } else {
    manipulationAssessment = `LOW manipulation risk (${pct(manipulation)}). News sources appear credible. No manipulation-driven adjustment needed.`;
  }

  // ── Key factors ──
  const keyFactors: string[] = [];
  keyFactors.push(`Technical confidence: ${conf}/100 (${sig.confidenceBand})`);
  keyFactors.push(`Risk score: ${risk}/100`);
  if (alignment !== 'no_news') keyFactors.push(`News alignment: ${alignment.replace(/_/g, ' ')}`);
  if (manipulation > 0.3) keyFactors.push(`Manipulation suspicion: ${pct(manipulation)}`);
  if (eventRisk.eventRiskBand !== 'low') keyFactors.push(`Event risk: ${eventRisk.eventRiskBand}`);
  if (sig.tradePlan) keyFactors.push(`R:R ratio: ${sig.tradePlan.rrTarget1.toFixed(1)}:1`);

  return {
    tradeDecision,
    newsVsTechnical,
    riskInterpretation,
    manipulationAssessment,
    keyFactors,
  };
}

// ── Batch Builder ────────────────────────────────────────────

export function buildDexterNarratives(
  signals: Phase4SignalEnvelope[],
): DexterSignalIntelligence[] {
  return signals.map(buildDexterNarrative);
}

// ── Score Breakdown from ScoreCard ──────────────────────────────

function buildScoreBreakdown(
  sig: Phase4SignalEnvelope,
): DexterSignalIntelligence['scoreBreakdown'] {
  const sc = sig.scoreCard ?? sig.newsContext.scoreCard;
  if (!sc) return null;

  return {
    sourceReliability: sc.sourceReliability,
    recency: sc.recency,
    sentiment: sc.sentiment,
    novelty: sc.novelty,
    directness: sc.directness,
    manipulationRisk: sc.manipulationRisk,
    finalSymbolImpact: sc.finalSymbolImpact,
    finalEventRisk: sc.finalEventRisk,
  };
}

// ── Helpers ───────────���──────────────────────────────────────

function formatStrategy(signalType: string): string {
  return signalType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatEventType(eventType: string): string {
  return eventType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

/** Format a 0-1 value as a percentage string. */
function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
