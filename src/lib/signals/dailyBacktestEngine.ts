// ════════════════════════════════════════════════════════════════
//  dailyBacktestEngine — PHASE_4_BACKTESTING_2026-05
//
//  Backtesting layer that validates signal logic, indicator
//  reliability, thresholds, market-regime behaviour, and
//  missed-opportunity patterns.
//
//  CRITICAL SAFETY RULES:
//   - This module NEVER fabricates candles or outcomes.
//   - This module NEVER alters live thresholds, scoring weights,
//     or approval gates.
//   - Missing historical data is surfaced as INSUFFICIENT_DATA with
//     explicit warnings — never zero-filled.
//   - Threshold simulations are flagged REVIEW_ONLY.
//   - Recommendations are governance-flagged.
//
//  Architecture:
//   - The engine accepts already-fetched data (signal pool +
//     historical candle map). This keeps the engine pure-functional
//     and easy to unit-test; the route layer handles I/O.
//   - The route layer (src/app/api/signals/backtest/route.ts) pulls
//     real data from historicalMarketData.ts and feeds it to this
//     module.
// ════════════════════════════════════════════════════════════════

import {
  getSignalFinalScore,
  getSignalConfidence,
  getSignalRiskReward,
  type RankableSignal,
} from '@/lib/signals/signalRanking';
import type {
  HistoricalCandle,
  HistoricalCandleResult,
  HistoricalSignalRow,
  MarketMover,
} from '@/lib/signals/historicalMarketData';

// ── Public contract ─────────────────────────────────────────────

export type BacktestWindow = 'INTRADAY' | '1D' | '7D' | '30D' | '90D' | 'CUSTOM';
export type BacktestStatus = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'FAILED';
export type SignalOutcome = 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING' | 'PARTIAL_WIN' | 'PARTIAL_LOSS' | 'INSUFFICIENT_DATA';
export type GovernanceFlag = 'REVIEW_ONLY' | 'REVIEW_REQUIRED' | 'DO_NOT_APPLY_AUTOMATICALLY';

export interface BacktestUniverse {
  symbolsTested:              number;
  approvedSignalsTested:      number;
  highPotentialTested:        number;
  watchlistTested:            number;
  rejectedTested:             number;
  simulatedCandidatesTested:  number;
}

export interface BacktestPerformance {
  totalTrades:           number;
  wins:                  number;
  losses:                number;
  neutral:               number;
  pending:               number;
  insufficientData:      number;
  winRate:               number | null;
  avgReturnPercent:      number | null;
  medianReturnPercent:   number | null;
  bestReturnPercent:     number | null;
  worstReturnPercent:    number | null;
  avgMfePercent:         number | null;
  avgMaePercent:         number | null;
  targetHitRate:         number | null;
  stopHitRate:           number | null;
  expectancy:            number | null;
  profitFactor:          number | null;
  maxDrawdownPercent:    number | null;
}

export interface BacktestTierPerformance {
  tier:               'APPROVED' | 'HIGH_POTENTIAL' | 'WATCHLIST' | 'REJECTED';
  total:              number;
  wins:               number;
  losses:             number;
  winRate:            number | null;
  avgReturnPercent:   number | null;
  targetHitRate:      number | null;
  stopHitRate:        number | null;
  notes:              string[];
}

export interface BacktestIndicatorPerformance {
  indicator:        string;
  totalSignals:     number;
  wins:             number;
  losses:           number;
  pending:          number;
  winRate:          number | null;
  avgReturnPercent: number | null;
  bestWindow:       string | null;
  notes:            string[];
}

export interface BacktestIndicatorCombination {
  combination:       string;
  totalSignals:      number;
  wins:              number;
  losses:            number;
  winRate:           number | null;
  avgReturnPercent:  number | null;
  notes:             string[];
}

export interface ThresholdSimulationResult {
  simulationName:           string;
  finalScoreThreshold:      number;
  confidenceThreshold:      number;
  riskRewardThreshold:      number;
  simulatedSignalCount:     number;
  wins:                     number;
  losses:                   number;
  winRate:                  number | null;
  avgReturnPercent:         number | null;
  falsePositiveRate:        number | null;
  notes:                    string[];
  governanceStatus:         GovernanceFlag;
}

export interface MarketRegimeBacktestResult {
  regime:              'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'SIDEWAYS' | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY' | 'GAP_UP' | 'GAP_DOWN' | 'EVENT_DRIVEN' | 'INSUFFICIENT_DATA';
  totalSignals:        number;
  wins:                number;
  losses:              number;
  winRate:             number | null;
  avgReturnPercent:    number | null;
  bestIndicators:      string[];
  weakIndicators:      string[];
  notes:               string[];
}

export interface MissedOpportunityBacktestItem {
  symbol:              string;
  date:                string;
  actualMovePercent:   number | null;
  highestTierReached:  'NONE' | 'WATCHLIST' | 'HIGH_POTENTIAL' | 'REJECTED' | 'APPROVED';
  reasonNotApproved:   string;
  failedConditions:    string[];
  backtestFinding:     string;
  learningPriority:    'LOW' | 'MEDIUM' | 'HIGH';
  suggestedReview:     string;
}

export interface BacktestRecommendation {
  title:               string;
  observation:         string;
  evidence:            string;
  suggestedAction:     string;
  governanceStatus:    GovernanceFlag;
  priority:            'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface BacktestResult {
  backtestId:                 string;
  runDate:                    string;
  generatedAt:                string;
  window:                     BacktestWindow;
  startDate:                  string;
  endDate:                    string;
  status:                     BacktestStatus;
  universe:                   BacktestUniverse;
  performance:                BacktestPerformance;
  tierPerformance: {
    approved:        BacktestTierPerformance;
    highPotential:   BacktestTierPerformance;
    watchlist:       BacktestTierPerformance;
    rejected:        BacktestTierPerformance;
  };
  indicatorPerformance:       BacktestIndicatorPerformance[];
  indicatorCombinations:      BacktestIndicatorCombination[];
  thresholdSimulation:        ThresholdSimulationResult[];
  marketRegimePerformance:    MarketRegimeBacktestResult[];
  missedOpportunityBacktest:  MissedOpportunityBacktestItem[];
  warnings:                   string[];
  recommendations:            BacktestRecommendation[];
  /** PHASE_B_MANIPULATION — comparison shell for the surveillance
   *  filter. Always present so the wire shape is predictable, but the
   *  default status is INSUFFICIENT_DATA because historical manipulation
   *  risk memory (q365_manipulation_symbol_risk) is proposal-only
   *  until Phase B's memory layer is wired up. */
  manipulationBacktest?:      ManipulationBacktestReview;
}

