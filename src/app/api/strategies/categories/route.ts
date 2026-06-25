import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { buildCategoryIndex } from '@/lib/strategy-hub/categories';
import { loadAllStrategySummaries } from '@/lib/strategy-hub/registry';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/strategies/categories
 * Strategy category index with counts.
 */
export async function GET() {
  try {
    await requireSession();
    const strategies = loadAllStrategySummaries();
    const counts: Partial<Record<string, number>> = {};
    for (const s of strategies) {
      counts[s.category] = (counts[s.category] ?? 0) + 1;
    }
    return NextResponse.json({
      ok: true,
      categories: buildCategoryIndex(counts),
      total: strategies.length,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
