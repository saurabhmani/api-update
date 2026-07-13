import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import {
  acknowledgePortfolioAlert,
  loadPortfolioAlerts,
  refreshPortfolioAlerts,
  resolvePortfolioAlert,
} from '@/lib/strategy-hub/services/portfolioService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const status = (req.nextUrl.searchParams.get('status') ?? 'open') as 'open' | 'all';
    const alerts = await loadPortfolioAlerts({ status, limit: 100 });
    return NextResponse.json({ ok: true, alerts });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load alerts' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'refresh');

    if (action === 'refresh') {
      const count = await refreshPortfolioAlerts();
      const alerts = await loadPortfolioAlerts({ status: 'open', limit: 100 });
      return NextResponse.json({ ok: true, generated: count, alerts });
    }

    const id = Number(body.id);
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });

    const actor = admin.email ?? `user:${admin.id}`;
    if (action === 'acknowledge') {
      await acknowledgePortfolioAlert(id, actor);
    } else if (action === 'resolve') {
      await resolvePortfolioAlert(id, actor);
    } else {
      return NextResponse.json({ ok: false, error: 'Invalid action' }, { status: 400 });
    }

    const alerts = await loadPortfolioAlerts({ status: 'open', limit: 100 });
    return NextResponse.json({ ok: true, alerts });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Alert action failed' }, { status: 500 });
  }
}
