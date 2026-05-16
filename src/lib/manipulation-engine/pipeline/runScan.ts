// ════════════════════════════════════════════════════════════════
//  Pipeline — Run the Manipulation Scan for a Symbol / Universe
//
//  Pure orchestrator: wires the feature builder, detector registry,
//  and scoring into a single snapshot per (symbol, date). No DB
//  reads or writes here — callers decide when to persist.
// ════════════════════════════════════════════════════════════════

import type {
  DailyBar, ManipulationSnapshot, SymbolMeta, DetectorResult, AdvancedBarInputs,
} from '../types';
import { computeFeaturesForSeries } from '../features/computeFeatures';
import { ALL_DETECTORS } from '../detectors';
import { computeScore } from '../scoring/computeScore';
import { deriveRiskLabels } from '../scoring/riskLabels';

export interface ScanOptions {
  /** How many trailing bars of history each detector receives. Default 30. */
  detectorWindow?: number;
  /** Phase 2: optional pre-fetched intraday/orderbook/delivery for the scan bar. */
  advanced?: AdvancedBarInputs;
}

/**
 * Scan one symbol. Returns a snapshot for the LAST bar in the series —
 * the caller is responsible for ensuring `bars` ends at the date they
 * want evaluated. Returns null if there isn't enough history to evaluate.
 */
export function scanSymbol(
  symbol: string,
  bars: DailyBar[],
  meta: SymbolMeta = { symbol },
  options: ScanOptions = {},
): ManipulationSnapshot | null {
  if (bars.length < 2) return null;

  const features = computeFeaturesForSeries(symbol, bars, meta);
  const current = features[features.length - 1];
  const currentBar = bars[bars.length - 1];

  const windowSize = options.detectorWindow ?? 30;
  const history = features.slice(-windowSize);
  const barHistory = bars.slice(-windowSize);

  const advanced = options.advanced;
  const triggered: DetectorResult[] = ALL_DETECTORS.map((fn) =>
    fn({ symbol, current, history, currentBar, barHistory, meta, advanced }),
  );

  const { score, band, explanation } = computeScore(triggered, current);
  const riskLabels = deriveRiskLabels(triggered);

  return {
    symbol,
    snapshotDate: currentBar.date,
    manipulationScore: score,
    suspicionBand: band,
    features: current,
    triggeredEvents: triggered,
    explanation,
    riskLabels,
  };
}

/**
 * Scan an entire series — one snapshot per bar starting at the first
 * bar where enough history exists for features to stabilize (default
 * after `warmup` bars). Used for backtesting the surveillance layer
 * itself, not for production scoring.
 */
export function scanSymbolSeries(
  symbol: string,
  bars: DailyBar[],
  meta: SymbolMeta = { symbol },
  warmup: number = 21,
): ManipulationSnapshot[] {
  const out: ManipulationSnapshot[] = [];
  const features = computeFeaturesForSeries(symbol, bars, meta);

  for (let i = warmup; i < bars.length; i++) {
    const currentBar = bars[i];
    const current = features[i];
    const history = features.slice(Math.max(0, i - 30), i + 1);
    const barHistory = bars.slice(Math.max(0, i - 30), i + 1);

    const triggered = ALL_DETECTORS.map((fn) =>
      fn({ symbol, current, history, currentBar, barHistory, meta }),
    );

    const { score, band, explanation } = computeScore(triggered, current);
    const riskLabels = deriveRiskLabels(triggered);
    out.push({
      symbol,
      snapshotDate: currentBar.date,
      manipulationScore: score,
      suspicionBand: band,
      features: current,
      triggeredEvents: triggered,
      explanation,
      riskLabels,
    });
  }

  return out;
}
