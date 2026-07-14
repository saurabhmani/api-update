// ════════════════════════════════════════════════════════════════
//  Phase 7 — Baseline & ablation comparison
// ════════════════════════════════════════════════════════════════

import type { BacktestRunConfig } from '../types';
import type { RobustnessStressResult } from './robustnessSuite';
import type { SimulatedTrade } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export const BASELINE_COMPARE_VERSION = '7.0.0';

export type BaselineKind =
  | 'previous_production'
  | 'buy_and_hold'
  | 'random_entry'
  | 'unfiltered_strategy'
  | 'ablation_no_consensus'
  | 'ablation_no_mtf'
  | 'ablation_no_fib_v2'
  | 'candidate';

export interface BaselineCompareRow {
  kind: BaselineKind;
  label: string;
  n: number;
  expectancyR: number;
  profitFactor: number;
  winRate: number;
  totalReturnPct: number | null;
}

export interface BaselineCompareReport {
  modelVersion: string;
  rows: BaselineCompareRow[];
  candidateBeatsPrevious: boolean | null;
  candidateBeatsRandom: boolean | null;
  ablationDeltas: Array<{ ablation: BaselineKind; deltaExpectancyR: number }>;
  generatedAt: string;
}

function row(kind: BaselineKind, label: string, trades: SimulatedTrade[], totalReturnPct: number | null = null): BaselineCompareRow {
  if (trades.length === 0) {
    return { kind, label, n: 0, expectancyR: 0, profitFactor: 0, winRate: 0, totalReturnPct };
  }
  const exp = computeExpectancy(trades);
  const wr = trades.filter((t) => t.outcome === 'win').length / trades.length;
  return {
    kind,
    label,
    n: trades.length,
    expectancyR: exp.expectancyR,
    profitFactor: Number.isFinite(exp.profitFactor) ? exp.profitFactor : 0,
    winRate: Math.round(wr * 1000) / 1000,
    totalReturnPct,
  };
}

/**
 * Build comparison from precomputed trade sets (parity-safe, no reinvented engines).
 */
export function compareBaselinesAndAblations(input: {
  candidate: SimulatedTrade[];
  previousProduction?: SimulatedTrade[] | null;
  buyAndHoldReturnPct?: number | null;
  randomEntry?: SimulatedTrade[] | null;
  unfiltered?: SimulatedTrade[] | null;
  ablationNoConsensus?: SimulatedTrade[] | null;
  ablationNoMtf?: SimulatedTrade[] | null;
  ablationNoFibV2?: SimulatedTrade[] | null;
}): BaselineCompareReport {
  const rows: BaselineCompareRow[] = [
    row('candidate', 'Candidate strategy version', input.candidate),
  ];
  if (input.previousProduction) {
    rows.push(row('previous_production', 'Previous production version', input.previousProduction));
  }
  if (input.buyAndHoldReturnPct != null) {
    rows.push({
      kind: 'buy_and_hold',
      label: 'Buy & hold benchmark',
      n: 0,
      expectancyR: 0,
      profitFactor: 0,
      winRate: 0,
      totalReturnPct: input.buyAndHoldReturnPct,
    });
  }
  if (input.randomEntry) {
    rows.push(row('random_entry', 'Random entry (same hold/risk)', input.randomEntry));
  }
  if (input.unfiltered) {
    rows.push(row('unfiltered_strategy', 'Unfiltered strategy', input.unfiltered));
  }
  if (input.ablationNoConsensus) {
    rows.push(row('ablation_no_consensus', 'Ablation: no consensus factor', input.ablationNoConsensus));
  }
  if (input.ablationNoMtf) {
    rows.push(row('ablation_no_mtf', 'Ablation: no MTF confirmation', input.ablationNoMtf));
  }
  if (input.ablationNoFibV2) {
    rows.push(row('ablation_no_fib_v2', 'Ablation: Fib pre-2.0', input.ablationNoFibV2));
  }

  const cand = rows.find((r) => r.kind === 'candidate')!;
  const prev = rows.find((r) => r.kind === 'previous_production');
  const rnd = rows.find((r) => r.kind === 'random_entry');

  const ablationDeltas = rows
    .filter((r) => r.kind.startsWith('ablation_'))
    .map((r) => ({
      ablation: r.kind,
      deltaExpectancyR: Math.round((cand.expectancyR - r.expectancyR) * 1000) / 1000,
    }));

  return {
    modelVersion: BASELINE_COMPARE_VERSION,
    rows,
    candidateBeatsPrevious: prev ? cand.expectancyR > prev.expectancyR : null,
    candidateBeatsRandom: rnd ? cand.expectancyR > rnd.expectancyR : null,
    ablationDeltas,
    generatedAt: new Date().toISOString(),
  };
}

/** Config clones for ablations — still call production runners; only flags change. */
export function buildAblationConfigs(base: BacktestRunConfig): Array<{ kind: BaselineKind; config: BacktestRunConfig }> {
  return [
    {
      kind: 'unfiltered_strategy',
      config: {
        ...base,
        name: `${base.name} [unfiltered]`,
        minConfidence: 0,
        minRewardRisk: 0.5,
        newsFilterScore: undefined,
        manipulationFilterScore: undefined,
        tags: [...(base.tags ?? []), 'ablation_unfiltered'],
      },
    },
    {
      kind: 'ablation_no_mtf',
      config: {
        ...base,
        name: `${base.name} [no_mtf_tag]`,
        tags: [...(base.tags ?? []), 'ablation_no_mtf'],
      },
    },
  ];
}

/** Generate synthetic random-entry control with same R distribution noise (offline). */
export function synthesizeRandomEntryControl(
  template: SimulatedTrade[],
  seed = 99,
): SimulatedTrade[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  return template.map((t) => {
    const retR = (rand() - 0.48) * 1.2;
    return {
      ...t,
      tradeId: `rnd_${t.tradeId}`,
      returnR: Math.round(retR * 1000) / 1000,
      returnPct: Math.round(retR * 1.5 * 1000) / 1000,
      netPnl: Math.round(retR * t.riskAmount * 100) / 100,
      outcome: retR > 0 ? 'win' as const : 'loss' as const,
      strategy: t.strategy,
    };
  });
}

void (null as unknown as RobustnessStressResult);
