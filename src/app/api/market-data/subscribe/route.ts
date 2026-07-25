import { NextRequest, NextResponse } from 'next/server';
import {
  registerDemand,
  getLiveMarketFeedStats,
} from '@/lib/marketData/liveMarketFeed';
import { getStreamServerStats } from '@/lib/ws/streamServer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DEMAND_TTL_MS = Math.max(
  30_000,
  Number(process.env.MARKET_FEED_DEMAND_TTL_MS) || 120_000,
);

export async function POST(req: NextRequest) {
  const { ensureLiveMarketStack } = await import('@/lib/marketData/ensureLiveMarketStack');
  await ensureLiveMarketStack();

  // Prefer the authenticated user's connected broker stream over the
  // system MARKET_DATA_PROVIDER fan-out (often still kite).
  let userProvider: string | null = null;
  try {
    const { getSession } = await import('@/lib/session');
    const { getUserActiveDataSource } = await import(
      '@/lib/broker/connections/activeDataSource'
    );
    const session = await getSession();
    if (session?.id) {
      const active = await getUserActiveDataSource(Number(session.id));
      if (active.provider && active.isConnected) {
        userProvider = active.provider;
        const { ensureStreamingAfterBrokerConnect } = await import(
          '@/lib/marketData/ensureBrokerStreaming'
        );
        await ensureStreamingAfterBrokerConnect({
          userId: Number(session.id),
          broker: active.provider,
        });
      }
    }
  } catch { /* anonymous subscribe still registers system demand */ }

  let body: { symbols?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const raw = Array.isArray(body?.symbols) ? body.symbols : [];
  const symbols: string[] = [];
  for (const s of raw) {
    const up = String(s ?? '').trim().toUpperCase();
    if (up && !symbols.includes(up)) symbols.push(up);
  }
  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: 'no symbols' }, { status: 400 });
  }

  const resolved = registerDemand(symbols, DEMAND_TTL_MS);
  const feed = getLiveMarketFeedStats();
  const ws = getStreamServerStats();

  return NextResponse.json({
    ok: true,
    resolved,
    unknown: symbols.filter((s) => !resolved.includes(s)),
    subscribed: feed.subscribedCount,
    tickSnapshot: {},
    source: userProvider ?? 'websocket',
    provider: userProvider,
    ws: {
      running: ws.running,
      port: ws.port,
      clients: ws.clientCount,
    },
  });
}
