import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  getSafeBrokerStatus,
  providerDataJson,
  resolveUserFeedMeta,
} from '@/lib/broker/connections';
import {
  getLiveFeedStateFor,
  liveFeedReferenceTime,
  isValidTimestamp,
} from '@/lib/marketData/liveFeedState';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/brokers/status
 * { provider, status, data } — safe connection status + active-feed freshness.
 * Never exposes tokens.
 */
export async function GET() {
  try {
    const user = await requireSession();
    const [status, feedMeta] = await Promise.all([
      getSafeBrokerStatus(user.id),
      resolveUserFeedMeta(user.id),
    ]);

    let lastLiveDataAt: number | null = null;
    let feedError: string | null = null;
    // Live broker feed keys are zerodha|shoonya only — IndianAPI has no WS tick state.
    if (feedMeta.provider === 'zerodha' || feedMeta.provider === 'shoonya') {
      const feed = getLiveFeedStateFor({
        userId: String(user.id),
        provider: feedMeta.provider,
      });
      const ref = liveFeedReferenceTime({
        lastReceivedAt: feed.lastReceivedAt ?? null,
        lastSuccessAt: feed.lastSuccessAt ?? null,
      });
      lastLiveDataAt = isValidTimestamp(ref) ? ref : null;
      feedError = feed.lastError ?? null;
    } else {
      feedError = 'Live broker ticks unsupported — quotes come from IndianAPI warehouse';
    }

    return providerDataJson(feedMeta.provider, feedMeta.status, {
      ...status,
      feedStatus: feedMeta.status,
      lastLiveDataAt,
      lastLiveDataAtIso: lastLiveDataAt != null
        ? new Date(lastLiveDataAt).toISOString()
        : null,
      feedError,
    });
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: 'Unable to load broker status' },
      { status: 500, headers: NO_STORE },
    );
  }
}
