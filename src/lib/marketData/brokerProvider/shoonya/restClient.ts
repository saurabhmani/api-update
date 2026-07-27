/**
 * Shoonya OAuth REST client for market data (quotes, search, historical).
 * Uses Bearer access_token from GenAcsTok — never leaks tokens in errors.
 */

import { getShoonyaConfig } from '@/lib/broker/oauth/shoonya';
import { logger } from '@/lib/logger';
import {
  isSessionExpiryMessage,
  markProviderSessionExpired,
} from '../connectionHelpers';
import { BrokerMarketDataError } from '../types';
import type { ShoonyaCandleRaw, ShoonyaQuoteRaw } from './convert';

const log = logger.child({ component: 'shoonya.rest' });

const DEFAULT_BASE = 'https://api.shoonya.com';

export interface ShoonyaSessionCreds {
  userId: number;
  accessToken: string;
  uid: string;
  actid: string;
}

export interface ShoonyaScripHit {
  exch: string;
  token: string;
  tsym: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Historical chart calls can be slow; default 90s (override via SHOONYA_HISTORICAL_TIMEOUT_MS). */
function historicalTimeoutMs(): number {
  const raw = Number(process.env.SHOONYA_HISTORICAL_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 10_000) return Math.floor(raw);
  return 90_000;
}

/**
 * EODChartData often returns a JSON array of JSON *strings*;
 * TPSeries usually returns objects (sometimes under `values`).
 */
function normalizeCandlePayload(json: unknown): ShoonyaCandleRaw[] {
  const values = Array.isArray((json as { values?: unknown }).values)
    ? ((json as { values: unknown[] }).values)
    : Array.isArray(json)
      ? json
      : [];

  const out: ShoonyaCandleRaw[] = [];
  for (const row of values) {
    if (typeof row === 'string') {
      try {
        const parsed = JSON.parse(row) as unknown;
        if (isRecord(parsed)) out.push(parsed as ShoonyaCandleRaw);
      } catch {
        // skip malformed row
      }
      continue;
    }
    if (isRecord(row)) out.push(row as ShoonyaCandleRaw);
  }
  return out;
}

export class ShoonyaRestClient {
  private readonly baseUrl: string;

