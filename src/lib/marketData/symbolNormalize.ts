// ════════════════════════════════════════════════════════════════
//  Symbol Normalization — NSE ↔ Yahoo ↔ Kite mapping // @deprecated marker
//
//  Problem: Several NSE symbols contain `&` (M&M, L&TFH, M&MFIN).
//  Yahoo Finance uses different tickers for these. NSE's historical // @deprecated marker
//  API sometimes chokes on `%26` encoding. This module provides a
//  canonical mapping so every fetch path sends the correct symbol
//  to each upstream.
//
//  Usage:
//    toYahooSymbol('M&M')    → 'M%26M.NS'  (Yahoo's actual ticker) // @deprecated marker
//    toNseSymbol('M&M')      → 'M%26M'     (NSE API)
//    normalizeSymbol('M&M')  → 'M&M'       (internal canonical)
// ════════════════════════════════════════════════════════════════

// ── NSE → Yahoo symbol mapping ────────────────────────────────── // @deprecated marker
// NSE symbols with `&` need special Yahoo tickers. Yahoo uses // @deprecated marker
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
  // Post-demerger rename (effective 2026-04-15 on Yahoo). The NSE // @deprecated marker
  // listing is still quoted as TATAMOTORS but Yahoo now serves the // @deprecated marker
  // same series under TMCV.NS — the legacy TATAMOTORS.NS 404s.
  'TATAMOTORS': 'TMCV.NS',
  // Kalpataru Power Transmission merged with JMC Projects in 2023
  // and the combined entity was renamed Kalpataru Projects Int'l.
  // NSE kept the legacy 'KALPATPOWR' symbol string; Yahoo now uses // @deprecated marker
  // KPIL.NS and returns 404 on the old ticker.
  'KALPATPOWR': 'KPIL.NS',
  // Lakshmi Machine Works rebranded to "LMW Limited" — Yahoo moved // @deprecated marker
  // to LMW.NS while NSE still accepts LAXMIMACH as the listed symbol.
  'LAXMIMACH':  'LMW.NS',
  // McDowell was renamed to United Spirits. NSE still lists the
  // stock under the legacy MCDOWELL-N symbol (the "-N" suffix
  // denotes the non-encumbered series) but Yahoo has consolidated // @deprecated marker
  // the series under UNITDSPR.NS — the old ticker now 404s on the
  // chart endpoint and spams candle-ingest logs with "http 404".
  'MCDOWELL-N': 'UNITDSPR.NS',

  // ── Benchmarks / indices ────────────────────────────────────────
  // The signal engine reads the benchmark series from
  // market_data_daily WHERE symbol = 'NIFTY 50' (see
  // src/lib/signal-engine/live/analyzeInstrument.ts → getBenchmarkSnapshot).
  // Yahoo's ticker for the NIFTY 50 index is '^NSEI' (no '.NS' // @deprecated marker
  // suffix; '^NSEI.NS' 404s). The chart endpoint percent-encodes
  // the leading '^' to '%5E' via encodeURIComponent on the call
  // site, which Yahoo accepts. Without this mapping the default // @deprecated marker
  // '<SYMBOL>.NS' rule produces 'NIFTY 50.NS', which is invalid,
  // and benchmark ingestion silently fails — the visible symptom
  // is every signal-engine run aborting with 'benchmark snapshot
  // unavailable' and the dashboard freezing on a stale 50-row
  // batch.
  'NIFTY 50':   '^NSEI',
};

// ── Reverse map for display normalization ───────────────────────
const YAHOO_TO_NSE: Record<string, string> = {};
for (const [nse, yahoo] of Object.entries(NSE_TO_YAHOO)) { // @deprecated marker
  YAHOO_TO_NSE[yahoo.replace('.NS', '')] = nse; // @deprecated marker
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Convert an NSE symbol to its Yahoo Finance equivalent. // @deprecated marker
 * For normal symbols: `RELIANCE` → `RELIANCE.NS`
 * For `&` symbols:    `M&M` → `M%26M.NS` (pre-encoded)
 */
export function toYahooSymbol(nseSymbol: string): string { // @deprecated marker
  const upper = nseSymbol.toUpperCase();
  if (upper.endsWith('.NS')) return upper;
  const mapped = NSE_TO_YAHOO[upper];
  if (mapped) return mapped;
  // Default: append .NS
  return `${upper}.NS`;
}

/**
 * Returns true if this Yahoo symbol was pre-encoded and should NOT // @deprecated marker
 * be passed through encodeURIComponent again. Double-encoding
 * `%26` → `%2526` causes 404s.
 */
export function isPreEncodedYahoo(yahooSymbol: string): boolean { // @deprecated marker
  return yahooSymbol.includes('%26'); // @deprecated marker
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
