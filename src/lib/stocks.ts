/**
 * Stock utility functions and index definitions
 */

// ── Index card definitions (used by TickerStrip + Intelligence Hub) ─
export interface IndexCardDef {
  symbol:  string;   // NSE tradingsymbol used for Redis stock:{symbol}
  label:   string;   // Display label
  yahoo:   string;   // Yahoo Finance symbol for fallback
}

export const INDEX_CARD_DEFS: IndexCardDef[] = [
  { symbol: 'NIFTY 50',      label: 'Nifty 50',    yahoo: '^NSEI'    },
  { symbol: 'NIFTY BANK',    label: 'Bank Nifty',  yahoo: '^NSEBANK' },
  { symbol: 'NIFTY IT',      label: 'Nifty IT',    yahoo: '^CNXIT'   },
  { symbol: 'NIFTY MIDCAP 100', label: 'Midcap',   yahoo: '^NSEMDCP50'},
  { symbol: 'INDIA VIX',     label: 'India VIX',   yahoo: '^INDIAVIX'},
];

// ── Yahoo Finance symbol converter ───────────────────────────────
export function toYahooSymbol(symbol: string): string {
  if (!symbol) return '';

  // Already a Yahoo symbol
  if (symbol.endsWith('.NS') || symbol.endsWith('.BO')) return symbol;

  // Known index mappings
  const indexMap: Record<string, string> = {
    'NIFTY 50':       '^NSEI',
    'NIFTY50':        '^NSEI',
    'NIFTY BANK':     '^NSEBANK',
    'BANKNIFTY':      '^NSEBANK',
    'NIFTY IT':       '^CNXIT',
    'INDIA VIX':      '^INDIAVIX',
    'SENSEX':         '^BSESN',
  };

  if (indexMap[symbol.toUpperCase()]) return indexMap[symbol.toUpperCase()];

  // Default: NSE equity
  return `${symbol.toUpperCase()}.NS`;
}

// ── Instrument key helpers ────────────────────────────────────────
export function symbolFromInstrumentKey(instrumentKey: string): string {
  if (instrumentKey.includes('|')) return instrumentKey.split('|')[1];
  if (instrumentKey.endsWith('.NS') || instrumentKey.endsWith('.BO'))
    return instrumentKey.replace(/\.(NS|BO)$/, '');
  return instrumentKey;
}

export function defaultInstrumentKey(symbol: string, exchange = 'NSE'): string {
  return `${exchange}_EQ|${symbol.toUpperCase()}`;
}
