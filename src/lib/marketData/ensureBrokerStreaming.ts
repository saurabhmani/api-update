/**
 * ensureBrokerStreaming — post-OAuth live-feed activation (Phase 5).
 *
 * Interactive streams are owned by ConnectionKey { userId, provider }.
 * The process-global Kite ticker is updated ONLY when the connecting
 * user is SYSTEM_MARKET_DATA_USER_ID (system feed owner).
 *
 * Shoonya OAuth never writes a Kite access token.
 */

import { logger } from '@/lib/logger';
import { getSystemLiveFeedProvider } from '@/lib/marketData/providerFlags';
import {
  getBrokerConnection,
  shouldUpdateSystemKiteFeed,
  upsertUserBrokerSession,
} from '@/lib/marketData/connectionManager';

const log = logger.child({ component: 'ensureBrokerStreaming' });

export type BrokerStreamingBroker = 'zerodha' | 'shoonya' | 'kite';

export interface EnsureBrokerStreamingInput {
  userId: number;
  broker: BrokerStreamingBroker;
  /** This user's token only — applied to their ConnectionKey instance. */
  accessToken?: string | null;
  accountId?: string | null;
}

export interface EnsureBrokerStreamingResult {
  ok: boolean;
  provider: string;
  stackEnsured: boolean;
  tickerReconnected: boolean;
  hydrated: boolean;
  wsRunning: boolean;
  baselineSymbols: number;
  userConnectionKey?: string;
  systemFeedUpdated?: boolean;
  skippedAlreadyConnected?: boolean;
  error?: string;
}

function normalizeBroker(
  broker: BrokerStreamingBroker,
): 'zerodha' | 'shoonya' {
  return broker === 'kite' ? 'zerodha' : broker;
}

export async function ensureStreamingAfterBrokerConnect(
  input: EnsureBrokerStreamingInput,
): Promise<EnsureBrokerStreamingResult> {
  const systemProvider = getSystemLiveFeedProvider();
  const broker = normalizeBroker(input.broker);
  const result: EnsureBrokerStreamingResult = {
    ok: false,
    provider: systemProvider,
    stackEnsured: false,
    tickerReconnected: false,
    hydrated: false,
    wsRunning: false,
    baselineSymbols: 0,
    systemFeedUpdated: false,
  };

  log.info('market_data_start_requested', {
    userId: input.userId,
    broker,
    systemProvider,
  });

  try {
    // Fast path: already connected for this user+broker — do not
    // re-authenticate / reconnect on every /api/signals poll (that
    // was pushing dashboard past its 12s/18s budgets → PARTIAL mode).
    const existing = getBrokerConnection({
      userId: input.userId,
      provider: broker,
    });
    if (existing) {
      const snap = existing.getSnapshot();
      if (snap.state === 'connected' && snap.hasAuthenticatedSession) {
        result.ok = true;
        result.hydrated = true;
        result.userConnectionKey = snap.keyString;
        result.skippedAlreadyConnected = true;
        // Warm the shared stack off the request path. Awaiting it here
        // re-introduced the /api/signals hang: enrichFromUserBroker →
        // provider.connect → ensureStreaming → ensureLiveMarketStack
        // → baseline SQL, stalling live-price enrichment on every poll.
        void import('@/lib/marketData/ensureLiveMarketStack')
          .then(({ ensureLiveMarketStack }) => ensureLiveMarketStack())
          .catch(() => { /* non-fatal */ });
        return result;
      }
    }

    const { getStatus: getMarketSession } = await import(
      '@/lib/marketData/marketSessionService'
    );
    const session = await getMarketSession({ exchange: 'NSE' });

    // 1) Always upsert THIS user's connection instance (tenant-safe).
    // Rehydrate from stored credentials when the caller did not pass a token
    // (e.g. visiting /signals after a process restart).
    let accessToken = input.accessToken?.trim() || null;
    let accountId = input.accountId ?? null;

    if (!accessToken) {
      const { getDecryptedAccessTokenForUser, getBrokerConnectionByUserAndBroker } =
        await import('@/lib/broker/connections');
      const row = await getBrokerConnectionByUserAndBroker(input.userId, broker);
      accessToken = await getDecryptedAccessTokenForUser(input.userId, broker);
      if (accountId == null) accountId = row?.brokerAccountId ?? null;
    }

    if (accessToken) {
      const snap = await upsertUserBrokerSession({
        userId: input.userId,
        provider: broker,
        accessToken,
        accountId,
        connectStream: session.isOpen,
      });
      result.hydrated = snap.hasAuthenticatedSession;
      result.userConnectionKey = snap.keyString;
    }

    // 2) Warm shared WS fan-out / baseline (broker-neutral stack).
    // Soft-bound: baseline SQL must not block OAuth / enrich callers.
    const { ensureLiveMarketStack } = await import(
      '@/lib/marketData/ensureLiveMarketStack'
    );
    try {
      const STACK_WAIT_MS = Math.max(
        500,
        Math.min(8_000, Number(process.env.LIVE_FEED_STACK_WAIT_MS) || 2_500),
      );
      let timer: NodeJS.Timeout | undefined;
      const stack = await Promise.race([
        ensureLiveMarketStack(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), STACK_WAIT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (stack) {
        result.stackEnsured = true;
        result.wsRunning = stack.wsRunning;
        result.baselineSymbols = stack.baselineSymbols;
      } else {
        void ensureLiveMarketStack().catch(() => undefined);
      }
    } catch {
      /* non-fatal — streaming may still come up via lazy boot */
    }

    if (!session.isOpen) {
      result.ok = true;
      log.info('market_data_status_changed', {
        userId: input.userId,
        broker,
        ok: true,
        note: 'closed_market_skip_ticker_reconnect',
        userConnectionKey: result.userConnectionKey,
      });
      return result;
    }

    // 3) System feed: only the designated owner may replace the global Kite token/ticker.
    const updateSystem =
      broker === 'zerodha'
      && shouldUpdateSystemKiteFeed(input.userId)
      && systemProvider === 'kite'
      && Boolean(input.accessToken?.trim() || result.hydrated);

    if (updateSystem) {
      const { getKiteClient } = await import('@/lib/kite/client');
      const client = getKiteClient();
      if (input.accessToken?.trim()) {
        client.setAccessToken(input.accessToken.trim());
      } else {
        await client.hydrateAccessTokenFromSession();
      }

      const { getTicker } = await import('@/lib/marketData/kiteTicker');
      const ticker = getTicker();
      ticker.clearLoginRequired();
      try {
        await ticker.disconnect();
      } catch { /* already down */ }
      await ticker.connect();
      const status = ticker.getStatus();
      result.tickerReconnected =
        status.state === 'open'
        || status.state === 'connecting'
        || !status.loginRequired;
      result.systemFeedUpdated = true;

      if (status.loginRequired) {
        result.ok = false;
        result.error = 'kite_login_required';
        return result;
      }
    } else if (broker === 'zerodha' && systemProvider === 'kite') {
      log.info('system_kite_feed_unchanged', {
        userId: input.userId,
        note: 'user is not SYSTEM_MARKET_DATA_USER_ID — per-user connection only',
      });
    }

    result.ok = true;
    log.info('market_data_status_changed', {
      userId: input.userId,
      broker,
      ok: true,
      userConnectionKey: result.userConnectionKey,
      systemFeedUpdated: result.systemFeedUpdated,
      tickerReconnected: result.tickerReconnected,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    log.error('market_data_stream_failed', {
      userId: input.userId,
      broker,
      error: message,
    });
    return result;
  }
}
