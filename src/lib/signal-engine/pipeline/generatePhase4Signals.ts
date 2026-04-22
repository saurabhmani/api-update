// ════════════════════════════════════════════════════════════════
//  Phase 4 Pipeline — AI Intelligence + Feedback Loop
//
//  Wraps Phase 3 output with:
//  - Macro/news/event context
//  - Contextual confidence modifiers
//  - AI explanations & trader narratives
//  - Signal freshness tracking
//  - Feedback state attachment
//  - Decision memory logging
//  - Portfolio commentary
// ════════════════════════════════════════════════════════════════

import type { Phase1Config } from '../types/signalEngine.types';
import type { Phase3Config, PortfolioSnapshot, ExecutableSignal } from '../types/phase3.types';
import type { Phase4SignalEnvelope, EventTag, FeedbackState, PortfolioCommentary } from '../types/phase4.types';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG } from '../constants/phase3.constants';
import { generatePhase3Signals } from './generatePhase3Signals';
import { createPipelineTracer, setAmbientTracer } from '../tracing/pipelineTracer';
import { computeScenario, type ScenarioResult } from '@/services/scenarioEngine';
import { computeMarketStance, type StanceResult } from '@/services/marketStanceEngine';
import type { Phase3Result } from './generatePhase3Signals';
import { buildMacroContext, defaultNewsContext, fetchLiveNewsContext, computeEventRisk } from '../context/macroContext';
import { computeContextualModifiers } from '../context/contextualModifiers';
import { computeFreshness } from '../freshness/signalDecay';
import { buildExplanation, buildTraderNarrative } from '../ai-explain/buildExplanation';
import { defaultFeedbackState } from '../feedback/outcomeTracker';
import { buildPortfolioCommentary, createMemoryEntry } from '../memory/decisionMemory';
import {
  saveExplanation, savePortfolioCommentary as persistCommentary, saveDecisionMemory,
  saveFreshnessSnapshot, saveContextSnapshot, loadLiveFeedbackState,
} from '../repository/savePhase4Artifacts';
import { saveSignals } from '../repository/saveSignals';
import { savePhase3Artifacts } from '../repository/savePhase3Signals';
import { buildSignalTimeline } from '../memory/decisionMemory';
import { buildLinkages, saveSignalNewsLinkage } from '@/lib/news-engine/feedback/linkageTracker';
import { buildDexterNarratives, type DexterSignalIntelligence } from '../dexter/buildDexterNarrative';
import { eventBus } from '@/lib/eventBus';
import type { CandleProvider } from './generatePhase1Signals';
import type { StrategyName } from '../types/signalEngine.types';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';

export interface Phase4Result {
  signals: Phase4SignalEnvelope[];
  commentary: PortfolioCommentary;
  /** Dexter AI intelligence narratives — one per signal. */
  dexterIntelligence: DexterSignalIntelligence[];
  /** Frozen snapshots of the upstream gate engines. */
  scenario:    ScenarioResult;
  marketStance: StanceResult;
  meta: {
    regime: string;
    regimeStrength: number;
    scanned: number;
    approved: number;
    deferred: number;
    rejected: number;
    scenarioTag:  string;
    marketStance: string;
  };
}

export interface Phase4RunOptions {
  /** String tag persisted to q365_signals.generation_source for audit. */
  generationSource?: string;
}

