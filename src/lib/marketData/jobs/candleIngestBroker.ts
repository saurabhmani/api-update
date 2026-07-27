/**
 * Candle warehouse ingest broker resolution (single-tenant friendly).
 *
 * Prefer the configured SYSTEM_MARKET_DATA_USER_ID's *active* data source
 * (Shoonya or Zerodha). When CANDLE_INGEST_USE_CONNECTED_BROKER is enabled
 * (default on) and SYSTEM_MARKET_DATA_USER_ID is unset, fall back to any
 * active primary / sole connected broker.
 *
 * Live quotes and warehouse candles then share the same connected source.
 */

import type { DataSourceBroker } from '@/lib/broker/connections/types';
import { getSystemMarketDataUserId } from '@/lib/marketData/connectionManager/systemFeed';
import type { HistoricalRange } from '@/types/market';
import type { Candle } from '@/lib/signal-engine';

export interface CandleIngestFetchResult {
  ok: boolean;
  candles: Candle[];
  errorCode: string | null;
  errorMessage: string | null;
  rawBarCount: number;
  validBarCount: number;
  provider: 'kite' | 'shoonya' | null;
  warehouseSource: 'kite' | 'shoonya';
}

export interface CandleIngestBroker {
  userId: number;
  broker: DataSourceBroker;
  connectionId: string | null;
  reason: 'system_user_active' | 'system_user_sole' | 'any_connected_primary' | 'any_connected_sole';
}

function envFlagOn(name: string, defaultOn = true): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** When true, candle jobs may use the connected active broker (incl. Shoonya). */
export function isConnectedBrokerCandleIngestEnabled(): boolean {
  return envFlagOn('CANDLE_INGEST_USE_CONNECTED_BROKER', true);
}

export function historicalRangeToWindow(range: HistoricalRange): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime());
  switch (range) {
    case '1d':
      from.setUTCDate(from.getUTCDate() - 1);
      break;
    case '5d':
      from.setUTCDate(from.getUTCDate() - 5);
      break;
    case '1mo':
      from.setUTCMonth(from.getUTCMonth() - 1);
      break;
    case '3mo':
      from.setUTCMonth(from.getUTCMonth() - 3);
      break;
    case '6mo':
      from.setUTCMonth(from.getUTCMonth() - 6);
      break;
    case '5y':
      from.setUTCFullYear(from.getUTCFullYear() - 5);
      break;
    case '1y':
    default:
      from.setUTCFullYear(from.getUTCFullYear() - 1);
      break;
  }
  return { from, to };
}

/**
 * Resolve which broker credentials to use for warehouse candle ingest.
 */
export async function resolveCandleIngestBroker(): Promise<CandleIngestBroker> {
  const { getUserActiveDataSource } = await import(
    '@/lib/broker/connections/activeDataSource'
  );
  const { listBrokerConnectionsForUser } = await import(
    '@/lib/broker/connections/repository'
  );
  const { isBrokerTokenExpired } = await import('@/lib/broker/connections/expiry');

  const systemId = getSystemMarketDataUserId();
  if (systemId != null) {
    const active = await getUserActiveDataSource(systemId);
    if (active.provider && active.isConnected && !active.needsSelection) {
      return {
        userId: systemId,
        broker: active.provider,
        connectionId: active.connectionId,
        reason: 'system_user_active',
      };
    }
    // Fall through to sole usable connection on that user.
    const rows = await listBrokerConnectionsForUser(systemId);
    const usable = rows.filter(
      (r) =>
        r.status === 'active'
        && r.accessTokenEncrypted
        && !isBrokerTokenExpired(r.tokenExpiresAt),
    );
    if (usable.length === 1) {
      return {
        userId: systemId,
        broker: usable[0].broker,
        connectionId: usable[0].id,
        reason: 'system_user_sole',
      };
    }
    if (usable.length > 1) {
      const primary = usable.find((r) => r.isPrimary) ?? usable[0];
      return {
        userId: systemId,
        broker: primary.broker,
        connectionId: primary.id,
        reason: 'system_user_active',
      };
    }
    throw new Error(
      `SYSTEM_MARKET_DATA_USER_ID=${systemId} has no connected Zerodha/Shoonya — `
      + 'connect a broker on /data-source for that user',
    );
  }

  if (!isConnectedBrokerCandleIngestEnabled()) {
    throw new Error(
      'System candle ingest unavailable — set SYSTEM_MARKET_DATA_USER_ID and connect '
      + 'Zerodha/Shoonya on /data-source, or enable CANDLE_INGEST_USE_CONNECTED_BROKER=1',
    );
  }

  // Single-tenant fallback: any active broker connection (primary preferred).
  const { db } = await import('@/lib/db');
  const { rows } = await db.query<{
    user_id: number;
    broker: DataSourceBroker;
    id: string;
    is_primary: number | boolean;
  }>(
    `SELECT user_id, broker, id, is_primary
       FROM broker_connections
      WHERE status = 'active'
        AND access_token_encrypted IS NOT NULL
        AND access_token_encrypted <> ''
      ORDER BY is_primary DESC, updated_at DESC
      LIMIT 5`,
  );

  if (!rows.length) {
    throw new Error(
      'No active broker connection found — connect Shoonya or Zerodha on /data-source',
    );
  }

  const pick = rows[0];
  return {
    userId: Number(pick.user_id),
    broker: pick.broker,
    connectionId: pick.id,
    reason: pick.is_primary ? 'any_connected_primary' : 'any_connected_sole',
  };
}

