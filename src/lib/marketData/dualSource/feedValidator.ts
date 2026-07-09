// Cross-source validation — compare Yahoo vs IndianAPI before signals.

import { isMarketOpen } from '@/lib/marketData/marketHours';
import type {
  CrossSourceMetrics,
  DualSourceConfig,
  FeedValidationResult,
  NormalizedFeedTick,
  ValidationStatus,
} from './types';

function bpsDiff(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Infinity;
  return Math.abs((a - b) / ((a + b) / 2)) * 10_000;
}

function pctDiff(a: number, b: number): number | null {
  if (a <= 0 && b <= 0) return 0;
  const base = Math.max(a, b, 1);
  return Math.abs(a - b) / base * 100;
}

function ohlcConsistent(a: NormalizedFeedTick, b: NormalizedFeedTick): boolean {
  const fields: Array<keyof Pick<NormalizedFeedTick, 'open' | 'high' | 'low' | 'close'>> =
    ['open', 'high', 'low', 'close'];
  let compared = 0;
  let ok = 0;
  for (const f of fields) {
    if (a[f] > 0 && b[f] > 0) {
      compared++;
      if (bpsDiff(a[f], b[f]) <= 150) ok++;
    }
  }
  return compared === 0 ? true : ok / compared >= 0.75;
}

export function validateCrossSourceFeeds(
  symbol: string,
  yahoo: NormalizedFeedTick | null,
  indian: NormalizedFeedTick | null,
  config: Pick<
    DualSourceConfig,
    'priceToleranceBps' | 'volumeTolerancePct' | 'timestampToleranceMs' | 'outlierSpikeBps'
  >,
  now = Date.now(),
): FeedValidationResult {
  const reasons: string[] = [];
  const marketOpen = isMarketOpen();

  if (!yahoo && !indian) {
    return {
      symbol,
      status: 'no_reliable_data',
      metrics: {
        priceDiffBps: null,
        volumeDiffPct: null,
        timestampSkewMs: null,
        ohlcConsistent: null,
        outlierDetected: false,
        missingCandles: true,
        delayedUpdate: false,
      },
      yahoo,
      indianapi: indian,
      reasons: ['both_sources_failed'],
      validatedAt: now,
    };
  }

  if (!yahoo || !indian) {
    const present = yahoo ?? indian!;
    const missing = yahoo ? 'indianapi' : 'yahoo';
    const age = now - present.sourceTimestamp;
    const delayed = marketOpen && age > config.timestampToleranceMs;
    if (delayed) reasons.push(`${missing}_missing_and_present_feed_delayed`);
    else reasons.push(`${missing}_unavailable`);
    return {
      symbol,
      status: 'single_source',
      metrics: {
        priceDiffBps: null,
        volumeDiffPct: null,
        timestampSkewMs: null,
        ohlcConsistent: null,
        outlierDetected: false,
        missingCandles: false,
        delayedUpdate: delayed,
      },
      yahoo,
      indianapi: indian,
      reasons,
      validatedAt: now,
    };
  }

  const priceDiffBps = bpsDiff(yahoo.ltp, indian.ltp);
  const volumeDiffPct = pctDiff(yahoo.volume, indian.volume);
  const timestampSkewMs = Math.abs(yahoo.sourceTimestamp - indian.sourceTimestamp);
  const ohlcOk = ohlcConsistent(yahoo, indian);
  const outlier = priceDiffBps >= config.outlierSpikeBps;
  const yahooAge = now - yahoo.sourceTimestamp;
  const indianAge = now - indian.sourceTimestamp;
  const delayed = marketOpen && (
    yahooAge > config.timestampToleranceMs || indianAge > config.timestampToleranceMs
  );

  if (delayed) reasons.push('delayed_update');
  if (!ohlcOk) reasons.push('ohlc_inconsistent');
  if (outlier) reasons.push('outlier_spike');

  const priceOk = priceDiffBps <= config.priceToleranceBps;
  const volumeOk = volumeDiffPct == null || volumeDiffPct <= config.volumeTolerancePct;
  const timeOk = timestampSkewMs <= config.timestampToleranceMs;

  let status: ValidationStatus;
  if (priceOk && volumeOk && timeOk && ohlcOk && !outlier && !delayed) {
    status = 'confirmed';
    reasons.push('sources_agree');
  } else {
    status = 'pending_validation';
    if (!priceOk) reasons.push(`price_diff_${priceDiffBps.toFixed(1)}bps`);
    if (!volumeOk) reasons.push(`volume_diff_${volumeDiffPct?.toFixed(1)}pct`);
    if (!timeOk) reasons.push(`timestamp_skew_${timestampSkewMs}ms`);
  }

  if (priceDiffBps >= config.outlierSpikeBps * 2) {
    status = 'data_mismatch';
    reasons.push('severe_price_mismatch');
  }

  return {
    symbol,
    status,
    metrics: {
      priceDiffBps,
      volumeDiffPct,
      timestampSkewMs,
      ohlcConsistent: ohlcOk,
      outlierDetected: outlier,
      missingCandles: false,
      delayedUpdate: delayed,
    },
    yahoo,
    indianapi: indian,
    reasons,
    validatedAt: now,
  };
}
