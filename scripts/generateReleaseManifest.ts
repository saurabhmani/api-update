#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReleaseManifest, releaseManifestToJson } from '@/lib/operations/releaseGovernance';
import { validateDeployment } from '@/lib/operations/deploymentValidation';

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const deployment = validateDeployment({
    generatedAt,
    databaseConnected: process.env.CI === 'true' && !process.env.DATABASE_URL ? undefined : true,
    sessionSecretPresent: Boolean(process.env.SESSION_SECRET),
  });
  const manifest = buildReleaseManifest({
    generatedAt,
    gitCommit: process.env.GITHUB_SHA?.slice(0, 12) ?? process.env.GIT_COMMIT ?? null,
    validationResult: deployment,
    releaseNotes: process.env.RELEASE_NOTES ?? null,
  });

  const dir = join(process.cwd(), 'releases');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `manifest-${manifest.buildVersion}-${generatedAt.slice(0, 10)}.json`);
  writeFileSync(path, releaseManifestToJson(manifest));
  console.log(`Release manifest written: ${path}`);
  console.log(`Validation: ${manifest.validationStatus}`);
  process.exit(deployment.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
