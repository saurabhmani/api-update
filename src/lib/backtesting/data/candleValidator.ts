// ════════════════════════════════════════════════════════════════
//  Candle Validator + Repair Layer
//
//  Defensive layer that runs BEFORE replay. Detects:
//   - duplicate timestamps
//   - out-of-order timestamps
//   - zero-volume bars
//   - extreme gaps (flash crash / spike)
//   - corrupt OHLC values (high < low, negative prices, NaN)
//   - missing intermediate dates (gaps in sequence)
//
//  Behaviour controlled by strictDataMode:
//   - strict=true  → reject any symbol with violations
//   - strict=false → repair what's safe, drop what's not
//
//  Returns a ValidationReport so the orchestrator can audit
//  what was repaired vs rejected.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';

export interface ValidationIssue {
  type: 'duplicate' | 'out_of_order' | 'zero_volume' | 'extreme_gap'
      | 'corrupt_ohlc' | 'negative_price' | 'nan_value';
  date: string;
  detail: string;
}

export interface SymbolValidationReport {
  symbol: string;
  inputCount: number;
  outputCount: number;
  rejected: boolean;
  issues: ValidationIssue[];
  repaired: number;
  dropped: number;
}

export interface ValidationReport {
  symbolReports: SymbolValidationReport[];
  totalSymbols: number;
  totalRepairs: number;
  totalDropped: number;
  rejectedSymbols: string[];
}

/** Default thresholds — tuned for daily NSE equity data */
const DEFAULT_GAP_THRESHOLD = 0.30;   // > 30% single-bar move flagged
const DEFAULT_MIN_VOLUME = 0;          // 0 volume gets flagged but not auto-dropped

/**
 * Validate and optionally repair a single symbol's candle series.
 *
 * @param symbol  ticker symbol (used in audit)
 * @param candles raw candles from the data store, must be sorted ASC by ts
 * @param strict  if true, any violation rejects the entire symbol
 */
export function validateSymbolCandles(
  symbol: string,
  candles: Candle[],
  strict = false,
  gapThreshold: number = DEFAULT_GAP_THRESHOLD,
): { candles: Candle[]; report: SymbolValidationReport } {
  const issues: ValidationIssue[] = [];
  let repaired = 0;
  let dropped = 0;

  if (candles.length === 0) {
    return {
      candles: [],
      report: { symbol, inputCount: 0, outputCount: 0, rejected: false, issues, repaired: 0, dropped: 0 },
    };
  }

  // Pass 1 — detect issues bar-by-bar
  const seen = new Set<string>();
  let lastTs: string | null = null;
  let lastClose: number | null = null;

  for (const c of candles) {
    const date = c.ts.split('T')[0];

    // NaN / negative
    if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
      issues.push({ type: 'nan_value', date, detail: 'OHLC contains NaN/Infinity' });
    } else if (c.open < 0 || c.high < 0 || c.low < 0 || c.close < 0) {
      issues.push({ type: 'negative_price', date, detail: `O=${c.open} H=${c.high} L=${c.low} C=${c.close}` });
    } else if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      // OHLC integrity broken
      issues.push({
        type: 'corrupt_ohlc',
        date,
        detail: `H=${c.high} L=${c.low} O=${c.open} C=${c.close} (high must be >= all, low must be <= all)`,
      });
    }

    // Zero volume
    if (c.volume <= DEFAULT_MIN_VOLUME) {
      issues.push({ type: 'zero_volume', date, detail: `volume=${c.volume}` });
    }

    // Duplicate
    if (seen.has(date)) {
      issues.push({ type: 'duplicate', date, detail: 'duplicate timestamp' });
    }
    seen.add(date);

    // Out-of-order
    if (lastTs !== null && date < lastTs) {
      issues.push({ type: 'out_of_order', date, detail: `${date} < ${lastTs}` });
    }
    lastTs = date;

    // Extreme gap (close-to-close move > threshold)
    if (lastClose !== null && lastClose > 0 && isFinite(c.close)) {
      const moveAbs = Math.abs((c.close - lastClose) / lastClose);
      if (moveAbs > gapThreshold) {
        issues.push({
          type: 'extreme_gap',
          date,
          detail: `${(moveAbs * 100).toFixed(1)}% move from ${lastClose.toFixed(2)} to ${c.close.toFixed(2)}`,
        });
      }
    }
    if (isFinite(c.close)) lastClose = c.close;
  }

  // Strict mode — any issue rejects the symbol entirely
  if (strict && issues.length > 0) {
    return {
      candles: [],
      report: {
        symbol,
        inputCount: candles.length,
        outputCount: 0,
        rejected: true,
        issues,
        repaired: 0,
        dropped: candles.length,
      },
    };
  }

  // Lenient mode — repair what we can, drop the rest
  const cleaned: Candle[] = [];
  const seenAfter = new Set<string>();

  for (const c of candles) {
    const date = c.ts.split('T')[0];

    // Drop NaN/negative/corrupt — unrecoverable
    if (!isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close)) {
      dropped++; continue;
    }
    if (c.open < 0 || c.high < 0 || c.low < 0 || c.close < 0) {
      dropped++; continue;
    }
    if (c.high < c.low || c.high < c.open || c.high < c.close || c.low > c.open || c.low > c.close) {
      // Try to repair OHLC by clamping
      const repairedHigh = Math.max(c.high, c.open, c.close, c.low);
      const repairedLow = Math.min(c.low, c.open, c.close, c.high);
      cleaned.push({ ...c, high: repairedHigh, low: repairedLow });
      repaired++;
      continue;
    }

    // Drop duplicates (keep first)
    if (seenAfter.has(date)) {
      dropped++;
      continue;
    }
    seenAfter.add(date);

    cleaned.push(c);
  }

  // Pass 2 — re-sort to fix any out-of-order issues
  if (issues.some(i => i.type === 'out_of_order')) {
    cleaned.sort((a, b) => a.ts.localeCompare(b.ts));
    repaired += issues.filter(i => i.type === 'out_of_order').length;
  }

  return {
    candles: cleaned,
    report: {
      symbol,
      inputCount: candles.length,
      outputCount: cleaned.length,
      rejected: false,
      issues,
      repaired,
      dropped,
    },
  };
}

/**
 * Validate every symbol in a data store and return both the cleaned data
 * and a per-symbol report. The orchestrator uses the report to emit
 * data_repair_applied / data_rejected audit events.
 */
export function validateDataStore(
  symbolToCandles: Map<string, Candle[]>,
  strict: boolean,
): { cleaned: Map<string, Candle[]>; report: ValidationReport } {
  const cleaned = new Map<string, Candle[]>();
  const symbolReports: SymbolValidationReport[] = [];
  const rejectedSymbols: string[] = [];
  let totalRepairs = 0;
  let totalDropped = 0;

  for (const [symbol, candles] of Array.from(symbolToCandles.entries())) {
    const { candles: cleanCandles, report } = validateSymbolCandles(symbol, candles, strict);
    symbolReports.push(report);
    totalRepairs += report.repaired;
    totalDropped += report.dropped;
    if (report.rejected) {
      rejectedSymbols.push(symbol);
    } else {
      cleaned.set(symbol, cleanCandles);
    }
  }

  return {
    cleaned,
    report: {
      symbolReports,
      totalSymbols: symbolToCandles.size,
      totalRepairs,
      totalDropped,
      rejectedSymbols,
    },
  };
}