/**
 * Wire shape for the manipulation-filter backtest comparison. When the
 * historical memory table doesn't exist (Phase B has only the SQL
 * proposal so far), the engine returns status='INSUFFICIENT_DATA' with
 * a clear note so the UI can show the user why metrics are missing.
 * No fake win rates or returns are ever produced.
 */
export interface ManipulationBacktestReview {
  status:                  'AVAILABLE' | 'INSUFFICIENT_DATA' | 'NOT_CONFIGURED';
  withFilter:              ManipulationBacktestSlice | null;
  withoutFilter:           ManipulationBacktestSlice | null;
  blockedButPerformed:     number;
  blockedAndFailed:        number;
  warningOnlyCount:        number;
  scoreBucketPerformance:  Array<{
    band:               'LOW' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'SEVERE';
    total:              number;
    winRate:            number | null;
    avgReturnPercent:   number | null;
  }>;
  notes:                   string[];
}

export interface ManipulationBacktestSlice {
  totalSignals:      number;
  winRate:           number | null;
  avgReturnPercent:  number | null;
  maxDrawdownPercent: number | null;
}

export interface BacktestPreview {
  status:                  BacktestStatus;
  window:                  BacktestWindow;
  totalTested:             number;
  winRate:                 number | null;
  approvedWinRate:         number | null;
  highPotentialWinRate:    number | null;
  topIndicator:            string | null;
  weakestIndicator:        string | null;
  dataSufficiency:         'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  warnings:                string[];
}

export interface SignalForBacktest extends RankableSignal {
  /** Optional pre-fetched candle series spanning the backtest window
   *  for this signal's symbol. When undefined, outcome calculation
   *  falls back to entry → currentPrice when both exist on the row,
   *  otherwise INSUFFICIENT_DATA. */
  __candles?: HistoricalCandle[];
  /** Marker so the tier counters can split lists. */
  __tier?: 'APPROVED' | 'HIGH_POTENTIAL' | 'WATCHLIST' | 'REJECTED';
}

export interface SignalOutcomeReview {
  symbol:                   string;
  signalId:                 number | null;
  tier:                     'APPROVED' | 'HIGH_POTENTIAL' | 'WATCHLIST' | 'REJECTED';
  direction:                'BUY' | 'SELL' | string | null;
  generatedAt:              string | null;
  entryPrice:               number | null;
  targetPrice:              number | null;
  stopLoss:                 number | null;
  exitPrice:                number | null;
  reviewWindow:             string | null;
  returnPercent:            number | null;
  maxFavorableMovePercent:  number | null;
  maxAdverseMovePercent:    number | null;
  targetHit:                boolean | null;
  stopLossHit:              boolean | null;
  timeToTargetMinutes:      number | null;
  timeToStopMinutes:        number | null;
  outcome:                  SignalOutcome;
  explanation:              string;
}

// ── Internals ───────────────────────────────────────────────────

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const safePct = (a: number, b: number): number | null => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round((a / b) * 1000) / 10;
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100
    : Math.round(sorted[mid] * 100) / 100;
};

// ── Outcome calculation (per signal) ────────────────────────────

export interface EvaluateOutcomeOptions {
  windowEndIso?:     string;  // hard cap on candles considered (no future leakage)
  reviewWindowLabel: string;
}

