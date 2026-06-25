'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui';
import { categoryDisplayLabel } from '@/lib/trust-layer/mappers/regimeMapper';
import Link from 'next/link';

interface RegimeData {
  label: string;
  category: string;
  categoryLabel: string;
  confidence: number;
  confidenceModifier: number;
  strength: number;
}

export function MarketRegimeWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ['market-regime'],
    queryFn: async () => {
      const res = await fetch('/api/market-regime', { cache: 'no-store', credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.json();
      return body.data as RegimeData;
    },
    refetchInterval: 120_000,
  });

  if (isLoading || !data) {
    return (
      <Link href="/trust" className="regime-widget" style={{ fontSize: '0.75rem', color: '#94A3B8' }}>
        Regime…
      </Link>
    );
  }

  const variant =
    data.category === 'bullish' ? 'green'
    : data.category === 'bearish' ? 'red'
    : data.category === 'high_volatility' ? 'orange'
    : 'gray';

  return (
    <Link
      href="/trust"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: '0.75rem',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <Badge variant={variant}>{categoryDisplayLabel(data.category as never)}</Badge>
      <span style={{ color: '#64748B' }}>
        {data.confidence}% conf · {data.confidenceModifier >= 0 ? '+' : ''}{data.confidenceModifier} adj
      </span>
    </Link>
  );
}
