/**
 * buildNse1000Universe.ts — rank EQ symbols and populate q365_universe
 *
 * Prerequisite: npx tsx scripts/loadSecuritiesMaster.ts
 *
 * Usage:
 *   npx tsx scripts/buildNse1000Universe.ts
 *   npx tsx scripts/buildNse1000Universe.ts --target 1000 --dry-run
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import { _resetNifty500CacheForTests } from '@/lib/marketData/nifty500Universe';
import {
  applyNseTopUniverseToDb,
  buildNseTopUniverse,
  NSE_UNIVERSE_TARGET_DEFAULT,
} from '@/lib/marketData/nseUniverseRanker';

function parseArgs(argv: string[]): { target: number; dryRun: boolean } {
  let target = NSE_UNIVERSE_TARGET_DEFAULT();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' && argv[i + 1]) {
      target = Math.max(1, Math.floor(Number(argv[++i])));
      continue;
    }
    if (a === '--dry-run') { dryRun = true; continue; }
  }
  return { target, dryRun };
}

async function main(): Promise<void> {
  const { target, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`[buildNse1000Universe] target=${target} dry_run=${dryRun}`);
  await ensureAllSchemas();

  const { ranked, selected, candidates } = await buildNseTopUniverse({ targetSize: target });
  console.log(
    `[buildNse1000Universe] candidates=${candidates} selected=${selected.length} ` +
    `top=${ranked.slice(0, 5).map((r) => `${r.symbol}:${r.compositeScore.toFixed(3)}`).join(', ')}`,
  );

  const applied = await applyNseTopUniverseToDb(ranked, target, { dryRun });
  console.log('[buildNse1000Universe] applied', applied);

  if (!dryRun) {
    _resetNifty500CacheForTests();
    console.log('[buildNse1000Universe] universe cache cleared — restart or call initOnce()');
  }
}

main().catch((err) => {
  console.error('[buildNse1000Universe] failed', err);
  process.exit(1);
});
