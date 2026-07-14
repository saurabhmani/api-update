// Confidence scoring from dual-source agreement and feed quality.

import type {
  ConfidenceBand,
  FeedValidationResult,
  NormalizedFeedTick,
} from './types';

export interface ConfidenceInput {
  validation: FeedValidationResult;
  indicatorsAgree?: boolean | null;
  trendConfirmed?: boolean | null;
  liquidityOk?: boolean | null;
  volatilityOk?: boolean | null;
}

function bandFromScore(score: number): ConfidenceBand {
  if (score >= 98) return 'institutional';
  if (score >= 90) return 'high';
  if (score >= 80) return 'moderate';
  return 'reject';
}

function freshnessScore(tick: NormalizedFeedTick | null, now: number, slaMs: number): number {
  if (!tick) return 0;
  const age = now - tick.sourceTimestamp;
  if (age <= slaMs / 4) return 100;
  if (age <= slaMs / 2) return 85;
  if (age <= slaMs) return 70;
  if (age <= slaMs * 2) return 50;
  return 20;
}

export function computeConfidenceScore(input: ConfidenceInput, now = Date.now()): {
  score: number;
  band: ConfidenceBand;
  breakdown: Record<string, number>;
} {
  const { validation } = input;
  const slaMs = Math.max(30_000, Number(process.env.DUAL_SOURCE_TIMESTAMP_TOLERANCE_MS) || 60_000);
  const breakdown: Record<string, number> = {};

  let sourceAgreement = 0;
  switch (validation.status) {
    case 'confirmed':        sourceAgreement = 100; break;
    case 'single_source':    sourceAgreement = 55; break;
    case 'pending_validation': sourceAgreement = 40; break;
    case 'data_mismatch':    sourceAgreement = 15; break;
    default:                 sourceAgreement = 0;
  }
  breakdown.sourceAgreement = sourceAgreement;

  const yFresh = freshnessScore(validation.yahoo, now, slaMs);
  const iFresh = freshnessScore(validation.kite, now, slaMs);
  const syncScore = validation.metrics.timestampSkewMs != null
    ? Math.max(0, 100 - Math.min(100, validation.metrics.timestampSkewMs / (slaMs / 100)))
    : 50;
  breakdown.timestampSync = Math.round((yFresh + iFresh) / 2 * 0.4 + syncScore * 0.6);

  const priceScore = validation.metrics.priceDiffBps != null
    ? Math.max(0, 100 - Math.min(100, validation.metrics.priceDiffBps / 5))
    : (validation.status === 'single_source' ? 60 : 0);
  breakdown.priceConsistency = Math.round(priceScore);

  const volScore = validation.metrics.volumeDiffPct != null
    ? Math.max(0, 100 - Math.min(100, validation.metrics.volumeDiffPct))
    : 70;
  breakdown.volumeConfirmation = Math.round(volScore);

  breakdown.indicatorAgreement = input.indicatorsAgree === true ? 100
    : input.indicatorsAgree === false ? 20 : 50;
  breakdown.trendConfirmation = input.trendConfirmed === true ? 100
    : input.trendConfirmed === false ? 30 : 50;
  breakdown.liquidity = input.liquidityOk === true ? 100
    : input.liquidityOk === false ? 25 : 60;
  breakdown.volatility = input.volatilityOk === true ? 100
    : input.volatilityOk === false ? 30 : 60;

  const weights = {
    sourceAgreement: 0.28,
    timestampSync: 0.14,
    priceConsistency: 0.18,
    volumeConfirmation: 0.10,
    indicatorAgreement: 0.12,
    trendConfirmation: 0.08,
    liquidity: 0.05,
    volatility: 0.05,
  };

  let score = 0;
  for (const [k, w] of Object.entries(weights)) {
    score += (breakdown[k] ?? 0) * w;
  }
  score = Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;

  return { score, band: bandFromScore(score), breakdown };
}
