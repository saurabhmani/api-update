import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import {
  loadStrategyConfiguration,
  resetStrategyConfiguration,
  updateStrategyConfiguration,
} from '@/lib/strategy-hub/services/configurationService';
import type { ConfigurableParamKey } from '@/lib/strategy-hub/strategyParameterCatalog';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/strategies/[id]/config — effective configuration (read-only for all users)
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const user = await requireSession();
    const { id } = await context.params;
    const config = await loadStrategyConfiguration(id);
    if (!config) {
      return NextResponse.json({ ok: false, error: 'Strategy not found' }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      config,
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
 * PATCH /api/strategies/[id]/config — apply configuration overrides (admin only)
 * Body: { values: Record<string, unknown>, reason?: string }
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const values = body.values ?? body;
    if (!values || typeof values !== 'object') {
      return NextResponse.json({ ok: false, error: 'values object required' }, { status: 400 });
    }

    const result = await updateStrategyConfiguration({
      strategyId: id,
      userId: admin.id,
      actor: admin.email,
      values: values as Record<string, unknown>,
      reason: body.reason != null ? String(body.reason) : null,
      source: 'api',
    });

    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        error: result.error ?? 'Update failed',
        preview: result.preview,
      }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      config: result.config,
      preview: result.preview,
      message: 'Configuration updated',
    });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Update failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/strategies/[id]/config — reset overrides (admin only)
 * Query: ?key=idealRsiRange (optional — reset single param)
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin();
    const { id } = await context.params;
    const key = req.nextUrl.searchParams.get('key') as ConfigurableParamKey | null;

    const result = await resetStrategyConfiguration({
      strategyId: id,
      userId: admin.id,
      actor: admin.email,
      key: key ?? undefined,
      reason: key ? `Reset ${key}` : 'Reset all configuration overrides',
    });

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error ?? 'Reset failed' }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      config: result.config,
      message: key ? `Reset ${key} to registry default` : 'Reset all parameters to registry defaults',
    });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden — admin only' }, { status: 403 });
    }
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    const msg = e instanceof Error ? e.message : 'Reset failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
