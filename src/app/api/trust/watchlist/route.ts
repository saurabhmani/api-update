import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError, AppError } from '@/lib/errors';
import { loadTrustWatchlist } from '@/lib/trust-layer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const user = await requireSession();
    const items = await loadTrustWatchlist(user.id);
    const categories = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.category] = (acc[item.category] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: true, data: items, count: items.length, categories });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[trust/watchlist] load failed:', err);
    if (err instanceof AppError) {
      return NextResponse.json(
        { ok: false, error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Failed to load watchlist' },
      { status: 500 },
    );
  }
}
