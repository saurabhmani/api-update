import { describe, it, expect } from 'vitest';
import {
  computeUniverseChurnSelection,
  isSymbolDataQualityOk,
  UNIVERSE_CHURN_THRESHOLDS_DEFAULT,
} from '@/lib/marketData/nseUniverseChurn';
import type { UniverseRankInput } from '@/lib/marketData/nseUniverseRanker';

function row(symbol: string, score: number): UniverseRankInput {
  return {
    symbol,
    tradedValue: 1_000_000,
    volumeConsistency: 0.9,
    candleCompleteness: 0.95,
    compositeScore: score,
  };
}

function bars(symbols: string[], count = 100): Map<string, number> {
  return new Map(symbols.map((s) => [s.toUpperCase(), count]));
}

describe('nseUniverseChurn', () => {
  const thresholds = { addMaxRank: 900, keepMaxRank: 1100, removeMinRank: 1200 };

  it('keeps existing symbols when rank <= 1100 and data quality is good', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => row(`SYM${i + 1}`, 1 - i * 0.01));
    const currentActive = new Set(['SYM5', 'SYM1000']);
    const totalDailyBars = bars([...ranked.map((r) => r.symbol), 'SYM1000']);

    const result = computeUniverseChurnSelection({
      ranked,
      currentActive,
      totalDailyBars,
      targetSize: 10,
      maxSize: 15,
      thresholds,
      minBars: 80,
    });

    expect(result.decisions.find((d) => d.symbol === 'SYM5')?.action).toBe('keep');
    expect(result.selected).toContain('SYM5');
  });

  it('removes existing symbols when rank > 1200 or data quality fails', () => {
    const ranked = Array.from({ length: 5 }, (_, i) => row(`GOOD${i + 1}`, 1 - i * 0.01));
    ranked.push(row('BAD_RANK', 0.01));
    const currentActive = new Set(['GOOD1', 'BAD_RANK']);
    const totalDailyBars = bars(['GOOD1', 'BAD_RANK']);

    const result = computeUniverseChurnSelection({
      ranked: ranked.slice(0, 5),
      currentActive,
      totalDailyBars,
      targetSize: 3,
      maxSize: 10,
      thresholds,
      minBars: 80,
    });

    expect(result.decisions.find((d) => d.symbol === 'BAD_RANK')?.action).toBe('remove');
    expect(result.selected).not.toContain('BAD_RANK');
  });

  it('adds new symbols only when rank <= 900 and data quality is good', () => {
    const ranked = Array.from({ length: 1000 }, (_, i) => row(`N${i + 1}`, 1 - i * 0.0001));
    const currentActive = new Set(['N1', 'N2']);
    const totalDailyBars = bars(ranked.slice(0, 950).map((r) => r.symbol));

    const result = computeUniverseChurnSelection({
      ranked,
      currentActive,
      totalDailyBars,
      targetSize: 1000,
      maxSize: 1050,
      thresholds,
      minBars: 80,
    });

    const adds = result.decisions.filter((d) => d.action === 'add');
    for (const d of adds) {
      expect(d.rank).toBeLessThanOrEqual(thresholds.addMaxRank);
      expect(d.dataQualityOk).toBe(true);
    }
  });

  it('isSymbolDataQualityOk rejects low bars and poor completeness', () => {
    const good = row('RELIANCE', 0.99);
    expect(isSymbolDataQualityOk(good, 100, 80)).toBe(true);
    expect(isSymbolDataQualityOk(good, 50, 80)).toBe(false);
    expect(isSymbolDataQualityOk({ ...good, candleCompleteness: 0.3 }, 100, 80)).toBe(false);
    expect(isSymbolDataQualityOk({ ...good, tradedValue: 0 }, 100, 80)).toBe(false);
  });

  it('uses default thresholds from env helper', () => {
    const t = UNIVERSE_CHURN_THRESHOLDS_DEFAULT();
    expect(t.addMaxRank).toBe(900);
    expect(t.keepMaxRank).toBe(1100);
    expect(t.removeMinRank).toBe(1200);
  });
});
