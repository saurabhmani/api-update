'use client';

import { useParams }  from 'next/navigation';
import AppShell       from '@/components/layout/AppShell';
import MarketDetail   from '@/components/market/MarketDetail';

export default function InstrumentDetailPage() {
  const { key } = useParams<{ key: string }>();
  const decoded = decodeURIComponent(key);
  const sym     = decoded.includes('|') ? decoded.split('|')[1].toUpperCase() : decoded.toUpperCase();
  const exch    = decoded.includes('|') ? decoded.split('|')[0].replace('_EQ', '').replace('_FO', '') : 'NSE';

  return (
    <AppShell title={sym}>
      <div className="page">
        <MarketDetail
          instrumentKey={decoded}
          symbol={sym}
          exchange={exch}
        />
      </div>
    </AppShell>
  );
}
