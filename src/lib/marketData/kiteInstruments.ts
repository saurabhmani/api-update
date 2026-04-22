// ════════════════════════════════════════════════════════════════
//  kiteInstruments — NEUTRALIZED STUB
//
//  Symbol↔instrument_token resolution is Kite-specific. Yahoo-only
//  mode doesn't need tokens. All lookups return null.
// ════════════════════════════════════════════════════════════════

export interface KiteInstrument {
  instrument_token: number;
  tradingsymbol:    string;
  exchange:         string;
  segment:          string;
  instrument_type:  string;
  lot_size:         number;
  tick_size:        number;
  name?:            string;
  expiry?:          string;
  strike?:          number;
  last_price?:      number;
}

export async function refreshInstruments(_force = false): Promise<number> {
  return 0;
}

export function seedInstrumentMap(
  _entries: Array<{ symbol: string; token: number }>,
): number {
  return 0;
}

export async function getInstrumentToken(_symbol: string): Promise<number | null> {
  return null;
}

export async function getSymbolForToken(_token: number): Promise<string | null> {
  return null;
}

export async function resolveTokens(_symbols: string[]): Promise<Map<string, number>> {
  return new Map();
}
