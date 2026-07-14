// ════════════════════════════════════════════════════════════════
//  Phase 7 — Robustness stress suite (offline on trade sets)
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade, StrategyName, MarketRegimeLabel } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export const ROBUSTNESS_SUITE_VERSION = '7.0.0';

export interface RobustnessStressResult {
  name: string;
  n: number;
  expectancyR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  winRate: number;
  passed: boolean;
  note: string;
}

export interface RobustnessReport {
  modelVersion: string;
  strategy?: StrategyName | null;
  stresses: RobustnessStressResult[];
  regimeSlices: RobustnessStressResult[];
  sectorSlices: RobustnessStressResult[];
  yearSlices: RobustnessStressResult[];
  directionSlices: RobustnessStressResult[];
  bootstrapCi: {
    expectancyR_p05: number;
    expectancyR_p50: number;
    expectancyR_p95: number;
    nBootstrap: number;
  };
  monteCarloMaxDd: {
    p50: number;
    p95: number;
    nShuffles: number;
  };
  overallPass: boolean;
  generatedAt: string;
}

function summarize(name: string, trades: SimulatedTrade[], floorExp = -0.05): RobustnessStressResult {
  if (trades.length === 0) {
    return {
      name, n: 0, expectancyR: 0, profitFactor: 0, maxDrawdownPct: 0, winRate: 0,
      passed: false, note: 'No trades in slice',
    };
  }
  const exp = computeExpectancy(trades);
  const maxDd = estimatePathDrawdown(trades);
  const wr = trades.filter((t) => t.outcome === 'win').length / trades.length;
  const passed = exp.expectancyR >= floorExp && Number.isFinite(exp.profitFactor);
  return {
    name,
    n: trades.length,
    expectancyR: exp.expectancyR,
    profitFactor: Number.isFinite(exp.profitFactor) ? exp.profitFactor : 0,
    maxDrawdownPct: maxDd,
    winRate: Math.round(wr * 1000) / 1000,
    passed,
    note: passed ? 'ok' : 'edge degraded',
  };
}

function estimatePathDrawdown(trades: SimulatedTrade[]): number {
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    eq += t.returnPct;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return Math.round(maxDd * 100) / 100;
}

/** Extra slippage: shrink returns by bps estimate. */
export function stressSlippage(trades: SimulatedTrade[], extraBps: number): SimulatedTrade[] {
  const haircut = extraBps / 10000 * 100; // to pct points approx per side*2
  return trades.map((t) => ({
    ...t,
    returnPct: t.returnPct - haircut,
    returnR: t.returnR - haircut / Math.max(0.5, Math.abs(t.returnPct / Math.max(0.01, Math.abs(t.returnR)))),
    netPnl: t.netPnl * (1 - extraBps / 10000),
    outcome: t.returnPct - haircut > 0 ? 'win' as const : t.returnPct - haircut < 0 ? 'loss' as const : t.outcome,
  }));
}

/** Entry delay: drop first N wins bias by shifting returnR down mildly. */
export function stressEntryDelay(trades: SimulatedTrade[], delayBars: number): SimulatedTrade[] {
  const pen = 0.05 * delayBars;
  return trades.map((t) => ({
    ...t,
    barsToEntry: t.barsToEntry + delayBars,
    returnR: t.returnR - pen,
    returnPct: t.returnPct - pen,
  }));
}

/** Missing signal/data: randomly drop fraction of trades (seeded). */
export function stressMissingData(trades: SimulatedTrade[], dropFrac: number, seed = 42): SimulatedTrade[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  return trades.filter(() => rand() > dropFrac);
}

/** Parameter perturbation: keep only trades above raised confidence. */
export function stressParameterPerturbation(
  trades: SimulatedTrade[],
  confDelta: number,
): SimulatedTrade[] {
  return trades.filter((t) => t.confidenceScore >= 55 + confDelta);
}

