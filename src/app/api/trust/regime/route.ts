import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadMarketRegimeSnapshot } from '@/lib/trust-layer';
import { persistRegimeSnapshot } from '@/lib/trust-layer/repository/regimeSnapshots';
import { categoryDisplayLabel } from '@/lib/trust-layer/mappers/regimeMapper';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await requireSession();
    const snapshot = await loadMarketRegimeSnapshot();
    await persistRegimeSnapshot(snapshot);

    const categories = {
      bullish:         snapshot.category === 'bullish',
      bearish:         snapshot.category === 'bearish',
      sideways:        snapshot.category === 'sideways',
      highVolatility:  snapshot.category === 'high_volatility',
    };

    return NextResponse.json({
      ok: true,
      data: {
        ...snapshot,
        categoryLabel: categoryDisplayLabel(snapshot.category),
        categories,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
