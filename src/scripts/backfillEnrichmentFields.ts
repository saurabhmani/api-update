// ════════════════════════════════════════════════════════════════
//  Backfill: sector + volatility_state for historical signals
//
//  One-shot migration script. Safe to re-run.
//
//  What it does:
//    1. q365_signals       — fills NULL sector from getSector(symbol)
//                          — fills NULL volatility_state with 'unknown'
//    2. backtest_signals   — same two fills
//
//  Invariants:
//    - Only touches rows where the target column IS NULL.
//    - Never overwrites an existing non-null value.
//    - Uses a per-symbol batched UPDATE for sector so getSector()
//      runs in JS exactly once per distinct symbol, not per row.
//    - volatility_state uses a single bulk UPDATE since every NULL
//      row gets the same sentinel value ('unknown') — we can't
//      recompute it without the feature snapshot.
//
//  Run directly:
//    npx ts-node src/scripts/backfillEnrichmentFields.ts
//
//  Or import and call from an admin route:
//    import { backfillEnrichmentFields } from './scripts/backfillEnrichmentFields';
//    const report = await backfillEnrichmentFields();
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

export interface BackfillReport {
  q365_signals: {
    sectorRowsUpdated: number;
    sectorSymbolsProcessed: number;
    volatilityRowsUpdated: number;
  };
  backtest_signals: {
    sectorRowsUpdated: number;
    sectorSymbolsProcessed: number;
    volatilityRowsUpdated: number;
  };
  durationMs: number;
}

// Backfill sector for a single table. Fetches the distinct list of
// symbols that currently have NULL sector (cheap — indexed on symbol),
// then issues one UPDATE per symbol guarded by `sector IS NULL` so
// concurrent writers don't get clobbered.
async function backfillSectorForTable(
  table: 'q365_signals' | 'backtest_signals',
): Promise<{ rows: number; symbols: number }> {
  const { rows: distinctRows } = await db.query<{ symbol: string }>(
    `SELECT DISTINCT symbol FROM ${table} WHERE sector IS NULL`,
  );

  let totalRows = 0;
  for (const { symbol } of distinctRows) {
    if (!symbol) continue;
    const sector = getSector(symbol);
    // The `sector IS NULL` guard in the WHERE clause is the
    // idempotency guarantee: re-running the script cannot flip a
    // row that was populated between the SELECT and the UPDATE.
    const result: any = await db.query(
      `UPDATE ${table}
          SET sector = ?
        WHERE symbol = ? AND sector IS NULL`,
      [sector, symbol],
    );
    totalRows += Number(result.affectedRows ?? 0);
  }
  return { rows: totalRows, symbols: distinctRows.length };
}

// Backfill volatility_state. We don't have the feature snapshot for
// historical rows, so the only safe fill is the sentinel 'unknown'.
// That keeps rollup queries from crashing on NULL without pretending
// we know the actual volatility regime at signal time.
async function backfillVolatilityForTable(
  table: 'q365_signals' | 'backtest_signals',
): Promise<number> {
  const result: any = await db.query(
    `UPDATE ${table}
        SET volatility_state = 'unknown'
      WHERE volatility_state IS NULL`,
  );
  return Number(result.affectedRows ?? 0);
}

export async function backfillEnrichmentFields(): Promise<BackfillReport> {
  const startMs = Date.now();
  const report: BackfillReport = {
    q365_signals: { sectorRowsUpdated: 0, sectorSymbolsProcessed: 0, volatilityRowsUpdated: 0 },
    backtest_signals: { sectorRowsUpdated: 0, sectorSymbolsProcessed: 0, volatilityRowsUpdated: 0 },
    durationMs: 0,
  };

  console.log('[backfill] Starting enrichment backfill...');

  // ── q365_signals ───────────────────────────────────────────
  try {
    const s = await backfillSectorForTable('q365_signals');
    report.q365_signals.sectorRowsUpdated = s.rows;
    report.q365_signals.sectorSymbolsProcessed = s.symbols;
    console.log(`[backfill] q365_signals sector: ${s.rows} rows across ${s.symbols} symbols`);
  } catch (err) {
    console.error('[backfill] q365_signals sector failed:', err);
  }
  try {
    const v = await backfillVolatilityForTable('q365_signals');
    report.q365_signals.volatilityRowsUpdated = v;
    console.log(`[backfill] q365_signals volatility_state: ${v} rows → 'unknown'`);
  } catch (err) {
    console.error('[backfill] q365_signals volatility failed:', err);
  }

  // ── backtest_signals ───────────────────────────────────────
  try {
    const s = await backfillSectorForTable('backtest_signals');
    report.backtest_signals.sectorRowsUpdated = s.rows;
    report.backtest_signals.sectorSymbolsProcessed = s.symbols;
    console.log(`[backfill] backtest_signals sector: ${s.rows} rows across ${s.symbols} symbols`);
  } catch (err) {
    console.error('[backfill] backtest_signals sector failed:', err);
  }
  try {
    const v = await backfillVolatilityForTable('backtest_signals');
    report.backtest_signals.volatilityRowsUpdated = v;
    console.log(`[backfill] backtest_signals volatility_state: ${v} rows → 'unknown'`);
  } catch (err) {
    console.error('[backfill] backtest_signals volatility failed:', err);
  }

  report.durationMs = Date.now() - startMs;
  console.log(`[backfill] Done in ${report.durationMs}ms`);
  return report;
}

// Allow direct execution: npx ts-node src/scripts/backfillEnrichmentFields.ts
if (require.main === module) {
  backfillEnrichmentFields()
    .then((report) => {
      console.log('\nFinal report:', JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('\nBackfill failed:', err);
      process.exit(1);
    });
}
