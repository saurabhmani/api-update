// ════════════════════════════════════════════════════════════════
//  NSE symbol / series normalization for upstream candle requests.
//
//  Universe rows may carry series suffixes (KHAITANLTD-BE, FEL-BZ).
//  IndianAPI historical uses `stock_name` = base tradingsymbol.
//  NSE cm/equity historical wants base symbol + series[] query param.
//
//  Never strip blindly — only known NSE series tokens are peeled.
// ════════════════════════════════════════════════════════════════

/** Equity / trade-to-trade / SME series suffixes commonly seen on NSE. */
export const NSE_SERIES_SUFFIXES = [
  'EQ', 'BE', 'BZ', 'SM', 'ST', 'IL', 'RR', 'GB', 'GS', 'A', 'B',
] as const;

export type NseSeriesSuffix = (typeof NSE_SERIES_SUFFIXES)[number];

/** Series that often lack clean IndianAPI / EQ historical coverage. */
export const NSE_SPECIAL_SERIES = new Set<string>([
  'BE', 'BZ', 'SM', 'ST', 'IL', 'RR', 'GB', 'GS',
]);

const SERIES_RE = new RegExp(
  `^(.+)-(${NSE_SERIES_SUFFIXES.join('|')})$`,
  'i',
);

export interface NormalizedNseSymbol {
  /** Original universe / DB symbol (e.g. KHAITANLTD-BE). */
  universeSymbol: string;
  /** Symbol sent to IndianAPI / NSE path (e.g. KHAITANLTD). */
  providerSymbol: string;
  /** Series token, default EQ when none present. */
  series: string;
  /** True when a known series suffix was stripped. */
  seriesStripped: boolean;
  /** True for trade-to-trade / SME / other non-EQ special series. */
  isSpecialSeries: boolean;
}

/**
 * Canonical split of an NSE universe symbol into provider request form.
 * `M&M`, `BAJAJ-AUTO` (hyphenated names without series) stay intact —
 * only a trailing `-<SERIES>` where SERIES is in the known set is peeled.
 */
export function normalizeNseUniverseSymbol(raw: string): NormalizedNseSymbol {
  const universeSymbol = String(raw ?? '').trim().toUpperCase();
  const m = SERIES_RE.exec(universeSymbol);
  if (!m) {
    return {
      universeSymbol,
      providerSymbol: universeSymbol,
      series: 'EQ',
      seriesStripped: false,
      isSpecialSeries: false,
    };
  }
  const providerSymbol = m[1];
  const series = m[2].toUpperCase();
  return {
    universeSymbol,
    providerSymbol,
    series,
    seriesStripped: true,
    isSpecialSeries: NSE_SPECIAL_SERIES.has(series),
  };
}

/** Log when universe and provider symbols differ. */
export function logSymbolNormalizeIfChanged(n: NormalizedNseSymbol): void {
  if (!n.seriesStripped) return;
  console.log(
    `[SYMBOL NORMALIZE] universeSymbol=${n.universeSymbol} ` +
    `providerSymbol=${n.providerSymbol} series=${n.series}`,
  );
}
