// ════════════════════════════════════════════════════════════════
//  Phase 3 Pipeline — Trade Engine + Risk Engine + Portfolio-Aware
//
//  Signal → Trade Plan → Position Size → Portfolio Fit →
//  Risk Integration → Execution Readiness → Lifecycle → Rank
// ════════════════════════════════════════════════════════════════

import type {
  Candle, QuantSignal, Phase1Config, EnhancedMarketRegime,
  StrategyName, SignalAction, SignalSubtype, MarketContextTag, StrengthTag,
} from '../types/signalEngine.types';
import type {
  ExecutableSignal, Phase3TradePlan, Phase3Config,
  PortfolioSnapshot, PortfolioPosition,
} from '../types/phase3.types';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG, getSector } from '../constants/phase3.constants';
import { createPipelineTracer, setAmbientTracer } from '../tracing/pipelineTracer';
import { detectEnhancedRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { runAllStrategies, resetSellDebugAgg, flushSellDebugAgg } from '../strategy-engine/runStrategies';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import { computeRelativeStrength, defaultRelativeStrength } from '../context/relativeStrength';
import { calculatePositionSize } from '../position-sizing/positionSizer';
import { evaluatePortfolioFit } from '../portfolio-fit/evaluatePortfolioFit';
import { evaluateExecutionReadiness } from '../execution/executionReadiness';
import { computePhase3Risk } from '../risk/phase3Risk';
import { createLifecycle, resolveInitialState } from '../lifecycle/signalLifecycle';
import { buildPhase3TradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { evaluateCorrelationPenalty, buildCorrelationMatrix, type CorrelationMatrix } from '../correlation/correlationEngine';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';
import type { CandleProvider } from './generatePhase1Signals';
import { runRejectionEngine, type RejectionInput, type RejectionDecision } from '../core/runRejectionEngine';

export interface Phase3Result {
  regime: EnhancedMarketRegime;
  signals: ExecutableSignal[];
  scanned: number;
  approved: number;
  deferred: number;
  rejected: number;
  rejectionLog: { symbol: string; reason: string }[];
}

const ACTION_MAP: Record<StrategyName, SignalAction> = {
  bullish_breakout:       'enter_on_strength',
  bullish_pullback:       'enter_on_pullback',
  bearish_breakdown:      'enter_short',
  mean_reversion_bounce:  'enter_on_bounce',
  momentum_continuation:  'enter_on_momentum',
  bullish_divergence:     'enter_on_divergence',
  volume_climax_reversal: 'enter_on_climax',
  gap_continuation:       'enter_on_gap',
  range_breakout:         'enter_on_breakout',
  ema_crossover:          'enter_on_crossover',
  oversold_bounce:        'enter_on_oversold',
  // Both new bearish strategies share 'enter_short' — saveSignals.ts
  // maps enter_short → direction='SELL'. No new action enum needed.
  overbought_reversal:    'enter_short',
  weak_trend_breakdown:   'enter_short',
};

const SUBTYPE_MAP: Record<StrategyName, SignalSubtype> = {
  bullish_breakout:       'fresh_breakout',
  bullish_pullback:       'pullback_entry',
  bearish_breakdown:      'breakdown',
  mean_reversion_bounce:  'reversal_bounce',
  momentum_continuation:  'momentum_ride',
  bullish_divergence:     'divergence_reversal',
  volume_climax_reversal: 'climax_reversal',
  gap_continuation:       'gap_and_go',
  range_breakout:         'range_expansion',
  ema_crossover:          'ema_cross',
  oversold_bounce:        'oversold_reversal',
  overbought_reversal:    'overbought_reversal_entry',
  weak_trend_breakdown:   'weak_trend_entry',
};

type Phase3EntryType = 'breakout_confirmation' | 'pullback_retest' | 'momentum_followthrough' | 'mean_reversion_confirmation';
const ENTRY_TYPE_MAP: Record<StrategyName, Phase3EntryType> = {
  bullish_breakout:       'breakout_confirmation',
  bullish_pullback:       'pullback_retest',
  bearish_breakdown:      'momentum_followthrough',
  mean_reversion_bounce:  'mean_reversion_confirmation',
  momentum_continuation:  'momentum_followthrough',
  bullish_divergence:     'mean_reversion_confirmation',
  volume_climax_reversal: 'mean_reversion_confirmation',
  gap_continuation:       'breakout_confirmation',
  range_breakout:         'breakout_confirmation',
  ema_crossover:          'momentum_followthrough',
  oversold_bounce:        'mean_reversion_confirmation',
  overbought_reversal:    'mean_reversion_confirmation',
  weak_trend_breakdown:   'momentum_followthrough',
};

function contextTag(regime: string): MarketContextTag {
  if (regime === 'Strong Bullish' || regime === 'Bullish') return 'Bullish';
  if (regime === 'Bearish' || regime === 'Weak') return 'Weak';
  return 'Neutral';
}

function strengthTag(confidence: number): StrengthTag {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Avoid';
}

export async function generatePhase3Signals(
  provider: CandleProvider,
  portfolio: PortfolioSnapshot,
  p1Config: Phase1Config = DEFAULT_PHASE1_CONFIG,
  p3Config: Phase3Config = DEFAULT_PHASE3_CONFIG,
): Promise<Phase3Result> {
  const now = new Date().toISOString();
  const rejectionLog: Phase3Result['rejectionLog'] = [];
  let approved = 0, deferred = 0, rejected = 0;

  // ── Tracing ────────────────────────────────────────────────
  const tracer = createPipelineTracer();
  setAmbientTracer(tracer);
  const phaseSpan = tracer.phase('Phase3', {
    universe: p1Config.universe.length,
    capital: portfolio.capital ?? null,
    openPositions: portfolio.openPositions?.length ?? 0,
  });

  // ── Step 1: Detect regime ─────────────────────────────────
  const benchmarkCandles = await provider.fetchDailyCandles(p1Config.benchmarkSymbol);
  const benchValid = validateCandleSeries(benchmarkCandles, p1Config.minCandleCount);
  if (!benchValid.valid) throw new Error(`Benchmark invalid: ${benchValid.reason}`);
  const regime = detectEnhancedRegime(benchmarkCandles);


  // ── Build correlation matrix from available candle data ────
  const candleCache = new Map<string, Candle[]>();
  for (const sym of p1Config.universe) {
    try {
      const c = await provider.fetchDailyCandles(sym);
      if (c.length >= 30) candleCache.set(sym, c);
    } catch {}
  }
  const correlationMatrix = candleCache.size > 1
    ? buildCorrelationMatrix(candleCache) : undefined;

  // Mutable portfolio for tracking allocations within this run
  const runPortfolio: PortfolioSnapshot = {
    capital: portfolio.capital,
    cashAvailable: portfolio.cashAvailable,
    openPositions: [...portfolio.openPositions],
    pendingSignals: [...portfolio.pendingSignals],
  };

  const signals: ExecutableSignal[] = [];

  // Reset SELL-generation counters for this batch. The strategy
  // runner accumulates per-symbol counts into a module-level
  // aggregator; we reset here and flush at the end so one Phase 3
  // scan produces exactly one [SELL DEBUG AGG] log line.
  resetSellDebugAgg();

  // ── Tracing — aggregate counters per engine ───────────────
  // We emit a single span per engine at phase end with summary
  // counts instead of N spans per symbol, so the log stays
  // readable for a 2000-symbol universe.
  const engineCounts = {
    tradePlan:           { ok: 0, fail: 0 },
    positionSize:        { ok: 0, capped: 0, invalid: 0 },
    portfolioFit:        { approved: 0, deferred: 0, rejected: 0 },
    executionReadiness:  { approved: 0, deferred: 0, rejected: 0 },
    manipulationPenalty: { penalized: 0, rejected: 0, clean: 0 },
    canonicalRejection:  { approved: 0, rejected: 0 },
  };

  // [SELL TRACE] — per-stage SELL attrition. Incremented only when
  // the candidate is a bearish strategy. At the end of the scan we
  // emit one roll-up line so the operator can see exactly where
  // SELL candidates are being dropped.
  const sellTrace = {
    after_generation:        0,  // survived runAllStrategies
    after_trade_plan:        0,  // passed stop-width + R:R gates
    after_position_sizing:   0,  // sizing didn't invalidate
    after_portfolio_fit:     0,  // portfolio_fit decision != rejected
    after_execution_ready:   0,  // execution readiness approved
    after_canonical_reject:  0,  // canonical rejection engine approved
    final_saved:             0,  // actually pushed into signals[]
  };

  // ── Step 2: Process each symbol ───────────────────────────
  for (const symbol of p1Config.universe) {
    try {
      const candles = await provider.fetchDailyCandles(symbol);
      const candleCheck = validateCandleSeries(candles, p1Config.minCandleCount);
      if (!candleCheck.valid) { rejectionLog.push({ symbol, reason: candleCheck.reason! }); continue; }

      const features = buildSignalFeatures(candles, regime.label, p1Config.minAvgVolume, p1Config.minPrice);
      const featureCheck = validateFeatures(features);
      if (!featureCheck.valid) { rejectionLog.push({ symbol, reason: featureCheck.reason! }); continue; }

      let rs = defaultRelativeStrength();
      try { rs = computeRelativeStrength(candles, benchmarkCandles); } catch {}

      // ── Step 3: Strategy evaluation ─────────────────────────
      const { candidates, rejections } = runAllStrategies(features, rs);
      for (const r of rejections) rejectionLog.push({ symbol, reason: `[${r.strategy}] ${r.reason}` });
      if (candidates.length === 0) continue;

      // ── Best-per-direction emission (Nov 2026 SELL-balance fix) ─
      //
      // Historical bug: `const best = candidates[0]` picked the
      // highest-confidence candidate per symbol regardless of
      // direction. In bull tapes, bullish strategies almost always
      // outscored bearish ones on the same stock, so SELL signals
      // silently lost out at this single line — the #1 cause of
      // "SELL=0 in final output" despite bearish strategies matching
      // at the generation layer (visible in [SELL DEBUG AGG]).
      //
      // New behaviour: pick best bullish AND best bearish. Emit both
      // IFF (a) both exist, (b) secondary score is within 15 points
      // of primary, (c) secondary score ≥ 50. Otherwise emit just
      // the dominant one. No faking — every emitted candidate had to
      // actually match its strategy's criteria.
      const bullishBest = candidates.find((c) => !BEARISH_STRATEGIES.has(c.strategy));
      const bearishBest = candidates.find((c) =>  BEARISH_STRATEGIES.has(c.strategy));
      const toBuild: typeof candidates = [];
      if (bullishBest && bearishBest) {
        const primary   = bullishBest.confidence.finalScore >= bearishBest.confidence.finalScore
          ? bullishBest : bearishBest;
        const secondary = primary === bullishBest ? bearishBest : bullishBest;
        toBuild.push(primary);
        const gap = primary.confidence.finalScore - secondary.confidence.finalScore;
        if (gap <= 15 && secondary.confidence.finalScore >= 50) {
          toBuild.push(secondary);
        }
      } else if (bullishBest) toBuild.push(bullishBest);
      else if (bearishBest)   toBuild.push(bearishBest);

    // Loop-per-direction over the body below. Every downstream
    // step (trade plan, sizing, portfolio fit, rejection engine,
    // signal save) runs once per surviving candidate, so a stock
    // with a clear BUY + a near-parity SELL produces two rows.
    for (const best of toBuild) {
      const isSellCandidate = BEARISH_STRATEGIES.has(best.strategy);
      if (isSellCandidate) sellTrace.after_generation++;
      // Early confidence filter REMOVED. The pipeline used to drop
      // any candidate below minConfidenceToSave here, which meant
      // the API never saw the bottom of the ranked distribution.
      // Now every scored signal flows through to the API layer,
      // which sorts by confidence desc and applies the final
      // top-50 cap. This guarantees the user sees the top 50
      // signals from the entire universe — never fewer just
      // because the cut was applied too early.
      void p1Config;

      // ── Step 4: Build Phase 3 trade plan (strategy-aware target3) ─
      const tradePlan = buildPhase3TradePlanForStrategy(features, best.strategy);

      // ── Step 5: Stop width check ────────────────────────────
      const stopWidthPct = tradePlan.entryZoneHigh > 0
        ? (tradePlan.initialRiskPerUnit / tradePlan.entryZoneHigh) * 100
        : 0;
      if (stopWidthPct > p3Config.stopMaxWidthPct) {
        rejectionLog.push({ symbol, reason: `Stop too wide: ${stopWidthPct.toFixed(1)}% > ${p3Config.stopMaxWidthPct}%` });
        rejected++;
        continue;
      }

      // ── Step 6: R:R check ───────────────────────────────────
      if (tradePlan.rrTarget1 < p3Config.minRewardRisk) {
        rejectionLog.push({ symbol, reason: `R:R ${tradePlan.rrTarget1} below min ${p3Config.minRewardRisk}` });
        rejected++;
        continue;
      }
      if (isSellCandidate) sellTrace.after_trade_plan++;

      // ── Step 7: Position sizing ─────────────────────────────
      const currentGross = runPortfolio.openPositions.reduce((s, p) => s + p.grossValue, 0);
      const sizing = calculatePositionSize({
        portfolioCapital: runPortfolio.capital,
        riskPerTradePct: p3Config.riskPerTradePct,
        maxGrossExposurePct: p3Config.maxGrossExposurePct,
        entryPrice: tradePlan.entryZoneHigh,
        stopLoss: tradePlan.stopLoss,
        atrPct: features.volatility.atrPct,
        model: features.volatility.atrPct > 3 ? 'volatility_adjusted' : 'fixed_fractional',
        currentGrossExposure: currentGross,
      });
      if (sizing.validationStatus === 'capped')       engineCounts.positionSize.capped++;
      else if (sizing.validationStatus === 'invalid') engineCounts.positionSize.invalid++;
      else                                             engineCounts.positionSize.ok++;

      if (isSellCandidate && sizing.validationStatus !== 'invalid') {
        sellTrace.after_position_sizing++;
      }
      if (isSellCandidate && process.env.DEBUG_SELL_DOWNSTREAM === '1' &&
          sizing.validationStatus === 'invalid') {
        console.log('[SIZE REJECT]', symbol, {
          reason: sizing.warnings[0] ?? 'zero_size',
          entry:  tradePlan.entryZoneHigh,
          stop:   tradePlan.stopLoss,
        });
      }

      // ── Step 8: Portfolio fit ───────────────────────────────
      // Use the shared BEARISH_STRATEGIES Set so new bearish strategies
      // are recognised as SHORT. Prior bug: hardcoded === 'bearish_breakdown'
      // silently produced 'long' direction for new bearish strategies,
      // breaking portfolio fit + position sizing downstream.
      const direction = BEARISH_STRATEGIES.has(best.strategy) ? 'short' as const : 'long' as const;
      const portfolioFit = evaluatePortfolioFit(
        symbol, direction, sizing.grossPositionValue, runPortfolio, p3Config,
      );
      if      (portfolioFit.portfolioDecision === 'rejected') engineCounts.portfolioFit.rejected++;
      else if (portfolioFit.portfolioDecision === 'deferred') engineCounts.portfolioFit.deferred++;
      else                                                     engineCounts.portfolioFit.approved++;

      if (isSellCandidate && portfolioFit.portfolioDecision !== 'rejected') {
        sellTrace.after_portfolio_fit++;
      }
      if (isSellCandidate && process.env.DEBUG_SELL_DOWNSTREAM === '1' &&
          portfolioFit.portfolioDecision === 'rejected') {
        console.log('[PORTFOLIO REJECT]', {
          symbol,
          reason: portfolioFit.penalties[0] ?? 'fit_score_too_low',
          fit_score:      portfolioFit.fitScore,
          direction_impact: portfolioFit.directionImpact,
        });
      }

      // ── Step 8b: Real correlation penalty (upgrades sector proxy) ─
      if (correlationMatrix) {
        const corrResult = evaluateCorrelationPenalty(
          symbol, runPortfolio.openPositions, correlationMatrix, p3Config,
        );
        // Replace sector-proxy correlation with real correlation data
        if (corrResult.correlationPenalty > portfolioFit.correlationPenalty) {
          portfolioFit.fitScore = Math.max(0, portfolioFit.fitScore -
            (corrResult.correlationPenalty - portfolioFit.correlationPenalty));
          portfolioFit.correlationPenalty = corrResult.correlationPenalty;
          portfolioFit.correlationCluster = corrResult.correlationCluster;
          if (corrResult.correlationPenalty > 10) {
            portfolioFit.penalties.push(
              `Correlation cluster "${corrResult.correlationCluster}": ${corrResult.clusterExposureCount} correlated positions`,
            );
          }
          // Re-evaluate decision based on updated fit score
          if (portfolioFit.fitScore < 30) portfolioFit.portfolioDecision = 'rejected';
          else if (portfolioFit.fitScore < 50) portfolioFit.portfolioDecision = 'deferred';
          else if (portfolioFit.fitScore < 70) portfolioFit.portfolioDecision = 'approved_with_penalty';
        }
      }

      // ── Step 9: Phase 3 risk ────────────────────────────────
      const riskBreakdown = computePhase3Risk(best.risk, portfolioFit);

      // ── Step 10: Execution readiness ────────────────────────
      const execution = evaluateExecutionReadiness(
        best.confidence.finalScore, best.confidence.band,
        tradePlan.rrTarget1, portfolioFit, sizing, riskBreakdown, p3Config,
      );
      if      (execution.approvalDecision === 'rejected') engineCounts.executionReadiness.rejected++;
      else if (execution.approvalDecision === 'deferred') engineCounts.executionReadiness.deferred++;
      else                                                 engineCounts.executionReadiness.approved++;

      if (isSellCandidate && execution.approvalDecision !== 'rejected') {
        sellTrace.after_execution_ready++;
      }
      if (isSellCandidate && process.env.DEBUG_SELL_DOWNSTREAM === '1') {
        console.log('[EXECUTION STATE]', {
          symbol,
          status:     execution.status,
          decision:   execution.approvalDecision,
          reason:     execution.reasons[0] ?? null,
        });
      }

      // ── Step 10b: Manipulation check ──────────────────────────
      let manipulationContext: RejectionInput['manipulationContext'] = undefined;
      try {
        const { getManipulationStatusForSymbol } = await import('@/lib/manipulation-engine/api/signalEngineHooks');
        const manipStatus = await getManipulationStatusForSymbol(symbol);
        if (manipStatus.score > 0) {
          if (manipStatus.shouldReject)        engineCounts.manipulationPenalty.rejected++;
          else if (manipStatus.shouldPenalize) engineCounts.manipulationPenalty.penalized++;
          else                                  engineCounts.manipulationPenalty.clean++;
          manipulationContext = {
            score: manipStatus.score,
            band: manipStatus.band,
            shouldPenalize: manipStatus.shouldPenalize,
            shouldReject: manipStatus.shouldReject,
            warning: manipStatus.warning,
          };
          // Apply penalty to confidence. CONTRACT: execution
          // readiness was already computed against the ORIGINAL
          // (pre-penalty) confidence above — the penalty is
          // intentionally additive guidance for the ranking and
          // narrative layers, not a re-gate. The rejection engine
          // below consumes `best.confidence.finalScore` which is
          // the post-penalty number, so low-confidence signals
          // that cross the reject threshold after penalty are
          // still caught there.
          if (manipStatus.shouldPenalize && !manipStatus.shouldReject) {
            const penalty = manipStatus.suggestedPenalty;
            best.confidence = {
              ...best.confidence,
              finalScore: Math.max(0, best.confidence.finalScore - penalty),
            };
          }
        }
      } catch { /* manipulation engine unavailable — continue without penalty */ }

      // ── Step 10c: Canonical rejection engine ──────────────────
      const rejectionInput: RejectionInput = {
        symbol,
        strategy: best.strategy,
        confidenceScore: best.confidence.finalScore,
        riskScore: riskBreakdown.totalRiskScore,
        rewardRisk: tradePlan.rrTarget1,
        entryPrice: tradePlan.entryZoneHigh,
        stopLoss: tradePlan.stopLoss,
        atrPct: features.volatility.atrPct,
        volume: features.volume.volume,
        regime: regime.label,
        sector: getSector(symbol),
        portfolioFit,
        executionReadiness: execution,
        manipulationContext,
      };
      const rejectionDecision: RejectionDecision = runRejectionEngine(rejectionInput);
      if (rejectionDecision.finalDecision === 'rejected') engineCounts.canonicalRejection.rejected++;
      else                                                 engineCounts.canonicalRejection.approved++;

      if (isSellCandidate && rejectionDecision.finalDecision !== 'rejected') {
        sellTrace.after_canonical_reject++;
      }

      // Override execution approval if rejection engine says no
      if (rejectionDecision.finalDecision === 'rejected' && execution.approvalDecision !== 'rejected') {
        execution.approvalDecision = 'rejected';
        execution.status = rejectionDecision.rejectionCode?.includes('manipulation')
          ? 'rejected_due_to_risk' as any
          : 'rejected_due_to_risk' as any;
        execution.reasons = [...execution.reasons, rejectionDecision.rejectionMessage ?? 'Rejection engine'];
      } else if (rejectionDecision.finalDecision === 'deferred' && execution.approvalDecision === 'approved') {
        execution.approvalDecision = 'deferred';
      }

      // ── Step 11: Lifecycle ──────────────────────────────────
      const { state, reason } = resolveInitialState(execution.approvalDecision, execution.status);
      const lifecycle = createLifecycle(state, reason);

      // ── Step 12: Track allocation ───────────────────────────
      if (execution.approvalDecision === 'approved') {
        approved++;
        runPortfolio.openPositions.push({
          symbol, side: direction, sector: getSector(symbol),
          grossValue: sizing.grossPositionValue,
          riskAllocated: sizing.riskBudgetAmount,
        });
        runPortfolio.cashAvailable -= sizing.grossPositionValue;
      } else if (execution.approvalDecision === 'deferred') {
        deferred++;
      } else {
        rejected++;
      }

      // Max approved per run
      if (approved >= p3Config.maxApprovedPerRun && execution.approvalDecision === 'approved') {
        // Don't add more, but still push the signal
      }

      if (isSellCandidate) sellTrace.final_saved++;
      signals.push({
        symbol,
        signalType: best.strategy,
        signalSubtype: SUBTYPE_MAP[best.strategy],
        marketRegime: regime.label,
        confidenceScore: best.confidence.finalScore,
        confidenceBand: best.confidence.band,
        tradePlan,
        positionSizing: sizing,
        portfolioFit,
        executionReadiness: execution,
        riskBreakdown,
        lifecycle,
        // Carry forward for Phase 4 explanation engine
        features,
        confidenceBreakdown: best.confidence,
        standaloneRisk: best.risk,
        reasons: best.reasons,
        warnings: [...best.warnings, ...sizing.warnings, ...portfolioFit.penalties],
        generatedAt: now,
      });
    }  // end for (const best of toBuild)
    } catch (err) {
      rejectionLog.push({ symbol, reason: `Error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // ── Step 13: Rank by execution priority ───────────────────
  signals.sort((a, b) => {
    // Approved first, then deferred, then rejected
    const orderMap = { approved: 0, deferred: 1, rejected: 2 };
    const aOrder = orderMap[a.executionReadiness.approvalDecision] ?? 2;
    const bOrder = orderMap[b.executionReadiness.approvalDecision] ?? 2;
    if (aOrder !== bOrder) return aOrder - bOrder;

    // Within same approval: higher confidence first
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;

    // Then lower risk
    return a.riskBreakdown.totalRiskScore - b.riskBreakdown.totalRiskScore;
  });

  // Assign priority ranks
  signals.forEach((s, i) => { s.executionReadiness.priorityRank = i + 1; });

  console.log(`[Phase3] Complete — ${signals.length} signals: ${approved} approved, ${deferred} deferred, ${rejected} rejected`);

  // Emit one summary span per engine so the trace log shows what
  // each engine saw and produced across the full universe.
  for (const [name, counts] of Object.entries(engineCounts)) {
    const span = tracer.engine(name);
    span.input({ universe: p1Config.universe.length });
    span.end(counts as Record<string, number>);
  }

  phaseSpan.end({
    scanned: p1Config.universe.length,
    signals: signals.length,
    approved,
    deferred,
    rejected,
    regime: regime.label,
  });
  // ── [STRATEGY SUMMARY] — BUY/SELL roll-up at generation layer ─
  // Separate from [SELL DEBUG AGG] (which only counts bearish
  // strategy matches/rejections). This counts actual SIGNAL rows
  // produced per direction after Phase 3 has also run position-
  // sizing + portfolio-fit + execution gates. A mismatch between
  // the two — e.g. [SELL DEBUG AGG].matched = 40 but
  // [STRATEGY SUMMARY].sell_generated = 2 — points the operator
  // straight at the downstream gate eating the SELLs.
  let buyGenerated  = 0;
  let sellGenerated = 0;
  for (const s of signals) {
    if (BEARISH_STRATEGIES.has(s.signalType as any)) sellGenerated++;
    else                                             buyGenerated++;
  }
  // [SELL TRACE] — downstream attrition. The bottleneck is wherever
  // the count drops the most between consecutive stages.
  //
  //   generation → trade_plan : R:R or stop-width too wide
  //   trade_plan → sizing     : zero/invalid position size
  //   sizing     → fit        : portfolio fit score < 30
  //                             (direction imbalance now rebalancing-aware,
  //                              so this should be rare for SELLs unless
  //                              sector/correlation clusters bite)
  //   fit        → exec       : risk score > 75 or deferred by fit
  //   exec       → canonical  : canonical rejection engine (manipulation etc.)
  //   canonical  → saved      : always equal — a row past canonical is saved
  console.log('[SELL TRACE]', sellTrace);

  console.log('[STRATEGY SUMMARY]', {
    scanned:          p1Config.universe.length,
    total_generated:  signals.length,
    buy_generated:    buyGenerated,
    sell_generated:   sellGenerated,
    sell_ratio_pct:   signals.length > 0
      ? Math.round((sellGenerated / signals.length) * 100)
      : 0,
    regime:           regime.label,
    hint:
      sellGenerated === 0  ? 'Zero SELL at generation — see [SELL DEBUG AGG] above for bottleneck.' :
      sellGenerated < 10   ? 'Thin SELL pool — downstream auto-relax will kick in at /api/signals.' :
      'Healthy BUY/SELL mix at generation.',
  });

  // Flush the SELL generation aggregate — one line per scan that
  // tells the operator EXACTLY how many bearish strategy
  // candidates matched vs. were rejected, and which gate killed
  // them.
  flushSellDebugAgg();
  return { regime, signals, scanned: p1Config.universe.length, approved, deferred, rejected, rejectionLog };
}
