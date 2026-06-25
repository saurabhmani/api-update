import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { consumePremiumAccess } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** POST /api/billing/usage — meter + consume credits for a feature */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const featureKey = String(body.featureKey ?? body.feature ?? '');
    if (!featureKey) {
      return NextResponse.json({ ok: false, error: 'featureKey required' }, { status: 400 });
    }
    const result = await consumePremiumAccess(user.id, featureKey, {
      creditCost: body.creditCost ? Number(body.creditCost) : 1,
      metadata: body.metadata,
    });
    const status = result.allowed ? 200 : result.upgradeRequired ? 402 : 403;
    return NextResponse.json({ ok: result.allowed, ...result }, { status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Usage failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
