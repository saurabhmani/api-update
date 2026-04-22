'use client';

import { useParams }    from 'next/navigation';
import AppShell         from '@/components/layout/AppShell';
import StockDashboard   from '@/components/stock/StockDashboard';

export default function StockPage() {
  const { symbol } = useParams<{ symbol: string }>();
  const sym        = decodeURIComponent(symbol).toUpperCase();

  return (
    <AppShell title={sym}>
      <div className="page">
        <StockDashboard symbol={sym} />
      </div>
    </AppShell>
  );
}
