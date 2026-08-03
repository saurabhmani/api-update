/**
 * validateNse1000UniverseAcceptance.ts — acceptance checks for NSE 1000 universe
 *
 * Usage:
 *   npx tsx scripts/validateNse1000UniverseAcceptance.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env.production') });

import { runNse1000UniverseAcceptance } from '@/lib/marketData/nse1000UniverseAcceptance';

async function main(): Promise<void> {
  const result = await runNse1000UniverseAcceptance();
  console.log('\n[NSE1000_ACCEPTANCE SUMMARY]');
  console.log(JSON.stringify({
    ok: result.ok,
    checked_at: result.checkedAt,
    target: result.targetSize,
    checks: result.checks,
  }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[NSE1000_ACCEPTANCE] failed', err);
  process.exit(1);
});
