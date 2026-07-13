import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import {
  loadAllocationHistory,
  saveCapitalAllocations,
  updatePortfolioCapital,
} from '@/lib/strategy-hub/services/portfolioService';
import type { AllocationMethod } from '@/lib/strategy-hub/portfolio/types';

export const dynamic = 'force-dynamic';

const METHODS = new Set<AllocationMethod>([
  'fixed', 'percentage', 'equal', 'risk_weighted',
  'performance_weighted', 'confidence_weighted', 'manual',
]);

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const strategyId = req.nextUrl.searchParams.get('strategyId') ?? undefined;
    const history = await loadAllocationHistory({ strategyId, limit: 100 });
    return NextResponse.json({ ok: true, history });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load allocation history' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));

    if (body.totalCapital != null) {
      const settings = await updatePortfolioCapital(Number(body.totalCapital), admin.email ?? `user:${admin.id}`);
      return NextResponse.json({ ok: true, settings });
    }

    const method = String(body.method ?? 'manual') as AllocationMethod;
    if (!METHODS.has(method)) {
      return NextResponse.json({ ok: false, error: 'Invalid allocation method' }, { status: 400 });
    }

    const result = await saveCapitalAllocations({
      method,
      allocations: body.allocations ?? [],
      actor: admin.email ?? `user:${admin.id}`,
      reason: body.reason ?? null,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to save allocations' }, { status: 500 });
  }
}
