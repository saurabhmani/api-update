/**
 * loadSecuritiesMaster.ts — populate securities_master from NSE EQUITY_L.csv
 *
 * Usage:
 *   npx tsx scripts/loadSecuritiesMaster.ts
 *   npx tsx scripts/loadSecuritiesMaster.ts --csv ./data/EQUITY_L.csv
 *   npx tsx scripts/loadSecuritiesMaster.ts --dry-run
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import {
  buildSecuritiesMasterValidationSummary,
  importActiveEqSecuritiesFromCsv,
  logSecuritiesMasterValidation,
  resolveEquityLCsvPath,
} from '@/lib/marketData/securitiesMaster';

function parseArgs(argv: string[]): { csv: string; dryRun: boolean } {
  let csv = resolveEquityLCsvPath();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv' && argv[i + 1]) { csv = resolvePath(process.cwd(), argv[++i]); continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
  }
  return { csv, dryRun };
}

async function main(): Promise<void> {
  const { csv, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`[loadSecuritiesMaster] csv=${csv} dry_run=${dryRun}`);
  await ensureAllSchemas();
  const result = await importActiveEqSecuritiesFromCsv({ csvPath: csv, dryRun });
  console.log('[loadSecuritiesMaster] complete', result);
  if (!dryRun) {
    const validation = await buildSecuritiesMasterValidationSummary();
    logSecuritiesMasterValidation(validation);
  }
}

main().catch((err) => {
  console.error('[loadSecuritiesMaster] failed', err);
  process.exit(1);
});
