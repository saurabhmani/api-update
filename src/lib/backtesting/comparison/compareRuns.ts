// ════════════════════════════════════════════════════════════════
//  Backtest Comparison Engine — side-by-side run analysis
// ════════════════════════════════════════════════════════════════

import { loadBacktestRun, loadEquityCurve } from '../repository/persistence';
import type { BacktestSummary } from '../types';

export interface ComparisonRunSnapshot {
  runId: string;
  name: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  config: Record<string, unknown>;
  summary: BacktestSummary | null;
  equityPoints: number;
  tradeCount: number;
  signalCount: number;
}

export interface ComparisonDelta {
  metric: string;
  values: Record<string, number | string | null>;
  bestRunId: string | null;
  deltaPct: number | null;
}

export interface BacktestComparisonResult {
  runs: ComparisonRunSnapshot[];
  deltas: ComparisonDelta[];
  winner: {
    byReturn: string | null;
    bySharpe: string | null;
    byDrawdown: string | null;
  };
}

const METRICS: Array<{ key: keyof BacktestSummary; label: string; higherIsBetter: boolean }> = [
  { key: 'totalReturnPct', label: 'Total Return %', higherIsBetter: true },
  { key: 'winRate', label: 'Win Rate', higherIsBetter: true },
  { key: 'sharpeRatio', label: 'Sharpe Ratio', higherIsBetter: true },
  { key: 'sortinoRatio', label: 'Sortino Ratio', higherIsBetter: true },
  { key: 'maxDrawdownPct', label: 'Max Drawdown %', higherIsBetter: false },
  { key: 'profitFactor', label: 'Profit Factor', higherIsBetter: true },
  { key: 'expectancyR', label: 'Expectancy (R)', higherIsBetter: true },
  { key: 'calmarRatio', label: 'Calmar Ratio', higherIsBetter: true },
];

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export async function compareBacktestRuns(runIds: string[]): Promise<BacktestComparisonResult> {
  const unique = [...new Set(runIds)].slice(0, 6);
  const runs: ComparisonRunSnapshot[] = [];

  for (const runId of unique) {
    const [record, equity] = await Promise.all([
      loadBacktestRun(runId).catch(() => null),
      loadEquityCurve(runId).catch(() => []),
    ]);
    if (!record) continue;

    const config = parseJsonObject(record.config_json ?? record.config);
    const summary = parseJsonObject(record.summary_json ?? record.summary);

    runs.push({
      runId: String(record.run_id ?? record.runId ?? runId),
      name: String(record.name ?? config.name ?? 'Backtest Run'),
      status: String(record.status ?? 'unknown'),
      startedAt: toIsoString(record.started_at ?? record.startedAt),
      completedAt: toIsoString(record.completed_at ?? record.completedAt),
      config,
      summary: Object.keys(summary).length ? summary as unknown as BacktestSummary : null,
      equityPoints: equity.length,
      tradeCount: toNumber(record.trade_count ?? record.tradeCount),
      signalCount: toNumber(record.signal_count ?? record.signalCount),
    });
  }

  const deltas: ComparisonDelta[] = [];
  for (const m of METRICS) {
    const values: Record<string, number | string | null> = {};
    let bestId: string | null = null;
    let bestVal: number | null = null;

    for (const r of runs) {
      const raw = r.summary?.[m.key];
      const num = typeof raw === 'number' ? raw : null;
      values[r.runId] = num;
      if (num == null) continue;
      if (bestVal == null) {
        bestVal = num;
        bestId = r.runId;
      } else if (m.higherIsBetter ? num > bestVal : num < bestVal) {
        bestVal = num;
        bestId = r.runId;
      }
    }

    let deltaPct: number | null = null;
    const nums = Object.values(values).filter((v): v is number => typeof v === 'number');
    if (nums.length >= 2) {
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      deltaPct = min !== 0 ? Math.round(((max - min) / Math.abs(min)) * 100) / 100 : null;
    }

    deltas.push({ metric: m.label, values, bestRunId: bestId, deltaPct });
  }

  const byReturn = pickBest(runs, 'totalReturnPct', true);
  const bySharpe = pickBest(runs, 'sharpeRatio', true);
  const byDrawdown = pickBest(runs, 'maxDrawdownPct', false);

  return { runs, deltas, winner: { byReturn, bySharpe, byDrawdown } };
}

function pickBest(
  runs: ComparisonRunSnapshot[],
  key: keyof BacktestSummary,
  higher: boolean,
): string | null {
  let best: { id: string; v: number } | null = null;
  for (const r of runs) {
    const v = r.summary?.[key];
    if (typeof v !== 'number') continue;
    if (!best || (higher ? v > best.v : v < best.v)) best = { id: r.runId, v };
  }
  return best?.id ?? null;
}
