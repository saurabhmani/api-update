// ════════════════════════════════════════════════════════════════
//  Historical Data Seeder — Fetches EOD candles from Yahoo Finance
//
//  Downloads 2+ years of daily candle data for all universe symbols,
//  persists to the MySQL `candles` table so backtesting has data.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { persistCandle } from '@/services/marketDataService';

// Yahoo headers retired with the rest of the Yahoo stack.

interface SeedProgress {
  symbol: string;
  status: 'ok' | 'failed' | 'skipped';
  candlesLoaded: number;
  error?: string;
}

export interface SeedResult {
  totalSymbols: number;
  seeded: number;
  failed: number;
  skipped: number;
  totalCandles: number;
  details: SeedProgress[];
  durationMs: number;
}

/**
 * Check how many EOD candles exist for a symbol.
 */
async function getExistingCandleCount(symbol: string): Promise<number> {
  const { rows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM candles
     WHERE instrument_key LIKE ? AND candle_type = 'eod' AND interval_unit = '1day'`,
    [`%${symbol}%`],
  );
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Resolve instrument key for a symbol.
 */
const INDEX_KEY_MAP: Record<string, string> = {
  'NIFTY 50': 'NSE_INDEX|NIFTY 50',
  'NIFTY BANK': 'NSE_INDEX|NIFTY BANK',
  'NIFTY NEXT 50': 'NSE_INDEX|NIFTY NEXT 50',
  'NIFTY IT': 'NSE_INDEX|NIFTY IT',
};

async function resolveKey(symbol: string): Promise<string> {
  if (INDEX_KEY_MAP[symbol]) return INDEX_KEY_MAP[symbol];
  try {
    const { rows } = await db.query(
      `SELECT instrument_key FROM instruments WHERE tradingsymbol=? AND is_active=TRUE LIMIT 1`,
      [symbol],
    );
    return (rows[0] as any)?.instrument_key ?? `NSE_EQ|${symbol}`;
  } catch {
    return `NSE_EQ|${symbol}`;
  }
}

/**
 * Fetch historical daily candles. Yahoo retired — returns empty.
 * Backtests will need a replacement seed source (CSV import, paid
 * historical API, etc.) to function.
 */
async function fetchYahooHistorical(
  _symbol: string,
  _range: string = '2y',
): Promise<{ ts: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  return [];
}

/**
 * Seed historical EOD data for a list of symbols.
 * Skips symbols that already have >= minCandles of data.
 */
export async function seedHistoricalData(
  symbols: string[],
  options: {
    range?: string;         // Yahoo range: '1y', '2y', '5y'
    minCandles?: number;    // skip if already has this many candles
    onProgress?: (p: SeedProgress) => void;
  } = {},
): Promise<SeedResult> {
  const { range = '2y', minCandles = 200, onProgress } = options;
  const startMs = Date.now();
  const details: SeedProgress[] = [];
  let seeded = 0;
  let failed = 0;
  let skipped = 0;
  let totalCandles = 0;

  for (const symbol of symbols) {
    // Check existing data
    const existing = await getExistingCandleCount(symbol);
    if (existing >= minCandles) {
      const prog: SeedProgress = { symbol, status: 'skipped', candlesLoaded: existing };
      details.push(prog);
      onProgress?.(prog);
      skipped++;
      continue;
    }

    try {
      const instrumentKey = await resolveKey(symbol);
      const bars = await fetchYahooHistorical(symbol, range);

      if (bars.length === 0) {
        const prog: SeedProgress = { symbol, status: 'failed', candlesLoaded: 0, error: 'No data from Yahoo' };
        details.push(prog);
        onProgress?.(prog);
        failed++;
        continue;
      }

      // Persist each bar
      let persisted = 0;
      for (const bar of bars) {
        try {
          await persistCandle(
            instrumentKey, 'eod', '1day',
            new Date(bar.ts),
            bar.open, bar.high, bar.low, bar.close, bar.volume, 0,
          );
          persisted++;
        } catch {
          // duplicate key or other — skip silently
        }
      }

      const prog: SeedProgress = { symbol, status: 'ok', candlesLoaded: persisted };
      details.push(prog);
      onProgress?.(prog);
      seeded++;
      totalCandles += persisted;

      console.log(`[Seed] ${symbol}: ${persisted} EOD candles persisted (${bars.length} fetched)`);

      // Rate limit: small delay between symbols to avoid Yahoo throttling
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      const prog: SeedProgress = { symbol, status: 'failed', candlesLoaded: 0, error: err instanceof Error ? err.message : String(err) };
      details.push(prog);
      onProgress?.(prog);
      failed++;
    }
  }

  return {
    totalSymbols: symbols.length,
    seeded,
    failed,
    skipped,
    totalCandles,
    details,
    durationMs: Date.now() - startMs,
  };
}
