// ════════════════════════════════════════════════════════════════
//  Phase 7 — In-sample calibration (walk-forward fold)
//
//  Estimates permitted filter parameters from IS results ONLY.
//  Output is frozen and applied unchanged to the next OOS window.
// ════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import type { BacktestRunConfig, FrozenCalibrationArtifact, SimulatedTrade } from '../types';
import { forbidOosOptimisation } from '../bias/leakageGuards';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export const IN_SAMPLE_CALIBRATION_VERSION = '7.0.0';

export interface InSampleCalibrationInput {
  foldIndex: number;
  inSampleStart: string;
  inSampleEnd: string;
  baseConfig: BacktestRunConfig;
  /** Completed IS trades — never pass OOS trades. */
  inSampleTrades: SimulatedTrade[];
  window: 'in_sample';
}

/**
 * Calibrate bounded filters from in-sample outcomes.
 * Does NOT invent strategy rules — only adjusts publication floors mildly.
 */
export function calibrateFromInSample(input: InSampleCalibrationInput): FrozenCalibrationArtifact {
  if (input.window !== 'in_sample') {
    throw new Error('calibrateFromInSample may only run on in_sample window');
  }
  const leakage = forbidOosOptimisation('is');
  void leakage;

  const trades = input.inSampleTrades;
  const n = trades.length;
  const base = input.baseConfig;
  const notes: string[] = [];

  let minConfidence = base.minConfidence;
  let minRewardRisk = base.minRewardRisk;
  let slippageBps = base.slippageBps;

  if (n < 20) {
    notes.push(`Insufficient IS sample (n=${n}) — using base filters without optimisation`);
  } else {
    const exp = computeExpectancy(trades);
    // Mild shrink toward more selective filters when IS edge is thin
    if (exp.expectancyR < 0.05) {
      minConfidence = Math.min(75, base.minConfidence + 5);
      notes.push(`Thin IS expectancyR=${exp.expectancyR} → raise minConfidence to ${minConfidence}`);
    } else if (exp.expectancyR > 0.25 && base.minConfidence > 50) {
      minConfidence = Math.max(50, base.minConfidence - 2);
      notes.push(`Strong IS expectancyR=${exp.expectancyR} → slight minConfidence ease to ${minConfidence}`);
    }

    if (exp.profitFactor < 1.1) {
      minRewardRisk = Math.min(2.0, Math.max(base.minRewardRisk, 1.4));
      notes.push(`Weak IS PF=${r(exp.profitFactor)} → minRewardRisk ${minRewardRisk}`);
    }

    // Confidence-monotonicity soft check
    const hi = trades.filter((t) => t.confidenceScore >= 70);
    const lo = trades.filter((t) => t.confidenceScore < 55);
    const hiWr = hi.length ? hi.filter((t) => t.outcome === 'win').length / hi.length : 0;
    const loWr = lo.length ? lo.filter((t) => t.outcome === 'win').length / lo.length : 0;
    if (hi.length >= 8 && lo.length >= 8 && hiWr + 0.05 < loWr) {
      minConfidence = Math.min(78, minConfidence + 3);
      notes.push('IS confidence inversion detected — raised minConfidence');
    }
  }

  const payload = {
    foldIndex: input.foldIndex,
    inSampleStart: input.inSampleStart,
    inSampleEnd: input.inSampleEnd,
    minConfidence,
    minRewardRisk,
    slippageBps,
    n,
  };
  const artifactHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

  return {
    modelVersion: IN_SAMPLE_CALIBRATION_VERSION,
    foldIndex: input.foldIndex,
    calibratedAt: new Date().toISOString(),
    inSampleStart: input.inSampleStart,
    inSampleEnd: input.inSampleEnd,
    sampleSize: n,
    minConfidence,
    minRewardRisk,
    slippageBps,
    notes,
    artifactHash,
  };
}

/** Apply a frozen artifact onto a base config for OOS (immutable freeze). */
export function applyFrozenCalibration(
  base: BacktestRunConfig,
  frozen: FrozenCalibrationArtifact,
): BacktestRunConfig {
  return {
    ...base,
    minConfidence: frozen.minConfidence,
    minRewardRisk: frozen.minRewardRisk,
    slippageBps: frozen.slippageBps,
    frozenCalibration: frozen,
  };
}

function r(n: number): number {
  return Math.round(n * 1000) / 1000;
}
