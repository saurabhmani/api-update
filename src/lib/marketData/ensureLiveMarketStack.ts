// Lazy-boot the live market stack when instrumentation did not run
// (common in `next dev`) or when the WS server failed to bind on
// the first attempt.

import { logger } from '@/lib/logger';

const log = logger.child({ component: 'ensureLiveMarketStack' });
const GLOBAL_KEY = '__q365_live_market_stack_booted__';

export async function ensureLiveMarketStack(): Promise<{
  wsRunning: boolean;
  wsPort: number;
  baselineSymbols: number;
}> {
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  const wsDisabled = (process.env.STREAM_WS_DISABLED ?? '').toLowerCase() === 'true';
  if (wsDisabled) {
    return { wsRunning: false, wsPort: 0, baselineSymbols: 0 };
  }

  if (!g[GLOBAL_KEY]) {
    try {
      const { installLiveSessionBarStore } = await import(
        '@/lib/marketData/liveSessionBarStore'
      );
      const { startLiveMarketFeed } = await import('@/lib/marketData/liveMarketFeed');
      const { startStreamServer } = await import('@/lib/ws/streamServer');
      const { installLiveSignalRecalc } = await import(
        '@/lib/signal-engine/live/liveSignalRecalc'
      );

      installLiveSessionBarStore();
      startLiveMarketFeed();
      const ws = startStreamServer();
      void installLiveSignalRecalc();
      if (ws.running) {
        g[GLOBAL_KEY] = true;
        log.info('live market stack booted (lazy)', { wsPort: ws.port, wsRunning: ws.running });
      } else {
        log.warn('live market stack partial boot — WS not listening', { wsPort: ws.port });
      }
    } catch (err) {
      log.warn('lazy live market boot failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { refreshLiveFeedBaseline, getBaselineSymbols } = await import(
    '@/lib/marketData/liveFeedBaseline'
  );
  // Baseline refresh is soft-timed inside refreshLiveFeedBaseline so a
  // slow q365_signals scan cannot stall request handlers that await this.
  try {
    await refreshLiveFeedBaseline();
  } catch (err) {
    log.warn('baseline refresh failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const { getStreamServerStats } = await import('@/lib/ws/streamServer');
  const ws = getStreamServerStats();

  return {
    wsRunning: ws.running,
    wsPort:    ws.port,
    baselineSymbols: getBaselineSymbols().length,
  };
}
