import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import {
  loadLatestValidation,
  loadValidationReport,
  listValidationHistory,
  runStrategyValidation,
  validateAndPersistStrategy,
} from '@/lib/strategy-hub/services/strategyValidationService';
import type { ValidationTarget } from '@/lib/strategy-hub/validation/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/strategies/[id]/validation — latest validation status + history summary
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const user = await requireSession();
    const { id } = await context.params;
    const validationId = Number(req.nextUrl.searchParams.get('validationId') ?? 0);

    if (validationId > 0) {
      const row = await loadValidationReport(id, validationId);
      if (!row) {
        return NextResponse.json({ ok: false, error: 'Validation not found' }, { status: 404 });
      }
      return NextResponse.json({
        ok: true,
        report: row.report_json,
        validationId: row.id,
        canManage: user.role === 'admin',
      });
    }

    const latest = await loadLatestValidation(id);
    const history = await listValidationHistory({ strategyId: id, limit: 10 });

    return NextResponse.json({
      ok: true,
      latest: latest
        ? { report: latest.report_json, validationId: latest.id, createdAt: latest.created_at }
        : null,
      history: history.map((h) => ({
        id: h.id,
        overallStatus: h.overall_status,
        validationScore: h.validation_score,
        target: h.validation_target,
        createdAt: h.created_at,
        actor: h.actor,
      })),
      canManage: user.role === 'admin',
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/**
 * POST /api/strategies/[id]/validation — run validation (admin only)
 * Body: { target?: 'paper' | 'live' | 'assessment', persist?: boolean }
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const target = (body.target ?? 'assessment') as ValidationTarget;
    const persist = body.persist !== false;

    const report = persist
      ? await validateAndPersistStrategy({
          strategyId: id,
          userId: admin.id,
          actor: admin.email,
          target,
        })
      : await runStrategyValidation({ strategyId: id, target });

    return NextResponse.json({
      ok: true,
      report,
      message: `Validation ${report.overallStatus} — score ${report.overallScore}`,
    });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Validation failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