export function evaluateSignalOutcome(
  signal: SignalForBacktest,
  options: EvaluateOutcomeOptions,
): SignalOutcomeReview {
  const tier = signal.__tier ?? 'REJECTED';
  const direction = String(signal.direction ?? '').toUpperCase();
  const symbol = String(signal.symbol ?? signal.tradingsymbol ?? '');
  const entry  = numOrNull((signal as any).entry_price);
  const stop   = numOrNull((signal as any).stop_loss);
  const target = numOrNull((signal as any).target1);
  const generatedAt = (signal as any).generated_at != null
    ? new Date((signal as any).generated_at).toISOString() : null;

  // No entry → cannot compute anything meaningful.
  if (entry == null || entry <= 0) {
    return {
      symbol,
      signalId:                 (signal as any).id ?? null,
      tier,
      direction:                direction || null,
      generatedAt,
      entryPrice:               null,
      targetPrice:              target,
      stopLoss:                 stop,
      exitPrice:                null,
      reviewWindow:             options.reviewWindowLabel,
      returnPercent:            null,
      maxFavorableMovePercent:  null,
      maxAdverseMovePercent:    null,
      targetHit:                null,
      stopLossHit:              null,
      timeToTargetMinutes:      null,
      timeToStopMinutes:        null,
      outcome:                  'INSUFFICIENT_DATA',
      explanation:              'Entry price missing — outcome cannot be evaluated.',
    };
  }

  // Candle-driven path — preferred when historical data is loaded.
  const candles = signal.__candles ?? [];
  if (candles.length > 0) {
    const cutoffMs = options.windowEndIso ? new Date(options.windowEndIso).getTime() : null;
    const startMs  = generatedAt ? new Date(generatedAt).getTime() : null;
    let exit:       number | null = null;
    let mfe = 0, mae = 0;
    let targetHit:  boolean | null = null;
    let stopLossHit: boolean | null = null;
    let timeToTargetMinutes: number | null = null;
    let timeToStopMinutes:   number | null = null;
    let evaluated = 0;
    for (const c of candles) {
      const t = new Date(c.ts).getTime();
      if (!Number.isFinite(t)) continue;
      if (startMs != null && t < startMs) continue; // never use pre-signal candles
      if (cutoffMs != null && t > cutoffMs) break;  // no future-data leakage
      evaluated++;
      exit = c.close;
      const movePct = direction === 'SELL'
        ? ((entry - c.low) / entry)  * 100   // best favourable for short
        : ((c.high - entry) / entry) * 100;  // best favourable for long
      const advPct = direction === 'SELL'
        ? ((c.high - entry) / entry) * 100   // worst adverse for short
        : ((entry - c.low)  / entry) * 100;  // worst adverse for long
      if (movePct > mfe) mfe = movePct;
      if (advPct > mae) mae = advPct;

      if (target != null && targetHit !== true) {
        const tg = direction === 'SELL' ? (c.low <= target) : (c.high >= target);
        if (tg) {
          targetHit = true;
          if (startMs != null) timeToTargetMinutes = Math.max(0, Math.round((t - startMs) / 60_000));
        }
      }
      if (stop != null && stopLossHit !== true) {
        const sl = direction === 'SELL' ? (c.high >= stop) : (c.low <= stop);
        if (sl) {
          stopLossHit = true;
          if (startMs != null) timeToStopMinutes = Math.max(0, Math.round((t - startMs) / 60_000));
        }
      }
      if (targetHit === true && stopLossHit !== true) break; // win locked
      if (stopLossHit === true && targetHit !== true) break; // loss locked
    }
    if (evaluated === 0) {
      return {
        symbol,
        signalId:                 (signal as any).id ?? null,
        tier,
        direction:                direction || null,
        generatedAt,
        entryPrice:               entry,
        targetPrice:              target,
        stopLoss:                 stop,
        exitPrice:                null,
        reviewWindow:             options.reviewWindowLabel,
        returnPercent:            null,
        maxFavorableMovePercent:  null,
        maxAdverseMovePercent:    null,
        targetHit:                null,
        stopLossHit:              null,
        timeToTargetMinutes:      null,
        timeToStopMinutes:        null,
        outcome:                  'INSUFFICIENT_DATA',
        explanation:              'No candles within the requested window.',
      };
    }
    const rawRet = exit != null ? ((exit - entry) / entry) * 100 : null;
    const ret    = rawRet != null && direction === 'SELL' ? -rawRet : rawRet;
    let outcome: SignalOutcome;
    let explanation: string;
    if (targetHit === true && stopLossHit !== true) {
      outcome = 'WIN';
      explanation = 'Target reached before stop loss.';
    } else if (stopLossHit === true && targetHit !== true) {
      outcome = 'LOSS';
      explanation = 'Stop loss breached before target.';
    } else if (targetHit === true && stopLossHit === true) {
      outcome = 'LOSS';
      explanation = 'Both target and stop touched within the window; classifying conservatively as LOSS.';
    } else if (ret != null && ret >= 1.5) {
      outcome = 'PARTIAL_WIN';
      explanation = `Move in direction reached ${ret.toFixed(2)}% without touching target.`;
    } else if (ret != null && ret <= -1.5) {
      outcome = 'PARTIAL_LOSS';
      explanation = `Adverse move ${ret.toFixed(2)}% without stop touch.`;
    } else if (ret != null && Math.abs(ret) < 0.5) {
      outcome = 'NEUTRAL';
      explanation = `Net move ${ret.toFixed(2)}% — no decisive direction within window.`;
    } else {
      outcome = 'NEUTRAL';
      explanation = ret != null ? `Net move ${ret.toFixed(2)}%` : 'Net move unavailable.';
    }
    return {
      symbol,
      signalId:                 (signal as any).id ?? null,
      tier,
      direction:                direction || null,
      generatedAt,
      entryPrice:               entry,
      targetPrice:              target,
      stopLoss:                 stop,
      exitPrice:                exit,
      reviewWindow:             options.reviewWindowLabel,
      returnPercent:            ret != null ? Math.round(ret * 100) / 100 : null,
      maxFavorableMovePercent:  Math.round(mfe * 100) / 100,
      maxAdverseMovePercent:    Math.round(mae * 100) / 100,
      targetHit,
      stopLossHit,
      timeToTargetMinutes,
      timeToStopMinutes,
      outcome,
      explanation,
    };
  }

  // No candle data — try live-price fallback (only meaningful for
  // INTRADAY). Real data, never fabricated.
  const live = numOrNull((signal as any).livePrice ?? (signal as any).ltp);
  if (live != null) {
    const rawRet = ((live - entry) / entry) * 100;
    const ret    = direction === 'SELL' ? -rawRet : rawRet;
    let outcome: SignalOutcome;
    let explanation: string;
    if (target != null && stop != null) {
      if (direction === 'BUY' && live >= target) { outcome = 'WIN'; explanation = 'Live price reached target.'; }
      else if (direction === 'BUY' && live <= stop) { outcome = 'LOSS'; explanation = 'Live price hit stop.'; }
      else if (direction === 'SELL' && live <= target) { outcome = 'WIN'; explanation = 'Live price reached target.'; }
      else if (direction === 'SELL' && live >= stop) { outcome = 'LOSS'; explanation = 'Live price hit stop.'; }
      else { outcome = ret >= 1.5 ? 'PARTIAL_WIN' : ret <= -1.5 ? 'PARTIAL_LOSS' : 'NEUTRAL';
             explanation = `Live-price proxy outcome (no candle history). Move ${ret.toFixed(2)}%.`; }
    } else {
      outcome = ret >= 1.5 ? 'PARTIAL_WIN' : ret <= -1.5 ? 'PARTIAL_LOSS' : 'NEUTRAL';
      explanation = `Live-price proxy outcome — target/stop missing. Move ${ret.toFixed(2)}%.`;
    }
    return {
      symbol,
      signalId:                 (signal as any).id ?? null,
      tier,
      direction:                direction || null,
      generatedAt,
      entryPrice:               entry,
      targetPrice:              target,
      stopLoss:                 stop,
      exitPrice:                live,
      reviewWindow:             options.reviewWindowLabel,
      returnPercent:            Math.round(ret * 100) / 100,
      maxFavorableMovePercent:  null,
      maxAdverseMovePercent:    null,
      targetHit:                target != null ? (direction === 'SELL' ? live <= target : live >= target) : null,
      stopLossHit:              stop   != null ? (direction === 'SELL' ? live >= stop   : live <= stop)   : null,
      timeToTargetMinutes:      null,
      timeToStopMinutes:        null,
      outcome,
      explanation,
    };
  }

  return {
    symbol,
    signalId:                 (signal as any).id ?? null,
    tier,
    direction:                direction || null,
    generatedAt,
    entryPrice:               entry,
    targetPrice:              target,
    stopLoss:                 stop,
    exitPrice:                null,
    reviewWindow:             options.reviewWindowLabel,
    returnPercent:            null,
    maxFavorableMovePercent:  null,
    maxAdverseMovePercent:    null,
    targetHit:                null,
    stopLossHit:              null,
    timeToTargetMinutes:      null,
    timeToStopMinutes:        null,
    outcome:                  'INSUFFICIENT_DATA',
    explanation:              'No candle data and no live price available.',
  };
}

