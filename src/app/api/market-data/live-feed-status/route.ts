// GET /api/market-data/live-feed-status — live WebSocket feed health
import { NextResponse } from 'next/server';
import { ensureLiveMarketStack } from '@/lib/marketData/ensureLiveMarketStack';
import { getLiveFeedState } from '@/lib/marketData/liveFeedState';
import { getLiveSessionBarStats } from '@/lib/marketData/liveSessionBarStore';
import { getStreamServerStats } from '@/lib/ws/streamServer';
import {
  resolveActiveCandleSource,
} from '@/lib/marketData/liveFeedState';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  await ensureLiveMarketStack();
  const feed = getLiveFeedState();
  const session = getLiveSessionBarStats();
  const ws = getStreamServerStats();
  const { getLiveMarketFeedStats } = await import('@/lib/marketData/liveMarketFeed');
  const poll = getLiveMarketFeedStats();
  const { getDualSourceConfig } = await import('@/lib/marketData/providerFlags');
  const { getDualSourceMonitoringSnapshot } = await import('@/lib/marketData/dualSource/monitoringService');
  const dualConfig = getDualSourceConfig();
  const dualSource = dualConfig.enabled ? getDualSourceMonitoringSnapshot() : null;

  return NextResponse.json({
    ...feed,
    candleSource:     resolveActiveCandleSource(),
    liveFeedProvider: poll.provider,
    dualSourceEnabled: poll.dualSourceEnabled ?? dualConfig.enabled,
    dualSource,
    sessionBarSymbols: session.symbols,
    ws: {
      running:     ws.running,
      port:        ws.port,
      clientCount: ws.clientCount,
    },
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
