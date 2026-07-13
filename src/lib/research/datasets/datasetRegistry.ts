// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Datasets
// ════════════════════════════════════════════════════════════════

import type { ResearchDataset, ResearchCandle } from '../types';

const datasets = new Map<string, ResearchDataset>();
const candleStore = new Map<string, ResearchCandle[]>();

export function registerDataset(dataset: ResearchDataset, candles?: ResearchCandle[]): void {
  datasets.set(dataset.datasetId, Object.freeze({ ...dataset }));
  if (candles) candleStore.set(dataset.datasetId, Object.freeze([...candles]) as ResearchCandle[]);
}

export function getDataset(datasetId: string): ResearchDataset | null {
  return datasets.get(datasetId) ?? null;
}

export function getDatasetCandles(datasetId: string): ResearchCandle[] {
  return candleStore.get(datasetId) ?? [];
}

export function listDatasets(): ResearchDataset[] {
  return [...datasets.values()];
}

export function buildSyntheticDataset(input: {
  datasetId: string;
  symbols: string[];
  barCount?: number;
  startDate?: string;
}): { dataset: ResearchDataset; candles: ResearchCandle[] } {
  const barCount = input.barCount ?? 120;
  const startDate = input.startDate ?? '2026-01-01';
  const candles: ResearchCandle[] = [];
  let price = 100;
  for (let i = 0; i < barCount; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const drift = Math.sin(i / 8) * 0.5;
    const open = price;
    const close = price + drift + (i % 3) * 0.2 - 0.2;
    candles.push({
      ts: `${startDate.slice(0, 8)}${day}`,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 100_000 + i * 1000,
    });
    price = close;
  }
  const dataset: ResearchDataset = {
    datasetId: input.datasetId,
    name: input.datasetId,
    symbols: input.symbols,
    startDate,
    endDate: candles[candles.length - 1].ts,
    assetClass: 'equity',
    barCount,
    source: 'synthetic_research',
  };
  registerDataset(dataset, candles);
  return { dataset, candles };
}
