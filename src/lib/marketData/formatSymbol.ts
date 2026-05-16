// ════════════════════════════════════════════════════════════════
//  formatSymbol — canonical symbol format converter
//
//  Normalises any ingestion-time symbol string into the shapes each
//  downstream API expects:
//
//    raw   : "RELIANCE"            → what we store in q365_signals
//    kite  : "NSE:RELIANCE"        → what KiteConnect REST expects // @deprecated marker
//                                     (the WebSocket uses tokens, not
//                                      strings, and is unaffected by this)
//    yahoo : "RELIANCE.NS"         → what Yahoo's chart/quote endpoints // @deprecated marker
//                                     expect for NSE equities
//
//  Accepts any of these shapes as input — the function is idempotent
//  across all three, so callers don't have to branch on "did I already
//  normalise this?". Also trims whitespace and uppercases.
//
//  Examples:
//    formatSymbol("RELIANCE")         → { raw: "RELIANCE", kite: "NSE:RELIANCE", yahoo: "RELIANCE.NS" } // @deprecated marker
//    formatSymbol("NSE:RELIANCE")     → same
//    formatSymbol("RELIANCE.NS")      → same
//    formatSymbol("  reliance  ")     → same
//    formatSymbol("NSE:RELIANCE.NS")  → same (handles doubly-tagged input)
// ════════════════════════════════════════════════════════════════

export interface FormattedSymbol {
  raw:    string;   // bare uppercase ticker, no prefix/suffix
  kite:   string;   // "NSE:RELIANCE" // @deprecated marker
  yahoo:  string;   // "RELIANCE.NS" // @deprecated marker
}

const KITE_PREFIX_RE  = /^NSE:/i;
const YAHOO_SUFFIX_RE = /\.NS$/i;
const BSE_PREFIX_RE   = /^BSE:/i;
const BSE_SUFFIX_RE   = /\.BO$/i;

export function formatSymbol(input: string): FormattedSymbol {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) {
    return { raw: '', kite: '', yahoo: '' }; // @deprecated marker
  }

  // Strip known exchange tags in either direction, then normalise.
  let raw = trimmed.toUpperCase();
  raw = raw.replace(KITE_PREFIX_RE, '');
  raw = raw.replace(YAHOO_SUFFIX_RE, '');
  raw = raw.replace(BSE_PREFIX_RE,   '');
  raw = raw.replace(BSE_SUFFIX_RE,   '');
  // Defensive: if something like "NSE:RELIANCE.NS" slips through the
  // first pass (rare — some data vendors double-tag), strip again.
  raw = raw.replace(KITE_PREFIX_RE, '');
  raw = raw.replace(YAHOO_SUFFIX_RE, '');

  return {
    raw,
    kite:  raw ? `NSE:${raw}` : '', // @deprecated marker
    yahoo: raw ? `${raw}.NS`  : '', // @deprecated marker
  };
}

/** Extract just the Kite-formatted string. */ // @deprecated marker
export function toKiteSymbol(input: string): string { // @deprecated marker
  return formatSymbol(input).kite; // @deprecated marker
}

/** Extract just the Yahoo-formatted string. */ // @deprecated marker
export function toYahooSymbol(input: string): string { // @deprecated marker
  return formatSymbol(input).yahoo; // @deprecated marker
}

/** Extract the bare ticker used by q365_signals. */
export function toRawSymbol(input: string): string {
  return formatSymbol(input).raw;
}