function bootstrapExpectancy(trades: SimulatedTrade[], nBoot = 200, seed = 7): RobustnessReport['bootstrapCi'] {
  if (trades.length === 0) {
    return { expectancyR_p05: 0, expectancyR_p50: 0, expectancyR_p95: 0, nBootstrap: 0 };
  }
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const samples: number[] = [];
  for (let b = 0; b < nBoot; b++) {
    const draw: SimulatedTrade[] = [];
    for (let i = 0; i < trades.length; i++) {
      draw.push(trades[Math.floor(rand() * trades.length)]);
    }
    samples.push(computeExpectancy(draw).expectancyR);
  }
  samples.sort((a, b) => a - b);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return {
    expectancyR_p05: Math.round(q(0.05) * 1000) / 1000,
    expectancyR_p50: Math.round(q(0.5) * 1000) / 1000,
    expectancyR_p95: Math.round(q(0.95) * 1000) / 1000,
    nBootstrap: nBoot,
  };
}

function monteCarloDrawdown(trades: SimulatedTrade[], nShuffles = 100, seed = 11): RobustnessReport['monteCarloMaxDd'] {
  if (trades.length === 0) return { p50: 0, p95: 0, nShuffles: 0 };
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const dds: number[] = [];
  for (let k = 0; k < nShuffles; k++) {
    const arr = [...trades];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    dds.push(estimatePathDrawdown(arr));
  }
  dds.sort((a, b) => a - b);
  const q = (p: number) => dds[Math.min(dds.length - 1, Math.floor(p * dds.length))];
  return { p50: q(0.5), p95: q(0.95), nShuffles };
}

/**
 * Run the full robustness battery on a closed trade set (typically OOS).
 */
export function runRobustnessSuite(
  trades: SimulatedTrade[],
  opts: { strategy?: StrategyName | null } = {},
): RobustnessReport {
  const stresses: RobustnessStressResult[] = [
    summarize('baseline_oos', trades),
    summarize('param_perturb_+5conf', stressParameterPerturbation(trades, 5)),
    summarize('slippage_+15bps', stressSlippage(trades, 15)),
    summarize('entry_delay_1bar', stressEntryDelay(trades, 1)),
    summarize('missing_data_20pct', stressMissingData(trades, 0.2)),
  ];

  const regimes = Array.from(new Set(trades.map((t) => t.regime)));
  const regimeSlices = regimes.map((r) =>
    summarize(`regime_${r}`, trades.filter((t) => t.regime === r)),
  );

  const sectors = Array.from(new Set(trades.map((t) => t.sector)));
  const sectorSlices = sectors.map((sec) =>
    summarize(`sector_${sec}`, trades.filter((t) => t.sector === sec)),
  );

  const years = Array.from(new Set(trades.map((t) => (t.entryDate ?? t.signalDate).slice(0, 4))));
  const yearSlices = years.map((y) =>
    summarize(`year_${y}`, trades.filter((t) => (t.entryDate ?? t.signalDate).startsWith(y))),
  );

  const directionSlices = [
    summarize('long', trades.filter((t) => t.direction === 'long')),
    summarize('short', trades.filter((t) => t.direction === 'short')),
  ];

  // High-vol proxy: High Volatility Risk regime or wide MAE
  const hv = trades.filter(
    (t) => t.regime === ('High Volatility Risk' as MarketRegimeLabel) || t.maePct >= 4,
  );
  if (hv.length) stresses.push(summarize('high_vol_events', hv, -0.15));

  const bootstrapCi = bootstrapExpectancy(trades);
  const monteCarloMaxDd = monteCarloDrawdown(trades);

  const criticalFail = stresses
    .filter((s) => ['baseline_oos', 'param_perturb_+5conf', 'slippage_+15bps'].includes(s.name))
    .some((s) => s.n >= 15 && s.expectancyR < -0.1);

  return {
    modelVersion: ROBUSTNESS_SUITE_VERSION,
    strategy: opts.strategy ?? null,
    stresses,
    regimeSlices,
    sectorSlices,
    yearSlices,
    directionSlices,
    bootstrapCi,
    monteCarloMaxDd,
    overallPass: !criticalFail && stresses[0].expectancyR >= 0,
    generatedAt: new Date().toISOString(),
  };
}

/** Template payload for docs / API. */
export function robustnessReportTemplate(): Record<string, unknown> {
  return {
    version: ROBUSTNESS_SUITE_VERSION,
    sections: [
      'parameter_perturbation',
      'slippage_stress',
      'entry_delay_stress',
      'missing_data_stress',
      'regime_by_regime',
      'sector_by_sector',
      'year_by_year',
      'bootstrap_ci',
      'monte_carlo_drawdown',
      'long_short_separation',
      'high_volatility_events',
    ],
  };
}
