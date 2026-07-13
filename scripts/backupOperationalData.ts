#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import {
  buildBackupPlan,
  buildBackupManifest,
  BACKUP_TABLE_QUERIES,
} from '@/lib/operations/backupRecovery';

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const plan = buildBackupPlan({ generatedAt });
  const outDir = join(process.cwd(), plan.outputDir, plan.backupId);
  mkdirSync(outDir, { recursive: true });

  const artifacts: Array<{ category: string; path: string; recordCount: number | null; content?: string }> = [];

  for (const category of plan.categories) {
    const query = BACKUP_TABLE_QUERIES[category];
    if (!query) {
      artifacts.push({ category, path: `${outDir}/${category}/`, recordCount: null });
      continue;
    }
    try {
      const { rows } = await db.query(query);
      const content = JSON.stringify(rows, null, 2);
      const filePath = join(outDir, `${category}.json`);
      writeFileSync(filePath, content);
      artifacts.push({
        category,
        path: filePath,
        recordCount: rows.length,
        content,
      });
    } catch (err) {
      console.warn(`Backup skipped for ${category}:`, (err as Error).message);
      artifacts.push({ category, path: `${outDir}/${category}.skipped`, recordCount: null });
    }
  }

  const manifest = buildBackupManifest({
    backupId: plan.backupId,
    generatedAt,
    artifacts,
  });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
