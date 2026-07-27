/**
 * Shoonya BrokerMarketDataProvider — Phase 3.
 *
 * Owns: session hydration, WebSocket, subscription format (EXCH|TOKEN),
 * exchange/token mapping, quote + historical conversion, reconnect,
 * session-expiry handling. Emits NormalizedTick only.
 */

import {
  hydrateBrokerSession,
  requireActiveConnection,
  resolveConnection,
  statusFromConnection,
} from './connectionHelpers';
import { NormalizedTickBus } from './tickBus';
import type {
  BrokerConnectionContext,
  BrokerMarketDataProvider,
  BrokerSession,
  HistoricalCandleRequest,
  NormalizedCandle,
  NormalizedInstrument,
  NormalizedQuote,
  NormalizedTickHandler,
  ProviderConnectionStatus,
} from './types';
import { BrokerMarketDataError } from './types';
import {
  isShoonyaDailyInterval,
  shoonyaCandleToNormalized,
  shoonyaIntervalFromBroker,
  shoonyaQuoteToNormalized,
} from './shoonya/convert';
import { resolveShoonyaInstrument } from './shoonya/instruments';
import { ShoonyaRestClient } from './shoonya/restClient';
import {
  disconnectShoonyaTicker,
  getShoonyaTickerForUser,
  type ShoonyaTicker,
} from './shoonya/ticker';

export class ShoonyaMarketDataProvider implements BrokerMarketDataProvider {
  readonly name = 'shoonya' as const;

  private readonly tickBus = new NormalizedTickBus();
  private readonly tickersByUser = new Map<number, ShoonyaTicker>();

  onTick(handler: NormalizedTickHandler): () => void {
    return this.tickBus.on(handler);
  }

  async connect(context: BrokerConnectionContext): Promise<void> {
    const session = await hydrateBrokerSession(this.name, context);
    const client = ShoonyaRestClient.fromHydrated({
      userId: context.userId,
      accessToken: session.accessToken,
      accountId: session.accountId,
    });
    const ticker = getShoonyaTickerForUser(
      context.userId,
      client.getSession(),
      this.tickBus,
    );
    this.tickersByUser.set(context.userId, ticker);
    await ticker.connect();
  }

  async disconnect(context: BrokerConnectionContext): Promise<void> {
    this.tickersByUser.delete(context.userId);
    await disconnectShoonyaTicker(context.userId);
  }

  async isConnected(context: BrokerConnectionContext): Promise<boolean> {
    const row = await resolveConnection(this.name, context);
    return row?.status === 'active';
  }

