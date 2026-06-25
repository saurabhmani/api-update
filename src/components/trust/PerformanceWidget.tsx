'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

interface PerformanceGlobal {
  blendedWinRate: number;
  totalTrades: number;
  count: number;
}

export function PerformanceWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ['performance', 'global'],
    queryFn: async () => {
      const res = await fetch('/api/performance?window=90D', { cache: 'no-store', credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.json();
      return body.global as PerformanceGlobal;
    },
    refetchInterval: 300_000,
  });

  if (isLoading || !data) {
    return <span style={{ fontSize: '0.75rem', color: '#94A3B8' }}>Perf…</span>;
  }

  return (
    <Link
      href="/trust"
      style={{ fontSize: '0.75rem', color: '#64748B', textDecoration: 'none' }}
    >
      90D WR <strong style={{ color: '#1E40AF' }}>{data.blendedWinRate}%</strong>
      {' · '}
      {data.totalTrades} trades
    </Link>
  );
}
