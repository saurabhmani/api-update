'use client';

import { useState } from 'react';
import { Card, Loading, Badge } from '@/components/ui';
import { useTrustStrategyPerformance } from '@/hooks/trust/useTrustStrategyPerformance';

const WINDOWS = ['7D', '30D', '90D', '180D', '1Y'] as const;

function statusBadge(row: {
  dataStatus: string;
  performanceStatus?: string;
  totalTrades: number;
}) {
  if (row.dataStatus === 'AVAILABLE') {
    if (row.performanceStatus === 'SUFFICIENT') {
      return <Badge variant="green">Sufficient</Badge>;
    }
    return <Badge variant="orange">Limited</Badge>;
  }
  return (
    <span title={`Only ${row.totalTrades} closed trade(s) in window`}>
      <Badge variant="gray">Insufficient</Badge>
    </span>
  );
}

function sourceLabel(source?: string): string {
  if (!source || source === 'insufficient_data') return '—';
  return source.replace(/_/g, ' ');
}

export function StrategyPerformanceTable() {
  const [window, setWindow] = useState<string>('90D');
  const [showThinSample, setShowThinSample] = useState(true);
  const { data, isLoading, error } = useTrustStrategyPerformance(window);

  if (isLoading) return <Loading text="Loading strategy performance…" />;
  if (error) {
    return (
      <Card title="Strategy Performance">
        <p style={{ padding: 16, color: '#DC2626' }}>
          {error instanceof Error ? error.message : 'Failed to load strategy performance.'}
        </p>
      </Card>
    );
  }

  const rows = data?.rows ?? [];
  const reliable = rows.filter((r) => r.dataStatus === 'AVAILABLE');
  const thinSample = rows.filter((r) => r.dataStatus !== 'AVAILABLE');
  const visibleRows = showThinSample ? rows : reliable;
  const sources = data?.sourceStatus;
  const noClosedOutcomes =
    rows.length === 0 &&
    (sources?.directOutcomeRows ?? 0) === 0 &&
    (sources?.observedSnapshotRows ?? 0) === 0 &&
    (sources?.backtestTradeRows ?? 0) === 0 &&
    (sources?.strategySnapshots ?? 0) === 0;

  return (
    <Card
      title={`Strategy Performance (${reliable.length} ranked)`}
      action={
        <select
          value={window}
          onChange={(e) => setWindow(e.target.value)}
          className="input"
          style={{ width: 100, padding: '4px 8px' }}
        >
          {WINDOWS.map((w) => <option key={w} value={w}>{w}</option>)}
        </select>
      }
      flush
    >
      {noClosedOutcomes && (
        <div style={{
          padding: '12px 20px', fontSize: 13, color: '#92400E',
          background: '#FFFBEB', borderBottom: '1px solid #FDE68A',
        }}>
          No closed signal outcomes found for {window}. This usually means the
          learning scheduler has not populated <code>q365_signal_outcomes</code> /
          confirmed snapshot terminals on this environment yet. Run{' '}
          <code>npm run learning-scheduler</code> (or wait for the daily PM2 cron)
          after signals have aged enough to grade.
        </div>
      )}
      {!noClosedOutcomes && rows.length === 0 && (
        <div style={{ padding: '16px 20px', fontSize: 13, color: '#64748B' }}>
          Outcome rows exist, but none resolve to WIN/LOSS for {window}. Confirm
          learning evaluations completed and try a wider window (90D / 180D / 1Y).
        </div>
      )}
      {sources && (sources.directOutcomeRows > 0 || sources.observedSnapshotRows > 0) && (
        <div style={{
          padding: '8px 20px', fontSize: 11, color: '#94A3B8',
          borderBottom: '1px solid #F1F5F9',
        }}>
          Sources — direct: {sources.directOutcomeRows}
          {' · '}observed: {sources.observedSnapshotRows}
          {' · '}backtest: {sources.backtestTradeRows}
          {' · '}snapshots: {sources.strategySnapshots}
          {' · '}evaluated trades: {sources.evaluatedTrades}
        </div>
      )}
      {thinSample.length > 0 && (
        <div style={{
          padding: '8px 20px', fontSize: 12, color: '#64748B',
          borderBottom: '1px solid #F1F5F9',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>
            {thinSample.length} strateg{thinSample.length === 1 ? 'y has' : 'ies have'} fewer than 5
            closed trades (sample too thin to rank)
          </span>
          <button
            type="button"
            onClick={() => setShowThinSample((v) => !v)}
            style={{
              background: 'none', border: 'none', color: '#2563EB',
              fontSize: 12, cursor: 'pointer', padding: 0,
            }}
          >
            {showThinSample ? 'Hide thin samples' : 'Show thin samples'}
          </button>
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Sample</th>
              <th>Source</th>
              <th>Win Rate</th>
              <th>Trades</th>
              <th>Avg Win</th>
              <th>Avg Loss</th>
              <th>Best</th>
              <th>Worst</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && rows.length > 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>
                  No strategy has ≥5 closed trades in {window}. Use &ldquo;Show thin samples&rdquo; to
                  inspect early data.
                </td>
              </tr>
            )}
            {visibleRows.length === 0 && rows.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>
                  No outcomes yet
                </td>
              </tr>
            )}
            {visibleRows.map((row) => {
              const thin = row.dataStatus !== 'AVAILABLE';
              const dim = thin ? { color: '#94A3B8' } : undefined;
              return (
                <tr key={row.strategyId}>
                  <td><strong>{row.displayName}</strong></td>
                  <td>{statusBadge(row)}</td>
                  <td style={{ fontSize: '0.75rem', color: '#64748B', textTransform: 'capitalize' }}>
                    {sourceLabel(row.performanceSource)}
                  </td>
                  <td style={dim}>{thin ? '—' : `${row.winRate.toFixed(1)}%`}</td>
                  <td style={dim}>{row.totalTrades}</td>
                  <td style={thin ? dim : { color: '#16A34A' }}>
                    {thin ? '—' : `${row.averageProfit.toFixed(2)}%`}
                  </td>
                  <td style={thin ? dim : { color: '#DC2626' }}>
                    {thin ? '—' : `${row.averageLoss.toFixed(2)}%`}
                  </td>
                  <td style={thin ? dim : { color: '#16A34A' }}>
                    {thin ? '—' : `${row.bestTrade.toFixed(2)}%`}
                  </td>
                  <td style={thin ? dim : { color: '#DC2626' }}>
                    {thin ? '—' : `${row.worstTrade.toFixed(2)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
