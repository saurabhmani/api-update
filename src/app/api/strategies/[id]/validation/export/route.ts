import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadValidationReport } from '@/lib/strategy-hub/services/strategyValidationService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/strategies/[id]/validation/export?validationId=
 * Export validation report as JSON download.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    await requireSession();
    const { id } = await context.params;
    const validationId = Number(req.nextUrl.searchParams.get('validationId') ?? 0);
    if (!validationId) {
      return NextResponse.json({ ok: false, error: 'validationId required' }, { status: 400 });
    }

    const row = await loadValidationReport(id, validationId);
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Validation not found' }, { status: 404 });
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      strategyId: id,
      validationId: row.id,
      report: row.report_json,
      effectiveConfig: row.effective_config_json,
      configVersion: row.config_version,
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="validation-${id}-${validationId}.json"`,
      },
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Export failed' }, { status: 500 });
  }
}
