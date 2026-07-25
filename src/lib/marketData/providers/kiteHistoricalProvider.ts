// ════════════════════════════════════════════════════════════════
//  kiteHistoricalProvider — Phase 6 historical envelope over
//  KiteAdapter.getHistorical / getHistoricalByInterval.
//
//  OHLC history provider:
//    • never throws to callers
//    • returns ProviderInvocation-shaped envelope
//    • maps auth / rate-limit / empty into stable error codes
//
//  Jobs, chart service, and scripts must call this (or
//  candleFallbackChain) — never `src/lib/kite` directly.
// ════════════════════════════════════════════════════════════════

import { getKiteClient, loadKiteConfig } from '@/lib/kite';
import {
  KiteAuthenticationError,
  KiteRateLimitError,
} from '@/lib/kite/errors';
import * as Kite from '@/providers/adapters/KiteAdapter';
import type { HistoricalRange, HistoricalSeries } from '@/types/market';
import {
  chartIntervalToHistoricalRange,
} from '@/lib/marketData/historicalIntervalMap';

export type KiteHistStatus = 'success' | 'partial' | 'failed';

export interface KiteHistoricalInvocation {
  provider: 'kite';
  endpoint: string;
  requestStartedAt: string;
  responseReceivedAt: string;
  latencyMs: number;
  status: KiteHistStatus;
  errorCode: string | null;
  errorMessage: string | null;
  data: HistoricalSeries | null;
}

export type KiteHistoricalErrorCode =
  | 'KITE_NOT_CONFIGURED'
  | 'KiteAuthenticationError'
  | 'KiteRateLimitError'
  | 'EMPTY_RESPONSE'
  | 'UPSTREAM_ERROR';

/**
 * True when API key is set and a session access token is already loaded
 * in-process. Prefer `ensureKiteHistoricalConfigured()` before jobs.
 */
export function isKiteHistoricalConfigured(): boolean {
  const cfg = loadKiteConfig();
  return Boolean(cfg.apiKey && getKiteClient().getAccessToken());
}

/** Hydrate session token from the system feed owner only, then check readiness. */
export async function ensureKiteHistoricalConfigured(): Promise<boolean> {
  const cfg = loadKiteConfig();
  if (!cfg.apiKey) return false;

  const { isSystemOwnedIngestionConfigured } = await import(
    '@/lib/marketData/jobs/jobClassification'
  );
  if (!isSystemOwnedIngestionConfigured()) {
    return false;
  }

  await getKiteClient().hydrateAccessTokenFromSession();
  return Boolean(getKiteClient().getAccessToken());
}

function nowIso(): string {
  return new Date().toISOString();
}

function failedInv(
  endpoint: string,
  startedAt: string,
  t0: number,
  errorCode: string,
  errorMessage: string,
): KiteHistoricalInvocation {
  return {
    provider: 'kite',
    endpoint,
    requestStartedAt: startedAt,
    responseReceivedAt: nowIso(),
    latencyMs: Date.now() - t0,
    status: 'failed',
    errorCode,
    errorMessage,
    data: null,
  };
}

function mapThrownError(err: unknown): { code: string; message: string } {
  if (err instanceof KiteAuthenticationError) {
    return { code: 'KiteAuthenticationError', message: err.message };
  }
  if (err instanceof KiteRateLimitError) {
    return { code: 'KiteRateLimitError', message: err.message };
  }
  const name = err instanceof Error ? err.name : 'KiteError';
  const message = err instanceof Error ? err.message : String(err);
  if (/auth|token|403|401/i.test(message) || name.includes('Auth')) {
    return { code: 'KiteAuthenticationError', message };
  }
  if (/rate|429/i.test(message) || name.includes('Rate')) {
    return { code: 'KiteRateLimitError', message };
  }
  return { code: 'UPSTREAM_ERROR', message };
}

/**
 * Fetch historical OHLC via KiteAdapter.getHistorical → HistoricalSeries.
 */
