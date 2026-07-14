// ════════════════════════════════════════════════════════════════
//  Kite Connect service layer — public barrel
//
//  Phase 2: standalone Zerodha integration. Not yet wired into
//  MarketDataProvider / marketDataResolver / UI.
// ════════════════════════════════════════════════════════════════

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
