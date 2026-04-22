// ════════════════════════════════════════════════════════════════
//  Performance Metrics — Aggregate all metric domains
//
//  Single entry point that computes MFE/MAE, outcomes,
//  expectancy, calibration, and drawdown into a unified result.
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade, SimulatedSignal, EquityPoint, CalibrationBucketResult, BacktestMetric } from '../types';
import { computeMfeMaeStats, type MfeMaeStats } from './mfeMae';
import { computeTradeOutcomeStats, computeSignalOutcomes, type TradeOutcomeStats, type OutcomeDistribution } from './outcomeMetrics';
import { computeExpectancy, type ExpectancyResult } from './expectancyMetrics';
import { computeFullCalibrationMatrix, isModelCalibrated } from './calibrationMetrics';
import { computeDrawdownStats, type DrawdownStats } from './drawdownMetrics';

export interface FullPerformanceReport {
  mfeMae: MfeMaeStats;
  tradeOutcomes: TradeOutcomeStats;
  signalOutcomes: OutcomeDistribution;
  expectancy: ExpectancyResult;
  drawdown: DrawdownStats;
  calibration: CalibrationBucketResult[];
  calibrationSummary: { calibrated: boolean; overconfidentBuckets: string[]; underconfidentBuckets: string[] };
  /** Flat list of all key metrics for DB persistence */
  flatMetrics: BacktestMetric[];
}

/**
 * Compute the full performance report from trades, signals, and equity curve.
 * This is the master analytics function called after a backtest completes.
 */
export function computeFullPerformanceReport(
  trades: SimulatedTrade[],
  signals: SimulatedSignal[],
  equityCurve: EquityPoint[],
): FullPerformanceReport {
  const mfeMae = computeMfeMaeStats(trades);
  const tradeOutcomes = computeTradeOutcomeStats(trades);
  const signalOutcomes = computeSignalOutcomes(signals, trades);
  const expectancy = computeExpectancy(trades);
  const drawdown = computeDrawdownStats(equityCurve);
  const calibration = computeFullCalibrationMatrix(trades);
  const calibrationSummary = isModelCalibrated(calibration.filter(c => c.strategy === 'all' && c.regime === 'all'));

  // Flatten all metrics into a persitable key-value list
  const flatMetrics: BacktestMetric[] = [
    // Return metrics
    m('win_rate', tradeOutcomes.winRate, '%', 'return', 'Win rate'),
    m('profit_factor', expectancy.profitFactor, 'ratio', 'return', 'Profit factor'),
    m('expectancy_pct', expectancy.expectancyPct, '%', 'return', 'Expectancy per trade (%)'),
    m('expectancy_r', expectancy.expectancyR, 'R', 'return', 'Expectancy per trade (R)'),
    m('sqn', expectancy.sqn, 'score', 'return', 'System Quality Number'),
    m('payoff_ratio', expectancy.payoffRatio, 'ratio', 'return', 'Payoff ratio (avg win/avg loss)'),
    m('kelly_criterion', expectancy.kellyCriterion, '%', 'return', 'Kelly criterion optimal fraction'),
    m('avg_gain_pct', tradeOutcomes.avgGainPct, '%', 'return', 'Average gain on winners'),
    m('avg_loss_pct', tradeOutcomes.avgLossPct, '%', 'return', 'Average loss on losers'),

    // Risk metrics
    m('max_drawdown_pct', drawdown.maxDrawdownPct, '%', 'risk', 'Maximum drawdown'),
    m('max_drawdown_duration', drawdown.maxDrawdownDuration, 'bars', 'risk', 'Max drawdown duration'),
    m('avg_drawdown_pct', drawdown.avgDrawdownPct, '%', 'risk', 'Average drawdown'),
    m('longest_underwater', drawdown.longestUnderwaterDays, 'bars', 'risk', 'Longest time underwater'),
    m('consecutive_losses', tradeOutcomes.consecutiveLosses, 'trades', 'risk', 'Max consecutive losses'),
    m('largest_loss_pct', tradeOutcomes.largestLossPct, '%', 'risk', 'Largest single loss'),

    // Excursion metrics
    m('avg_mfe_pct', mfeMae.avgMfePct, '%', 'excursion', 'Average MFE (%)'),
    m('avg_mae_pct', mfeMae.avgMaePct, '%', 'excursion', 'Average MAE (%)'),
    m('median_mfe_pct', mfeMae.medianMfePct, '%', 'excursion', 'Median MFE (%)'),
    m('median_mae_pct', mfeMae.medianMaePct, '%', 'excursion', 'Median MAE (%)'),
    m('edge_ratio', mfeMae.edgeRatio, 'ratio', 'excursion', 'Edge ratio (MFE/MAE)'),
    m('capture_ratio', mfeMae.captureRatio, 'ratio', 'excursion', 'Capture ratio (return/MFE)'),
    m('pain_ratio', mfeMae.painRatio, 'ratio', 'excursion', 'Pain ratio (MAE/loss)'),

    // Target metrics
    m('target1_hit_rate', tradeOutcomes.targetHitRates.target1, '%', 'target', 'Target 1 hit rate'),
    m('target2_hit_rate', tradeOutcomes.targetHitRates.target2, '%', 'target', 'Target 2 hit rate'),
    m('target3_hit_rate', tradeOutcomes.targetHitRates.target3, '%', 'target', 'Target 3 hit rate'),
    m('stop_hit_rate', tradeOutcomes.stopHitRate, '%', 'target', 'Stop loss hit rate'),

    // Efficiency metrics
    m('signal_trigger_rate', signalOutcomes.triggerRate, '%', 'efficiency', 'Signal trigger rate'),
    m('avg_bars_to_entry', tradeOutcomes.avgBarsToEntry, 'bars', 'efficiency', 'Avg bars to entry'),
    m('avg_bars_held', tradeOutcomes.avgBarsHeld, 'bars', 'efficiency', 'Avg holding period'),
    m('edge_per_trade', expectancy.edgePerTradeCurrency, 'INR', 'efficiency', 'Edge per trade (₹)'),
  ];

  return { mfeMae, tradeOutcomes, signalOutcomes, expectancy, drawdown, calibration, calibrationSummary, flatMetrics };
}

function m(key: string, value: number, unit: string, category: BacktestMetric['category'], desc: string): BacktestMetric {
  return { metricKey: key, metricValue: value, metricUnit: unit, category, description: desc };
}