/** True when ingest can proceed (connected broker or classic system Kite). */
export async function ensureCandleIngestConfigured(): Promise<{
  ok: boolean;
  ingest: CandleIngestBroker | null;
  message: string;
}> {
  try {
    if (isConnectedBrokerCandleIngestEnabled()) {
      const ingest = await resolveCandleIngestBroker();
      return {
        ok: true,
        ingest,
        message: `connected ${ingest.broker} userId=${ingest.userId} (${ingest.reason})`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fall through to classic Kite check when connected-broker path fails.
    if (!getSystemMarketDataUserId()) {
      return { ok: false, ingest: null, message: msg };
    }
  }

  const { ensureKiteHistoricalConfigured } = await import(
    '@/lib/marketData/providers/kiteHistoricalProvider'
  );
  if (await ensureKiteHistoricalConfigured()) {
    const userId = getSystemMarketDataUserId()!;
    return {
      ok: true,
      ingest: {
        userId,
        broker: 'zerodha',
        connectionId: null,
        reason: 'system_user_active',
      },
      message: `system kite userId=${userId}`,
    };
  }

  try {
    const ingest = await resolveCandleIngestBroker();
    return {
      ok: true,
      ingest,
      message: `connected ${ingest.broker} userId=${ingest.userId}`,
    };
  } catch (err) {
    return {
      ok: false,
      ingest: null,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeAdapterCandles(
  raw: Array<{ ts: string; open: number; high: number; low: number; close: number; volume: number }>,
): { candles: Candle[]; rawBarCount: number; validBarCount: number } {
  const candles: Candle[] = [];
  const rawBarCount = raw.length;
  for (const c of raw) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    if (
      !Number.isFinite(c.open) || !Number.isFinite(c.high)
      || !Number.isFinite(c.low) || !Number.isFinite(c.close)
    ) continue;
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) continue;
    candles.push({
      ts: new Date(t).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: Number.isFinite(c.volume) ? c.volume : 0,
    });
  }
  candles.sort(
    (a, b) => new Date(a.ts as string).getTime() - new Date(b.ts as string).getTime(),
  );
  return { candles, rawBarCount, validBarCount: candles.length };
}

/**
 * Fetch daily bars from the resolved connected broker (Shoonya or Zerodha).
 */
export async function fetchConnectedBrokerDailyCandles(
  symbol: string,
  range: HistoricalRange = '1y',
  ingest?: CandleIngestBroker,
): Promise<CandleIngestFetchResult> {
  const sym = symbol.toUpperCase();
  let resolved = ingest;
  try {
    resolved = resolved ?? await resolveCandleIngestBroker();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      candles: [],
      errorCode: 'NOT_CONFIGURED',
      errorMessage: msg,
      rawBarCount: 0,
      validBarCount: 0,
      provider: null,
      warehouseSource: 'kite',
    };
  }

  if (resolved.broker === 'zerodha') {
    // Prefer per-user Zerodha adapter; fall back to classic Kite historical
    // when the system feed owner token is hydrated in-process.
    try {
      const { getBrokerMarketDataProvider } = await import(
        '@/lib/marketData/brokerProvider'
      );
      const { normalizeInstrument } = await import(
        '@/lib/marketData/brokerProvider/instruments/normalize'
      );
      const adapter = getBrokerMarketDataProvider('zerodha');
      const ctx = {
        userId: resolved.userId,
        connectionId: resolved.connectionId ?? undefined,
      };
      await adapter.connect(ctx);
      const { from, to } = historicalRangeToWindow(range);
      const bars = await adapter.fetchHistoricalCandles(ctx, {
        instrument: normalizeInstrument({
          exchange: 'NSE',
          symbol: sym,
          instrumentType: 'EQ',
        }),
        interval: 'day',
        from,
        to,
      });
      const { candles, rawBarCount, validBarCount } = normalizeAdapterCandles(bars);
      if (validBarCount === 0) {
        return {
          ok: false,
          candles: [],
          errorCode: 'EMPTY_RESPONSE',
          errorMessage: 'Zerodha returned zero candles',
          rawBarCount,
          validBarCount: 0,
          provider: 'kite',
          warehouseSource: 'kite',
        };
      }
      console.log(
        `[ZERODHA FETCH OK] symbol=${sym} bars=${validBarCount} userId=${resolved.userId}`,
      );
      return {
        ok: true,
        candles,
        errorCode: null,
        errorMessage: null,
        rawBarCount,
        validBarCount,
        provider: 'kite',
        warehouseSource: 'kite',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Classic path for SYSTEM_MARKET_DATA_USER_ID kite hydrate.
      try {
        const { getKiteClient } = await import('@/lib/kite/client');
        if (getSystemMarketDataUserId() === resolved.userId) {
          await getKiteClient().hydrateAccessTokenFromSession();
        }
        const { getHistorical: getKiteHistorical, ensureKiteHistoricalConfigured } =
          await import('@/lib/marketData/providers/kiteHistoricalProvider');
        if (!(await ensureKiteHistoricalConfigured())) {
          return {
            ok: false,
            candles: [],
            errorCode: 'KITE_NOT_CONFIGURED',
            errorMessage: msg,
            rawBarCount: 0,
            validBarCount: 0,
            provider: 'kite',
            warehouseSource: 'kite',
          };
        }
        const inv = await getKiteHistorical(sym, range);
        if (inv.status !== 'success' || !inv.data?.candles?.length) {
          return {
            ok: false,
            candles: [],
            errorCode: inv.errorCode ?? 'EMPTY_RESPONSE',
            errorMessage: inv.errorMessage ?? msg,
            rawBarCount: 0,
            validBarCount: 0,
            provider: 'kite',
            warehouseSource: 'kite',
          };
        }
        const mapped = inv.data.candles.map((c) => ({
          ts: new Date(c.t).toISOString(),
          open: c.o,
          high: c.h,
          low: c.l,
          close: c.c,
          volume: Number.isFinite(c.v) ? (c.v as number) : 0,
        }));
        const { candles, rawBarCount, validBarCount } = normalizeAdapterCandles(mapped);
        return {
          ok: validBarCount > 0,
          candles,
          errorCode: validBarCount > 0 ? null : 'MALFORMED_RESPONSE',
          errorMessage: validBarCount > 0 ? null : 'Kite bars failed validation',
          rawBarCount,
          validBarCount,
          provider: 'kite',
          warehouseSource: 'kite',
        };
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        return {
          ok: false,
          candles: [],
          errorCode: 'UPSTREAM_ERROR',
          errorMessage: msg2 || msg,
          rawBarCount: 0,
          validBarCount: 0,
          provider: 'kite',
          warehouseSource: 'kite',
        };
      }
    }
  }

  // Shoonya
  try {
    const { getBrokerMarketDataProvider } = await import(
      '@/lib/marketData/brokerProvider'
    );
    const { normalizeInstrument } = await import(
      '@/lib/marketData/brokerProvider/instruments/normalize'
    );
    const adapter = getBrokerMarketDataProvider('shoonya');
    const ctx = {
      userId: resolved.userId,
      connectionId: resolved.connectionId ?? undefined,
    };
    await adapter.connect(ctx);
    const { from, to } = historicalRangeToWindow(range);
    const bars = await adapter.fetchHistoricalCandles(ctx, {
      instrument: normalizeInstrument({
        exchange: 'NSE',
        symbol: sym,
        instrumentType: 'EQ',
      }),
      interval: 'day',
      from,
      to,
    });
    const { candles, rawBarCount, validBarCount } = normalizeAdapterCandles(bars);
    if (validBarCount === 0) {
      return {
        ok: false,
        candles: [],
        errorCode: 'EMPTY_RESPONSE',
        errorMessage: 'Shoonya returned zero candles',
        rawBarCount,
        validBarCount: 0,
        provider: 'shoonya',
        warehouseSource: 'shoonya',
      };
    }
    console.log(
      `[SHOONYA FETCH OK] symbol=${sym} bars=${validBarCount} raw_bars=${rawBarCount} userId=${resolved.userId}`,
    );
    return {
      ok: true,
      candles,
      errorCode: null,
      errorMessage: null,
      rawBarCount,
      validBarCount,
      provider: 'shoonya',
      warehouseSource: 'shoonya',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SHOONYA FETCH FAIL] symbol=${sym} reason="${msg}"`);
    return {
      ok: false,
      candles: [],
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: msg,
      rawBarCount: 0,
      validBarCount: 0,
      provider: 'shoonya',
      warehouseSource: 'shoonya',
    };
  }
}
