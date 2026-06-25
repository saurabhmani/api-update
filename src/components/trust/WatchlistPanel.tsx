'use client';

import { Card, Badge, Loading } from '@/components/ui';
import { useTrustWatchlist } from '@/hooks/trust/useTrustWatchlist';
import { fmt } from '@/lib/utils';

const CATEGORY_COLORS: Record<string, 'green' | 'orange' | 'red' | 'gray' | 'default'> = {
  actionable: 'green',
  emerging: 'orange',
  blocked: 'red',
  low_confidence: 'gray',
  regime_mismatch: 'orange',
  no_data: 'gray',
};

export function WatchlistPanel() {
  const { data, isLoading } = useTrustWatchlist();

  if (isLoading) return <Loading text="Loading watchlist intelligence…" />;

  const items = data?.items ?? [];

  return (
    <Card title={`Watchlist (${items.length})`} flush>
      <div style={{ overflowX: 'auto' }}>
        <table className="table table--compact">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Category</th>
              <th>LTP</th>
              <th>Change</th>
              <th>Direction</th>
              <th>Confidence</th>
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>Watchlist empty — add symbols from Market Search</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.instrumentKey}>
                <td><strong>{item.tradingsymbol}</strong></td>
                <td>
                  <Badge variant={CATEGORY_COLORS[item.category] ?? 'default'}>
                    {item.category.replace('_', ' ')}
                  </Badge>
                </td>
                <td>{item.ltp !== null ? fmt.currency(item.ltp) : '—'}</td>
                <td style={{ color: (item.changePct ?? 0) >= 0 ? '#16A34A' : '#DC2626' }}>
                  {item.changePct !== null ? `${item.changePct.toFixed(2)}%` : '—'}
                </td>
                <td>{item.direction}</td>
                <td>{item.confidence !== null ? item.confidence.toFixed(0) : '—'}</td>
                <td style={{ fontSize: '0.8rem', color: '#B45309' }}>{item.warnings[0] ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
