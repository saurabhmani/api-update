// GET /api/market-data/live-feed-status — authenticated user's live feed health
import { NextResponse } from 'next/server';
import { ensureLiveMarketStack } from '@/lib/marketData/ensureLiveMarketStack';
import {
  getLiveFeedStateFor,
  listLiveFeedStates,
} from '@/lib/marketData/liveFeedState';
import { getLiveSessionBarStats } from '@/lib/marketData/liveSessionBarStore';
import { getStreamServerStats } from '@/lib/ws/streamServer';
import {
  isMarketApiGateResponse,
  providerDataJson,
  resolveOptionalUserMarketMeta,
} from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Resolves the authenticated user's active provider feed status.
 * Does not expose credentials or broker session tokens.
 */
export async function GET() {
  const meta = await resolveOptionalUserMarketMeta();
  if (isMarketApiGateResponse(meta)) return meta;

  await ensureLiveMarketStack();

  const session = getLiveSessionBarStats();
  const ws = getStreamServerStats();
  const { getLiveMarketFeedStats } = await import('@/lib/marketData/liveMarketFeed');
  const poll = getLiveMarketFeedStats();

  const userFeeds = listLiveFeedStates().filter(
    (f) => f.userId === String(meta.user.id),
  );

  const activeFeed = meta.provider
    ? getLiveFeedStateFor({
        userId: String(meta.user.id),
        provider: meta.provider,
      })
    : null;

  return providerDataJson(meta.provider, meta.status, {
    feed: activeFeed,
    feeds: userFeeds,
    sessionBarSymbols: session.symbols,
    systemPollProvider: poll.provider,
    ws: {
      running: ws.running,
      port: ws.port,
      clientCount: ws.clientCount,
    },
  });
}
