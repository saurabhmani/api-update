'use client';

import { useParams }  from 'next/navigation';
import AppShell       from '@/components/layout/AppShell';
import MarketDetail   from '@/components/market/MarketDetail';

function decodeInstrumentKey(raw: string): string {
  let value = raw;
  // Path segments may arrive once- or twice-encoded (`%7C` / `%257C`).
  for (let i = 0; i < 2; i++) {
    try {
      const next = decodeURIComponent(value);
      if (next === value) break;
      value = next;
    } catch {
      break;
    }
  }
  return value;
}

export default function InstrumentDetailPage() {
  const { key } = useParams<{ key: string }>();
  const decoded = decodeInstrumentKey(String(key ?? ''));
  const sym     = decoded.includes('|') ? decoded.split('|')[1]!.toUpperCase() : decoded.toUpperCase();
  const exch    = decoded.includes('|') ? decoded.split('|')[0]!.replace('_EQ', '').replace('_FO', '') : 'NSE';

  return (
    <AppShell title={sym}>
      <div className="page">
        <MarketDetail
          instrumentKey={decoded.includes('|') ? decoded : `NSE_EQ|${sym}`}
          symbol={sym}
          exchange={exch}
        />
      </div>
    </AppShell>
  );
}
