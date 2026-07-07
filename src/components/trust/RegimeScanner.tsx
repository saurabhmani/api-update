'use client';

import { Card, Badge, Loading } from '@/components/ui';
import { useTrustRegime } from '@/hooks/trust/useTrustRegime';

const REGIME_TILES = [
  { key: 'bullish', label: 'Bullish', color: '#16A34A' },
  { key: 'bearish', label: 'Bearish', color: '#DC2626' },
  { key: 'sideways', label: 'Sideways', color: '#64748B' },
  { key: 'highVolatility', label: 'High Volatility', color: '#D97706' },
] as const;

export function RegimeScanner() {
  const { data, isLoading, error } = useTrustRegime();

  if (isLoading) return <Loading text="Scanning market regime…" />;
  if (error || !data) {
    return <Card title="Market Regime Scanner"><p style={{ color: '#DC2626' }}>Regime data unavailable.</p></Card>;
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {REGIME_TILES.map((tile) => {
          const active = data.categories[tile.key];
          return (
            <div
              key={tile.key}
              style={{
                padding: 16,
                borderRadius: 8,
                border: active ? `2px solid ${tile.color}` : '1px solid #E2E8F0',
                background: active ? `${tile.color}11` : '#fff',
                textAlign: 'center',
              }}
            >
              <div style={{ fontWeight: 600, color: active ? tile.color : '#94A3B8' }}>{tile.label}</div>
              {active && <Badge variant="green" style={{ marginTop: 8 }}>Active</Badge>}
            </div>
          );
        })}
      </div>

      <Card title="Regime Details">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, fontSize: '0.9rem' }}>
          <div><strong>Label:</strong> {data.label}</div>
          <div><strong>Strength:</strong> {data.strength}%</div>
          <div><strong>Confidence:</strong> {data.confidence}%</div>
          <div><strong>Volatility:</strong> {data.volatilityRegime}</div>
          <div><strong>RSI:</strong> {data.details.rsi}</div>
          <div><strong>ATR %:</strong> {data.details.atrPct}</div>
          <div><strong>Bullish allowed:</strong> {data.allowBullishSignals ? 'Yes' : 'No'}</div>
          {typeof data.confidenceModifier === 'number' && (
            <div>
              <strong>Confidence modifier:</strong>{' '}
              {data.confidenceModifier >= 0 ? '+' : ''}{data.confidenceModifier}
            </div>
          )}
          {typeof data.impactsConfidence === 'boolean' && (
            <div><strong>Impacts signals:</strong> {data.impactsConfidence ? 'Yes' : 'No'}</div>
          )}
          <div><strong>Source:</strong> {data.source}</div>
        </div>
      </Card>
    </div>
  );
}
