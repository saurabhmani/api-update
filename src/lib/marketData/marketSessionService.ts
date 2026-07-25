/**
 * Centralized NSE market-session service (Asia/Kolkata).
 *
 * Thin façade over `marketHours.ts` so callers do not re-implement
 * weekend / holiday / hour checks. Prefer this module for new code.
 */

import {
  getMarketEnvelope,
  getMarketStatus,
  getLatestCompletedTradingDay,
  isMarketOpen,
  isMarketOverrideEnabled,
  type MarketEnvelope,
  type MarketStatus,
} from '@/lib/marketData/marketHours';

export type MarketSessionStatus =
  | 'pre_open'
  | 'open'
  | 'closed'
  | 'weekend'
  | 'holiday'
  | 'unknown';

export type BrokerConnectionStatus =
  | 'disconnected'
  | 'connected'
  | 'expired'
  | 'error';

export type MarketDataStatus =
  | 'connecting'
  | 'live'
  | 'connected_no_data'
  | 'closed_market'
  | 'stale'
  | 'error';

export interface MarketSessionQuery {
  exchange?: 'NSE' | 'BSE';
  /** Wall-clock instant; defaults to now. Evaluated in Asia/Kolkata. */
  at?: Date;
}

export interface MarketSessionResult {
  exchange: 'NSE' | 'BSE';
  status: MarketSessionStatus;
  isOpen: boolean;
  label: string;
  nowIst: string;
  sessionOpenIst: string;
  sessionCloseIst: string;
  tradingDate: string;
  latestCompletedTradingDay: string;
  bypassActive: boolean;
  envelope: MarketEnvelope;
  raw: MarketStatus;
}

function mapEnvelopeModeToStatus(mode: MarketEnvelope['mode']): MarketSessionStatus {
  switch (mode) {
    case 'live':       return 'open';
    case 'pre_open':   return 'pre_open';
    case 'weekend':    return 'weekend';
    case 'holiday':    return 'holiday';
    case 'post_close':
    case 'market_closed':
      return 'closed';
    default:
      return 'unknown';
  }
}

/**
 * Resolve NSE (default) session status in Asia/Kolkata.
 * Does not use server-local `getHours()` — all calendar math is IST.
 */
export async function getStatus(
  query: MarketSessionQuery = {},
): Promise<MarketSessionResult> {
  const exchange = query.exchange ?? 'NSE';
  const raw = getMarketStatus(query.at);
  // Envelope mode derivation is calendar-based; when `at` is supplied,
  // prefer status mapped from the clock-injected raw state.
  const envelope = query.at
    ? {
        ...getMarketEnvelope(),
        isOpen: raw.isOpen,
        state: raw.state,
        label: raw.label,
        nowIst: raw.nowIst,
        sessionOpenIst: raw.sessionOpenIst,
        sessionCloseIst: raw.sessionCloseIst,
        isHoliday: raw.state === 'holiday',
      }
    : getMarketEnvelope();

  const status: MarketSessionStatus = query.at
    ? (raw.state === 'open' ? 'open'
      : raw.state === 'pre-open' ? 'pre_open'
      : raw.state === 'holiday' ? 'holiday'
      : (() => {
          const ist = new Date((query.at as Date).getTime() + 5.5 * 3_600_000);
          const wd = ist.getUTCDay();
          return wd === 0 || wd === 6 ? 'weekend' : 'closed';
        })())
    : mapEnvelopeModeToStatus(envelope.mode);

  const tradingDate = raw.nowIst.slice(0, 10);
  const latestCompletedTradingDay = getLatestCompletedTradingDay();

  return {
    exchange,
    status,
    isOpen: raw.isOpen,
    label: raw.label,
    nowIst: raw.nowIst,
    sessionOpenIst: raw.sessionOpenIst,
    sessionCloseIst: raw.sessionCloseIst,
    tradingDate,
    latestCompletedTradingDay,
    bypassActive: envelope.bypassActive,
    envelope,
    raw,
  };
}

export function classifyMarketDataStatus(input: {
  brokerConnected: boolean;
  marketOpen: boolean;
  lastTickAt: string | null | undefined;
  liveThresholdMs?: number;
}): MarketDataStatus {
  const liveThresholdMs = input.liveThresholdMs ?? 60_000;
  if (!input.brokerConnected) return 'error';
  if (!input.marketOpen) return 'closed_market';
  if (!input.lastTickAt) return 'connected_no_data';
  const age = Date.now() - new Date(input.lastTickAt).getTime();
  if (!Number.isFinite(age)) return 'connected_no_data';
  if (age <= liveThresholdMs) return 'live';
  return 'stale';
}

export const marketSessionService = {
  getStatus,
  isMarketOpen,
  isMarketOverrideEnabled,
  classifyMarketDataStatus,
  getLatestCompletedTradingDay,
};

export default marketSessionService;
