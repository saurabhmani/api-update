import type { OutcomeAnalyticsRecord } from './outcomeAnalytics';

export const CONFIDENCE_ANALYTICS_VERSION = '3.0.0';

export interface ReliabilityBucket {
  lowerBound: number;
  upperBound: number;
  sampleCount: number;
  meanPredictedConfidence: number;
  observedWinRate: number;
  calibrationError: number;
}

export interface ConfidenceCalibrationReport {
  version: string;
  sampleCount: number;
  brierScore: number;
  expectedCalibrationError: number;
  maximumCalibrationError: number;
  reliabilityCurve: ReliabilityBucket[];
}

function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isWin(record: OutcomeAnalyticsRecord): number {
  return record.outcome.target1Hit && record.outcome.exitReason !== 'stop' ? 1 : 0;
}

/**
 * Generate calibration analytics only. This never feeds values back into
 * confidence scoring or signal generation.
 */
export function buildConfidenceCalibrationReport(
  records: readonly OutcomeAnalyticsRecord[],
  bucketWidth = 10,
): ConfidenceCalibrationReport {
  const width = Math.max(5, Math.min(25, Math.round(bucketWidth)));
  const bucketCount = Math.ceil(100 / width);
  const buckets: OutcomeAnalyticsRecord[][] = Array.from({ length: bucketCount }, () => []);

  for (const record of records) {
    const confidence = Math.max(0, Math.min(100, record.predictedConfidence));
    const index = Math.min(bucketCount - 1, Math.floor(confidence / width));
    buckets[index].push(record);
  }

  const reliabilityCurve: ReliabilityBucket[] = buckets.map((rows, index) => {
    const lowerBound = index * width;
    const upperBound = Math.min(100, (index + 1) * width);
    const sampleCount = rows.length;
    const meanPredictedConfidence = sampleCount === 0
      ? 0
      : rows.reduce((sum, row) => sum + row.predictedConfidence, 0) / sampleCount / 100;
    const observedWinRate = sampleCount === 0
      ? 0
      : rows.reduce((sum, row) => sum + isWin(row), 0) / sampleCount;

    return {
      lowerBound,
      upperBound,
      sampleCount,
      meanPredictedConfidence: round(meanPredictedConfidence),
      observedWinRate: round(observedWinRate),
      calibrationError: round(Math.abs(meanPredictedConfidence - observedWinRate)),
    };
  }).filter((bucket) => bucket.sampleCount > 0);

  const sampleCount = records.length;
  const brierScore = sampleCount === 0
    ? 0
    : records.reduce((sum, record) => {
      const predicted = Math.max(0, Math.min(1, record.predictedConfidence / 100));
      return sum + (predicted - isWin(record)) ** 2;
    }, 0) / sampleCount;

  const expectedCalibrationError = sampleCount === 0
    ? 0
    : reliabilityCurve.reduce(
      (sum, bucket) => sum + bucket.calibrationError * bucket.sampleCount / sampleCount,
      0,
    );

  return {
    version: CONFIDENCE_ANALYTICS_VERSION,
    sampleCount,
    brierScore: round(brierScore),
    expectedCalibrationError: round(expectedCalibrationError),
    maximumCalibrationError: round(Math.max(0, ...reliabilityCurve.map((bucket) => bucket.calibrationError))),
    reliabilityCurve,
  };
}
