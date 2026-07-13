// ════════════════════════════════════════════════════════════════
//  Phase 5 — Backup & Recovery
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { BackupManifest } from './types';

export const BACKUP_CATEGORIES = [
  'signals',
  'outcomes',
  'learning_snapshots',
  'adaptive_parameters',
  'reports',
  'configuration',
] as const;

export type BackupCategory = typeof BACKUP_CATEGORIES[number];

export interface BackupPlan {
  backupId: string;
  generatedAt: string;
  categories: BackupCategory[];
  outputDir: string;
}

export function buildBackupPlan(input: {
  generatedAt: string;
  outputDir?: string;
  categories?: BackupCategory[];
}): BackupPlan {
  const stamp = input.generatedAt.slice(0, 19).replace(/[:T]/g, '-');
  return {
    backupId: `backup_${stamp}`,
    generatedAt: input.generatedAt,
    categories: input.categories ?? [...BACKUP_CATEGORIES],
    outputDir: input.outputDir ?? 'backups',
  };
}

export function buildBackupManifest(input: {
  backupId: string;
  generatedAt: string;
  artifacts: Array<{ category: string; path: string; recordCount: number | null; content?: string }>;
}): BackupManifest {
  return {
    backupId: input.backupId,
    generatedAt: input.generatedAt,
    artifacts: input.artifacts.map((a) => ({
      category: a.category,
      path: a.path,
      recordCount: a.recordCount,
      checksum: a.content ? createHash('sha256').update(a.content).digest('hex') : null,
    })),
  };
}

export const BACKUP_TABLE_QUERIES: Record<BackupCategory, string | null> = {
  signals: `SELECT * FROM q365_signals ORDER BY generated_at DESC LIMIT 10000`,
  outcomes: `SELECT * FROM q365_signal_outcomes ORDER BY evaluated_at DESC LIMIT 10000`,
  learning_snapshots: `SELECT * FROM q365_learning_snapshots ORDER BY created_at DESC LIMIT 100`,
  adaptive_parameters: `SELECT * FROM q365_adaptive_parameters ORDER BY created_at DESC LIMIT 100`,
  reports: null,
  configuration: null,
};

export function restoreProcedure(category: BackupCategory): string {
  const procedures: Record<BackupCategory, string> = {
    signals: 'Import JSON rows into q365_signals using INSERT IGNORE to preserve IDs.',
    outcomes: 'Import outcome rows; re-run outcome evaluation only for missing signals.',
    learning_snapshots: 'INSERT IGNORE into q365_learning_snapshots — immutable, never UPDATE.',
    adaptive_parameters: 'INSERT IGNORE into q365_adaptive_parameters; restore pointer separately.',
    reports: 'Copy report files from backup directory to reports/.',
    configuration: 'Restore env snapshot; set SIGNAL_ENGINE_CONFIG_VERSION for replay parity.',
  };
  return procedures[category];
}

export function rollbackProcedure(type: 'promotion' | 'learning' | 'release'): string {
  const map = {
    promotion: 'Call rollbackParameter() or UPDATE q365_adaptive_parameter_pointer to prior parameter_id.',
    learning: 'Call activateLearningSnapshot(priorId) — pointer only, snapshots immutable.',
    release: 'Redeploy prior release manifest git commit; run validateDeployment before traffic.',
  };
  return map[type];
}
