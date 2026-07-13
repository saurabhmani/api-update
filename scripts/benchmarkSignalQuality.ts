#!/usr/bin/env tsx
/**
 * Phase 2 — Historical signal quality benchmark.
 *
 * Compares Phase 1 (config v1) vs Phase 2 (config v2) on synthetic
 * replay fixtures. Outputs acceptance/rejection/confidence metrics.
 *
 * Usage: npm run benchmark:signal-quality
 */
import { buildSignalFeatures } from '../src/lib/signal-engine/features/buildSignalFeatures';
import { runAllStrategies } from '../src/lib/signal-engine/strategy-engine/runStrategies';
import { runRejectionEngine } from '../src/lib/signal-engine/core/runRejectionEngine';
import { resetSignalEngineConfigCache } from '../src/lib/signal-engine/config/signalEnginePhase2Config';
import type { Candle, RelativeStrengthFeatures } from '../src/lib/signal-engine/types/signalEngine.types';

const RS: RelativeStrengthFeatures = { rsVsIndex: 1.5, rsVsSector: 0.5, sectorStrengthScore: 58 };

function makeScenario(name: string, trend: 'up' | 'down' | 'flat', vol: number): Candle[] {
  const out: Candle[] = [];
  const start = Date.UTC(2023, 0, 1);
  let price = 300;
  for (let i = 0; i < 150; i++) {
    const drift = trend === 'up' ? 0.4 : trend === 'down' ? -0.35 : 0.05;
    price += drift + Math.sin(i / 5) * 2;
    const close = Math.max(50, price);
    out.push({
      ts: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open: close - 0.8,
      high: close + vol,
      low: close - vol,
      close,
      volume: 180_000 + (i % 10) * 15_000,
    });
  }
  return out;
}

const SCENARIOS = [
  { label: 'uptrend', candles: makeScenario('uptrend', 'up', 2) },
  { label: 'downtrend', candles: makeScenario('downtrend', 'down', 2.5) },
  { label: 'sideways', candles: makeScenario('sideways', 'flat', 1.5) },
];

interface BenchMetrics {
  accepted: number;
  rejected: number;
  deferred: number;
  avgConfidence: number;
  avgRR: number;
  strategies: Record<string, number>;
}

function runBench(version: 1 | 2): BenchMetrics {
  process.env.SIGNAL_ENGINE_CONFIG_VERSION = String(version);
  resetSignalEngineConfigCache();

  const metrics: BenchMetrics = {
    accepted: 0,
    rejected: 0,
    deferred: 0,
    avgConfidence: 0,
    avgRR: 0,
    strategies: {},
  };

  let confSum = 0;
  let rrSum = 0;
  let n = 0;

  for (const { label, candles } of SCENARIOS) {
    const regime = label === 'uptrend' ? 'Bullish' : label === 'downtrend' ? 'Bearish' : 'Sideways';
    const features = buildSignalFeatures(candles, regime as 'Bullish' | 'Bearish' | 'Sideways');
    const { candidates } = runAllStrategies(features, RS);

    for (const c of candidates) {
      const decision = runRejectionEngine({
        symbol: `BENCH_${label}`,
        strategy: c.strategy,
        confidenceScore: c.confidence.finalScore,
        riskScore: c.risk.totalScore,
        rewardRisk: c.tradePlan.rewardRiskApprox,
        entryPrice: c.tradePlan.entry.zoneHigh,
        stopLoss: c.tradePlan.stopLoss,
        atrPct: features.volatility.atrPct,
        volume: features.volume.volume,
        regime,
        sector: 'IT',
        portfolioFit: {
          fitScore: 55,
          sectorExposureImpact: 'acceptable',
          directionImpact: 'acceptable',
          capitalAvailability: 'sufficient',
          correlationCluster: null,
          correlationPenalty: 0,
          portfolioDecision: 'approved',
          penalties: [],
        },
        executionReadiness: {
          status: 'ready',
          actionTag: 'enter_now',
          priorityRank: 1,
          approvalDecision: 'approved',
          reasons: [],
        },
        features: c.features,
        direction: c.strategy.includes('bearish') || c.strategy.includes('reversal') ? 'SELL' : 'BUY',
      });

      if (decision.finalDecision === 'approved') metrics.accepted++;
      else if (decision.finalDecision === 'deferred') metrics.deferred++;
      else metrics.rejected++;

      confSum += c.confidence.finalScore;
      rrSum += c.tradePlan.rewardRiskApprox;
      n++;
      metrics.strategies[c.strategy] = (metrics.strategies[c.strategy] ?? 0) + 1;
    }
  }

  metrics.avgConfidence = n > 0 ? Math.round(confSum / n) : 0;
  metrics.avgRR = n > 0 ? Math.round((rrSum / n) * 10) / 10 : 0;
  return metrics;
}

function main() {
  const phase1 = runBench(1);
  const phase2 = runBench(2);

  console.log('══════════════════════════════════════════════════════════');
  console.log('Signal Quality Benchmark — Phase 1 vs Phase 2');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Phase 1 (config v1):');
  console.log(JSON.stringify(phase1, null, 2));
  console.log('');
  console.log('Phase 2 (config v2):');
  console.log(JSON.stringify(phase2, null, 2));
  console.log('');
  console.log('Delta:');
  console.log(`  Accepted:  ${phase2.accepted - phase1.accepted >= 0 ? '+' : ''}${phase2.accepted - phase1.accepted}`);
  console.log(`  Rejected:  ${phase2.rejected - phase1.rejected >= 0 ? '+' : ''}${phase2.rejected - phase1.rejected}`);
  console.log(`  Avg conf:  ${phase2.avgConfidence - phase1.avgConfidence >= 0 ? '+' : ''}${phase2.avgConfidence - phase1.avgConfidence}`);
  console.log(`  Avg R:R:   ${phase2.avgRR - phase1.avgRR >= 0 ? '+' : ''}${phase2.avgRR - phase1.avgRR}`);
  console.log('');
  console.log('Determinism: identical replay inputs produce identical outputs per config version.');
}

main();
