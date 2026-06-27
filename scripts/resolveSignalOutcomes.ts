// ════════════════════════════════════════════════════════════════
//  resolveSignalOutcomes.ts — Outcome Resolution Engine CLI
//
//  Usage:
//    npm run resolve:signal-outcomes
//    npx tsx scripts/resolveSignalOutcomes.ts --dry-run --limit=100
// ════════════════════════════════════════════════════════════════

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { resolveSignalOutcomes } from '@/lib/signals/outcome/resolveSignalOutcomes';

const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

async function main(): Promise<void> {
  const result = await resolveSignalOutcomes({
    limit: argv.has('limit') ? Number(argv.get('limit')) : 500,
    sinceDays: argv.has('since-days') ? Number(argv.get('since-days')) : undefined,
    dryRun: argv.has('dry-run'),
  });

  if (argv.has('json')) {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error('[resolveSignalOutcomes] FAILED:', (err as Error).message);
  process.exitCode = 1;
});
