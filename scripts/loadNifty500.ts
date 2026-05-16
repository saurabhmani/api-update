/**
 * loadNifty500.ts — populate q365_universe from the NSE NIFTY 500 CSV.
 *
 * Usage:
 *   npx tsx scripts/loadNifty500.ts                  # default path
 *   npx tsx scripts/loadNifty500.ts --csv ./mylist.csv
 *   npx tsx scripts/loadNifty500.ts --dry-run        # parse only
 *
 * Behavior:
 *   - Inserts new symbols, updates existing rows that are still in
 *     the CSV (sets is_active=TRUE, refreshes name/isin/sector).
 *   - Sets is_active=FALSE on rows previously in the universe but
 *     missing from the CSV (handles NIFTY 500 reconstitution).
 *   - Logs counters: total / inserted / updated / deactivated.
 *
 * Expected CSV header (NSE official):
 *   "Company Name","Industry","Symbol","Series","ISIN Code"
 *
 * Robust to columns being in any order, whitespace inside fields,
 * and Windows CRLF line endings. We only require the four named
 * columns above to be present.
 */

import { config as dotenvConfig } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// Load .env.local before importing the db module (the pool reads env at construction).
dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });

import { db } from '@/lib/db';

interface Row {
  symbol:       string;
  companyName:  string;
  isin:         string | null;
  sector:       string | null;
}

function parseArgs(argv: string[]): { csv: string; dryRun: boolean } {
  let csv = './ind_nifty500list.csv';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv' && argv[i + 1]) { csv = argv[++i]; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
  }
  return { csv: resolvePath(process.cwd(), csv), dryRun };
}

/** Minimal CSV parser — handles quoted fields, embedded commas, and
 *  CRLF. NSE's published file is well-formed; nothing fancy required. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

function pickColumn(headers: string[], candidates: string[]): number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const wanted = candidates.map(norm);
  for (let i = 0; i < headers.length; i++) {
    if (wanted.includes(norm(headers[i]))) return i;
  }
  return -1;
}

function loadCsvRows(path: string): Row[] {
  if (!existsSync(path)) {
    throw new Error(
      `CSV not found at ${path}. Download the NIFTY 500 list from ` +
      `https://www.nseindia.com/products-services/indices-nifty500-index ` +
      `and save it as ${path}, or pass --csv <path>.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const grid = parseCsv(raw).filter((r) => r.length > 1 && r.some((c) => c.trim() !== ''));
  if (grid.length === 0) throw new Error('CSV is empty');
  const headers = grid[0];
  const iSymbol  = pickColumn(headers, ['Symbol', 'Trading Symbol']);
  const iName    = pickColumn(headers, ['Company Name', 'Name']);
  const iIsin    = pickColumn(headers, ['ISIN Code', 'ISIN']);
  const iSector  = pickColumn(headers, ['Industry', 'Sector']);
  if (iSymbol < 0 || iName < 0) {
    throw new Error(`CSV missing required columns. Headers found: ${headers.join(', ')}`);
  }
  const rows: Row[] = [];
  // Dedupe by symbol within the CSV. The DB column `symbol` is UNIQUE,
  // so two rows for the same symbol would crash applyToDb at the
  // second INSERT — drop the dup defensively here. First occurrence
  // wins (CSV order preserved).
  const seenSymbols = new Set<string>();
  let droppedDuplicates = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const symbol = (r[iSymbol] ?? '').trim().toUpperCase();
    const companyName = (r[iName] ?? '').trim();
    if (!symbol) continue;
    if (seenSymbols.has(symbol)) {
      droppedDuplicates++;
      continue;
    }
    seenSymbols.add(symbol);
    rows.push({
      symbol,
      companyName: companyName || symbol,
      isin:    iIsin   >= 0 ? ((r[iIsin]   ?? '').trim() || null) : null,
      sector:  iSector >= 0 ? ((r[iSector] ?? '').trim() || null) : null,
    });
  }
  if (droppedDuplicates > 0) {
    console.warn(
      `[loadNifty500] dropped ${droppedDuplicates} duplicate row(s) from CSV (first occurrence kept)`,
    );
  }
  return rows;
}

interface LoaderResult {
  total:        number;
  inserted:     number;
  updated:      number;
  deactivated:  number;
}

async function applyToDb(rows: Row[]): Promise<LoaderResult> {
  // Read existing universe, decide insert vs update vs deactivate.
  const { rows: existing } = await db.query<{ symbol: string; is_active: number }>(
    `SELECT symbol, is_active FROM q365_universe`,
  );
  const existingSet = new Set((existing as any[]).map((e) => e.symbol));
  const incomingSet = new Set(rows.map((r) => r.symbol));

  let inserted = 0;
  let updated  = 0;
  for (const r of rows) {
    if (existingSet.has(r.symbol)) {
      await db.query(
        `UPDATE q365_universe
            SET company_name = ?, isin = ?, sector = ?, is_active = 1
          WHERE symbol = ?`,
        [r.companyName, r.isin, r.sector, r.symbol],
      );
      updated++;
    } else {
      await db.query(
        `INSERT INTO q365_universe (symbol, company_name, isin, sector, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [r.symbol, r.companyName, r.isin, r.sector],
      );
      inserted++;
    }
  }

  // Deactivate rows present in DB but absent from CSV.
  let deactivated = 0;
  const toDeactivate = (existing as any[])
    .filter((e) => Number(e.is_active) === 1 && !incomingSet.has(e.symbol))
    .map((e) => e.symbol);
  for (const sym of toDeactivate) {
    await db.query(
      `UPDATE q365_universe SET is_active = 0 WHERE symbol = ?`,
      [sym],
    );
    deactivated++;
  }

  return { total: rows.length, inserted, updated, deactivated };
}

async function main(): Promise<void> {
  const { csv, dryRun } = parseArgs(process.argv.slice(2));
  console.log(`[loadNifty500] csv=${csv}  dryRun=${dryRun}`);
  const rows = loadCsvRows(csv);
  console.log(`[loadNifty500] parsed ${rows.length} rows from CSV`);
  if (dryRun) {
    console.log(`[loadNifty500] dry-run — first 3 rows:`, rows.slice(0, 3));
    return;
  }
  // Ensure the q365_universe + override tables exist before the upsert.
  // The first boot of the Next process would auto-create them via
  // ensureAllSchemas(); when this script is invoked standalone we
  // call it directly so a fresh DB is bootstrapped in one shot.
  console.log('[loadNifty500] ensuring schemas...');
  const { ensureAllSchemas } = await import('@/lib/db/ensureAllSchemas');
  const ensure = await ensureAllSchemas();
  console.log(`[loadNifty500] schemas ready (created=${ensure.created} failed=${ensure.failed})`);
  const result = await applyToDb(rows);
  console.log(
    `[loadNifty500] done  total=${result.total}  inserted=${result.inserted}  ` +
    `updated=${result.updated}  deactivated=${result.deactivated}`,
  );
  // Verify the spec's invariant.
  const { rows: countRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_universe WHERE is_active = 1`,
  );
  const active = Number((countRows as any[])[0]?.c ?? 0);
  console.log(`[loadNifty500] active universe size: ${active}`);
}

main().then(
  () => { process.exit(0); },
  (err) => {
    console.error('[loadNifty500] FAILED:', err?.message ?? err);
    process.exit(1);
  },
);
