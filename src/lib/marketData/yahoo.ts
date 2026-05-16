// ════════════════════════════════════════════════════════════════
//  yahoo — NEUTRALIZED STUB // @deprecated marker
//
//  @deprecated  Yahoo Finance has been removed from production. Do
//  not import from this file in new code. After Step 2 of the
//  IndianAPI cutover, Yahoo is gated behind YAHOO_EMERGENCY_FALLBACK_ENABLED // @deprecated marker
//  and only consulted via the YahooAdapter as an emergency fallback // @deprecated marker
//  inside MarketDataProvider — never directly.
//
//  The public surface is preserved so existing importers compile,
//  but every fetch resolves to
//    `{ price: null, source: 'none', error: 'yahoo_removed' }`. // @deprecated marker
//
//  Safe to delete this file outright once every importer has been
//  migrated to marketDataResolver. The stub is the transitional step
//  that keeps tsc green during the removal.
// ════════════════════════════════════════════════════════════════

import type { PriceResponse } from './getLivePrice';

export async function fetchFromYahoo(_symbol: string): Promise<PriceResponse> { // @deprecated marker
  return { price: null, source: 'none', error: 'yahoo_removed' }; // @deprecated marker
}
