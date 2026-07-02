// ════════════════════════════════════════════════════════════════
//  weeklyNse1000UniverseRebuild.ts — full NSE 1000 universe pipeline
//
//  1. Load EQUITY_L.csv (SECURITIES_MASTER_CSV_PATH)
//  2. Upsert active EQ → securities_master
//  3. Candle backfill for securities_master EQ pool
//  4. Rank with churn control (weekly) or top-N cut (bootstrap)
//  5. Persist active symbols → q365_universe + audit snapshot
// ════════════════════════════════════════════════════════════════

import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import {
  BACKFILL_UNIVERSE_LIMIT_DEFAULT,
  type CandleBackfillJobSummary,
  runCandleBackfillJob,
} from './candleBackfillJob';
import { getUniverseMaxSize, getUniverseMinSize } from './nifty500Universe';
import {
  computeUniverseChurnSelection,
  loadActiveUniverseSymbolSet,
  type ChurnSelectionResult,
} from './nseUniverseChurn';
import { initNifty500UniverseFromDb } from './nifty500Universe';
import {
  applyNseUniverseSelectionToDb,
  applyNseTopUniverseToDb,
  assessCandleCoverageForRanking,
  buildNseTopUniverse,
  loadTotalDailyBarCounts,
  logCandleCoverageValidation,
  logUniverseApplyValidation,
  NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT,
  NSE_UNIVERSE_TARGET_DEFAULT,
  type ApplyUniverseResult,
  type BuildNseUniverseResult,
  type CandleCoverageStats,
} from './nseUniverseRanker';
import {
  buildSecuritiesMasterValidationSummary,
  importActiveEqSecuritiesFromCsv,
  logSecuritiesMasterValidation,
  type SecuritiesMasterImportResult,
  type SecuritiesMasterValidationSummary,
} from './securitiesMaster';
import {
  completeUniverseRebuildLog,
  persistUniverseSnapshot,
  startUniverseRebuildLog,
  UNIVERSE_AUDIT_SQL,
} from './universeSnapshotRepository';

export interface WeeklyNse1000RebuildOptions {
  csvPath?: string;
  targetSize?: number;
  dryRun?: boolean;
  skipBackfill?: boolean;
  skipRanking?: boolean;
  maxFetch?: number;
  backfillLimit?: number;
  /** Weekly auto-rebuild uses churn control (default true). */
  useChurnControl?: boolean;
  triggerSource?: string;
}

export interface WeeklyNse1000RebuildSummary {
  ok: boolean;
  dryRun: boolean;
  targetSize: number;
  triggerSource: string;
  securitiesImport: SecuritiesMasterImportResult;
  securitiesValidation: SecuritiesMasterValidationSummary;
  backfill: CandleBackfillJobSummary | null;
  candleCoverage: CandleCoverageStats;
  universe: BuildNseUniverseResult | null;
  churn: ChurnSelectionResult | null;
  apply: ApplyUniverseResult | null;
  snapshotId: number | null;
  rebuildLogId: number | null;
  blockers: string[];
  durationMs: number;
}

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

