import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadMarketRegimeSnapshot } from '@/lib/trust-layer';
import { persistRegimeSnapshot } from '@/lib/trust-layer/repository/regimeSnapshots';
import { categoryDisplayLabel } from '@/lib/trust-layer/mappers/regimeMapper';
import { getRegimeCategoryModifier } from '@/lib/trust-layer/services/regimeConfidence';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/market-regime
 * Regime computed from benchmark candles before signal generation.
 * Confidence modifier is applied to signal confidence scores platform-wide.
 */
export async function GET() {
  try {
    await requireSession();
    const snapshot = await loadMarketRegimeSnapshot();
    await persistRegimeSnapshot(snapshot);

    const confidenceModifier = getRegimeCategoryModifier(snapshot.category);

    return NextResponse.json({
      ok: true,
      data: {
        ...snapshot,
        categoryLabel: categoryDisplayLabel(snapshot.category),
        confidenceModifier,
        impactsConfidence: true,
        computedBeforeSignals: true,
        categories: {
          bullish:        snapshot.category === 'bullish',
          bearish:        snapshot.category === 'bearish',
          sideways:       snapshot.category === 'sideways',
          highVolatility: snapshot.category === 'high_volatility',
        },
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