  constructor(
    private readonly session: ShoonyaSessionCreds,
    baseUrl = process.env.SHOONYA_API_BASE_URL?.trim() || DEFAULT_BASE,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  static fromHydrated(input: {
    userId: number;
    accessToken: string;
    accountId: string | null;
  }): ShoonyaRestClient {
    let uid: string;
    try {
      uid = getShoonyaConfig().uid;
    } catch {
      uid = (input.accountId || '').replace(/_U$/i, '').trim();
    }
    const actid = (input.accountId || uid).trim() || uid;
    if (!uid) {
      throw new BrokerMarketDataError(
        'shoonya',
        'not_connected',
        'Shoonya uid unavailable — check SHOONYA_UID / account id',
      );
    }
    return new ShoonyaRestClient({
      userId: input.userId,
      accessToken: input.accessToken,
      uid,
      actid,
    });
  }

  getSession(): ShoonyaSessionCreds {
    return this.session;
  }

  async getQuotes(exch: string, token: string): Promise<ShoonyaQuoteRaw> {
    const json = await this.post('/NorenWClientAPI/GetQuotes', {
      uid: this.session.uid,
      exch,
      token,
    });
    return json as ShoonyaQuoteRaw;
  }

  async searchScrip(stext: string, exch?: string): Promise<ShoonyaScripHit[]> {
    const json = await this.post('/NorenWClientAPI/SearchScrip', {
      uid: this.session.uid,
      stext,
      ...(exch ? { exch } : {}),
    });
    const values = Array.isArray((json as { values?: unknown }).values)
      ? ((json as { values: unknown[] }).values)
      : [];
    const hits: ShoonyaScripHit[] = [];
    for (const row of values) {
      if (!isRecord(row)) continue;
      const token = pickString(row, ['token', 'tok', 'tsym_token']);
      const rowExch = pickString(row, ['exch', 'exchange', 'e']);
      const tsym = pickString(row, ['tsym', 'symbol', 'tradingsymbol']);
      if (!token || !rowExch || !tsym) continue;
      hits.push({ exch: rowExch.toUpperCase(), token, tsym });
    }
    return hits;
  }

  async getTimePriceSeries(input: {
    exch: string;
    token: string;
    startUnix: number;
    endUnix: number;
    intrv: string;
  }): Promise<ShoonyaCandleRaw[]> {
    const json = await this.post(
      '/NorenWClientAPI/TPSeries',
      {
        uid: this.session.uid,
        exch: input.exch,
        token: input.token,
        st: String(input.startUnix),
        et: String(input.endUnix),
        intrv: input.intrv,
      },
      { timeoutMs: historicalTimeoutMs() },
    );
    return normalizeCandlePayload(json);
  }

  /**
   * Daily EOD bars — Shoonya `EODChartData` (NOT TPSeries).
   * TPSeries only accepts minute intervals; `intrv=D` hangs/timeouts.
   * @see https://github.com/Shoonya-Dev/ShoonyaApi-py (get_daily_price_series)
   */
  async getDailyPriceSeries(input: {
    exch: string;
    /** Trading symbol e.g. RELIANCE-EQ */
    tsym: string;
    startUnix: number;
    endUnix: number;
  }): Promise<ShoonyaCandleRaw[]> {
    const exch = input.exch.toUpperCase();
    const tsym = /-(EQ|BE|BL)$/i.test(input.tsym)
      ? input.tsym.toUpperCase()
      : `${input.tsym.toUpperCase()}-EQ`;
    // Official ShoonyaApi-py uses `NSE:RELIANCE-EQ` (no spaces).
    const trySyms = [`${exch}:${tsym}`, `${exch} : ${tsym}`];
    let lastError: unknown;
    for (const sym of trySyms) {
      try {
        const json = await this.post(
          '/NorenWClientAPI/EODChartData',
          {
            uid: this.session.uid,
            sym,
            st: String(input.startUnix),
            et: String(input.endUnix),
          },
          { timeoutMs: historicalTimeoutMs() },
        );
        const rows = normalizeCandlePayload(json);
        if (rows.length > 0) return rows;
        // Empty array — try alternate sym formatting once.
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    return [];
  }

  private async post(
    path: string,
    data: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown> | unknown[]> {
    const url = `${this.baseUrl}${path}`;
    const body = `jData=${JSON.stringify(data)}`;
    const timeoutMs = opts?.timeoutMs ?? 20_000;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Bearer ${this.session.accessToken}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? 'Shoonya market-data request timed out'
        : 'Unable to reach Shoonya market-data API';
      throw new BrokerMarketDataError('shoonya', 'provider_error', msg, { cause: err });
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BrokerMarketDataError(
        'shoonya',
        'provider_error',
        'Invalid JSON from Shoonya market-data API',
      );
    }

    const emsg = isRecord(parsed)
      ? pickString(parsed, ['emsg', 'message', 'error'])
      : undefined;
    const stat = isRecord(parsed) ? pickString(parsed, ['stat', 'status']) : undefined;

    if (
      response.status === 401
      || response.status === 403
      || isSessionExpiryMessage(emsg)
      || (stat && /not_?ok/i.test(stat) && isSessionExpiryMessage(emsg))
    ) {
      await markProviderSessionExpired('shoonya', this.session.userId);
      log.warn('Shoonya session expired on REST', { path, userId: this.session.userId });
      throw new BrokerMarketDataError(
        'shoonya',
        'session_expired',
        'Shoonya session expired — reconnect on /data-source',
      );
    }

    if (!response.ok || (stat && /not_?ok/i.test(stat))) {
      throw new BrokerMarketDataError(
        'shoonya',
        'provider_error',
        emsg ? `Shoonya request failed: ${emsg.slice(0, 120)}` : 'Shoonya request failed',
      );
    }

    return parsed as Record<string, unknown> | unknown[];
  }
}