export async function getHistorical(
  symbol: string,
  range: HistoricalRange = '1y',
): Promise<KiteHistoricalInvocation> {
  const sym = String(symbol ?? '').trim().toUpperCase();
  const endpoint = `kite.historical:${range}`;
  const startedAt = nowIso();
  const t0 = Date.now();

  if (!sym) {
    return failedInv(endpoint, startedAt, t0, 'UPSTREAM_ERROR', 'empty symbol');
  }

  if (!(await ensureKiteHistoricalConfigured())) {
    return failedInv(
      endpoint,
      startedAt,
      t0,
      'KITE_NOT_CONFIGURED',
      'No active Kite session — connect Zerodha from the dashboard',
    );
  }

  try {
    console.log(`[PROVIDER] attempt provider=kite method=getHistorical symbol=${sym} range=${range}`);
    const series = await Kite.getHistorical(sym, range);
    const bars = series.candles?.length ?? 0;
    if (bars === 0) {
      console.log(
        `[PROVIDER] fail provider=kite method=getHistorical symbol=${sym} reason=EMPTY_RESPONSE`,
      );
      return failedInv(
        endpoint,
        startedAt,
        t0,
        'EMPTY_RESPONSE',
        'Kite returned zero candles',
      );
    }
    console.log(
      `[PROVIDER] success provider=kite method=getHistorical symbol=${sym} ` +
      `bars=${bars} latency_ms=${Date.now() - t0}`,
    );
    return {
      provider: 'kite',
      endpoint,
      requestStartedAt: startedAt,
      responseReceivedAt: nowIso(),
      latencyMs: Date.now() - t0,
      status: 'success',
      errorCode: null,
      errorMessage: null,
      data: series,
    };
  } catch (err) {
    const { code, message } = mapThrownError(err);
    console.log(
      `[PROVIDER] fallback from=kite to=legacy_vendor reason=${code} symbol=${sym}`,
    );
    return failedInv(endpoint, startedAt, t0, code, message);
  }
}

/**
 * Chart-interval historical via KiteAdapter.getHistoricalByInterval.
 * Daily-only aliases still return HistoricalSeries (same contract).
 */
export async function getHistoricalForInterval(
  symbol: string,
  appInterval: string,
  from?: string | null,
  to?: string | null,
): Promise<KiteHistoricalInvocation> {
  const range = chartIntervalToHistoricalRange(appInterval);
  const sym = String(symbol ?? '').trim().toUpperCase();
  const endpoint = `kite.historical_interval:${appInterval}`;
  const startedAt = nowIso();
  const t0 = Date.now();

  if (!(await ensureKiteHistoricalConfigured())) {
    return failedInv(
      endpoint,
      startedAt,
      t0,
      'KITE_NOT_CONFIGURED',
      'No active Kite session — connect Zerodha from the dashboard',
    );
  }

  try {
    console.log(
      `[PROVIDER] attempt provider=kite method=getHistoricalByInterval ` +
      `symbol=${sym} interval=${appInterval}`,
    );
    const series = await Kite.getHistoricalByInterval(
      sym,
      appInterval,
      range,
      from,
      to,
    );
    const bars = series.candles?.length ?? 0;
    if (bars === 0) {
      return failedInv(
        endpoint,
        startedAt,
        t0,
        'EMPTY_RESPONSE',
        'Kite returned zero candles',
      );
    }
    console.log(
      `[PROVIDER] success provider=kite method=getHistoricalByInterval ` +
      `symbol=${sym} bars=${bars} latency_ms=${Date.now() - t0}`,
    );
    return {
      provider: 'kite',
      endpoint,
      requestStartedAt: startedAt,
      responseReceivedAt: nowIso(),
      latencyMs: Date.now() - t0,
      status: 'success',
      errorCode: null,
      errorMessage: null,
      data: series,
    };
  } catch (err) {
    const { code, message } = mapThrownError(err);
    console.log(
      `[PROVIDER] fallback from=kite to=legacy_vendor reason=${code} symbol=${sym}`,
    );
    return failedInv(endpoint, startedAt, t0, code, message);
  }
}
