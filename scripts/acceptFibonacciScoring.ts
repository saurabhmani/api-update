/**
 * Acceptance probe for fibonacci_pullback scoring, reasons, and warnings.
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '.env.local') });
dotenvConfig({ path: resolve(process.cwd(), '.env.production') });

import { buildFibonacciTestCandles } from './seedFibonacciPullbackTest';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { evaluateFibonacciPullback } from '@/lib/signal-engine/strategies/fibonacciPullback';
import { validateCandleSeries } from '@/lib/signal-engine/utils/candles';
import { MIN_CANDLE_COUNT, STRUCTURE_LOOKBACK } from '@/lib/signal-engine/constants/signalEngine.constants';
import { calculateFibonacciLevels } from '@/lib/signal-engine/indicators/fibonacci';
import { scoreConfidence, scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import { buildReasons } from '@/lib/signal-engine/explain/buildReasons';
import { buildWarnings } from '@/lib/signal-engine/explain/buildWarnings';
import type { RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const RS_STUB: RelativeStrengthFeatures = {
  rsVsIndex: 1,
  rsVsSector: 1,
  sectorStrengthScore: 55,
};

const FIB_REASON_PHRASES = [
  'Fibonacci retracement support zone',
  'aligned with the bullish trend',
  'reacting from',
];

const FIB_WARNING_PHRASES = [
  'below the key Fibonacci retracement zone',
  'volume confirmation is missing',
  'below 61.8% or 78.6%',
];

function tuneMatched() {
  const base = buildFibonacciTestCandles().map((c) => ({ ...c }));
  const n = base.length;
  const lookStart = n - STRUCTURE_LOOKBACK - 1;
  const hi = Math.max(...base.slice(lookStart, n - 1).map((c) => c.high));
  const lo = Math.min(...base.slice(lookStart, n - 1).map((c) => c.low));
  const levels = calculateFibonacciLevels(hi, lo);
  for (const target of [levels.fib382, levels.fib50, levels.fib618].filter((v): v is number => v != null)) {
    for (let drift = -2; drift <= 2; drift += 0.25) {
      const out = base.map((c) => ({ ...c }));
      const last = out[n - 1];
      last.close = target + drift;
      last.open = last.close - 0.2;
      last.high = last.close + 0.8;
      last.low = last.close - 0.8;
      if (!validateCandleSeries(out, MIN_CANDLE_COUNT).valid) continue;
      const f = buildSignalFeatures(out, 'Bullish', 50_000, 10);
      if (evaluateFibonacciPullback(f).matched) return f;
    }
  }
  throw new Error('Could not tune matched fibonacci fixture');
}

function weakFibFeatures(strong: SignalFeatures): SignalFeatures {
  const f = structuredClone(strong) as SignalFeatures;
  f.volume.volumeVs20dAvg = 0.5;
  f.momentum.rsi14 = 72;
  f.context.marketRegime = 'High Volatility Risk';
  f.structure.fibZoneMatched = false;
  if (f.structure.fib618 != null) {
    f.trend.close = f.structure.fib618 * 0.94;
  }
  return f;
}

function main(): void {
  const strong = tuneMatched();
  const weak = weakFibFeatures(strong);

  const strongReasons = buildReasons(strong, 'fibonacci_pullback');
  const weakWarnings = buildWarnings(weak, 'fibonacci_pullback');

  const baseScore = scoreConfidence(strong).finalScore;
  const fibScore = scoreConfidenceForStrategy(strong, 'fibonacci_pullback', RS_STUB).finalScore;
  const fibDelta = fibScore - baseScore;
  const breakoutScore = scoreConfidenceForStrategy(strong, 'bullish_breakout', RS_STUB).finalScore;
  const pullbackScore = scoreConfidenceForStrategy(strong, 'bullish_pullback', RS_STUB).finalScore;

  const reasonsOk = FIB_REASON_PHRASES.every((p) =>
    strongReasons.some((r) => r.includes(p)),
  );
  const warningsOk = FIB_WARNING_PHRASES.some((p) =>
    weakWarnings.some((w) => w.includes(p)),
  );
  const scoreOk = fibScore <= 85 && fibDelta <= 15 && fibDelta >= 0;
  const existingOk = breakoutScore > 0 && pullbackScore > 0;

  const results = {
    criterion1_reasons: reasonsOk,
    criterion2_weak_warnings: warningsOk,
    criterion3_score_realistic: scoreOk,
    criterion4_existing_scoring: existingOk,
    fib_score: fibScore,
    fib_delta_vs_base: fibDelta,
    breakout_score: breakoutScore,
    pullback_score: pullbackScore,
    strong_reasons_sample: strongReasons.slice(0, 4),
    weak_warnings_sample: weakWarnings.filter((w) =>
      FIB_WARNING_PHRASES.some((p) => w.includes(p)),
    ),
  };

  console.log(JSON.stringify(results, null, 2));
  const pass = reasonsOk && warningsOk && scoreOk && existingOk;
  process.exit(pass ? 0 : 1);
}

main();
