// ════════════════════════════════════════════════════════════════
//  Kite Connect service layer — public barrel
//
//  Phase 2: standalone Zerodha integration. Not yet wired into
//  MarketDataProvider / marketDataResolver / UI.
// ════════════════════════════════════════════════════════════════

// Phase 1 config (`./config` / getKiteConfig) is server-only and must
// be imported via `@/lib/kite/config` — never from this barrel.

export {
  KiteClient,
  getKiteClient,
  resetKiteClient,
  loadKiteConfig,
  assertKiteConfig,
} from './client';

export {
  getClient,
  setAccessToken,
  validateConnection,
  assertConnection,
  getLoginUrl,
  generateSession,
} from './auth';

export {
  getQuote,
  getQuotes,
  getLTP,
  getLTPValue,
  getOHLC,
  getOHLCFor,
} from './marketData';

export { getHistoricalData } from './historical';

export {
  downloadInstruments,
  searchInstrument,
  getInstrumentBySymbol,
  clearInstrumentsCache,
} from './instruments';

export {
  KiteAPIError,
  KiteAuthenticationError,
  KiteRateLimitError,
  KiteConfigError,
  normalizeKiteError,
  withKiteErrors,
  isKiteErrorPayload,
} from './errors';

export {
  getKiteHealth,
  recordKiteCall,
  isKiteConfigured,
  markKiteSessionTokenPresent,
  _resetKiteHealthForTests,
} from './health';
export type { KiteHealthSnapshot, RecordKiteCallInput } from './health';

export type {
  KiteConfig,
  KiteConnectionValidation,
  KiteDepthLevel,
  KiteExchange,
  KiteHistoricalCandle,
  KiteHistoricalInterval,
  KiteHistoricalParams,
  KiteInstrument,
  KiteInstrumentKey,
  KiteInstrumentType,
  KiteLTP,
  KiteLTPMap,
  KiteMarketDepth,
  KiteOHLC,
  KiteOHLCBlock,
  KiteOHLCMap,
  KiteProfile,
  KiteQuote,
  KiteQuotesMap,
  KiteApiErrorBody,
} from './types';

export type { KiteErrorType } from './errors';

// Phase 2 — client-safe browser session cleanup (no token storage)
export {
  saveKiteSession,
  getKiteSession,
  clearKiteSession,
  getKiteAccessToken,
} from './browser-session';
