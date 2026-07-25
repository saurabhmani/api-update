// ════════════════════════════════════════════════════════════════
//  ensureBrokerStreaming — post-OAuth live-feed activation
//
//  OAuth callbacks persist tokens but historically left the
//  process-global Kite ticker in `closed` / `loginRequired` from
//  boot-without-token. This helper is the single idempotent entry
//  that rehydrates credentials and (re)connects the live stack.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { getLiveFeedProvider } from '@/lib/marketData/providerFlags';

const log = logger.child({ component: 'ensureBrokerStreaming' });

export type BrokerStreamingBroker = 'zerodha' | 'shoonya' | 'kite';

export interface EnsureBrokerStreamingInput {
  userId: number;
  broker: BrokerStreamingBroker;
  /** When set, apply to the in-process Kite client before reconnect. */
  accessToken?: string | null;
}

export interface EnsureBrokerStreamingResult {
  ok: boolean;
  provider: string;
  stackEnsured: boolean;
  tickerReconnected: boolean;
  hydrated: boolean;
  wsRunning: boolean;
  baselineSymbols: number;
  error?: string;
}

/**
 * After broker OAuth succeeds: hydrate tokens, ensure the process-global
 * live market stack, and reconnect the Kite ticker when it is the live
 * provider. Safe to call repeatedly (idempotent).
 *
 * Streaming is process-global (one Kite session / one ticker), not per-user.
 * Shoonya connections still trigger stack + baseline refresh so Yahoo/poll
 * paths and WS fan-out stay warm; they do not open a second ticker.
 */
export async function ensureStreamingAfterBrokerConnect(
  input: EnsureBrokerStreamingInput,
): Promise<EnsureBrokerStreamingResult> {
  const provider = getLiveFeedProvider();
  const result: EnsureBrokerStreamingResult = {
    ok: false,
    provider,
    stackEnsured: false,
    tickerReconnected: false,
    hydrated: false,
    wsRunning: false,
    baselineSymbols: 0,
  };

  log.info('market_data_start_requested', {
    userId: input.userId,
    broker: input.broker,
    provider,
  });

  try {
    const { getStatus: getMarketSession } = await import(
      '@/lib/marketData/marketSessionService'
    );
    const session = await getMarketSession({ exchange: 'NSE' });

    const { getKiteClient } = await import('@/lib/kite/client');
    const client = getKiteClient();

    if (input.accessToken?.trim()) {
      client.setAccessToken(input.accessToken.trim());
      result.hydrated = true;
    } else {
      result.hydrated = await client.hydrateAccessTokenFromSession();
    }

    log.info('market_session_resolved', {
      userId: input.userId,
      broker: input.broker,
      marketStatus: session.status,
      isOpen: session.isOpen,
      tradingDate: session.tradingDate,
    });

    log.info('market_data_stream_connecting', {
      userId: input.userId,
      broker: input.broker,
      hydrated: result.hydrated,
      provider,
      marketStatus: session.status,
    });

    const { ensureLiveMarketStack } = await import(
      '@/lib/marketData/ensureLiveMarketStack'
    );
    const stack = await ensureLiveMarketStack();
    result.stackEnsured = true;
    result.wsRunning = stack.wsRunning;
    result.baselineSymbols = stack.baselineSymbols;

    // Market closed / weekend / holiday: keep tokens + WS fan-out warm
    // but do NOT force a ticker reconnect loop. Absence of ticks is
    // expected — not a broker failure.
    if (!session.isOpen) {
      result.ok = true;
      result.tickerReconnected = false;
      log.info('market_data_status_changed', {
        userId: input.userId,
        broker: input.broker,
        ok: true,
        provider,
        marketStatus: session.status,
        note: 'closed_market_skip_ticker_reconnect',
        wsRunning: result.wsRunning,
        baselineSymbols: result.baselineSymbols,
      });
      return result;
    }

    if (provider === 'kite') {
      const { getTicker } = await import('@/lib/marketData/kiteTicker');
      const ticker = getTicker();
      ticker.clearLoginRequired();

      // Force a clean reconnect — boot often left the ticker closed with
      // loginRequired after connecting without a token.
      try {
        await ticker.disconnect();
      } catch {
        /* already down */
      }

      await ticker.connect();
      const status = ticker.getStatus();
      result.tickerReconnected =
        status.state === 'open'
        || status.state === 'connecting'
        || !status.loginRequired;

      log.info('market_data_stream_connected', {
        userId: input.userId,
        broker: input.broker,
        tickerState: status.state,
        loginRequired: status.loginRequired,
        subscribed: status.subscribedCount,
        baselineSymbols: result.baselineSymbols,
      });

      if (result.baselineSymbols > 0) {
        log.info('market_data_subscription_created', {
          userId: input.userId,
          broker: input.broker,
          instrumentCount: result.baselineSymbols,
        });
      }

      // Stack may be up, but without a usable Kite session the live WS path
      // is not active — do not report overall ok for a loginRequired feed.
      // `connecting` is success: kiteconnect opens the socket asynchronously.
      if (status.loginRequired) {
        result.ok = false;
        result.error = 'kite_login_required';
        log.warn('market_data_status_changed', {
          userId: input.userId,
          broker: input.broker,
          ok: false,
          error: result.error,
          tickerState: status.state,
        });
        return result;
      }
    } else {
      log.info('market_data_stream_connected', {
        userId: input.userId,
        broker: input.broker,
        provider,
        note: 'non-kite live provider — poll/yahoo path only',
        baselineSymbols: result.baselineSymbols,
      });
    }

    result.ok = true;
    log.info('market_data_status_changed', {
      userId: input.userId,
      broker: input.broker,
      ok: true,
      provider,
      tickerReconnected: result.tickerReconnected,
      wsRunning: result.wsRunning,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    log.error('market_data_stream_failed', {
      userId: input.userId,
      broker: input.broker,
      error: message,
    });
    return result;
  }
}
