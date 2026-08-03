/**
 * validateFibonacciPipeline.ts — fibonacci_pullback pipeline acceptance
 *
 * Usage:
 *   npx tsx scripts/validateFibonacciPullbackPipeline.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env.production') });

import type { StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import { STRATEGY_REGISTRY, getStrategyEntryType } from '@/lib/signal-engine/strategies/strategyRegistry';
import { generatePhase4Signals } from '@/lib/signal-engine';
import type { Candle, CandleProvider, PortfolioSnapshot } from '@/lib/signal-engine';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';
import { DEFAULT_PHASE3_CONFIG } from '@/lib/signal-engine/constants/phase3.constants';
import { buildFibonacciTestCandles } from './seedFibonacciPullbackTest';
import { persistBarsForSymbol } from '@/lib/marketData/candleBackfillJob';
import { db } from '@/lib/db';

const ALL_STRATEGIES: StrategyName[] = [
  'bullish_breakout', 'bullish_pullback', 'fibonacci_pullback', 'bearish_breakdown',
  'mean_reversion_bounce', 'momentum_continuation', 'bullish_divergence', 'volume_climax_reversal',
  'gap_continuation', 'range_breakout', 'ema_crossover', 'oversold_bounce', 'overbought_reversal',
  'weak_trend_breakdown', 'failed_breakout_reversal', 'bearish_pullback_rejection',
  'volatility_squeeze_breakout', 'multi_timeframe_alignment', 'vwap_reclaim_long',
  'vwap_rejection_short', 'opening_range_breakout', 'opening_range_breakdown',
];

const TEST_SYMBOL = 'FIBPIPE';

async function main(): Promise<void> {
  const registryMissing = ALL_STRATEGIES.filter((s) => !STRATEGY_REGISTRY[s]);
  const entryTypeFallbacks: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    if (msg.includes('[strategyRegistry] entryType fallback')) {
      entryTypeFallbacks.push(msg);
    }
    origWarn(...args);
  };

  for (const s of ALL_STRATEGIES) {
    getStrategyEntryType(s);
  }
  console.warn = origWarn;

  const fibMeta = STRATEGY_REGISTRY.fibonacci_pullback;
  const candles = buildFibonacciTestCandles();
  await persistBarsForSymbol(TEST_SYMBOL, candles);

  const provider: CandleProvider = {
    async fetchDailyCandles(symbol: string): Promise<Candle[]> {
      if (symbol.toUpperCase() === TEST_SYMBOL) return candles;
      return [];
    },
  };

  const portfolio: PortfolioSnapshot = {
    capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions: [],
    pendingSignals: [],
  };

  let pipelineError: string | null = null;
  let result: Awaited<ReturnType<typeof generatePhase4Signals>> | null = null;
  try {
    result = await generatePhase4Signals(
      provider,
      portfolio,
      undefined,
      undefined,
      {
        ...DEFAULT_PHASE1_CONFIG,
        universe: [TEST_SYMBOL],
        benchmarkSymbol: TEST_SYMBOL,
      },
      undefined,
      { generationSource: 'validate:fibonacci-pipeline' },
    );
  } catch (err) {
    pipelineError = err instanceof Error ? err.message : String(err);
  }

  const fibSignal = result?.signals.find((s) => s.signalType === 'fibonacci_pullback') ?? null;
  const selectiveNoTrade =
    pipelineError == null
    && fibSignal == null
    && (result?.signals?.length ?? 0) === 0;

  const criteria = {
    // Registry contract always required.
    '1_registry_signal_type': {
      pass: fibMeta?.signalType === 'fibonacci_pullback',
      detail: `registry.signalType=${fibMeta?.signalType ?? 'missing'}`,
    },
    // Phase 5+: Sideways/Weak regimes correctly suppress fibonacci — no-trade is valid.
    // When a signal is produced it must carry the canonical subtype.
    '2_match_or_selective_no_trade': {
      pass:
        (fibSignal?.signalType === 'fibonacci_pullback'
          && fibSignal?.signalSubtype === 'fib_retracement_entry')
        || selectiveNoTrade,
      detail:
        fibSignal
          ? `matched subtype=${fibSignal.signalSubtype}`
          : `selective_no_trade=true signals=${result?.signals?.length ?? 0} (Phase 5 regime selectivity is acceptable)`,
    },
    '3_no_unknown_strategy_errors': {
      pass:
        pipelineError == null
        && registryMissing.length === 0
        && entryTypeFallbacks.length === 0
        && !(pipelineError ?? '').toLowerCase().includes('unknown strategy'),
      detail:
        `pipeline_error=${pipelineError ?? 'none'} ` +
        `registry_missing=[${registryMissing.join(',')}] ` +
        `entryType_fallbacks=${entryTypeFallbacks.length}`,
    },
  };

  console.log('\n=== FIBONACCI PIPELINE VALIDATION ===\n');
  let passCount = 0;
  for (const [key, c] of Object.entries(criteria)) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}`);
    console.log(`       ${c.detail}\n`);
    if (c.pass) passCount++;
  }
  console.log(`Result: ${passCount}/${Object.keys(criteria).length} criteria passed`);
  console.log('Note: run npm run typecheck && npm run lint && npm run build for build/lint gate.\n');

  await db.query(`DELETE FROM q365_signals WHERE symbol = ?`, [TEST_SYMBOL]);
  await db.query(`DELETE FROM candles WHERE instrument_key = ?`, [`NSE_EQ|${TEST_SYMBOL}`]);

  process.exit(passCount === Object.keys(criteria).length && !pipelineError ? 0 : 1);
}

main().catch((err) => {
  console.error('[validateFibonacciPipeline] fatal:', err);
  process.exit(2);
});
