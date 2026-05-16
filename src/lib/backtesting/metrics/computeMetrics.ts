// ════════════════════════════════════════════════════════════════
//  Backtesting Metrics Engine
//
//  Computes all performance analytics from trade records and
//  equity curve. Metrics match institutional standards:
//  Sharpe, Sortino, Calmar, expectancy, profit factor, MFE/MAE.
// ════════════════════════════════════════════════════════════════

import type {
  SimulatedTrade, EquityPoint, BacktestSummary,
  StrategyBreakdownResult, RegimeBreakdownResult, BacktestRunConfig,
} from '../types';
import type { StrategyName, MarketRegimeLabel } from '../../signal-engine/types/signalEngine.types';

const TRADING_DAYS_PER_YEAR = 252;
const RISK_FREE_RATE = 0.06; // 6% annual (Indian T-bill proxy)

// ── Full Summary ───────────────────────────────────────────

export function computeBacktestSummary(
  trades: SimulatedTrade[],
  equityCurve: EquityPoint[],
  config: BacktestRunConfig,
  totalSignals: number,
): BacktestSummary {
  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');

  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;

  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.returnPct), 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Expectancy
  const avgPnl = totalTrades > 0 ? trades.reduce((s, t) => s + t.netPnl, 0) / totalTrades : 0;
  const avgRiskAmount = totalTrades > 0 ? trades.reduce((s, t) => s + t.riskAmount, 0) / totalTrades : 1;
  const expectancyPct = totalTrades > 0 ? trades.reduce((s, t) => s + t.returnPct, 0) / totalTrades : 0;
  const expectancyR = avgRiskAmount > 0 ? avgPnl / avgRiskAmount * (totalTrades > 0 ? totalTrades : 1) / Math.max(totalTrades, 1) : 0;

  // Equity curve metrics
  const initialEquity = config.initialCapital;
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialEquity;
  const peakEquity = equityCurve.length > 0 ? Math.max(...equityCurve.map(e => e.equity)) : initialEquity;
  const tradingDays = equityCurve.length;

  const totalReturnPct = initialEquity > 0 ? ((finalEquity - initialEquity) / initialEquity) * 100 : 0;
  const years = tradingDays / TRADING_DAYS_PER_YEAR;
  const annualizedReturnPct = years > 0 ? (Math.pow(finalEquity / initialEquity, 1 / years) - 1) * 100 : 0;

  // Drawdown
  const { maxDrawdownPct, maxDrawdownDuration } = computeDrawdown(equityCurve);

  // Risk-adjusted returns
  const { sharpe, sortino } = computeRiskAdjusted(equityCurve);
  const calmarRatio = maxDrawdownPct > 0 ? annualizedReturnPct / maxDrawdownPct : 0;

  // Excursion averages
  const avgMfePct = totalTrades > 0 ? trades.reduce((s, t) => s + t.mfePct, 0) / totalTrades : 0;
  const avgMaePct = totalTrades > 0 ? trades.reduce((s, t) => s + t.maePct, 0) / totalTrades : 0;
  const avgBarsInTrade = totalTrades > 0 ? trades.reduce((s, t) => s + t.barsInTrade, 0) / totalTrades : 0;

  // Target hit rates
  const target1HitRate = totalTrades > 0 ? trades.filter(t => t.target1Hit).length / totalTrades : 0;
  const target2HitRate = totalTrades > 0 ? trades.filter(t => t.target2Hit).length / totalTrades : 0;
  const target3HitRate = totalTrades > 0 ? trades.filter(t => t.target3Hit).length / totalTrades : 0;

  return {
    totalSignalsGenerated: totalSignals,
    totalTradesTaken: totalTrades,
    totalWins: wins.length,
    totalLosses: losses.length,
    winRate: r(winRate),
    avgWinPct: r(avgWinPct),
    avgLossPct: r(avgLossPct),
    profitFactor: r(profitFactor),
    expectancyPct: r(expectancyPct),
    expectancyR: r(expectancyR),
    totalReturnPct: r(totalReturnPct),
    annualizedReturnPct: r(annualizedReturnPct),
    maxDrawdownPct: r(maxDrawdownPct),
    maxDrawdownDuration,
    sharpeRatio: r(sharpe),
    sortinoRatio: r(sortino),
    calmarRatio: r(calmarRatio),
    avgMfePct: r(avgMfePct),
    avgMaePct: r(avgMaePct),
    avgBarsInTrade: r(avgBarsInTrade),
    target1HitRate: r(target1HitRate),
    target2HitRate: r(target2HitRate),
    target3HitRate: r(target3HitRate),
    initialCapital: initialEquity,
    finalEquity: r(finalEquity),
    peakEquity: r(peakEquity),
    tradingDays,
  };
}

// ── Drawdown Calculation ───────────────────────────────────