  async subscribe(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<void> {
    const { client, ticker } = await this.ensureLive(context);
    const { mapManyToShoonya, getSubscriptionBook } = await import('./instruments');
    const { mapped, failed } = await mapManyToShoonya(instruments, client);

    if (mapped.length === 0) {
      throw new BrokerMarketDataError(
        this.name,
        'instrument_unresolved',
        `No Shoonya mappings for: ${failed.slice(0, 5).join(', ') || 'empty'}`,
      );
    }

    const book = getSubscriptionBook(context.userId, 'shoonya');
    const delta = book.applySubscribe(
      mapped.map((m) => ({
        instrument: m.instrument,
        brokerRef: m.scripKey,
      })),
    );

    if (delta.added.length > 0) {
      ticker.subscribeScrips(
        delta.added.map((e) => {
          const [exchange, token] = e.brokerRef.split('|');
          return {
            exchange: exchange || 'NSE',
            token: token || e.brokerRef,
            symbol: e.instrument.symbol,
          };
        }),
      );

      const { acquireBrokerConnection } = await import(
        '@/lib/marketData/connectionManager'
      );
      const conn = acquireBrokerConnection({
        userId: context.userId,
        provider: 'shoonya',
      });
      await conn.subscribe(delta.added.map((e) => e.brokerRef));
    }
  }

  async unsubscribe(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<void> {
    const { ticker } = await this.ensureLive(context);
    const { normalizeInstrument, getSubscriptionBook } = await import('./instruments');
    const keys = instruments.map((i) => normalizeInstrument(i, 'shoonya').instrumentKey);
    const book = getSubscriptionBook(context.userId, 'shoonya');
    const delta = book.applyUnsubscribe(keys);

    if (delta.removed.length > 0) {
      ticker.unsubscribeScrips(
        delta.removed.map((e) => {
          const [exchange, token] = e.brokerRef.split('|');
          return { exchange: exchange || 'NSE', token: token || e.brokerRef };
        }),
      );
      const { getBrokerConnection } = await import(
        '@/lib/marketData/connectionManager'
      );
      const conn = getBrokerConnection({ userId: context.userId, provider: 'shoonya' });
      if (conn) await conn.unsubscribe(delta.removed.map((e) => e.brokerRef));
    }
  }

  async fetchQuote(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<NormalizedQuote[]> {
    const client = await this.restClient(context);
    const out: NormalizedQuote[] = [];
    try {
      for (const inst of instruments) {
        const resolved = await resolveShoonyaInstrument(client, inst);
        const raw = await client.getQuotes(resolved.exchange, resolved.token);
        out.push(
          shoonyaQuoteToNormalized(raw, {
            symbol: resolved.symbol,
            exchange: resolved.exchange,
          }),
        );
      }
      return out;
    } catch (err) {
      if (err instanceof BrokerMarketDataError) throw err;
      throw new BrokerMarketDataError(
        this.name,
        'quote_failed',
        'Failed to fetch Shoonya quotes',
        { cause: err },
      );
    }
  }

  async fetchHistoricalCandles(
    context: BrokerConnectionContext,
    request: HistoricalCandleRequest,
  ): Promise<NormalizedCandle[]> {
    const client = await this.restClient(context);
    const resolved = await resolveShoonyaInstrument(client, request.instrument);
    const fromMs =
      typeof request.from === 'string'
        ? Date.parse(request.from)
        : request.from.getTime();
    const toMs =
      typeof request.to === 'string' ? Date.parse(request.to) : request.to.getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      throw new BrokerMarketDataError(
        this.name,
        'historical_failed',
        'Invalid from/to for Shoonya historical candles',
      );
    }

    try {
      const startUnix = Math.floor(fromMs / 1000);
      const endUnix = Math.floor(toMs / 1000);
      // TPSeries only accepts minute intervals; daily uses EODChartData.
      const raw = isShoonyaDailyInterval(request.interval)
        ? await client.getDailyPriceSeries({
            exch: resolved.exchange,
            tsym: resolved.symbol,
            startUnix,
            endUnix,
          })
        : await client.getTimePriceSeries({
            exch: resolved.exchange,
            token: resolved.token,
            startUnix,
            endUnix,
            intrv: shoonyaIntervalFromBroker(request.interval),
          });
      let candles = raw.map(shoonyaCandleToNormalized);
      candles.sort((a, b) => a.ts.localeCompare(b.ts));
      if (request.limit && request.limit > 0 && candles.length > request.limit) {
        candles = candles.slice(-request.limit);
      }
      return candles;
    } catch (err) {
      if (err instanceof BrokerMarketDataError) throw err;
      throw new BrokerMarketDataError(
        this.name,
        'historical_failed',
        'Failed to fetch Shoonya historical candles',
        { cause: err },
      );
    }
  }

  async refreshSession(context: BrokerConnectionContext): Promise<BrokerSession> {
    const row = await requireActiveConnection(this.name, context);
    // OAuth refresh is not available for Shoonya GenAcsTok; re-hydrate + reconnect WS.
    await this.connect(context);
    return {
      broker: this.name,
      userId: context.userId,
      connectionId: row.id,
      accountId: row.brokerAccountId,
      expiresAt: row.tokenExpiresAt,
      refreshedAt: new Date().toISOString(),
    };
  }

  async getStatus(context: BrokerConnectionContext): Promise<ProviderConnectionStatus> {
    const row = await resolveConnection(this.name, context);
    const ticker = this.tickersByUser.get(context.userId);
    const st = ticker?.getStatus();
    const streamConnected = st?.state === 'open';
    let stateOverride: ProviderConnectionStatus['state'] | undefined;
    if (st?.state === 'connecting') stateOverride = 'reconnecting';
    if (st?.state === 'expired') stateOverride = 'expired';

    const base = statusFromConnection(this.name, row, {
      streamConnected,
      lastTickAt: st?.lastTickAt ? new Date(st.lastTickAt).toISOString() : null,
      lastError: st?.lastError ?? null,
      state: stateOverride,
      detail: row?.status === 'active'
        ? streamConnected
          ? 'shoonya_stream_open'
          : 'shoonya_session_active'
        : row?.status ?? 'no_connection',
    });

    if (base.sessionActive && !streamConnected && !stateOverride) {
      return { ...base, state: 'connected_no_data' };
    }
    return base;
  }

  private async restClient(context: BrokerConnectionContext): Promise<ShoonyaRestClient> {
    const session = await hydrateBrokerSession(this.name, context);
    return ShoonyaRestClient.fromHydrated({
      userId: context.userId,
      accessToken: session.accessToken,
      accountId: session.accountId,
    });
  }

  private async ensureLive(context: BrokerConnectionContext): Promise<{
    client: ShoonyaRestClient;
    ticker: ShoonyaTicker;
  }> {
    const client = await this.restClient(context);
    let ticker = this.tickersByUser.get(context.userId);
    if (!ticker) {
      ticker = getShoonyaTickerForUser(
        context.userId,
        client.getSession(),
        this.tickBus,
      );
      this.tickersByUser.set(context.userId, ticker);
    } else {
      ticker.updateSession(client.getSession());
    }
    await ticker.connect();
    return { client, ticker };
  }
}

export const shoonyaMarketDataProvider = new ShoonyaMarketDataProvider();
