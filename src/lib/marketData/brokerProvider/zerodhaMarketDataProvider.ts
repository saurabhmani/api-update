/**
 * Zerodha (Kite) BrokerMarketDataProvider — Phase 3.
 *
 * Owns: access-token hydration, Kite WS, instrument-token mapping,
 * quote/historical conversion, reconnect (via kiteTicker), subscriptions.
 * Emits NormalizedTick only.
 */

import type { KiteQuote } from '@/lib/kite/types';
import { ensureStreamingAfterBrokerConnect } from '@/lib/marketData/ensureBrokerStreaming';
import { getTicker, type Tick } from '@/lib/marketData/kiteTicker';
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
  kiteCandleToNormalized,
  kiteIntervalFromBroker,
  kiteQuoteToNormalized,
  kiteTickToNormalized,
} from './zerodha/convert';

export class ZerodhaMarketDataProvider implements BrokerMarketDataProvider {
  readonly name = 'zerodha' as const;

  private readonly tickBus = new NormalizedTickBus();
  /** userId → last known exchange/symbol map for tick enrichment */
  private readonly symbolMeta = new Map<string, { exchange: string; symbol: string }>();
  private wiredTicker = false;
  private activeUserId: string | null = null;

  onTick(handler: NormalizedTickHandler): () => void {
    this.ensureTickerBridge();
    return this.tickBus.on(handler);
  }

  async connect(context: BrokerConnectionContext): Promise<void> {
    const session = await hydrateBrokerSession(this.name, context);
    this.activeUserId = String(context.userId);

    // Tenant-safe: never setAccessToken on the process-global client here.
    // ensureStreaming upserts this user's ConnectionKey and only updates the
    // system ticker when userId === SYSTEM_MARKET_DATA_USER_ID.
    const result = await ensureStreamingAfterBrokerConnect({
      userId: context.userId,
      broker: 'zerodha',
      accessToken: session.accessToken,
      accountId: session.accountId,
    });

    if (!result.ok && result.error === 'kite_login_required') {
      throw new BrokerMarketDataError(
        this.name,
        'not_connected',
        'Zerodha live feed requires an active Kite session',
      );
    }
    if (!result.ok && !result.userConnectionKey) {
      throw new BrokerMarketDataError(
        this.name,
        'provider_error',
        result.error ?? 'failed to start Zerodha market-data stream',
      );
    }

    this.ensureTickerBridge();
  }

  async disconnect(context: BrokerConnectionContext): Promise<void> {
    const { releaseBrokerConnection, isSystemFeedOwner } = await import(
      '@/lib/marketData/connectionManager'
    );
    await releaseBrokerConnection({ userId: context.userId, provider: 'zerodha' });

    // Never tear down another tenant's / the system ticker unless this user owns it.
    if (isSystemFeedOwner(context.userId)) {
      try {
        await getTicker().disconnect();
      } catch { /* already down */ }
    }
    if (this.activeUserId === String(context.userId)) {
      this.activeUserId = null;
    }
  }

  async isConnected(context: BrokerConnectionContext): Promise<boolean> {
    const row = await resolveConnection(this.name, context);
    return row?.status === 'active';
  }

