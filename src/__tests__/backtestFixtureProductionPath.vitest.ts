import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/signal-engine/repositories/signalRepository', () => ({ saveSignals: vi.fn(async () => new Map()) }));
vi.mock('@/lib/manipulation-engine/repository', () => ({ saveManipulationPenalty: vi.fn(async () => undefined) }));

import { generatePhase1Signals } from '@/lib/signal-engine/pipeline/generatePhase1Signals';

describe('Backtest fixture production signal path', () => {
  it('initializes the production pipeline and exercises accepted and rejected candidates', async () => {
    const raw = JSON.parse(await fs.readFile(path.resolve('src/test-fixtures/backtesting/candles.json'), 'utf8'));
    const bySymbol = new Map<string, any[]>();
    for (const item of raw) {
      const candle = { ...item, time: item.timestamp };
      bySymbol.set(item.symbol, [...(bySymbol.get(item.symbol) ?? []), candle]);
    }
    const provider = { fetchDailyCandles: async (symbol: string) => bySymbol.get(symbol) ?? [] };
    const result = await generatePhase1Signals(provider, {
      universe: ['FIXTURE-A', 'FIXTURE-B'], benchmarkSymbol: 'FIXTURE-BENCH', timeframe: 'daily',
      minCandleCount: 220, breakoutBuffer: 1.002, minAvgVolume: 100_000, minPrice: 50, minConfidenceToSave: 55,
    }, { generationSource: 'fixture-suitability-v2' });
    expect(result.scanned).toBe(2);
    expect(result.rejected.some(item => item.symbol === 'FIXTURE-B')).toBe(true);
    expect(result.signals.some(item => item.symbol === 'FIXTURE-A')).toBe(true);
  }, 30_000);
});
