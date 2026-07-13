// ════════════════════════════════════════════════════════════════
//  Phase 5 — Release Governance
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DeploymentValidationResult, ReleaseManifest } from './types';
import { OPERATIONS_SCHEMA_VERSION } from './types';
import { ADAPTIVE_LEARNING_VERSION } from '@/lib/signal-engine/adaptive/adaptiveParameterTypes';
import { PERFORMANCE_REPORT_VERSION } from '@/lib/signal-engine/analytics/performanceReporting';
import { OUTCOME_INTELLIGENCE_VERSION } from '@/lib/signal-engine/feedback/outcomeTracker';
import { SIGNAL_ENGINE_CONFIG_VERSION } from '@/lib/signal-engine/config/signalEnginePhase2Config';

export const RELEASE_MANIFEST_VERSION = '5.0.0';

export interface ReleaseManifestInput {
  generatedAt: string;
  gitCommit?: string | null;
  buildVersion?: string;
  adaptiveVersion?: string | null;
  validationResult?: DeploymentValidationResult | null;
  releaseNotes?: string | null;
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitCommit(): string | null {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    const head = readFileSync(join(process.cwd(), '.git', 'HEAD'), 'utf-8').trim();
    if (head.startsWith('ref:')) {
      const ref = head.slice(5).trim();
      const refPath = join(process.cwd(), '.git', ref);
      if (existsSync(refPath)) return readFileSync(refPath, 'utf-8').trim().slice(0, 12);
    }
    return head.slice(0, 12);
  } catch {
    return null;
  }
}

export function buildReleaseManifest(input: ReleaseManifestInput): ReleaseManifest {
  const validation = input.validationResult;
  const checks = validation?.checks.map((c) => ({
    name: c.name,
    passed: c.passed,
    message: c.message,
  })) ?? [];

  return {
    manifestVersion: RELEASE_MANIFEST_VERSION,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit ?? readGitCommit(),
    buildVersion: input.buildVersion ?? readPackageVersion(),
    configurationVersion: SIGNAL_ENGINE_CONFIG_VERSION,
    learningVersion: OUTCOME_INTELLIGENCE_VERSION,
    adaptiveVersion: input.adaptiveVersion ?? ADAPTIVE_LEARNING_VERSION,
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    benchmarkVersion: PERFORMANCE_REPORT_VERSION,
    validationStatus: validation
      ? (validation.passed ? 'passed' : 'failed')
      : 'pending',
    validationChecks: checks,
    releaseNotes: input.releaseNotes ?? null,
  };
}

export function hashReleaseManifest(manifest: ReleaseManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function releaseManifestToJson(manifest: ReleaseManifest): string {
  return JSON.stringify({ ...manifest, contentHash: hashReleaseManifest(manifest) }, null, 2);
}

export function verifyReleaseManifest(manifest: ReleaseManifest, expectedHash?: string): boolean {
  if (!expectedHash) return true;
  return hashReleaseManifest(manifest) === expectedHash;
}
