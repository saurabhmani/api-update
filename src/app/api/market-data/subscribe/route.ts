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
    source: 'websocket',
    ws: {
      running: ws.running,
      port: ws.port,
      clients: ws.clientCount,
    },
  });
}
