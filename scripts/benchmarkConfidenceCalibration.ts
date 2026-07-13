#!/usr/bin/env tsx

import { loadOutcomeAnalyticsRecords } from '../src/lib/workers/learningScheduler';
import { buildConfidenceCalibrationReport } from '../src/lib/signal-engine/analytics/confidenceAnalytics';

async function main(): Promise<void> {
  const lookbackDays = Math.max(30, Math.min(3650, Number(process.env.CALIBRATION_BENCHMARK_DAYS) || 365));
  const records = await loadOutcomeAnalyticsRecords(lookbackDays);
  const report = buildConfidenceCalibrationReport(records);
  console.log(JSON.stringify({
    benchmarkVersion: report.version,
    lookbackDays,
    ...report,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[confidence-calibration-benchmark]', error);
    process.exit(1);
  });
