// ════════════════════════════════════════════════════════════════
//  Symbol Normalization — NSE ↔ Yahoo ↔ Kite mapping
//
//  Problem: Several NSE symbols contain `&` (M&M, L&TFH, M&MFIN).
//  Yahoo Finance uses different tickers for these. NSE's historical
//  API sometimes chokes on `%26` encoding. This module provides a
//  canonical mapping so every fetch path sends the correct symbol
//  to each upstream.
//
//  Usage:
//    toYahooSymbol('M&M')    → 'M%26M.NS'  (Yahoo's actual ticker)
//    toNseSymbol('M&M')      → 'M%26M'     (NSE API)
//    normalizeSymbol('M&M')  → 'M&M'       (internal canonical)
// ════════════════════════════════════════════════════════════════

// ── NSE → Yahoo symbol mapping ──────────────────────────────────
// NSE symbols with `&` need special Yahoo tickers. Yahoo uses
// percent-encoded `%26` in the URL but sometimes needs a different
// base symbol entirely. This map is the authoritative source.
//
// Maintained manually — add new entries when a symbol with `&` is
// added to the NIFTY 500 universe.

const NSE_TO_YAHOO: Record<string, string> = {
  'M&M':     'M%26M.NS',
  'M&MFIN':  'M%26MFIN.NS',
  'L&TFH':   'L%26TFH.NS',
  'J&KBANK':  'J%26KBANK.NS',
  // Post-demerger rename (effective 2026-04-15 on Yahoo). The NSE
  // listing is still quoted as TATAMOTORS but Yahoo now serves the
  // same series under TMCV.NS — the legacy TATAMOTORS.NS 404s.
  'TATAMOTORS': 'TMCV.NS',
  // Kalpataru Power Transmission merged with JMC Projects in 2023
  // and the combined entity was renamed Kalpataru Projects Int'l.
  // NSE kept the legacy 'KALPATPOWR' symbol string; Yahoo now uses
  // KPIL.NS and returns 404 on the old ticker.
  'KALPATPOWR': 'KPIL.NS',
  // Lakshmi Machine Works rebranded to "LMW Limited" — Yahoo moved
  // to LMW.NS while NSE still accepts LAXMIMACH as the listed symbol.
  'LAXMIMACH':  'LMW.NS',
  // McDowell was renamed to United Spirits. NSE still lists the
  // stock under the legacy MCDOWELL-N symbol (the "-N" suffix
  // denotes the non-encumbered series) but Yahoo has consolidated
  // the series under UNITDSPR.NS — the old ticker now 404s on the
  // chart endpoint and spams candle-ingest logs with "http 404".
  'MCDOWELL-N': 'UNITDSPR.NS',
};

// ── Reverse map for display normalization ───────────────────────
const YAHOO_TO_NSE: Record<string, string> = {};
for (const [nse, yahoo] of Object.entries(NSE_TO_YAHOO)) {
  YAHOO_TO_NSE[yahoo.replace('.NS', '')] = nse;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Convert an NSE symbol to its Yahoo Finance equivalent.
 * For normal symbols: `RELIANCE` → `RELIANCE.NS`
 * For `&` symbols:    `M&M` → `M%26M.NS` (pre-encoded)
 */
export function toYahooSymbol(nseSymbol: string): string {
  const upper = nseSymbol.toUpperCase();
  if (upper.endsWith('.NS')) return upper;
  const mapped = NSE_TO_YAHOO[upper];
  if (mapped) return mapped;
  // Default: append .NS
  return `${upper}.NS`;
}

/**
 * Returns true if this Yahoo symbol was pre-encoded and should NOT
 * be passed through encodeURIComponent again. Double-encoding
 * `%26` → `%2526` causes 404s.
 */
export function isPreEncodedYahoo(yahooSymbol: string): boolean {
  return yahooSymbol.includes('%26');
}

/**
 * Convert an NSE symbol for the NSE historical API.
 * Normal symbols pass through. `&` symbols are encoded carefully.
 */
export function toNseApiSymbol(nseSymbol: string): string {
  const upper = nseSymbol.toUpperCase();
  // NSE API needs the raw symbol with & — encodeURIComponent
  // handles this at the URL construction level.
  return upper;
}

/**
 * Check if a symbol has special characters that need per-upstream handling.
 */
export function hasSpecialChars(symbol: string): boolean {
  return /[&+]/.test(symbol);
}

/**
 * Normalize a symbol back to the canonical NSE form.
 * `M%26M` → `M&M`, `RELIANCE.NS` → `RELIANCE`
 */
export function normalizeSymbol(symbol: string): string {
  let s = symbol.toUpperCase().replace(/\.NS$/, '');
  s = decodeURIComponent(s);
  return YAHOO_TO_NSE[s] ?? s;
}
