// ════════════════════════════════════════════════════════════════
//  Canonical feature normalization — maps raw values to 0..100
// ════════════════════════════════════════════════════════════════

import { clamp } from '../utils/math';

/**
 * Linear normalize `value` from [min, max] into [0, 100].
 * Values below min → 0, above max → 100.
 */
export function normalizeFeatureScore(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 50;
  const pct = ((value - min) / (max - min)) * 100;
  return clamp(Math.round(pct), 0, 100);
}

/**
 * Invert a 0..100 score so high raw values map to low quality scores.
 */
export function invertFeatureScore(score: number): number {
  return clamp(100 - Math.round(score), 0, 100);
}
