#!/usr/bin/env tsx
/**
 * Benchmark adaptive learning pipeline on historical outcome analytics.
 * Report-only — does not promote parameters unless env flags are set.
 */
import 'tsconfig-paths/register';
import { loadOutcomeAnalyticsRecords } from '@/lib/workers/learningScheduler';
import { runAdaptiveLearningPipeline } from '@/lib/signal-engine/adaptive/runAdaptiveLearningPipeline';
import { clearAdaptiveParameterStore } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { clearAdaptiveAuditTrail } from '@/lib/signal-engine/adaptive/learningAudit';
import { resetRuntimeConfiguration } from '@/lib/signal-engine/adaptive/runtimeConfiguration';

async function main(): Promise<void> {
  clearAdaptiveParameterStore();
  clearAdaptiveAuditTrail();
  resetRuntimeConfiguration();
  process.env.SIGNAL_ADAPTIVE_WRITE_REPORTS = 'false';

  const records = await loadOutcomeAnalyticsRecords(90);
  const started = Date.now();
  const result = await runAdaptiveLearningPipeline({
    records,
    lookbackDays: 90,
    createdAt: new Date().toISOString(),
    priorSnapshot: null,
  });
  const elapsed = Date.now() - started;

  console.log(JSON.stringify({
    benchmark: 'adaptive-learning',
    sampleSize: records.length,
    elapsedMs: elapsed,
    ...result,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
