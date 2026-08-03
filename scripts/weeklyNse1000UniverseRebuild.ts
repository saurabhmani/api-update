/**
 * weeklyNse1000UniverseRebuild.ts — full NSE 1000 universe pipeline
 *
 * Ordered steps:
 *   1. Load EQUITY_L.csv via SECURITIES_MASTER_CSV_PATH
 *   2. Import active EQ → securities_master
 *   3. Candle backfill (securities_master pool, before ranking)
 *   4. Rank top-N (only when candle coverage is sufficient)
 *   5. Save active ranked symbols → q365_universe
 *
 * Usage:
 *   npx tsx scripts/weeklyNse1000UniverseRebuild.ts
 *   npx tsx scripts/weeklyNse1000UniverseRebuild.ts --dry-run
 *   npx tsx scripts/weeklyNse1000UniverseRebuild.ts --target 1000 --max-fetch 50
 *   npx tsx scripts/weeklyNse1000UniverseRebuild.ts --skip-backfill --skip-ranking
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env.production') });

import { runWeeklyNse1000UniverseRebuild } from '@/lib/marketData/weeklyNse1000UniverseRebuild';

interface CliArgs {
  csvPath?: string;
  target: number;
  dryRun: boolean;
  skipBackfill: boolean;
  skipRanking: boolean;
  maxFetch?: number;
  backfillLimit?: number;
  /** Bootstrap mode — simple top-N cut without churn control. */
  bootstrap: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let csvPath: string | undefined;
  let target = Number(process.env.UNIVERSE_TARGET_SIZE) || 1000;
  let dryRun = false;
  let skipBackfill = false;
  let skipRanking = false;
  let maxFetch: number | undefined;
  let backfillLimit: number | undefined;
  let bootstrap = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv' && argv[i + 1]) { csvPath = resolvePath(process.cwd(), argv[++i]); continue; }
    if (a === '--target' && argv[i + 1]) { target = Math.max(1, Math.floor(Number(argv[++i]))); continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--skip-backfill') { skipBackfill = true; continue; }
    if (a === '--skip-ranking') { skipRanking = true; continue; }
    if (a === '--bootstrap') { bootstrap = true; continue; }
    if (a === '--max-fetch' && argv[i + 1]) { maxFetch = Number(argv[++i]); continue; }
    if (a === '--backfill-limit' && argv[i + 1]) { backfillLimit = Number(argv[++i]); continue; }
  }

  return {
    csvPath,
    target: Number.isFinite(target) ? target : 1000,
    dryRun,
    skipBackfill,
    skipRanking,
    maxFetch: maxFetch != null && Number.isFinite(maxFetch) ? maxFetch : undefined,
    backfillLimit: backfillLimit != null && Number.isFinite(backfillLimit) ? backfillLimit : undefined,
    bootstrap,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runWeeklyNse1000UniverseRebuild({
    csvPath: args.csvPath,
    targetSize: args.target,
    dryRun: args.dryRun,
    skipBackfill: args.skipBackfill,
    skipRanking: args.skipRanking,
    maxFetch: args.maxFetch,
    backfillLimit: args.backfillLimit,
    useChurnControl: !args.bootstrap,
    triggerSource: args.bootstrap ? 'manual:bootstrap-rebuild' : 'manual:weekly-rebuild',
  });

  console.log('\n[NSE1000_REBUILD SUMMARY]');
  console.log(JSON.stringify({
    ok: summary.ok,
    dry_run: summary.dryRun,
    target: summary.targetSize,
    securities_master: {
      csv: summary.securitiesImport.csvPath,
      parsed: summary.securitiesImport.parsedRows,
      inserted: summary.securitiesImport.inserted,
      updated: summary.securitiesImport.updated,
      active_eq: summary.securitiesValidation.activeEqCount,
    },
    backfill: summary.backfill
      ? {
        universe_total: summary.backfill.universeTotal,
        fetched: summary.backfill.fetched,
        skipped: summary.backfill.skippedSufficient,
        failed: summary.backfill.failed,
        deferred: summary.backfill.deferredDueToBudget,
      }
      : null,
    candle_coverage: {
      ready: summary.candleCoverage.readyForRanking,
      eq_master: summary.candleCoverage.eqMasterCount,
      with_min_bars: summary.candleCoverage.withMinBars,
      coverage_pct: summary.candleCoverage.coveragePct,
      blockers: summary.candleCoverage.blockers,
    },
    universe: summary.universe
      ? { candidates: summary.universe.candidates, selected: summary.universe.selected.length }
      : null,
    churn: summary.churn
      ? {
        selected: summary.churn.selected.length,
        added: summary.churn.added,
        kept: summary.churn.kept,
        removed: summary.churn.removed,
        thresholds: summary.churn.thresholds,
      }
      : null,
    snapshot_id: summary.snapshotId,
    rebuild_log_id: summary.rebuildLogId,
    apply: summary.apply
      ? {
        activated: summary.apply.activated,
        deactivated: summary.apply.deactivated,
        total_active: summary.apply.totalActive,
      }
      : null,
    blockers: summary.blockers,
    duration_ms: summary.durationMs,
  }, null, 2));

  if (!summary.ok && summary.blockers.length > 0) {
    console.warn('\nBlockers (re-run after resolving):');
    for (const b of summary.blockers) {
      console.warn(`  - ${b}`);
    }
  }

  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[NSE1000_REBUILD] failed', err);
  process.exit(1);
});
