'use client';

import { useState } from 'react';
import { Card, Loading } from '@/components/ui';
import { useTrustStrategyPerformance } from '@/hooks/trust/useTrustStrategyPerformance';

const WINDOWS = ['7D', '30D', '90D', '180D', '1Y'] as const;

export function StrategyPerformanceTable() {
  const [window, setWindow] = useState<string>('90D');
  const { data, isLoading } = useTrustStrategyPerformance(window);

  if (isLoading) return <Loading text="Loading strategy performance…" />;

  const rows = data ?? [];

  return (
    <Card
      title="Strategy Performance"
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
      <div style={{ overflowX: 'auto' }}>
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Win Rate</th>
              <th>Total Trades</th>
              <th>Avg Profit</th>
              <th>Avg Loss</th>
              <th>Best Trade</th>
              <th>Worst Trade</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>Insufficient performance data</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.strategyId}>
                <td><strong>{row.displayName}</strong></td>
                <td>{row.winRate.toFixed(1)}%</td>
                <td>{row.totalTrades}</td>
                <td style={{ color: '#16A34A' }}>{row.averageProfit.toFixed(2)}%</td>
                <td style={{ color: '#DC2626' }}>{row.averageLoss.toFixed(2)}%</td>
                <td style={{ color: '#16A34A' }}>{row.bestTrade.toFixed(2)}%</td>
                <td style={{ color: '#DC2626' }}>{row.worstTrade.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
