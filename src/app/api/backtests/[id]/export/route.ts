import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import {
  buildBacktestExport,
  serializeExport,
  exportFilename,
  type ExportFormat,
} from '@/lib/backtesting/export/backtestExport';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/backtests/[id]/export?format=csv|json
 * Export backtest summary, equity curve, and trade history.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    const raw = (req.nextUrl.searchParams.get('format') ?? 'json').toLowerCase();
    const format: ExportFormat = raw === 'csv' ? 'csv' : 'json';

    const bundle = await buildBacktestExport(id);
    const body = serializeExport(bundle, format);
    const filename = exportFilename(id, format);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': format === 'json' ? 'application/json' : 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Export failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
