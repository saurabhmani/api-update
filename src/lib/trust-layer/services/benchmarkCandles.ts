// ════════════════════════════════════════════════════════════════
//  Benchmark candle loader for Trust Layer regime scanner
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';
import {
  detectMarketRegime,
  detectEnhancedRegime,
} from '@/lib/signal-engine/regime/detectMarketRegime';
import { mapRegimeToCategory } from '../mappers/regimeMapper';
import type { TrustRegimeSnapshot } from '../types';

async function fetchDailyCandles(symbol: string): Promise<Candle[]> {
  const { rows } = await db.query(
    `SELECT ts, open, high, low, close, volume FROM (
       SELECT ts, open, high, low, close, volume
         FROM market_data_daily
        WHERE symbol = ?
        ORDER BY ts DESC
        LIMIT 300
     ) t
     ORDER BY ts ASC`,
    [symbol],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    ts:     r.ts as string,
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume),
  }));
}

export async function loadMarketRegimeSnapshot(): Promise<TrustRegimeSnapshot> {
  const symbol = DEFAULT_PHASE1_CONFIG.benchmarkSymbol;
  const capturedAt = new Date().toISOString();

  try {
    const candles = await fetchDailyCandles(symbol);
    if (candles.length < DEFAULT_PHASE1_CONFIG.minCandleCount) {
      return emptyRegimeSnapshot(capturedAt);
    }
    const enhanced = detectEnhancedRegime(candles);
    return {
      label: enhanced.label,
      category: mapRegimeToCategory(enhanced.label),
      allowBullishSignals: enhanced.allowBullishSignals,
      strength: enhanced.strength,
      confidence: enhanced.confidence,
      volatilityRegime: enhanced.volatilityRegime,
      trendSlope: enhanced.trendSlope,
      details: {
        rsi: enhanced.details.rsi,
        atrPct: enhanced.details.atrPct,
        closeVsEma20: enhanced.details.closeVsEma20,
        closeVsEma50: enhanced.details.closeVsEma50,
      },
      source: 'index',
      capturedAt,
    };
  } catch {
    return emptyRegimeSnapshot(capturedAt);
  }
}

function emptyRegimeSnapshot(capturedAt: string): TrustRegimeSnapshot {
  return {
    label: 'Sideways',
    category: 'sideways',
    allowBullishSignals: false,
    strength: 0,
    confidence: 0,
    volatilityRegime: 'Normal',
    trendSlope: 0,
    details: { rsi: 0, atrPct: 0, closeVsEma20: 0, closeVsEma50: 0 },
    source: 'insufficient_data',
    capturedAt,
  };
}
