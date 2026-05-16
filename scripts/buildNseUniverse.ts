// ════════════════════════════════════════════════════════════════
//  Build the NSE universe JSON from the downloaded Excel.
//
//  Source : C:\Users\pranj\Downloads\nse_stocks_list.xlsx
//  Sheet  : NSE_STOCKS
//  Column : Trading Symbol
//
//  Writes : src/lib/signal-engine/constants/nseUniverse.json
//           so DEFAULT_PHASE1_CONFIG can import a static artifact
//           at module load (no Excel parsing in the hot path).
//
//  Re-run whenever the NSE list changes. The output is checked
//  into git so production bundles don't need the xlsx dep at runtime.
// ════════════════════════════════════════════════════════════════
import * as XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EXCEL_PATH = 'C:\\Users\\pranj\\Downloads\\nse_stocks_list.xlsx';
const OUT_PATH   = resolve(
  process.cwd(),
  'src/lib/signal-engine/constants/nseUniverse.json',
);
const SHEET_NAME  = 'NSE_STOCKS';
const SYMBOL_COL  = 'Trading Symbol';

const wb = XLSX.readFile(EXCEL_PATH);
const ws = wb.Sheets[SHEET_NAME];
if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found in ${EXCEL_PATH}`);

const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

// Extract, trim, uppercase, de-dup while preserving order of first-seen.
// Drop *INAV pseudo-symbols — NSE's "Indicative NAV" feeds for ETFs,
// which are reference data, not tradeable. Yahoo 404s on every one,
// so they belong nowhere in our scan universe.
const seen = new Set<string>();
const symbols: string[] = [];
let blank = 0;
let duplicate = 0;
let inavSkipped = 0;

for (const row of rows) {
  const raw = row[SYMBOL_COL];
  if (raw == null) { blank++; continue; }
  const sym = String(raw).trim().toUpperCase();
  if (!sym) { blank++; continue; }
  if (/INAV$/.test(sym)) { inavSkipped++; continue; }
  if (seen.has(sym)) { duplicate++; continue; }
  seen.add(sym);
  symbols.push(sym);
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(
  OUT_PATH,
  JSON.stringify({ source: 'nse_stocks_list.xlsx', count: symbols.length, symbols }, null, 2),
  'utf8',
);

console.log(`[buildNseUniverse] read ${rows.length} rows`);
console.log(`[buildNseUniverse] blank=${blank} duplicate=${duplicate} inav_skipped=${inavSkipped} unique=${symbols.length}`);
console.log(`[buildNseUniverse] wrote ${OUT_PATH}`);
console.log(`[buildNseUniverse] first 5: ${symbols.slice(0, 5).join(', ')}`);
console.log(`[buildNseUniverse] last  5: ${symbols.slice(-5).join(', ')}`);
