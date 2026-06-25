import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { connectBroker, getBrokerAuthStatus } from '@/lib/broker';
import type { BrokerName } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** POST /api/broker/connect */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const broker = String(body.broker ?? process.env.BROKER_ADAPTER ?? 'simulated') as BrokerName;
    const result = await connectBroker(user.id, broker, {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt ?? new Date(Date.now() + 86400000).toISOString(),
      brokerUserId: body.brokerUserId ?? user.email,
      apiKey: body.apiKey,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
    }
    return NextResponse.json({
      ok: true,
      account: result.connection,
      status: await getBrokerAuthStatus(user.id, broker),
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** GET /api/broker/connect — connection status */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const broker = req.nextUrl.searchParams.get('broker') as BrokerName | null;
    const status = await getBrokerAuthStatus(user.id, broker ?? undefined);
    return NextResponse.json({ ok: true, ...status });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