// ── Tier-level performance aggregation ──────────────────────────

export function evaluateTierPerformance(
  tier: BacktestTierPerformance['tier'],
  outcomes: SignalOutcomeReview[],
): BacktestTierPerformance {
  const total = outcomes.length;
  let wins = 0, losses = 0, targetHits = 0, stopHits = 0, withReturn = 0;
  let returnSum = 0;
  const notes: string[] = [];
  for (const o of outcomes) {
    if (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') wins++;
    if (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') losses++;
    if (o.targetHit === true) targetHits++;
    if (o.stopLossHit === true) stopHits++;
    if (o.returnPercent != null) {
      returnSum += o.returnPercent;
      withReturn++;
    }
  }
  const resolved = wins + losses;
  if (total > 0 && resolved === 0) {
    notes.push('All rows in this tier are pending or insufficient data — outcome unknown.');
  }
  return {
    tier,
    total,
    wins,
    losses,
    winRate:           resolved > 0 ? safePct(wins, resolved) : null,
    avgReturnPercent:  withReturn > 0 ? Math.round((returnSum / withReturn) * 100) / 100 : null,
    targetHitRate:     total > 0 ? safePct(targetHits, total) : null,
    stopHitRate:       total > 0 ? safePct(stopHits, total)   : null,
    notes,
  };
}

// ── Overall performance summary ─────────────────────────────────

export function aggregatePerformance(outcomes: SignalOutcomeReview[]): BacktestPerformance {
  let wins = 0, losses = 0, neutral = 0, pending = 0, insufficient = 0;
  let targetHits = 0, stopHits = 0;
  const returns: number[] = [];
  let mfeSum = 0, mfeCount = 0, maeSum = 0, maeCount = 0;
  for (const o of outcomes) {
    if (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') wins++;
    else if (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') losses++;
    else if (o.outcome === 'NEUTRAL') neutral++;
    else if (o.outcome === 'PENDING') pending++;
    else if (o.outcome === 'INSUFFICIENT_DATA') insufficient++;
    if (o.targetHit === true) targetHits++;
    if (o.stopLossHit === true) stopHits++;
    if (o.returnPercent != null) returns.push(o.returnPercent);
    if (o.maxFavorableMovePercent != null) { mfeSum += o.maxFavorableMovePercent; mfeCount++; }
    if (o.maxAdverseMovePercent != null)   { maeSum += o.maxAdverseMovePercent;   maeCount++; }
  }
  const total = outcomes.length;
  const resolved = wins + losses;
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const positives = returns.filter((r) => r > 0);
  const negatives = returns.filter((r) => r < 0);
  const grossProfit = positives.reduce((a, b) => a + b, 0);
  const grossLoss   = Math.abs(negatives.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? null : 0);
  // Expectancy: (avgWin * winRate) - (avgLoss * lossRate)
  const wr = resolved > 0 ? wins / resolved : 0;
  const lr = resolved > 0 ? losses / resolved : 0;
  const avgWin = positives.length > 0 ? positives.reduce((a, b) => a + b, 0) / positives.length : 0;
  const avgLoss = negatives.length > 0 ? Math.abs(negatives.reduce((a, b) => a + b, 0) / negatives.length) : 0;
  const expectancy = resolved > 0 ? Math.round(((wr * avgWin) - (lr * avgLoss)) * 100) / 100 : null;
  // Max drawdown (equity curve from sequential returns).
  let equity = 0, peak = 0, dd = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const draw = peak - equity;
    if (draw > dd) dd = draw;
  }
  return {
    totalTrades:           total,
    wins,
    losses,
    neutral,
    pending,
    insufficientData:      insufficient,
    winRate:               resolved > 0 ? safePct(wins, resolved) : null,
    avgReturnPercent:      avgReturn != null ? Math.round(avgReturn * 100) / 100 : null,
    medianReturnPercent:   median(returns),
    bestReturnPercent:     returns.length > 0 ? Math.max(...returns) : null,
    worstReturnPercent:    returns.length > 0 ? Math.min(...returns) : null,
    avgMfePercent:         mfeCount > 0 ? Math.round((mfeSum / mfeCount) * 100) / 100 : null,
    avgMaePercent:         maeCount > 0 ? Math.round((maeSum / maeCount) * 100) / 100 : null,
    targetHitRate:         total > 0 ? safePct(targetHits, total) : null,
    stopHitRate:           total > 0 ? safePct(stopHits, total)   : null,
    expectancy,
    profitFactor,
    maxDrawdownPercent:    returns.length > 0 ? Math.round(dd * 100) / 100 : null,
  };
}

// ── Indicator backtest ──────────────────────────────────────────

const FACTOR_LABELS: Record<string, string> = {
  trend_alignment:     'Trend Alignment',
  momentum:            'Momentum',
  volume_confirmation: 'Volume Confirmation',
  strategy_quality:    'Strategy Quality',
  market_regime:       'Market Regime',
  liquidity:           'Liquidity',
  portfolio_fit:       'Portfolio Fit',
  risk_reward:         'Risk-Reward Factor',
};
const STRONG_FLOOR = 70;

const readFactor = (s: any, k: string): number | null => {
  const fs = s?.factor_scores;
  if (fs && typeof fs === 'object') {
    const raw = (fs as any)[k];
    if (raw != null) {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  // Flattened columns the elite gate populates.
  if (k === 'portfolio_fit')    return numOrNull(s?.portfolio_fit_score);
  if (k === 'liquidity')        return numOrNull(s?.liquidity_score);
  if (k === 'market_regime')    return numOrNull(s?.market_regime_score);
  return null;
};

export function evaluateIndicatorBacktest(
  signals: SignalForBacktest[],
  outcomes: Map<string, SignalOutcomeReview>,
): BacktestIndicatorPerformance[] {
  const out: BacktestIndicatorPerformance[] = [];
  for (const [key, label] of Object.entries(FACTOR_LABELS)) {
    let total = 0, wins = 0, losses = 0, pending = 0;
    let retSum = 0, retCount = 0;
    for (const s of signals) {
      const v = readFactor(s, key);
      if (v == null || v < STRONG_FLOOR) continue;
      total++;
      const key2 = String(s.symbol ?? s.tradingsymbol ?? '');
      const o = outcomes.get(key2);
      if (!o) { pending++; continue; }
      if (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') wins++;
      else if (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') losses++;
      else pending++;
      if (o.returnPercent != null) { retSum += o.returnPercent; retCount++; }
    }
    if (total === 0) continue;
    const resolved = wins + losses;
    out.push({
      indicator:        label,
      totalSignals:     total,
      wins,
      losses,
      pending,
      winRate:          resolved > 0 ? safePct(wins, resolved) : null,
      avgReturnPercent: retCount > 0 ? Math.round((retSum / retCount) * 100) / 100 : null,
      bestWindow:       null, // multi-window analysis is Phase 4B
      notes:            resolved > 0
        ? [`Strong ${label} signals were ${safePct(wins, resolved)}% in-direction.`]
        : ['Outcome data unavailable for this indicator on the backtest window.'],
    });
  }
  return out.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
}

export function evaluateIndicatorCombinationBacktest(
  signals: SignalForBacktest[],
  outcomes: Map<string, SignalOutcomeReview>,
): BacktestIndicatorCombination[] {
  const combos: Array<{ label: string; keys: string[] }> = [
    { label: 'Trend + Momentum',        keys: ['trend_alignment', 'momentum'] },
    { label: 'Trend + Volume',          keys: ['trend_alignment', 'volume_confirmation'] },
    { label: 'Momentum + Volume',       keys: ['momentum',        'volume_confirmation'] },
    { label: 'Trend + Regime',          keys: ['trend_alignment', 'market_regime'] },
    { label: 'Momentum + Regime + Vol', keys: ['momentum', 'market_regime', 'volume_confirmation'] },
  ];
  const out: BacktestIndicatorCombination[] = [];
  for (const c of combos) {
    let total = 0, wins = 0, losses = 0, retSum = 0, retCount = 0;
    for (const s of signals) {
      const allStrong = c.keys.every((k) => (readFactor(s, k) ?? 0) >= STRONG_FLOOR);
      if (!allStrong) continue;
      total++;
      const sym = String(s.symbol ?? s.tradingsymbol ?? '');
      const o = outcomes.get(sym);
      if (!o) continue;
      if (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') wins++;
      else if (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') losses++;
      if (o.returnPercent != null) { retSum += o.returnPercent; retCount++; }
    }
    if (total === 0) continue;
    const resolved = wins + losses;
    out.push({
      combination:      c.label,
      totalSignals:     total,
      wins,
      losses,
      winRate:          resolved > 0 ? safePct(wins, resolved) : null,
      avgReturnPercent: retCount > 0 ? Math.round((retSum / retCount) * 100) / 100 : null,
      notes:            resolved > 0
        ? [`${c.label} combo resolved ${safePct(wins, resolved)}% wins.`]
        : ['Outcome data unavailable for this combination.'],
    });
  }
  return out.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
}

// ── Threshold simulation ───────────────────────────────────────

export function runThresholdSimulation(
  signals: SignalForBacktest[],
  outcomes: Map<string, SignalOutcomeReview>,
): ThresholdSimulationResult[] {
  // Conservative grid — never goes BELOW the live elite floors so the
  // simulation explores quality rather than relaxation.
  const grid: Array<{ fs: number; cs: number; rr: number }> = [
    { fs: 70, cs: 65, rr: 1.5 },
    { fs: 75, cs: 70, rr: 1.8 },
    { fs: 80, cs: 75, rr: 2.0 },
    { fs: 85, cs: 80, rr: 2.5 },
  ];
  const out: ThresholdSimulationResult[] = [];
  for (const g of grid) {
    let simulatedCount = 0, wins = 0, losses = 0, retSum = 0, retCount = 0;
    let falsePositive = 0;
    for (const s of signals) {
      const fs = getSignalFinalScore(s);
      const cs = getSignalConfidence(s);
      const rr = getSignalRiskReward(s);
      if (fs < g.fs || cs < g.cs || rr < g.rr) continue;
      simulatedCount++;
      const sym = String(s.symbol ?? s.tradingsymbol ?? '');
      const o = outcomes.get(sym);
      if (!o) continue;
      if (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') wins++;
      else if (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') losses++;
      if (o.outcome === 'LOSS') falsePositive++;
      if (o.returnPercent != null) { retSum += o.returnPercent; retCount++; }
    }
    const resolved = wins + losses;
    const winRate  = resolved > 0 ? safePct(wins, resolved) : null;
    const fpRate   = resolved > 0 ? safePct(falsePositive, resolved) : null;
    const avgRet   = retCount > 0 ? Math.round((retSum / retCount) * 100) / 100 : null;
    const notes: string[] = [];
    if (simulatedCount === 0) notes.push('No signal in the universe met this hypothetical bar.');
    else if (resolved === 0)  notes.push('Hypothesis admitted signals but no outcomes are available.');
    else if (winRate != null && winRate >= 60) notes.push('Hypothetical threshold maintained strong outcome rate.');
    else if (winRate != null) notes.push('Hypothetical threshold underperformed institutional target.');
    out.push({
      simulationName:        `Final ≥ ${g.fs}, Confidence ≥ ${g.cs}, RR ≥ ${g.rr}`,
      finalScoreThreshold:   g.fs,
      confidenceThreshold:   g.cs,
      riskRewardThreshold:   g.rr,
      simulatedSignalCount:  simulatedCount,
      wins,
      losses,
      winRate,
      avgReturnPercent:      avgRet,
      falsePositiveRate:     fpRate,
      notes,
      governanceStatus:      'REVIEW_ONLY',
    });
  }
  return out;
}

// ── Market regime backtest ─────────────────────────────────────

export function evaluateMarketRegimeBacktest(
  signals: SignalForBacktest[],
  outcomes: Map<string, SignalOutcomeReview>,
): MarketRegimeBacktestResult[] {
  const buckets = new Map<string, { signals: SignalForBacktest[]; wins: number; losses: number; retSum: number; retCount: number }>();
  for (const s of signals) {
    const regimeScore = readFactor(s, 'market_regime');
    const regime: string =
      regimeScore == null ? 'INSUFFICIENT_DATA'
      : regimeScore >= 75 ? 'TRENDING_BULLISH'
      : regimeScore >= 60 ? 'SIDEWAYS'
      : regimeScore >= 45 ? 'HIGH_VOLATILITY'
      :                     'TRENDING_BEARISH';
    const b = buckets.get(regime) ?? { signals: [], wins: 0, losses: 0, retSum: 0, retCount: 0 };
    b.signals.push(s);
    const sym = String(s.symbol ?? s.tradingsymbol ?? '');
    const o = outcomes.get(sym);
    if (o) {
      if (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') b.wins++;
      else if (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') b.losses++;
      if (o.returnPercent != null) { b.retSum += o.returnPercent; b.retCount++; }
    }
    buckets.set(regime, b);
  }
  const out: MarketRegimeBacktestResult[] = [];
  for (const [regime, b] of buckets) {
    const resolved = b.wins + b.losses;
    // Best/weak indicators per regime — count factor strength among
    // winners.
    const winIndicators = new Map<string, number>();
    const lossIndicators = new Map<string, number>();
    for (const s of b.signals) {
      const sym = String(s.symbol ?? s.tradingsymbol ?? '');
      const o = outcomes.get(sym);
      if (!o) continue;
      const factors = Object.keys(FACTOR_LABELS).filter((k) => (readFactor(s, k) ?? 0) >= STRONG_FLOOR);
      const tally = (o.outcome === 'WIN' || o.outcome === 'PARTIAL_WIN') ? winIndicators
                  : (o.outcome === 'LOSS' || o.outcome === 'PARTIAL_LOSS') ? lossIndicators : null;
      if (tally) for (const f of factors) tally.set(f, (tally.get(f) ?? 0) + 1);
    }
    const top = (m: Map<string, number>): string[] => Array.from(m.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => FACTOR_LABELS[k] ?? k);
    out.push({
      regime:           regime as MarketRegimeBacktestResult['regime'],
      totalSignals:     b.signals.length,
      wins:             b.wins,
      losses:           b.losses,
      winRate:          resolved > 0 ? safePct(b.wins, resolved) : null,
      avgReturnPercent: b.retCount > 0 ? Math.round((b.retSum / b.retCount) * 100) / 100 : null,
      bestIndicators:   top(winIndicators),
      weakIndicators:   top(lossIndicators),
      notes:            resolved > 0
        ? [`${b.wins}/${resolved} resolved as wins in ${regime}.`]
        : ['Insufficient outcome data for this regime.'],
    });
  }
  return out;
}

// ── Missed opportunity backtest ────────────────────────────────

export function evaluateMissedOpportunityBacktest(
  marketMovers: MarketMover[],
  signals: SignalForBacktest[],
  outcomes: Map<string, SignalOutcomeReview>,
  date: string,
): MissedOpportunityBacktestItem[] {
  if (!marketMovers || marketMovers.length === 0) return [];
  const indexBy = (rows: SignalForBacktest[]): Map<string, SignalForBacktest> => {
    const m = new Map<string, SignalForBacktest>();
    for (const r of rows) {
      const k = String(r.symbol ?? r.tradingsymbol ?? '').toUpperCase();
      if (k) m.set(k, r);
    }
    return m;
  };
  const ix = indexBy(signals);
  const items: MissedOpportunityBacktestItem[] = [];
  for (const mv of marketMovers) {
    const sym = mv.symbol.toUpperCase();
    const candidate = ix.get(sym);
    const tier: MissedOpportunityBacktestItem['highestTierReached'] =
      candidate?.__tier === 'APPROVED'        ? 'APPROVED'
      : candidate?.__tier === 'HIGH_POTENTIAL' ? 'HIGH_POTENTIAL'
      : candidate?.__tier === 'WATCHLIST'      ? 'WATCHLIST'
      : candidate?.__tier === 'REJECTED'       ? 'REJECTED'
      :                                          'NONE';
    if (tier === 'APPROVED') continue; // not missed if approved
    const failedConditions: string[] = [];
    let reasonNotApproved = 'No candidate generated for this symbol.';
    if (candidate) {
      const fs = getSignalFinalScore(candidate);
      const cs = getSignalConfidence(candidate);
      const rr = getSignalRiskReward(candidate);
      if (fs < 80) failedConditions.push(`final ${fs.toFixed(1)} < 80`);
      if (cs < 75) failedConditions.push(`confidence ${cs.toFixed(1)} < 75`);
      if (rr < 2.0) failedConditions.push(`RR ${rr.toFixed(2)} < 2.0`);
      reasonNotApproved = failedConditions.length > 0
        ? `Reached ${tier} but blocked by: ${failedConditions.join(', ')}`
        : `Reached ${tier} but did not clear the strict gate.`;
    }
    const sigOutcome = outcomes.get(sym);
    const finding = sigOutcome
      ? `Backtest showed ${sigOutcome.outcome} (return ${sigOutcome.returnPercent ?? 'N/A'}%).`
      : 'No outcome data available.';
    items.push({
      symbol:            sym,
      date,
      actualMovePercent: mv.movePercent,
      highestTierReached: tier,
      reasonNotApproved,
      failedConditions,
      backtestFinding:   finding,
      learningPriority:  Math.abs(mv.movePercent) >= 5 ? 'HIGH' : Math.abs(mv.movePercent) >= 2 ? 'MEDIUM' : 'LOW',
      suggestedReview:   'Analyst review required before any threshold change.',
    });
  }
  return items.slice(0, 25);
}

// ── Recommendations ────────────────────────────────────────────

export function buildBacktestRecommendations(
  result: Omit<BacktestResult, 'recommendations' | 'warnings' | 'backtestId' | 'runDate' | 'generatedAt' | 'window' | 'startDate' | 'endDate' | 'status' | 'universe' | 'missedOpportunityBacktest'>
        & { warnings: string[]; missedOpportunityBacktest: MissedOpportunityBacktestItem[] },
): BacktestRecommendation[] {
  const recs: BacktestRecommendation[] = [];

  // Tier comparison — HP beating approved is a governance flag.
  const ap = result.tierPerformance.approved;
  const hp = result.tierPerformance.highPotential;
  if (ap.winRate != null && hp.winRate != null && hp.winRate > ap.winRate + 5) {
    recs.push({
      title:            'High-potential candidates outperformed approved signals',
      observation:      `HP win-rate ${hp.winRate}% vs approved ${ap.winRate}%.`,
      evidence:         `${hp.wins}/${hp.wins + hp.losses} HP resolved as wins; ${ap.wins}/${ap.wins + ap.losses} approved resolved.`,
      suggestedAction:  'Review the strict-gate calibration for HP candidates. Do NOT auto-relax thresholds.',
      governanceStatus: 'REVIEW_REQUIRED',
      priority:         'HIGH',
    });
  }

  // Indicator recommendations.
  for (const ind of result.indicatorPerformance.slice(0, 3)) {
    if (ind.winRate != null && ind.winRate >= 65 && ind.totalSignals >= 5) {
      recs.push({
        title:            `Review weight of ${ind.indicator}`,
        observation:      `${ind.indicator} resolved ${ind.winRate}% wins on ${ind.totalSignals} signals.`,
        evidence:         `Average return ${ind.avgReturnPercent ?? 'N/A'}%.`,
        suggestedAction:  'Analyst review required before raising scoring weight.',
        governanceStatus: 'REVIEW_REQUIRED',
        priority:         ind.winRate >= 75 ? 'HIGH' : 'MEDIUM',
      });
    }
  }
  for (const ind of result.indicatorPerformance.slice(-2)) {
    if (ind.winRate != null && ind.winRate < 35 && ind.totalSignals >= 5) {
      recs.push({
        title:            `Investigate ${ind.indicator} underperformance`,
        observation:      `${ind.indicator} resolved only ${ind.winRate}% wins on ${ind.totalSignals} signals.`,
        evidence:         `Average return ${ind.avgReturnPercent ?? 'N/A'}%.`,
        suggestedAction:  'Audit indicator computation and input data. Do not auto-tune weights.',
        governanceStatus: 'DO_NOT_APPLY_AUTOMATICALLY',
        priority:         'HIGH',
      });
    }
  }

  // Threshold simulation winner — surface as REVIEW_ONLY.
  const best = [...result.thresholdSimulation].sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))[0];
  if (best && best.winRate != null && best.simulatedSignalCount >= 5) {
    recs.push({
      title:            `Threshold simulation winner: ${best.simulationName}`,
      observation:      `Hypothetical bar produced ${best.winRate}% win-rate on ${best.simulatedSignalCount} signals.`,
      evidence:         `Average return ${best.avgReturnPercent ?? 'N/A'}%; false-positive rate ${best.falsePositiveRate ?? 'N/A'}%.`,
      suggestedAction:  'Simulation only — DO NOT apply to live approval policy without analyst review.',
      governanceStatus: 'REVIEW_ONLY',
      priority:         'MEDIUM',
    });
  }

  // Missed opportunities — single HIGH-priority entry.
  const highPriorityMissed = result.missedOpportunityBacktest.filter((m) => m.learningPriority === 'HIGH');
  if (highPriorityMissed.length > 0) {
    recs.push({
      title:            'High-impact missed opportunities detected',
      observation:      `${highPriorityMissed.length} symbol(s) moved sharply without being approved.`,
      evidence:         highPriorityMissed.slice(0, 3).map((m) => `${m.symbol}: ${m.actualMovePercent}% (${m.highestTierReached})`).join('; '),
      suggestedAction:  'Sample each case; do not change rules without analyst approval.',
      governanceStatus: 'REVIEW_REQUIRED',
      priority:         'HIGH',
    });
  }

  if (recs.length === 0) {
    recs.push({
      title:            'No backtest recommendations',
      observation:      'No observed pattern crossed the recommendation threshold.',
      evidence:         'Insufficient outcomes or balanced performance across tiers.',
      suggestedAction:  'Continue monitoring.',
      governanceStatus: 'REVIEW_ONLY',
      priority:         'LOW',
    });
  }
  return recs;
}

// ── Preview ────────────────────────────────────────────────────

export function buildBacktestPreview(result: BacktestResult): BacktestPreview {
  return {
    status:                  result.status,
    window:                  result.window,
    totalTested:             result.universe.symbolsTested,
    winRate:                 result.performance.winRate,
    approvedWinRate:         result.tierPerformance.approved.winRate,
    highPotentialWinRate:    result.tierPerformance.highPotential.winRate,
    topIndicator:            result.indicatorPerformance[0]?.indicator ?? null,
    weakestIndicator:        result.indicatorPerformance[result.indicatorPerformance.length - 1]?.indicator ?? null,
    dataSufficiency:         result.status === 'COMPLETE' ? 'COMPLETE'
                            : result.status === 'PARTIAL'  ? 'PARTIAL'
                            : 'INSUFFICIENT_DATA',
    warnings:                result.warnings.slice(0, 5),
  };
}

// ── Master orchestrator ────────────────────────────────────────

export interface RunBacktestInput {
  window:        BacktestWindow;
  startDate:     string;
  endDate:       string;
  signals: {
    approved:       SignalForBacktest[];
    highPotential:  SignalForBacktest[];
    watchlist:      SignalForBacktest[];
    rejected:       SignalForBacktest[];
  };
  candleSeriesBySymbol?: Map<string, HistoricalCandle[]>;
  marketMovers?:        MarketMover[];
  warnings?:            string[];
}

export function runDailyBacktest(input: RunBacktestInput): BacktestResult {
  const warnings: string[] = [...(input.warnings ?? [])];
  const stamp = (s: SignalForBacktest, tier: BacktestTierPerformance['tier']): SignalForBacktest => {
    const sym = String(s.symbol ?? s.tradingsymbol ?? '');
    return {
      ...s,
      __tier:    tier,
      __candles: input.candleSeriesBySymbol?.get(sym),
    };
  };

  const ap  = input.signals.approved.map((s)      => stamp(s, 'APPROVED'));
  const hp  = input.signals.highPotential.map((s) => stamp(s, 'HIGH_POTENTIAL'));
  const wl  = input.signals.watchlist.map((s)     => stamp(s, 'WATCHLIST'));
  const rj  = input.signals.rejected.map((s)      => stamp(s, 'REJECTED'));
  const allSignals = [...ap, ...hp, ...wl, ...rj];

  // Evaluate every signal exactly once.
  const reviewWindowLabel = input.window;
  const outcomes: SignalOutcomeReview[] = [];
  const outcomesIdx = new Map<string, SignalOutcomeReview>();
  for (const s of allSignals) {
    const r = evaluateSignalOutcome(s, {
      windowEndIso:     `${input.endDate}T23:59:59Z`,
      reviewWindowLabel,
    });
    outcomes.push(r);
    if (r.symbol) outcomesIdx.set(r.symbol.toUpperCase(), r);
  }

  // Split outcomes by tier for per-tier aggregation.
  const byTier: Record<BacktestTierPerformance['tier'], SignalOutcomeReview[]> = {
    APPROVED: [], HIGH_POTENTIAL: [], WATCHLIST: [], REJECTED: [],
  };
  for (const o of outcomes) byTier[o.tier].push(o);

  const universe: BacktestUniverse = {
    symbolsTested:              new Set(allSignals.map((s) => s.symbol ?? s.tradingsymbol ?? '').filter(Boolean)).size,
    approvedSignalsTested:      ap.length,
    highPotentialTested:        hp.length,
    watchlistTested:            wl.length,
    rejectedTested:             rj.length,
    simulatedCandidatesTested:  0,
  };

  const performance         = aggregatePerformance(outcomes);
  const tierPerformance = {
    approved:       evaluateTierPerformance('APPROVED',        byTier.APPROVED),
    highPotential:  evaluateTierPerformance('HIGH_POTENTIAL',  byTier.HIGH_POTENTIAL),
    watchlist:      evaluateTierPerformance('WATCHLIST',       byTier.WATCHLIST),
    rejected:       evaluateTierPerformance('REJECTED',        byTier.REJECTED),
  };
  const indicatorPerformance  = evaluateIndicatorBacktest(allSignals, outcomesIdx);
  const indicatorCombinations = evaluateIndicatorCombinationBacktest(allSignals, outcomesIdx);
  const thresholdSimulation   = runThresholdSimulation(allSignals, outcomesIdx);
  const marketRegimePerformance = evaluateMarketRegimeBacktest(allSignals, outcomesIdx);
  const missedOpportunityBacktest = evaluateMissedOpportunityBacktest(
    input.marketMovers ?? [], allSignals, outcomesIdx, input.endDate,
  );
  if ((input.marketMovers ?? []).length === 0) {
    warnings.push('Market movers dataset not configured — missed-opportunity backtest is empty.');
  }

  // Status — COMPLETE only when most candidates produced an outcome.
  const insufficientCount = outcomes.filter((o) => o.outcome === 'INSUFFICIENT_DATA').length;
  const total             = outcomes.length;
  let status: BacktestStatus;
  if (total === 0)                                      status = 'INSUFFICIENT_DATA';
  else if (insufficientCount === total)                  status = 'INSUFFICIENT_DATA';
  else if (insufficientCount / total > 0.6)              status = 'PARTIAL';
  else                                                   status = 'COMPLETE';

  if (status === 'INSUFFICIENT_DATA') {
    warnings.push('Backtest could not compute outcomes for any signal in this window.');
  } else if (status === 'PARTIAL') {
    warnings.push(`Backtest outcomes available for ${total - insufficientCount}/${total} signals only.`);
  }

  const partial: Parameters<typeof buildBacktestRecommendations>[0] = {
    performance,
    tierPerformance,
    indicatorPerformance,
    indicatorCombinations,
    thresholdSimulation,
    marketRegimePerformance,
    missedOpportunityBacktest,
    warnings,
  };
  const recommendations = buildBacktestRecommendations(partial);

  const generatedAt = new Date().toISOString();
  // PHASE_B_MANIPULATION — surveillance filter comparison shell. The
  // historical risk memory table (q365_manipulation_symbol_risk) is
  // still proposal-only, so until the daily worker is wired we return
  // INSUFFICIENT_DATA with an explicit note. No fake metrics.
  const manipulationBacktest: ManipulationBacktestReview = {
    status:                  'INSUFFICIENT_DATA',
    withFilter:              null,
    withoutFilter:           null,
    blockedButPerformed:     0,
    blockedAndFailed:        0,
    warningOnlyCount:        0,
    scoreBucketPerformance:  [],
    notes:                   [
      'Manipulation backtest unavailable — historical manipulation risk memory not configured.',
      'See src/lib/manipulation-engine/repository/migrations/009_manipulation_symbol_risk.sql.proposal.',
    ],
  };

  return {
    backtestId:                 `bt-${Date.now()}-${input.window}`,
    runDate:                    new Date().toISOString().slice(0, 10),
    generatedAt,
    window:                     input.window,
    startDate:                  input.startDate,
    endDate:                    input.endDate,
    status,
    universe,
    performance,
    tierPerformance,
    indicatorPerformance,
    indicatorCombinations,
    thresholdSimulation,
    marketRegimePerformance,
    missedOpportunityBacktest,
    warnings,
    recommendations,
    manipulationBacktest,
  };
}

/** Rolling backtest is a thin wrapper around runDailyBacktest with
 *  the right startDate/endDate scoped by the caller. */
export function runRollingBacktest(input: RunBacktestInput): BacktestResult {
  return runDailyBacktest(input);
}

// ── Daily-report preview shape exposed for Phase 3 integration ──

export interface DailyReportBacktestPreview extends BacktestPreview {
  // Kept identical to BacktestPreview today; aliased so the daily
  // report builder can reference a stable name.
}
