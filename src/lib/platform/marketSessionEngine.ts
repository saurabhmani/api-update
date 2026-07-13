// ════════════════════════════════════════════════════════════════
//  Phase 6 — Market Session Engine
// ════════════════════════════════════════════════════════════════

import {
  getMarketStatus,
  getMarketEnvelope,
  type MarketState,
  type MarketMode,
} from '@/lib/marketData/marketHours';
import type { AssetDefinition, MarketSessionType } from './types';
import { DEFAULT_NSE_EQUITY_ASSET } from './assetRegistry';

export interface SessionStatus {
  assetId: string;
  sessionType: MarketSessionType;
  isTradable: boolean;
  marketState: MarketState | 'open_24x7';
  marketMode: MarketMode | 'twenty_four_seven';
  timezone: string;
  message: string | null;
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function nowMinutesInTimezone(timezone: string, at = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function dateKeyInTimezone(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(at);
}

function weekdayInTimezone(timezone: string, at = new Date()): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(at);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? 0;
}

function resolveSessionForAsset(asset: AssetDefinition, at = new Date()): SessionStatus {
  const calendar = asset.calendar;
  const nowMin = nowMinutesInTimezone(calendar.timezone, at);
  const dateKey = dateKeyInTimezone(calendar.timezone, at);
  const weekday = weekdayInTimezone(calendar.timezone, at);

  if (calendar.holidays.includes(dateKey)) {
    return {
      assetId: asset.assetId,
      sessionType: 'regular',
      isTradable: false,
      marketState: 'holiday',
      marketMode: 'holiday',
      timezone: calendar.timezone,
      message: 'Trading holiday',
    };
  }

  if (calendar.weekends.includes(weekday)) {
    return {
      assetId: asset.assetId,
      sessionType: 'regular',
      isTradable: false,
      marketState: 'closed',
      marketMode: 'weekend',
      timezone: calendar.timezone,
      message: 'Weekend',
    };
  }

  const session24 = calendar.sessions.find((s) => s.type === 'twenty_four_seven');
  if (session24) {
    return {
      assetId: asset.assetId,
      sessionType: 'twenty_four_seven',
      isTradable: true,
      marketState: 'open_24x7',
      marketMode: 'twenty_four_seven',
      timezone: calendar.timezone,
      message: null,
    };
  }

  for (const session of calendar.sessions) {
    const open = parseHm(session.open);
    const close = parseHm(session.close);
    if (nowMin >= open && nowMin < close) {
      const nse = asset.assetClass === 'equity' || asset.assetClass === 'etf' || asset.assetClass === 'index';
      if (nse && session.type === 'regular') {
        const status = getMarketStatus();
        const envelope = getMarketEnvelope();
        return {
          assetId: asset.assetId,
          sessionType: session.type,
          isTradable: status.isOpen,
          marketState: status.state,
          marketMode: envelope.mode,
          timezone: calendar.timezone,
          message: status.isOpen ? null : `NSE ${status.state}`,
        };
      }
      return {
        assetId: asset.assetId,
        sessionType: session.type,
        isTradable: session.type === 'regular',
        marketState: session.type === 'regular' ? 'open' : 'pre-open',
        marketMode: session.type === 'regular' ? 'live' : 'pre_open',
        timezone: calendar.timezone,
        message: null,
      };
    }
  }

  return {
    assetId: asset.assetId,
    sessionType: 'post_market',
    isTradable: false,
    marketState: 'closed',
    marketMode: 'post_close',
    timezone: calendar.timezone,
    message: 'Outside trading sessions',
  };
}

/** Session-aware validation for any asset. NSE equity delegates to marketHours. */
export function getSessionStatus(
  asset: AssetDefinition = DEFAULT_NSE_EQUITY_ASSET,
  at = new Date(),
): SessionStatus {
  return resolveSessionForAsset(asset, at);
}

export function isSessionTradable(asset: AssetDefinition, at = new Date()): boolean {
  return getSessionStatus(asset, at).isTradable;
}

export function validateSessionForSignalGeneration(
  asset: AssetDefinition,
  at = new Date(),
): { allowed: boolean; reason: string | null } {
  const status = getSessionStatus(asset, at);
  if (asset.metadataOnly) {
    return { allowed: false, reason: 'Metadata-only asset class' };
  }
  if (!status.isTradable && asset.assetClass === 'equity') {
    return { allowed: true, reason: null };
  }
  if (!status.isTradable) {
    return { allowed: false, reason: status.message ?? 'Session not tradable' };
  }
  return { allowed: true, reason: null };
}