function computeDrawdown(curve: EquityPoint[]): { maxDrawdownPct: number; maxDrawdownDuration: number } {
  if (curve.length === 0) return { maxDrawdownPct: 0, maxDrawdownDuration: 0 };

  let peak = curve[0].equity;
  let maxDd = 0;
  let maxDdDuration = 0;
  let currentDdStart = 0;

  for (let i = 0; i < curve.length; i++) {
    if (curve[i].equity > peak) {
      peak = curve[i].equity;
      currentDdStart = i;
    }
    const dd = peak > 0 ? ((peak - curve[i].equity) / peak) * 100 : 0;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdDuration = i - currentDdStart;
    }
  }

  return { maxDrawdownPct: maxDd, maxDrawdownDuration: maxDdDuration };
}

// ── Sharpe & Sortino ───────────────────────────────────────

function computeRiskAdjusted(curve: EquityPoint[]): { sharpe: number; sortino: number } {
  if (curve.length < 10) return { sharpe: 0, sortino: 0 };

  const dailyReturns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i - 1].equity > 0) {
      dailyReturns.push((curve[i].equity - curve[i - 1].equity) / curve[i - 1].equity);
    }
  }

  if (dailyReturns.length < 5) return { sharpe: 0, sortino: 0 };

  const avgReturn = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
  const dailyRf = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
  const excessReturn = avgReturn - dailyRf;

  // Sharpe: annualized excess return / annualized volatility
  const variance = dailyReturns.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (excessReturn / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  // Sortino: only uses downside deviation
  const downsideReturns = dailyReturns.filter(r => r < dailyRf);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((s, v) => s + (v - dailyRf) ** 2, 0) / downsideReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? (excessReturn / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  return { sharpe, sortino };
}

// ── Strategy Breakdown ─────────────────────────────────────

export function computeStrategyBreakdown(trades: SimulatedTrade[]): StrategyBreakdownResult[] {
  const grouped = new Map<StrategyName, SimulatedTrade[]>();
  for (const t of trades) {
    const list = grouped.get(t.strategy) ?? [];
    list.push(t);
    grouped.set(t.strategy, list);
  }

  const results: StrategyBreakdownResult[] = [];
  for (const [strategy, stratTrades] of Array.from(grouped.entries())) {
    const wins = stratTrades.filter(t => t.outcome === 'win');
    const losses = stratTrades.filter(t => t.outcome === 'loss');
    const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

    const sorted = [...stratTrades].sort((a, b) => b.returnPct - a.returnPct);

    results.push({
      strategy,
      totalTrades: stratTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: r(stratTrades.length > 0 ? wins.length / stratTrades.length : 0),
      avgReturnPct: r(stratTrades.length > 0 ? stratTrades.reduce((s, t) => s + t.returnPct, 0) / stratTrades.length : 0),
      avgReturnR: r(stratTrades.length > 0 ? stratTrades.reduce((s, t) => s + t.returnR, 0) / stratTrades.length : 0),
      profitFactor: r(grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0),
      avgMfePct: r(stratTrades.length > 0 ? stratTrades.reduce((s, t) => s + t.mfePct, 0) / stratTrades.length : 0),
      avgMaePct: r(stratTrades.length > 0 ? stratTrades.reduce((s, t) => s + t.maePct, 0) / stratTrades.length : 0),
      target1HitRate: r(stratTrades.length > 0 ? stratTrades.filter(t => t.target1Hit).length / stratTrades.length : 0),
      target2HitRate: r(stratTrades.length > 0 ? stratTrades.filter(t => t.target2Hit).length / stratTrades.length : 0),
      bestTrade: sorted.length > 0 ? { symbol: sorted[0].symbol, returnPct: sorted[0].returnPct } : null,
      worstTrade: sorted.length > 0 ? { symbol: sorted[sorted.length - 1].symbol, returnPct: sorted[sorted.length - 1].returnPct } : null,
    });
  }

  return results.sort((a, b) => b.profitFactor - a.profitFactor);
}

// ── Regime Breakdown ───────────────────────────────────────

export function computeRegimeBreakdown(trades: SimulatedTrade[]): RegimeBreakdownResult[] {
  const grouped = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const list = grouped.get(t.regime) ?? [];
    list.push(t);
    grouped.set(t.regime, list);
  }

  const results: RegimeBreakdownResult[] = [];
  for (const [regime, regTrades] of Array.from(grouped.entries())) {
    const wins = regTrades.filter(t => t.outcome === 'win');
    const losses = regTrades.filter(t => t.outcome === 'loss');
    const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

    results.push({
      regime: regime as MarketRegimeLabel,
      totalTrades: regTrades.length,
      winRate: r(regTrades.length > 0 ? wins.length / regTrades.length : 0),
      avgReturnPct: r(regTrades.length > 0 ? regTrades.reduce((s, t) => s + t.returnPct, 0) / regTrades.length : 0),
      profitFactor: r(grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0),
    });
  }

  return results;
}

function r(v: number): number { return Math.round(v * 100) / 100; }
