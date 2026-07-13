#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { validateDeployment } from '@/lib/operations/deploymentValidation';
import { formatDeploymentValidationMarkdown } from '@/lib/operations/deploymentValidation';
import { db } from '@/lib/db';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const offline = process.env.DEPLOY_VALIDATION_OFFLINE === 'true'
    || (process.env.CI === 'true' && !process.env.DATABASE_URL);

  let databaseConnected: boolean | undefined = offline ? undefined : true;
  let databaseLatencyMs: number | null = null;
  if (!offline) {
    try {
      const t0 = Date.now();
      await db.query('SELECT 1');
      databaseLatencyMs = Date.now() - t0;
    } catch {
      databaseConnected = false;
    }
  }

  let reportsDirWritable = true;
  try {
    await access(join(process.cwd(), 'reports'), constants.W_OK);
  } catch {
    reportsDirWritable = false;
  }

  const result = validateDeployment({
    generatedAt,
    databaseConnected,
    databaseLatencyMs,
    reportsDirWritable,
    sessionSecretPresent: Boolean(process.env.SESSION_SECRET),
  });

  console.log(formatDeploymentValidationMarkdown(result));
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
