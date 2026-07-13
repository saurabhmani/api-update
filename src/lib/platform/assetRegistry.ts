// ════════════════════════════════════════════════════════════════
//  Phase 6 — Canonical Asset Registry
// ════════════════════════════════════════════════════════════════

import type { AssetClass, AssetDefinition, TradingCalendar } from './types';
import { MULTI_ASSET_SCHEMA_VERSION } from './types';

const NSE_EQUITY_CALENDAR: TradingCalendar = {
  timezone: 'Asia/Kolkata',
  weekends: [0, 6],
  holidays: [],
  sessions: [
    { type: 'pre_market', open: '09:00', close: '09:15' },
    { type: 'regular', open: '09:15', close: '15:30' },
    { type: 'post_market', open: '15:40', close: '16:00' },
  ],
};

const CRYPTO_CALENDAR: TradingCalendar = {
  timezone: 'UTC',
  weekends: [],
  holidays: [],
  sessions: [{ type: 'twenty_four_seven', open: '00:00', close: '23:59' }],
};

const FOREX_CALENDAR: TradingCalendar = {
  timezone: 'UTC',
  weekends: [0, 6],
  holidays: [],
  sessions: [{ type: 'twenty_four_seven', open: '00:00', close: '23:59' }],
};

function equityAsset(symbol: string, exchange = 'NSE'): AssetDefinition {
  return {
    assetId: `${exchange}:${symbol}`,
    assetClass: 'equity',
    symbol,
    exchange,
    currency: 'INR',
    tickSize: 0.05,
    lotSize: 1,
    pricePrecision: 2,
    timezone: 'Asia/Kolkata',
    calendar: NSE_EQUITY_CALENDAR,
    region: 'IN',
  };
}

const BUILTIN_ASSETS: AssetDefinition[] = [
  equityAsset('RELIANCE'),
  {
    assetId: 'NSE:NIFTY50',
    assetClass: 'index',
    symbol: 'NIFTY50',
    exchange: 'NSE',
    currency: 'INR',
    tickSize: 0.05,
    lotSize: 1,
    pricePrecision: 2,
    timezone: 'Asia/Kolkata',
    calendar: NSE_EQUITY_CALENDAR,
    region: 'IN',
  },
  {
    assetId: 'NSE:NIFTYBEES',
    assetClass: 'etf',
    symbol: 'NIFTYBEES',
    exchange: 'NSE',
    currency: 'INR',
    tickSize: 0.01,
    lotSize: 1,
    pricePrecision: 2,
    timezone: 'Asia/Kolkata',
    calendar: NSE_EQUITY_CALENDAR,
    region: 'IN',
  },
  {
    assetId: 'NSE:NIFTY_FUT',
    assetClass: 'futures',
    symbol: 'NIFTY',
    exchange: 'NSE',
    currency: 'INR',
    tickSize: 0.05,
    lotSize: 50,
    pricePrecision: 2,
    timezone: 'Asia/Kolkata',
    calendar: NSE_EQUITY_CALENDAR,
    region: 'IN',
  },
  {
    assetId: 'NSE:NIFTY_OPT',
    assetClass: 'options',
    symbol: 'NIFTY',
    exchange: 'NSE',
    currency: 'INR',
    tickSize: 0.05,
    lotSize: 50,
    pricePrecision: 2,
    timezone: 'Asia/Kolkata',
    calendar: NSE_EQUITY_CALENDAR,
    region: 'IN',
    metadataOnly: true,
  },
  {
    assetId: 'FX:EURUSD',
    assetClass: 'forex',
    symbol: 'EURUSD',
    exchange: 'FX',
    currency: 'USD',
    tickSize: 0.0001,
    lotSize: 1000,
    pricePrecision: 5,
    timezone: 'UTC',
    calendar: FOREX_CALENDAR,
    region: 'GLOBAL',
  },
  {
    assetId: 'CRYPTO:BTCUSD',
    assetClass: 'crypto',
    symbol: 'BTCUSD',
    exchange: 'CRYPTO',
    currency: 'USD',
    tickSize: 0.01,
    lotSize: 1,
    pricePrecision: 2,
    timezone: 'UTC',
    calendar: CRYPTO_CALENDAR,
    region: 'GLOBAL',
  },
  {
    assetId: 'MCX:GOLD',
    assetClass: 'commodity',
    symbol: 'GOLD',
    exchange: 'MCX',
    currency: 'INR',
    tickSize: 1,
    lotSize: 1,
    pricePrecision: 0,
    timezone: 'Asia/Kolkata',
    calendar: NSE_EQUITY_CALENDAR,
    region: 'IN',
  },
];

const registry = new Map<string, AssetDefinition>(
  BUILTIN_ASSETS.map((a) => [a.assetId, Object.freeze({ ...a })]),
);

/** Default Product A NSE equity asset — preserves existing behaviour. */
export const DEFAULT_NSE_EQUITY_ASSET: AssetDefinition = equityAsset('_DEFAULT');

export function registerAsset(asset: AssetDefinition): void {
  registry.set(asset.assetId, Object.freeze({ ...asset }));
}

export function getAssetById(assetId: string): AssetDefinition | null {
  return registry.get(assetId) ?? null;
}

export function listAssets(filter?: { assetClass?: AssetClass }): AssetDefinition[] {
  const all = [...registry.values()];
  if (!filter?.assetClass) return all;
  return all.filter((a) => a.assetClass === filter.assetClass);
}

export function resolveAssetForSymbol(
  symbol: string,
  exchange = 'NSE',
  assetClass: AssetClass = 'equity',
): AssetDefinition {
  const assetId = `${exchange}:${symbol}`;
  const existing = registry.get(assetId);
  if (existing) return existing;

  if (assetClass === 'equity' && exchange === 'NSE') {
    return { ...DEFAULT_NSE_EQUITY_ASSET, assetId, symbol, exchange };
  }

  const template = BUILTIN_ASSETS.find((a) => a.assetClass === assetClass);
  if (template) {
    return { ...template, assetId, symbol, exchange };
  }

  return { ...DEFAULT_NSE_EQUITY_ASSET, assetId, symbol, exchange, assetClass };
}

export function getAssetRegistryVersion(): string {
  return MULTI_ASSET_SCHEMA_VERSION;
}
