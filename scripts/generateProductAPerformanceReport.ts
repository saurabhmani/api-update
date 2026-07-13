#!/usr/bin/env tsx

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadOutcomeAnalyticsRecords } from '../src/lib/workers/learningScheduler';
import {
  buildProductAPerformanceReport,
  reportToCsv,
  reportToJson,
} from '../src/lib/signal-engine/analytics/performanceReporting';

function parseLookback(): number {
  const arg = process.argv.find((value) => value.startsWith('--days='));
  const value = Number(arg?.split('=')[1] ?? 365);
  return Number.isFinite(value) ? Math.max(1, Math.min(3650, Math.floor(value))) : 365;
}

async function main(): Promise<void> {
  const lookbackDays = parseLookback();
  const records = await loadOutcomeAnalyticsRecords(lookbackDays);
  const report = buildProductAPerformanceReport(records);
  const outputDir = path.resolve(process.cwd(), 'reports', 'product-a');
  await mkdir(outputDir, { recursive: true });

  const stamp = report.generatedAt.slice(0, 10).replaceAll('-', '');
  const jsonPath = path.join(outputDir, `performance-${stamp}.json`);
  const csvPath = path.join(outputDir, `performance-${stamp}.csv`);
  await Promise.all([
    writeFile(jsonPath, `${reportToJson(report)}\n`, 'utf8'),
    writeFile(csvPath, `${reportToCsv(report)}\n`, 'utf8'),
  ]);

  console.log(JSON.stringify({
    lookbackDays,
    sampleCount: records.length,
    jsonPath,
    csvPath,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[performance-report]', error);
    process.exit(1);
  });
