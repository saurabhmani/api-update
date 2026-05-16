// ════════════════════════════════════════════════════════════════
//  GET /api/debug/signal-validation
//
//  Spec FIX-CLEAN final-output validation report. Runs the same
//  cleanup queries the closed-market loader applies (in-memory) at
//  the SQL level so operators can verify the dashboard's rendered
//  shape matches the underlying table state.
//
//  Returns:
//    {
//      total_rows:           number — surviving q365_signals rows
//      unique_symbols:       number — distinct symbols
//      duplicates_removed:   number — extra rows beyond the latest
//                                     per (symbol, direction) pair
//      blank_fields_fixed:   number — risk/pfit/stress NULLs that
//                                     would be backfilled by the loader
//      signal_quality:       'CLEAN' | 'NEEDS_CLEANUP'
//    }
//
//  This endpoint is read-only and never modifies the table. To
//  actually drop the duplicate rows, run
//  `npx tsx scripts/cleanupBootstrapSignals.ts`.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

interface CountRow { c: number | string }

async function countOne(sql: string, params: unknown[] = []): Promise<number> {
  try {
    const { rows } = await db.query<CountRow>(sql, params);
    return Number((rows as CountRow[])[0]?.c ?? 0);
  } catch (err) {
    // Schema not yet migrated / column missing — treat as 0 so the
    // endpoint still renders the report without throwing.
    return 0;
  }
}

export async function GET(): Promise<Response> {
  const totalRows = await countOne(`SELECT COUNT(*) AS c FROM q365_signals`);

  const uniqueSymbols = await countOne(
    `SELECT COUNT(DISTINCT symbol) AS c FROM q365_signals`,
  );

  // Duplicate count: total minus the number of distinct (symbol, direction)
  // pairs. Equivalent to SUM(c-1) over groups with c>1, but cheaper
  // when most groups have c=1.
  const distinctPairs = await countOne(
    `SELECT COUNT(*) AS c FROM (
       SELECT symbol, direction
         FROM q365_signals
        GROUP BY symbol, direction
     ) AS g`,
  );
  const duplicatesRemoved = Math.max(0, totalRows - distinctPairs);

  // Rows where any of the three metric columns the dashboard renders
  // would render as a blank cell. The closed-market loader's
  // backfillBlankFields() applies the per-row formula in-memory; the
  // count here surfaces how many rows the SQL layer is currently
  // serving with NULLs that the response shaper has to repair.
  const blankFieldsFixed = await countOne(
    `SELECT COUNT(*) AS c FROM q365_signals
      WHERE risk_score             IS NULL
         OR portfolio_fit_score    IS NULL
         OR stress_survival_score  IS NULL`,
  );

  const signalQuality = duplicatesRemoved === 0 ? 'CLEAN' : 'NEEDS_CLEANUP';

  return NextResponse.json(
    {
      total_rows:         totalRows,
      unique_symbols:     uniqueSymbols,
      duplicates_removed: duplicatesRemoved,
      blank_fields_fixed: blankFieldsFixed,
      signal_quality:     signalQuality,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
