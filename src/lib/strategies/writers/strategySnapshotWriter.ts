// ════════════════════════════════════════════════════════════════
//  Strategy Performance Snapshot Writer — Phase 2 Priority 2 closure
//
//  Runs `buildPerformanceReport` for each supported window and
//  persists per-strategy pre-aggregated metrics into
//  `q365_strategy_performance_snapshots`. One row per
//  (strategy_id, window_label) — UPSERTed in place.
//
//  Source priority chain inside the loader is honoured: the
//  snapshot writer doesn't bypass any rule, it simply persists what
//  the live computation produced so the next read of
//  /api/strategies/performance can prefer the snapshot when the
//  live evaluated count is below the SUFFICIENT floor.
//
//  Safety:
//   - Skips strategies with performanceStatus = INSUFFICIENT_DATA
//     (so the table never stores a noise-only row).
//   - Idempotent UPSERT keyed by (strategy_id, window_label).
//   - Each window runs sequentially so a single window failure
//     doesn't abort the rest.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import {
  VALID_WINDOWS,
  loadDirectSignalOutcomes,
  loadObservedOutcomes,
  loadBacktestOutcomes,
  buildPerformanceReport,
  type PerformanceWindow,
} from '@/lib/strategies/strategyPerformance';

export interface SnapshotWriteResult {
  windowsProcessed: number;
  rowsWritten:      number;
  rowsSkipped:      number;
  elapsedMs:        number;
  perWindow:        Array<{
    window: PerformanceWindow;
    written: number;
    skipped: number;
  }>;
}

export async function backfillStrategyPerformanceSnapshots(
  /** Subset of windows to refresh. Defaults to the full set. */
  windows: PerformanceWindow[] = Array.from(VALID_WINDOWS),
): Promise<SnapshotWriteResult> {
  await ensureAllSchemas();
  const t0 = Date.now();
  let totalWritten = 0;
  let totalSkipped = 0;
  const perWindow: SnapshotWriteResult['perWindow'] = [];

  for (const window of windows) {
    let written = 0;
    let skipped = 0;
    try {
      const [direct, observed, backtests] = await Promise.all([
        loadDirectSignalOutcomes(window).catch(() => []),
        loadObservedOutcomes(window).catch(() => []),
        loadBacktestOutcomes(window).catch(() => []),
      ]);
      const outcomes = [...direct, ...observed, ...backtests];
      // We deliberately do NOT feed previous snapshots back into the
      // computation — that would create a feedback loop. The writer
      // persists the raw computation only.
      const { report } = buildPerformanceReport(outcomes, window);

      for (const s of report.strategies) {
        if (s.performanceStatus === 'INSUFFICIENT_DATA') { skipped++; continue; }
        try {
          const result: any = await db.query(
            `INSERT INTO q365_strategy_performance_snapshots
              (strategy_id, window_label, evaluated_signals, win_rate, expectancy,
               profit_factor, max_drawdown_pct, health_score, health_label,
               performance_source, snapshot_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
               evaluated_signals  = VALUES(evaluated_signals),
               win_rate           = VALUES(win_rate),
               expectancy         = VALUES(expectancy),
               profit_factor      = VALUES(profit_factor),
               max_drawdown_pct   = VALUES(max_drawdown_pct),
               health_score       = VALUES(health_score),
               health_label       = VALUES(health_label),
               performance_source = VALUES(performance_source),
               snapshot_at        = NOW()`,
            [
              s.strategyId, window, s.evaluatedSignals,
              roundSafe(s.winRate, 2),
              roundSafe(s.expectancy, 3),
              roundSafe(s.profitFactor, 3),
              roundSafe(s.maxDrawdownPct, 3),
              s.strategyHealthScore | 0,
              s.healthLabel,
              s.performanceSource,
            ],
          );
          const affected = Number(result?.affectedRows ?? 0);
          // MySQL UPSERT: affectedRows = 1 (insert) or 2 (update) means
          // a write happened; 0 means nothing changed (rare).
          if (affected > 0) written++;
          else              skipped++;
        } catch {
          skipped++;
        }
      }
    } catch {
      // Whole window failed — record nothing and continue.
    }
    totalWritten += written;
    totalSkipped += skipped;
    perWindow.push({ window, written, skipped });
  }

  return {
    windowsProcessed: windows.length,
    rowsWritten:      totalWritten,
    rowsSkipped:      totalSkipped,
    elapsedMs:        Date.now() - t0,
    perWindow,
  };
}

function roundSafe(v: number, p: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** p;
  return Math.round(v * f) / f;
}
