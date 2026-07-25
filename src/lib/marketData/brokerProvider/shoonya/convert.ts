/**
 * Shoonya (Noren) → normalized market-data converters.
 */

import { instrumentKeyFromNormalized, toInstrumentKey } from '../instrumentKey';
import type {
  BrokerCandleInterval,
  NormalizedCandle,
  NormalizedInstrument,
  NormalizedQuote,
  NormalizedTick,
} from '../types';

export interface ShoonyaQuoteRaw {
  exch?: string;
  e?: string;
  tsym?: string;
  token?: string | number;
  tk?: string | number;
  lp?: string | number;
  o?: string | number;
  h?: string | number;
  l?: string | number;
  c?: string | number;
  v?: string | number;
  volume?: string | number;
  pc?: string | number;
  bp1?: string | number;
  sp1?: string | number;
  ft?: string | number;
}

export interface ShoonyaCandleRaw {
  time?: string;
  into?: string | number;
  inth?: string | number;
  intl?: string | number;
  intc?: string | number;
  intv?: string | number;
  v?: string | number;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/** Shoonya TPSeries `intrv` (minutes or D). */
export function shoonyaIntervalFromBroker(interval: BrokerCandleInterval): string {
  switch (interval) {
    case '1minute':
      return '1';
    case '5minute':
      return '5';
    case '15minute':
      return '15';
    case '30minute':
      return '30';
    case '60minute':
      return '60';
    case 'day':
    case 'week':
    case 'month':
      return 'D';
    default:
      return 'D';
  }
}

/**
 * Parse Shoonya chart time `DD/MM/YYYY HH:mm:ss` (IST wall clock) to ISO UTC.
 * Falls back to the raw string when unparseable.
 */
export function parseShoonyaChartTime(raw: string | undefined): string {
  if (!raw) return new Date(0).toISOString();
  const m = String(raw).trim().match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!m) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
  }
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  // Treat as IST (UTC+5:30)
  const utcMs = Date.UTC(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh) - 5,
    Number(mi) - 30,
    Number(ss),
  );
  return new Date(utcMs).toISOString();
}

export function shoonyaQuoteToNormalized(
  raw: ShoonyaQuoteRaw,
  fallback: { symbol: string; exchange: string },
): NormalizedQuote {
  const exchange = String(raw.exch || raw.e || fallback.exchange || 'NSE').toUpperCase();
  const symbol = String(
    (raw.tsym || fallback.symbol || '').toString().replace(/-EQ$/i, ''),
  ).toUpperCase();
  const ltp = num(raw.lp) ?? 0;
  const close = num(raw.c);
  const changePercent = num(raw.pc);
  const change =
    changePercent != null && close
      ? (changePercent / 100) * close
      : close != null
        ? ltp - close
        : null;

  let asOfMs = Date.now();
  const ft = num(raw.ft);
  if (ft != null && ft > 1_000_000_000) {
    // Shoonya ft is often unix seconds
    asOfMs = ft > 1e12 ? ft : ft * 1000;
  }

  return {
    symbol,
    exchange,
    ltp,
    open: num(raw.o),
    high: num(raw.h),
    low: num(raw.l),
    close,
    prevClose: close,
    volume: num(raw.v ?? raw.volume),
    change,
    changePercent,
    asOfMs,
    quality: 'live',
  };
}

export function shoonyaCandleToNormalized(raw: ShoonyaCandleRaw): NormalizedCandle {
  return {
    ts: parseShoonyaChartTime(raw.time),
    open: num(raw.into) ?? 0,
    high: num(raw.inth) ?? 0,
    low: num(raw.intl) ?? 0,
    close: num(raw.intc) ?? 0,
    volume: num(raw.intv ?? raw.v) ?? 0,
  };
}

export function shoonyaTouchlineToNormalized(input: {
  raw: ShoonyaQuoteRaw;
  userId: string;
  symbol: string;
  exchange: string;
  brokerToken: string;
}): NormalizedTick {
  const exchange = String(input.raw.e || input.raw.exch || input.exchange).toUpperCase();
  const symbol = input.symbol.toUpperCase();
  const lp = num(input.raw.lp) ?? 0;
  return {
    provider: 'shoonya',
    userId: input.userId,
    instrumentKey: toInstrumentKey(exchange, symbol),
    exchange,
    symbol,
    brokerToken: String(input.raw.tk ?? input.raw.token ?? input.brokerToken),
    lastPrice: lp,
    open: num(input.raw.o) ?? undefined,
    high: num(input.raw.h) ?? undefined,
    low: num(input.raw.l) ?? undefined,
    close: num(input.raw.c) ?? undefined,
    volume: num(input.raw.v ?? input.raw.volume) ?? undefined,
    bid: num(input.raw.bp1) ?? undefined,
    ask: num(input.raw.sp1) ?? undefined,
    exchangeTimestamp:
      num(input.raw.ft) != null
        ? new Date(
          (num(input.raw.ft)! > 1e12 ? num(input.raw.ft)! : num(input.raw.ft)! * 1000),
        ).toISOString()
        : undefined,
    receivedAt: new Date().toISOString(),
  };
}

export function resolvedInstrumentMeta(inst: NormalizedInstrument): {
  symbol: string;
  exchange: string;
  instrumentKey: string;
} {
  const symbol = String(inst.symbol ?? '').trim().toUpperCase();
  const exchange = String(inst.exchange ?? 'NSE').trim().toUpperCase() || 'NSE';
  const instrumentKey =
    inst.instrumentKey?.trim()
    || instrumentKeyFromNormalized({ ...inst, symbol, exchange });
  return {
    symbol,
    exchange,
    instrumentKey,
  };
}