export async function runWeeklyNse1000UniverseRebuild(
  options: WeeklyNse1000RebuildOptions = {},
): Promise<WeeklyNse1000RebuildSummary> {
  const t0 = Date.now();
  const dryRun = options.dryRun ?? false;
  const targetSize = options.targetSize ?? NSE_UNIVERSE_TARGET_DEFAULT();
  const useChurnControl = options.useChurnControl !== false;
  const triggerSource = options.triggerSource ?? 'manual:weekly-rebuild';
  const blockers: string[] = [];

  const rebuildLogId = await startUniverseRebuildLog({
    triggerSource,
    dryRun,
    targetSize,
  });

  console.log(
    `[NSE1000_REBUILD] start trigger=${triggerSource} dry_run=${dryRun} target=${targetSize} ` +
    `churn=${useChurnControl} skip_backfill=${options.skipBackfill ?? false} ` +
    `skip_ranking=${options.skipRanking ?? false}`,
  );

  await ensureAllSchemas();

  const securitiesImport = await importActiveEqSecuritiesFromCsv({
    csvPath: options.csvPath,
    dryRun,
  });
  console.log(
    `[NSE1000_REBUILD] securities_master csv=${securitiesImport.csvPath} ` +
    `parsed=${securitiesImport.parsedRows} inserted=${securitiesImport.inserted} ` +
    `updated=${securitiesImport.updated} dry_run=${dryRun}`,
  );

  const securitiesValidation = dryRun
    ? {
      activeEqCount: securitiesImport.parsedRows,
      inactiveEqCount: 0,
      source: 'EQUITY_L',
      sql: (await buildSecuritiesMasterValidationSummary()).sql,
    }
    : await buildSecuritiesMasterValidationSummary();
  logSecuritiesMasterValidation(securitiesValidation);

  if (securitiesValidation.activeEqCount === 0 && !dryRun) {
    blockers.push('securities_master import produced zero active EQ rows');
  }

  let backfill: CandleBackfillJobSummary | null = null;
  if (!options.skipBackfill) {
    const backfillLimit = options.backfillLimit
      ?? envNum('UNIVERSE_REBUILD_BACKFILL_LIMIT', 100, 5000, Math.max(
        BACKFILL_UNIVERSE_LIMIT_DEFAULT(),
        securitiesValidation.activeEqCount || BACKFILL_UNIVERSE_LIMIT_DEFAULT(),
      ));

    console.log(
      `[NSE1000_REBUILD] candle backfill source=securities_master limit=${backfillLimit} ` +
      `resume=true max_fetch=${options.maxFetch ?? 'policy'}`,
    );

    backfill = await runCandleBackfillJob({
      symbolSource: 'securities_master',
      universeLimit: backfillLimit,
      minBars: NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT(),
      resume: true,
      maxFetch: options.maxFetch,
      dryRun,
    });

    console.log(
      `[NSE1000_REBUILD] backfill complete fetched=${backfill.fetched} ` +
      `skipped=${backfill.skippedSufficient} failed=${backfill.failed} ` +
      `deferred=${backfill.deferredDueToBudget}`,
    );

    if (!dryRun && backfill.deferredDueToBudget > 0) {
      blockers.push(
        `${backfill.deferredDueToBudget} symbols deferred — re-run rebuild to continue backfill`,
      );
    }
  } else {
    console.log('[NSE1000_REBUILD] backfill skipped');
  }

  const candleCoverage = await assessCandleCoverageForRanking({ targetSize });
  logCandleCoverageValidation(candleCoverage);

  let universe: BuildNseUniverseResult | null = null;
  let churn: ChurnSelectionResult | null = null;
  let apply: ApplyUniverseResult | null = null;
  let snapshotId: number | null = null;

  if (!options.skipRanking) {
    const productionReady = candleCoverage.readyForRanking;
    const canBootstrapRank = !useChurnControl && candleCoverage.withMinBars > 0;

    if (!productionReady && !canBootstrapRank) {
      blockers.push(...candleCoverage.blockers);
      console.warn(
        '[NSE1000_REBUILD] ranking skipped — candle data insufficient. ' +
        'Complete backfill and re-run.',
      );
    } else {
      if (!productionReady && canBootstrapRank) {
        console.warn(
          `[NSE1000_REBUILD] partial bootstrap ranking — ` +
          `${candleCoverage.withMinBars} eligible symbols (production min=${getUniverseMinSize()})`,
        );
        blockers.push(...candleCoverage.blockers);
      }

      universe = await buildNseTopUniverse({
        targetSize,
        requireCandleData: false,
      });
      console.log(
        `[NSE1000_REBUILD] ranked candidates=${universe.candidates} ` +
        `top5=${universe.ranked.slice(0, 5)
          .map((r) => `${r.symbol}:${r.compositeScore.toFixed(3)}`).join(', ')}`,
      );

      if (useChurnControl) {
        const currentActive = await loadActiveUniverseSymbolSet();
        const totalBars = await loadTotalDailyBarCounts(universe.ranked.map((r) => r.symbol));
        churn = computeUniverseChurnSelection({
          ranked: universe.ranked,
          currentActive,
          totalDailyBars: totalBars,
          targetSize,
          maxSize: getUniverseMaxSize(),
        });
        console.log(
          `[NSE1000_REBUILD] churn selected=${churn.selected.length} ` +
          `added=${churn.added} kept=${churn.kept} removed=${churn.removed} ` +
          `thresholds=add<=${churn.thresholds.addMaxRank} ` +
          `keep<=${churn.thresholds.keepMaxRank} remove>${churn.thresholds.removeMinRank}`,
        );
        apply = await applyNseUniverseSelectionToDb(
          universe.ranked,
          churn.selected,
          {
            dryRun,
            churn: { added: churn.added, kept: churn.kept, removed: churn.removed },
          },
        );
      } else {
        apply = await applyNseTopUniverseToDb(universe.ranked, targetSize, { dryRun });
      }

      logUniverseApplyValidation(apply, targetSize);

      snapshotId = await persistUniverseSnapshot({
        triggerSource,
        dryRun,
        ok: blockers.length === 0,
        targetSize,
        churn: churn ?? {
          selected: universe.selected,
          decisions: [],
          added: apply.added ?? 0,
          kept: apply.kept ?? 0,
          removed: apply.removed ?? apply.deactivated,
          targetSize,
          thresholds: {
            addMaxRank: 0,
            keepMaxRank: 0,
            removeMinRank: 0,
          },
        },
        summary: {
          coverage_pct: candleCoverage.coveragePct,
          candidates: universe.candidates,
          use_churn_control: useChurnControl,
        },
        rebuildLogId,
      });

      if (!dryRun) {
        const activeCount = apply?.totalActive ?? churn?.selected.length ?? universe.selected.length;
        if (activeCount >= getUniverseMinSize() && activeCount <= getUniverseMaxSize()) {
          await initNifty500UniverseFromDb();
          console.log('[NSE1000_REBUILD] universe cache refreshed via initNifty500UniverseFromDb()');
        } else {
          console.warn(
            `[NSE1000_REBUILD] universe cache not refreshed — active=${activeCount} ` +
            `outside [${getUniverseMinSize()}, ${getUniverseMaxSize()}]; complete backfill and re-run`,
          );
        }
      }
    }
  } else {
    console.log('[NSE1000_REBUILD] ranking skipped');
  }

  const summary: WeeklyNse1000RebuildSummary = {
    ok: blockers.length === 0,
    dryRun,
    targetSize,
    triggerSource,
    securitiesImport,
    securitiesValidation,
    backfill,
    candleCoverage,
    universe,
    churn,
    apply,
    snapshotId,
    rebuildLogId,
    blockers,
    durationMs: Date.now() - t0,
  };

  await completeUniverseRebuildLog(rebuildLogId, {
    ok: summary.ok,
    snapshotId,
    blockers: summary.blockers,
    summary: {
      trigger: triggerSource,
      churn: churn
        ? { added: churn.added, kept: churn.kept, removed: churn.removed, selected: churn.selected.length }
        : null,
      coverage_pct: candleCoverage.coveragePct,
    },
    durationMs: summary.durationMs,
  });

  console.log('[NSE1000_REBUILD] complete', {
    ok: summary.ok,
    dry_run: dryRun,
    target: targetSize,
    master_eq: securitiesValidation.activeEqCount,
    coverage_pct: candleCoverage.coveragePct,
    universe_selected: churn?.selected.length ?? universe?.selected.length ?? 0,
    snapshot_id: snapshotId,
    blockers: summary.blockers,
    duration_ms: summary.durationMs,
  });

  console.log('[NSE1000_REBUILD AUDIT SQL]');
  for (const sql of Object.values(UNIVERSE_AUDIT_SQL)) {
    console.log(`  ${sql}`);
  }

  return summary;
}
