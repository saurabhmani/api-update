import { describe, expect, it } from 'vitest';
import {
  buildBackupPlan,
  buildBackupManifest,
  restoreProcedure,
  rollbackProcedure,
  BACKUP_CATEGORIES,
} from '@/lib/operations/backupRecovery';

describe('backup and recovery', () => {
  it('builds backup plan with all categories', () => {
    const plan = buildBackupPlan({ generatedAt: '2026-01-11T00:00:00Z' });
    expect(plan.categories).toEqual([...BACKUP_CATEGORIES]);
    expect(plan.backupId).toMatch(/^backup_/);
  });

  it('builds manifest with checksums', () => {
    const manifest = buildBackupManifest({
      backupId: 'backup_test',
      generatedAt: '2026-01-11T00:00:00Z',
      artifacts: [{ category: 'signals', path: '/tmp/signals.json', recordCount: 10, content: '[]' }],
    });
    expect(manifest.artifacts[0].checksum).toHaveLength(64);
    expect(manifest.artifacts[0].recordCount).toBe(10);
  });

  it('documents restore and rollback procedures', () => {
    expect(restoreProcedure('learning_snapshots')).toContain('INSERT IGNORE');
    expect(rollbackProcedure('promotion')).toContain('rollback');
  });
});
