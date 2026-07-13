// ════════════════════════════════════════════════════════════════
//  Phase 5 — Deployment Validation
// ════════════════════════════════════════════════════════════════

import type { DeploymentValidationResult } from './types';
import { getSignalEngineConfig } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import { getRuntimeSignalEngineConfig } from '@/lib/signal-engine/adaptive/runtimeConfiguration';
import { verifyAdaptiveParameterRecord } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { getActivePromotedParameter } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { verifyLearningSnapshot } from '@/lib/signal-engine/learning/versionedLearningSnapshots';
import type { ImmutableLearningSnapshot } from '@/lib/signal-engine/learning/versionedLearningSnapshots';

export interface DeploymentCheckInput {
  generatedAt: string;
  databaseConnected?: boolean;
  databaseLatencyMs?: number | null;
  learningSnapshot?: ImmutableLearningSnapshot | null;
  reportsDirWritable?: boolean;
  sessionSecretPresent?: boolean;
}

export function validateDeployment(input: DeploymentCheckInput): DeploymentValidationResult {
  const checks: DeploymentValidationResult['checks'] = [];

  const config = getSignalEngineConfig();
  checks.push({
    name: 'configuration_valid',
    category: 'configuration',
    passed: config.version >= 1 && Boolean(config.configVersionLabel),
    blocking: true,
    message: `Config version ${config.configVersionLabel}`,
  });

  const runtime = getRuntimeSignalEngineConfig(input.generatedAt);
  checks.push({
    name: 'runtime_configuration',
    category: 'runtime',
    passed: Boolean(runtime.config) && runtime.manifest.replayable,
    blocking: true,
    message: `Runtime ${runtime.config.configVersionLabel}`,
  });

  const active = getActivePromotedParameter();
  if (active) {
    checks.push({
      name: 'adaptive_parameter_integrity',
      category: 'adaptive',
      passed: verifyAdaptiveParameterRecord(active),
      blocking: true,
      message: `Active parameter ${active.parameterId}`,
    });
  } else {
    checks.push({
      name: 'adaptive_parameter_integrity',
      category: 'adaptive',
      passed: true,
      blocking: false,
      message: 'No active adaptive parameter (base config only)',
    });
  }

  if (input.learningSnapshot) {
    checks.push({
      name: 'learning_snapshot_valid',
      category: 'snapshots',
      passed: verifyLearningSnapshot(input.learningSnapshot),
      blocking: true,
      message: `Snapshot ${input.learningSnapshot.snapshotId}`,
    });
  } else {
    checks.push({
      name: 'learning_snapshot_valid',
      category: 'snapshots',
      passed: true,
      blocking: false,
      message: 'No snapshot provided (skipped)',
    });
  }

  checks.push({
    name: 'database_connectivity',
    category: 'database',
    passed: input.databaseConnected !== false,
    blocking: input.databaseConnected !== undefined,
    message: input.databaseConnected === undefined
      ? 'Database check skipped (offline)'
      : input.databaseConnected === false
        ? 'Database unreachable'
        : `DB latency ${input.databaseLatencyMs ?? 'n/a'}ms`,
  });

  checks.push({
    name: 'reports_path',
    category: 'reports',
    passed: input.reportsDirWritable !== false,
    blocking: false,
    message: input.reportsDirWritable === false ? 'Reports dir not writable' : 'Reports path OK',
  });

  checks.push({
    name: 'session_secret',
    category: 'security',
    passed: input.sessionSecretPresent !== false,
    blocking: true,
    message: input.sessionSecretPresent === false ? 'SESSION_SECRET missing' : 'Session secret present',
  });

  const blockingFailed = checks.some((c) => c.blocking && !c.passed);
  return {
    passed: !blockingFailed,
    generatedAt: input.generatedAt,
    checks,
  };
}

export function formatDeploymentValidationMarkdown(result: DeploymentValidationResult): string {
  const lines = [
    '# Deployment Validation',
    '',
    `Generated: ${result.generatedAt}`,
    `Overall: **${result.passed ? 'PASSED' : 'BLOCKED'}**`,
    '',
    '| Check | Category | Blocking | Status | Message |',
    '|-------|----------|----------|--------|---------|',
  ];
  for (const c of result.checks) {
    lines.push(`| ${c.name} | ${c.category} | ${c.blocking} | ${c.passed ? '✓' : '✗'} | ${c.message} |`);
  }
  return lines.join('\n');
}