  async subscribe(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<void> {
    await this.connect(context);

    const { mapManyToZerodha, getSubscriptionBook } = await import('./instruments');
    const { mapped, failed } = await mapManyToZerodha(instruments);
    if (mapped.length === 0) {
      throw new BrokerMarketDataError(
        this.name,
        'instrument_unresolved',
        `No Zerodha mappings for: ${failed.slice(0, 5).join(', ') || 'empty'}`,
      );
    }

    const book = getSubscriptionBook(context.userId, 'zerodha');
    const delta = book.applySubscribe(
      mapped.map((m) => ({
        instrument: m.instrument,
        brokerRef: String(m.instrumentToken),
      })),
    );

    for (const m of mapped) {
      this.symbolMeta.set(m.instrument.symbol, {
        exchange: m.instrument.exchange,
        symbol: m.instrument.symbol,
      });
    }

    const { acquireBrokerConnection, isSystemFeedOwner } = await import(
      '@/lib/marketData/connectionManager'
    );
    const conn = acquireBrokerConnection({
      userId: context.userId,
      provider: 'zerodha',
    });

    const refsToWire = delta.added.map((e) => e.brokerRef);
    if (refsToWire.length > 0) {
      await conn.subscribe(refsToWire);
    }

    if (isSystemFeedOwner(context.userId) && refsToWire.length > 0) {
      const symbols = delta.added.map((e) => e.instrument.symbol);
      await getTicker().subscribeSymbols(symbols, 'full');
    }

    if (failed.length > 0 && delta.added.length === 0 && delta.already.length === 0) {
      throw new BrokerMarketDataError(
        this.name,
        'instrument_unresolved',
        `No Zerodha mappings for: ${failed.slice(0, 5).join(', ')}`,
      );
    }
  }

  async unsubscribe(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<void> {
    const { normalizeInstrument, getSubscriptionBook } = await import('./instruments');
    const keys = instruments.map((i) => normalizeInstrument(i, 'zerodha').instrumentKey);
    const book = getSubscriptionBook(context.userId, 'zerodha');
    const delta = book.applyUnsubscribe(keys);

    const { getBrokerConnection, isSystemFeedOwner } = await import(
      '@/lib/marketData/connectionManager'
    );
    const conn = getBrokerConnection({ userId: context.userId, provider: 'zerodha' });
    if (conn && delta.removed.length > 0) {
      await conn.unsubscribe(delta.removed.map((e) => e.brokerRef));
    }
    if (isSystemFeedOwner(context.userId) && delta.removed.length > 0) {
      await getTicker().unsubscribeSymbols(
        delta.removed.map((e) => e.instrument.symbol),
      );
    }
    for (const e of delta.removed) this.symbolMeta.delete(e.instrument.symbol);
  }

  async fetchQuote(
    context: BrokerConnectionContext,
    instruments: NormalizedInstrument[],
  ): Promise<NormalizedQuote[]> {
    const session = await hydrateBrokerSession(this.name, context);
    const { mapManyToZerodha } = await import('./instruments');
    const { mapped, failed } = await mapManyToZerodha(instruments);
    if (mapped.length === 0) {
      throw new BrokerMarketDataError(
        this.name,
        'instrument_unresolved',
        `No Zerodha mappings for: ${failed.slice(0, 5).join(', ') || 'empty'}`,
      );
    }
    const keys = mapped.map((m) => m.kiteKey);

    try {
      const map = await this.withUserKiteClient(session.accessToken, (kc) =>
        kc.getQuote(keys),
      );
      const out: NormalizedQuote[] = [];
      for (const key of keys) {
        const quote = (map as Record<string, KiteQuote>)[key];
        if (!quote) continue;
        out.push(kiteQuoteToNormalized(key, quote));
      }
      return out;
    } catch (err) {
      throw new BrokerMarketDataError(
        this.name,
        'quote_failed',
        'Failed to fetch Zerodha quotes',
        { cause: err },
      );
    }
  }

  async fetchHistoricalCandles(
    context: BrokerConnectionContext,
    request: HistoricalCandleRequest,
  ): Promise<NormalizedCandle[]> {
    const session = await hydrateBrokerSession(this.name, context);
    const { mapToZerodhaInstrument } = await import('./instruments');
    const mapped = await mapToZerodhaInstrument(request.instrument);
    const token = mapped.instrumentToken;

    const from =
      typeof request.from === 'string' ? request.from : request.from.toISOString();
    const to = typeof request.to === 'string' ? request.to : request.to.toISOString();

    try {
      const candles = await this.withUserKiteClient(session.accessToken, (kc) =>
        kc.getHistoricalData(
          token,
          kiteIntervalFromBroker(request.interval),
          from,
          to,
          false,
          false,
        ),
      );
      let normalized = (candles as Array<{
        date: Date;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }>).map(kiteCandleToNormalized);
      if (request.limit && request.limit > 0 && normalized.length > request.limit) {
        normalized = normalized.slice(-request.limit);
      }
      return normalized;
    } catch (err) {
      if (err instanceof BrokerMarketDataError) throw err;
      throw new BrokerMarketDataError(
        this.name,
        'historical_failed',
        'Failed to fetch Zerodha historical candles',
        { cause: err },
      );
    }
  }

  /** Per-request KiteConnect — does not mutate the process-global singleton. */
  private async withUserKiteClient<T>(
    accessToken: string,
    fn: (kc: import('kiteconnect').Connect) => Promise<T>,
  ): Promise<T> {
    const { KiteConnect } = await import('kiteconnect');
    const apiKey = (process.env.KITE_API_KEY ?? '').trim();
    if (!apiKey) {
      throw new BrokerMarketDataError(this.name, 'provider_error', 'KITE_API_KEY missing');
    }
    const kc = new KiteConnect({ api_key: apiKey, access_token: accessToken });
    kc.setAccessToken(accessToken);
    return fn(kc);
  }

  async refreshSession(context: BrokerConnectionContext): Promise<BrokerSession> {
    const row = await requireActiveConnection(this.name, context);
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
    let streamConnected = false;
    let lastTickAt: string | null = null;
    let lastError: string | null = null;
    let stateOverride: ProviderConnectionStatus['state'] | undefined;

    try {
      const st = getTicker().getStatus();
      streamConnected = st.state === 'open';
      if (st.state === 'connecting') stateOverride = 'reconnecting';
      if (st.lastTickAt) lastTickAt = new Date(st.lastTickAt).toISOString();
      lastError = st.lastError;
    } catch {
      streamConnected = false;
    }

    const base = statusFromConnection(this.name, row, {
      streamConnected,
      lastTickAt,
      lastError,
      state: stateOverride,
    });
    if (base.sessionActive && !streamConnected && !stateOverride) {
      return { ...base, state: 'connected_no_data' };
    }
    return base;
  }

  private ensureTickerBridge(): void {
    if (this.wiredTicker) return;
    this.wiredTicker = true;
    getTicker().on('ticks', (ticks: Tick[]) => {
      const userId = this.activeUserId ?? '0';
      for (const tick of ticks) {
        const sym = (tick.symbol || '').toUpperCase();
        const meta = this.symbolMeta.get(sym) ?? { exchange: 'NSE', symbol: sym };
        this.tickBus.emit(
          kiteTickToNormalized({
            tick,
            userId,
            exchange: meta.exchange,
            symbol: meta.symbol || sym,
          }),
        );
      }
    });
  }
}

export const zerodhaMarketDataProvider = new ZerodhaMarketDataProvider();