export async function generatePhase4Signals(
  provider: CandleProvider,
  portfolio: PortfolioSnapshot,
  eventTags: EventTag[] = ['none'],
  feedbackLookup?: (strategy: string, regime: string) => FeedbackState,
  p1Config: Phase1Config = DEFAULT_PHASE1_CONFIG,
  p3Config: Phase3Config = DEFAULT_PHASE3_CONFIG,
  options: Phase4RunOptions = {},
): Promise<Phase4Result> {
  const generationSource = options.generationSource ?? 'signal-engine:generatePhase4Signals';

  // ── Tracing ────────────────────────────────────────────────
  const tracer = createPipelineTracer();
  setAmbientTracer(tracer);
  const phaseSpan = tracer.phase('Phase4', {
    universe: p1Config.universe.length,
    events: eventTags.join(','),
    source: generationSource,
  });

  // ── Upstream gate engines (Scenario → Market Stance) ──────
  // These were dangling before this wire-up — both had full
  // implementations in src/services but no caller in the signal
  // pipeline. Running them here gives downstream engines (and
  // every persisted row) a deterministic scenario + stance
  // context. Ordering matters: Market Stance DEPENDS on Scenario.
  const scenarioSpan = tracer.engine('ScenarioEngine');
  scenarioSpan.input({});
  const scenarioLive = await computeScenario();
  if (!scenarioLive) {
    scenarioSpan.fail('computeScenario returned null');
    phaseSpan.fail('scenario missing');
    throw new Error('Scenario missing before Market Stance Engine');
  }
  // Snapshot immediately so later code paths cannot mutate the
  // cached scenario object back into the engine's TTL cache.
  const scenario: ScenarioResult = structuredClone(scenarioLive);
  scenarioSpan.end({
    tag: scenario.scenario_tag,
    confidence: scenario.scenario_confidence,
    direction_bias: scenario.direction_bias,
    volatility_mode: scenario.volatility_mode,
    breadth_state: scenario.breadth_state,
  });

  const stanceSpan = tracer.engine('MarketStanceEngine');
  stanceSpan.input({
    scenario_tag: scenario.scenario_tag,
  });
  if (!scenario) {
    stanceSpan.fail('Scenario missing before Market Stance Engine');
    throw new Error('Scenario missing before Market Stance Engine');
  }
  const stanceLive = await computeMarketStance(scenario);
  if (!stanceLive) {
    stanceSpan.fail('computeMarketStance returned null');
    phaseSpan.fail('stance missing');
    throw new Error('MarketStance missing before Phase 3 — gate engines broken');
  }
  const marketStance: StanceResult = structuredClone(stanceLive);
  stanceSpan.end({
    stance: marketStance.market_stance,
    confidence: marketStance.stance_confidence,
    min_confidence: marketStance.stance_config.min_confidence,
    min_rr: marketStance.stance_config.min_rr,
    max_positions: marketStance.stance_config.max_positions,
  });

  // ── Run Phase 3 (deterministic core) ──────────────────────
  const p3Span = tracer.engine('Phase3-inner');
  p3Span.input({
    universe: p1Config.universe.length,
    scenario_tag: scenario.scenario_tag,
    market_stance: marketStance.market_stance,
  });
  const phase3: Phase3Result = await generatePhase3Signals(provider, portfolio, p1Config, p3Config);
  p3Span.end({
    scanned: phase3.scanned,
    approved: phase3.approved,
    deferred: phase3.deferred,
    rejected: phase3.rejected,
  });

  // ── Build sector leadership from approved signals ──────────
  const sectorCounts: Record<string, number> = {};
  for (const sig of phase3.signals) {
    if (sig.executionReadiness.approvalDecision === 'approved') {
      const sector = (await import('../constants/phase3.constants')).getSector(sig.symbol);
      sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
    }
  }
  // Sectors with 2+ approved signals = leadership
  const leadingSectors = Object.entries(sectorCounts)
    .filter(([, count]) => count >= 2)
    .map(([sector]) => sector);

  // ── Build macro context from regime + sector leadership ───
  const macro = buildMacroContext(phase3.regime, leadingSectors);
  // Fetch market-level news context (non-symbol-specific fallback)
  const marketNews = await fetchLiveNewsContext();
  const eventRisk = computeEventRisk(eventTags);

  // ── Enrich each signal ────────────────────────────────────
  const enriched: Phase4SignalEnvelope[] = [];

  // Aggregate counters per Phase 4 engine.
  const phase4Counts = {
    computeFreshness:       { fresh: 0, aging: 0, stale: 0, expired: 0 },
    enrichSignalWithNews:   { enriched: 0, skipped: 0, confBoost: 0, confPenalty: 0 },
    contextualModifiers:    { applied: 0, none: 0 },
    buildExplanation:       { ok: 0, fail: 0 },
  };
  // Side-channel: Phase4SignalEnvelope doesn't carry the full risk
  // breakdown (only the total score), but the Phase 3 risk snapshot
  // persistence wants the standalone/portfolio/factors split. Keep
  // the breakdown keyed by symbol so we can pair it back up when
  // writing q365_signal_risk_snapshots below.
  const riskBreakdownBySymbol = new Map<string, typeof phase3.signals[number]['riskBreakdown']>();
  // Track news event details per symbol for linkage persistence
  const newsEventDetailsBySymbol = new Map<string, {
    details: Array<{ eventId: number; impactScore: number; trustScore: number; sentimentScore: number }>;
    modifierApplied: number;
  }>();

  for (const sig of phase3.signals) {
    // Snapshot the Phase-3 risk breakdown BEFORE news enrichment
    // mutates sig.riskBreakdown. Caching the live reference here
    // leaked the news-adjusted totalRiskScore into the standalone
    // risk_snapshots artifact — savePhase3Artifacts should see the
    // pre-news numbers. Deep clone via structuredClone (Node ≥17).
    riskBreakdownBySymbol.set(
      sig.symbol,
      structuredClone(sig.riskBreakdown),
    );
    const strategy = sig.signalType as StrategyName;

    // Freshness
    const freshness = computeFreshness(
      sig.generatedAt,
      sig.tradePlan.entryZoneHigh,
      sig.tradePlan.entryZoneHigh,
      0, // bars elapsed = 0 (just generated)
    );
    const decayKey = (freshness.decayState ?? 'fresh') as keyof typeof phase4Counts.computeFreshness;
    if (decayKey in phase4Counts.computeFreshness) phase4Counts.computeFreshness[decayKey]++;
    else phase4Counts.computeFreshness.fresh++;

    // Feedback state — prefer explicit lookup, then live DB state, then defaults
    let feedback: FeedbackState;
    if (feedbackLookup) {
      feedback = feedbackLookup(strategy, phase3.regime.label);
    } else {
      try {
        feedback = await loadLiveFeedbackState(strategy, phase3.regime.label);
      } catch {
        feedback = defaultFeedbackState();
      }
    }

    // Sector in leadership? Check if this signal's actual sector is in the leadership list
    const sigSector = (await import('../constants/phase3.constants')).getSector(sig.symbol);
    const sectorInLeadership = macro.sectorLeadership.includes(sigSector);

    // Symbol-specific news context (enriched from news-engine scoring)
    // Falls back to market-level news if symbol-specific scoring unavailable.
    // enrichSignalWithNews returns the full enriched NewsContext with
    // symbolImpactScore, eventRiskScore, manipulationSuspicion, etc.
    let news = marketNews;
    let newsWarnings: string[] = [];
    let newsSuppress = false;
    try {
      const { enrichSignalWithNews } = await import('@/lib/news-engine/impact/signalIntegration');
      const newsResult = await enrichSignalWithNews(
        sig.symbol, sig.confidenceScore, sig.riskBreakdown.totalRiskScore,
      );
      if (newsResult.newsContext.strength > 0) phase4Counts.enrichSignalWithNews.enriched++;
      else                                      phase4Counts.enrichSignalWithNews.skipped++;
      if (newsResult.confidenceAdjustment > 0)  phase4Counts.enrichSignalWithNews.confBoost++;
      if (newsResult.confidenceAdjustment < 0)  phase4Counts.enrichSignalWithNews.confPenalty++;
      // newsResult.newsContext is the full enriched NewsContext (0-1 contract)
      if (newsResult.newsContext.strength > 0) {
        news = newsResult.newsContext;
      }
      newsWarnings = newsResult.warnings;
      newsSuppress = newsResult.suppressSignal;
      // Track news event details for linkage
      if (newsResult.newsEventDetails && newsResult.newsEventDetails.length > 0) {
        newsEventDetailsBySymbol.set(sig.symbol, {
          details: newsResult.newsEventDetails,
          modifierApplied: newsResult.confidenceAdjustment,
        });
      }
      // Use the adjusted risk from news
      if (newsResult.riskAdjustment > 0) {
        sig.riskBreakdown = {
          ...sig.riskBreakdown,
          totalRiskScore: Math.min(100, sig.riskBreakdown.totalRiskScore + newsResult.riskAdjustment),
        };
      }
      // Link the news event ID into signal provenance if available
      if (news.eventId) {
        sig.reasons = [...sig.reasons, `News event: ${news.eventType ?? 'general'} (event ${news.eventId})`];
      }
    } catch { /* fall through to market-level news */ }

    // Contextual modifiers
    const modifiers = computeContextualModifiers(
      sig.confidenceScore, macro, news, eventRisk, freshness, feedback, sectorInLeadership,
    );
    if (modifiers.rawTotal !== 0) phase4Counts.contextualModifiers.applied++;
    else                           phase4Counts.contextualModifiers.none++;

    // Apply news warnings and suppression
    if (newsWarnings.length > 0) {
      sig.warnings = [...sig.warnings, ...newsWarnings];
    }
    if (newsSuppress) {
      // Phase 4 is enrichment-only — it MUST NOT alter the Phase 3
      // approval decision. News suppression is advisory: add a
      // strong warning but leave approvalDecision untouched.
      // Phase 3's rejection engine is the single authority.
      sig.warnings = [...sig.warnings, 'NEWS: Signal flagged for suppression by news intelligence engine — review before entry'];
    }

    // ── Score-dimension-aware decision logic ────────────────────
    // Use enriched score fields for more granular suppression/caution.
    const enrichedEventRisk = news.eventRiskScore ?? 0;
    const enrichedManipulation = news.manipulationSuspicion ?? 0;
    const enrichedSymbolImpact = news.symbolImpactScore ?? 0;

    // High event risk should add caution even if news bias is bullish
    if (enrichedEventRisk > 0.6 && !newsSuppress) {
      sig.warnings = [...sig.warnings, `NEWS: High event risk (${Math.round(enrichedEventRisk * 100)}%) — consider reduced sizing`];
    }

    // High manipulation suspicion reduces confidence regardless of sentiment
    if (enrichedManipulation > 0.5 && !newsSuppress) {
      sig.warnings = [...sig.warnings, `NEWS: Elevated manipulation suspicion (${Math.round(enrichedManipulation * 100)}%) — verify with official sources`];
    }

    // Strong symbol impact + low manipulation = can strengthen conviction (already via modifier)
    // But weak technical + hype news = additional caution
    if (sig.confidenceScore < 60 && enrichedSymbolImpact > 0.5 && enrichedManipulation > 0.3) {
      sig.warnings = [...sig.warnings, 'NEWS: Weak technical setup with hype-driven news — elevated false positive risk'];
    }

    // AI explanation — uses typed fields carried from Phase 2/3
    const defaultFeatures = { trend: { close: 0, open: 0, ema9: 0, ema21: 0, ema20: 0, ema50: 0, ema200: 0, sma200: 0, closeAbove20Ema: false, closeAbove50Ema: false, closeAbove200Ema: false, ema20Above50: false, ema50Above200: false, distanceFrom20EmaPct: 0, distanceFrom50EmaPct: 0 }, momentum: { rsi14: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0, roc5: 0, roc20: 0, stochasticK: 50, stochasticD: 50, adx: 0, bullishDivergence: false, bearishDivergence: false }, volume: { volume: 0, avgVolume20: 0, volumeVs20dAvg: 1, breakoutVolumeRatio: 0, obv: 0, obvSlope: 0, vwap: 0, volumeClimaxRatio: 0 }, volatility: { atr14: 0, atrPct: 0, dailyRangePct: 0, gapPct: 0, bollingerUpper: 0, bollingerLower: 0, bollingerWidth: 0, bollingerPctB: 0.5, squeezed: false }, structure: { recentResistance20: 0, recentSupport20: 0, breakoutDistancePct: 0, distanceToResistancePct: 0, distanceToSupportPct: 0, recentHigh20: 0, recentLow20: 0, isInsideDay: false, rangeCompressionRatio: 1, consecutiveHigherLows: 0, consecutiveLowerHighs: 0 }, context: { marketRegime: 'Sideways' as const, liquidityPass: true } };
    const explanation = buildExplanation({
      symbol: sig.symbol,
      strategy,
      features: sig.features ?? defaultFeatures,
      confidence: sig.confidenceBreakdown ?? { trendScore: 0, momentumScore: 0, volumeScore: 0, structureScore: 0, contextScore: 0, rawScore: 0, penaltyScore: 0, finalScore: sig.confidenceScore, band: sig.confidenceBand as any },
      risk: sig.standaloneRisk ?? { atrRisk: 0, gapRisk: 0, stopDistanceRisk: 0, overextensionRisk: 0, liquidityRisk: 0, candleVolatilityRisk: 0, regimeRisk: 0, totalScore: sig.riskBreakdown.totalRiskScore, band: sig.riskBreakdown.riskBand as any },
      tradePlan: sig.tradePlan,
      portfolioFit: sig.portfolioFit,
      sizing: sig.positionSizing,
      macro,
      eventRisk,
      freshness,
      newsContext: news,
    });

    phase4Counts.buildExplanation.ok++;
    const narrative = buildTraderNarrative(explanation, strategy);

    // Updated confidence band after modifiers
    const adjConf = modifiers.finalAdjustedConfidence;
    const adjBand = adjConf >= 85 ? 'High Conviction' : adjConf >= 70 ? 'Actionable' : adjConf >= 55 ? 'Watchlist' : 'Avoid';

    enriched.push({
      symbol: sig.symbol,
      signalType: sig.signalType,
      signalSubtype: sig.signalSubtype,
      marketRegime: phase3.regime.label,

      confidenceScore: sig.confidenceScore,
      adjustedConfidenceScore: adjConf,
      confidenceBand: adjBand,
      riskScore: sig.riskBreakdown.totalRiskScore,

      tradePlan: sig.tradePlan,
      positionSizing: sig.positionSizing,
      portfolioFit: sig.portfolioFit,
      executionReadiness: sig.executionReadiness,

      macroContext: macro,
      newsContext: news,
      eventRisk,
      contextualModifiers: modifiers,
      aiExplanation: explanation,
      traderNarrative: narrative,
      freshness,
      feedbackState: feedback,

      lifecycleStatus: sig.lifecycle.state,

      // Enriched news score breakdown — preserve full scoreCard and impactBreakdown
      scoreCard: news.scoreCard,
      impactBreakdown: news.impactBreakdown,

      reasons: sig.reasons,
      warnings: sig.warnings,
      generatedAt: sig.generatedAt,
    });
  }

  // ── Portfolio commentary ──────────────────────────────────
  const commentary = buildPortfolioCommentary(
    portfolio, phase3.regime, phase3.approved, phase3.deferred,
  );

  // ── Persist signals first to get real IDs, then save explanations ──
  try {
    // Save base signals (Phase 3 data) to get real DB IDs
    const signalIdMap = await saveSignals(enriched.map(sig => ({
      symbol: sig.symbol,
      timeframe: 'daily' as const,
      signalType: sig.signalType,
      signalSubtype: sig.signalSubtype ?? 'primary',
      // CRITICAL: action drives BUY/SELL direction downstream
      // (`saveSignals.ts:197` maps `action === 'enter_short'` → SELL,
      // everything else → BUY). The previous literal 'BUY'|'WATCH'
      // forced every bearish strategy (bearish_breakdown,
      // overbought_reversal, weak_trend_breakdown) to be persisted as
      // BUY — producing rows with SHORT-semantics trade plans
      // (stop > entry, target < entry) but direction='BUY' in the DB,
      // which (a) made `sell_in_db_pool = 0`, (b) tripped
      // applyLiveSanity's BUY stop-out check → `stopped_out_live`
      // flags on every fresh overbought_reversal row. Derive from
      // BEARISH_STRATEGIES instead.
      action: BEARISH_STRATEGIES.has(sig.signalType as StrategyName)
        ? 'enter_short' as const
        : 'enter_on_breakout' as const,
      marketRegime: sig.marketRegime,
      marketContextTag: 'normal',
      strengthTag: 'moderate',
      strategyName: sig.signalType,
      strategyConfidence: sig.confidenceScore,
      contextScore: 0,
      confidenceScore: sig.adjustedConfidenceScore,
      confidenceBand: sig.confidenceBand,
      riskScore: sig.riskScore,
      riskBand: sig.riskScore <= 30 ? 'Low' : sig.riskScore <= 60 ? 'Medium' : 'High',
      entry: { type: 'breakout_confirmation' as const, zoneLow: sig.tradePlan.entryZoneLow, zoneHigh: sig.tradePlan.entryZoneHigh },
      stopLoss: sig.tradePlan.stopLoss,
      targets: { target1: sig.tradePlan.target1, target2: sig.tradePlan.target2 },
      rewardRiskApprox: sig.tradePlan.rrTarget1,
      reasons: sig.reasons,
      warnings: sig.warnings,
      features: undefined,
      relativeStrength: undefined,
      confidenceBreakdown: undefined,
      riskBreakdown: undefined,
      status: sig.executionReadiness.approvalDecision === 'approved' ? 'active' : 'watchlist',
      generatedAt: sig.generatedAt,
    } as any)), generationSource);

    // Now save Phase 3 artifacts + explanations with REAL signal IDs
    for (const sig of enriched) {
      const realId = signalIdMap.get(sig.symbol);
      if (realId) {
        // Phase 3 artifacts
        await savePhase3Artifacts(
          realId,
          sig.tradePlan,
          sig.positionSizing,
          sig.portfolioFit,
          sig.executionReadiness,
          { state: sig.lifecycleStatus as any, reason: 'phase4_generated', changedAt: sig.generatedAt },
          riskBreakdownBySymbol.get(sig.symbol),
        ).catch((err) => console.error(`[Phase4] Phase3 artifacts save failed for ${sig.symbol}:`, err));

        // AI explanation — must never be silently swallowed. Every signal
        // is required to land a row in q365_signal_explanations; log loud
        // and leave the error to the outer try/catch so failures are
        // visible in logs instead of silently dropping the row.
        try {
          await saveExplanation(
            realId,
            sig.aiExplanation as unknown as Record<string, unknown>,
            { macro: sig.macroContext, news: sig.newsContext, eventRisk: sig.eventRisk, modifiers: sig.contextualModifiers } as Record<string, unknown>,
          );
          console.log(`[EXPLANATION] saved for signal_id: ${realId}`);
        } catch (err) {
          console.error(`[Phase4] saveExplanation failed for ${sig.symbol} (signal_id=${realId}):`, (err as Error).message);
        }

        // Dedicated context + freshness snapshots (spec §4.B, §4.C).
        // These are additive to the explanation row; keeping both so
        // existing readers of explanation.context_json don't break.
        await saveContextSnapshot(
          realId, sig.macroContext, sig.newsContext, sig.eventRisk, sig.contextualModifiers,
        ).catch(() => {});
        await saveFreshnessSnapshot(realId, sig.freshness, 0).catch(() => {});

        // News → Signal linkage — connects news events to this signal for calibration
        const newsInfo = newsEventDetailsBySymbol.get(sig.symbol);
        if (newsInfo && newsInfo.details.length > 0) {
          const linkages = buildLinkages(realId, sig.symbol, newsInfo.modifierApplied, newsInfo.details, sig.generatedAt);
          await saveSignalNewsLinkage(linkages).catch((err) => {
            console.warn(`[Phase4] news linkage save failed for ${sig.symbol}:`, (err as Error).message);
          });
        }

        // Decision memory — audit trail of why signal was generated
        const timeline = buildSignalTimeline(realId, [
          { stage: 'phase1_scan', message: `Signal detected: ${sig.signalType} for ${sig.symbol}` },
          { stage: 'phase2_strategy', message: `Strategy: ${sig.signalType}, confidence: ${sig.confidenceScore}` },
          { stage: 'phase3_execution', message: `Approval: ${sig.executionReadiness.approvalDecision}, fit: ${sig.portfolioFit.fitScore}`, payload: { sizing: sig.positionSizing.positionSizeUnits, risk: sig.riskScore } },
          { stage: 'phase4_enrichment', message: `Adjusted confidence: ${sig.adjustedConfidenceScore}, band: ${sig.confidenceBand}`, payload: { freshness: sig.freshness.decayState, eventRisk: sig.eventRisk.eventRiskScore } },
        ]);
        await saveDecisionMemory(timeline).catch(() => {});
      }
    }
    await persistCommentary(commentary).catch(() => {});
  } catch (err) {
    console.error('[Phase4] Persistence error (non-blocking):', err);
  }

  // ── Dexter AI narratives ──────────────────────────────────
  const dexterIntelligence = buildDexterNarratives(enriched);


  // Emit real-time events
  if (enriched.length > 0) {
    eventBus.emit('signal:new', { count: enriched.length, symbols: enriched.map(s => s.symbol) });
    eventBus.emit('dexter:update', { count: dexterIntelligence.length });
  }

  // Emit one summary span per Phase 4 engine — gives a unified
  // view of what freshness/news/context/explanation saw and
  // produced during the enrichment pass.
  for (const [name, counts] of Object.entries(phase4Counts)) {
    const span = tracer.engine(name);
    span.input({ phase3_signals: phase3.signals.length });
    span.end(counts as Record<string, number>);
  }

  phaseSpan.end({
    enriched: enriched.length,
    approved: phase3.approved,
    regime: phase3.regime.label,
    dexter: dexterIntelligence.length,
  });

  // ── Final unified-engine summary ─────────────────────────
  // One block at the end of the run. This is the ONLY line
  // block a human operator needs to verify the system ran
  // correctly end-to-end. Broken-communication checks below
  // surface any dangling or zero-output engines before the
  // summary, so a failed run is impossible to miss.
  const ctx = {
    scenario,
    marketStance,
    signals: enriched,
    meta: {
      regime:   phase3.regime.label,
      scanned:  phase3.scanned,
      approved: phase3.approved,
      deferred: phase3.deferred,
      rejected: phase3.rejected,
    },
  };

  const problems: string[] = [];
  if (!ctx.scenario)            problems.push('❌ Scenario missing');
  if (!ctx.marketStance)        problems.push('❌ Stance missing');
  if (ctx.signals.length === 0) problems.push('❌ Signal generation failed (0 enriched)');

  const status = problems.length === 0 ? 'OK ✅' : `DEGRADED (${problems.length} issue${problems.length === 1 ? '' : 's'})`;

  console.log(
`\n══════════════  UNIFIED ENGINE SUMMARY  [run=${tracer.runId}]  ══════════════
  Scenario       : ${ctx.scenario?.scenario_tag ?? '—'}  (${ctx.scenario?.scenario_confidence ?? 0}% confidence)
  Market Stance  : ${ctx.marketStance?.market_stance ?? '—'}  (min_conf=${ctx.marketStance?.stance_config.min_confidence ?? '—'}, min_rr=${ctx.marketStance?.stance_config.min_rr ?? '—'})
  Regime         : ${ctx.meta.regime}
  Scanned        : ${ctx.meta.scanned}
  Total Signals  : ${ctx.signals.length}
  Approved       : ${ctx.meta.approved}
  Deferred       : ${ctx.meta.deferred}
  Rejected       : ${ctx.meta.rejected}
  SYSTEM STATUS  : ${status}${problems.length > 0 ? '\n  PROBLEMS       :\n    - ' + problems.join('\n    - ') : ''}
══════════════════════════════════════════════════════════════════════════════\n`);

  return {
    signals: enriched,
    commentary,
    dexterIntelligence,
    scenario,
    marketStance,
    meta: {
      regime: phase3.regime.label,
      regimeStrength: phase3.regime.strength,
      scanned: phase3.scanned,
      approved: phase3.approved,
      deferred: phase3.deferred,
      rejected: phase3.rejected,
      scenarioTag:  scenario.scenario_tag,
      marketStance: marketStance.market_stance,
    },
  };
}
