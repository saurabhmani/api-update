// ════════════════════════════════════════════════════════════════
//  Backtest Export — CSV / JSON download support
// ════════════════════════════════════════════════════════════════

import { loadBacktestRun, loadBacktestTrades, loadEquityCurve } from '../repository/persistence';
import type { SimulatedTrade, EquityPoint, BacktestSummary } from '../types';

export type ExportFormat = 'json' | 'csv';

export interface BacktestExportBundle {
  runId: string;
  name: string;
  exportedAt: string;
  summary: BacktestSummary | null;
  config: Record<string, unknown>;
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
}

export async function buildBacktestExport(runId: string): Promise<BacktestExportBundle> {
  const [record, trades, equityCurve] = await Promise.all([
    loadBacktestRun(runId),
    loadBacktestTrades(runId),
    loadEquityCurve(runId),
  ]);

  return {
    runId: record.runId,
    name: record.config.name,
    exportedAt: new Date().toISOString(),
    summary: record.summary,
    config: record.config as unknown as Record<string, unknown>,
    trades,
    equityCurve,
  };
}

export function serializeExport(bundle: BacktestExportBundle, format: ExportFormat): string {
  if (format === 'json') {
    return JSON.stringify(bundle, null, 2);
  }
  return buildCsvExport(bundle);
}

function buildCsvExport(bundle: BacktestExportBundle): string {
  const lines: string[] = [];

  lines.push('# Backtest Export');
  lines.push(`# Run: ${bundle.name} (${bundle.runId})`);
  lines.push(`# Exported: ${bundle.exportedAt}`);
  lines.push('');

  if (bundle.summary) {
    lines.push('## Summary');
    lines.push('metric,value');
    for (const [k, v] of Object.entries(bundle.summary)) {
      if (typeof v === 'object') continue;
      lines.push(`${k},${v}`);
    }
    lines.push('');
  }

  lines.push('## Equity Curve');
  lines.push('date,equity,cash,drawdownPct,openPositions');
  for (const p of bundle.equityCurve) {
    lines.push([
      p.date,
      p.equity,
      p.cash ?? '',
      p.drawdownPct ?? '',
      p.openPositions ?? '',
    ].join(','));
  }
  lines.push('');

  lines.push('## Trades');
  if (bundle.trades.length > 0) {
    const headers = [
      'tradeId', 'symbol', 'strategy', 'direction', 'entryDate', 'exitDate',
      'entryPrice', 'exitPrice', 'positionSize', 'netPnl', 'returnPct', 'returnR',
      'outcome', 'exitReason', 'slippageCost', 'commissionCost',
    ];
    lines.push(headers.join(','));
    for (const t of bundle.trades) {
      lines.push(headers.map((h) => String((t as unknown as Record<string, unknown>)[h] ?? '')).join(','));
    }
  }

  return lines.join('\n');
}

export function exportFilename(runId: string, format: ExportFormat): string {
  const ts = new Date().toISOString().slice(0, 10);
  return `backtest_${runId.slice(0, 8)}_${ts}.${format === 'json' ? 'json' : 'csv'}`;
}
