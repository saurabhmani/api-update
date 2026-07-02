// ════════════════════════════════════════════════════════════════
//  securities_master — NSE EQUITY_L.csv master source (SERIES=EQ)
// ════════════════════════════════════════════════════════════════

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { db } from '@/lib/db';
import { parseCsv, pickCsvColumn } from './csvParse';

export interface SecuritiesMasterRow {
  symbol:       string;
  companyName:  string;
  series:       string;
  isin:         string | null;
  dateOfListing: string | null;
  marketLot:    number | null;
  faceValue:    number | null;
}

const EQUITY_L_CANDIDATE_PATHS = [
  'src/data/EQUITY_L.csv',
  'data/EQUITY_L.csv',
  'EQUITY_L.csv',
] as const;

export function resolveEquityLCsvPath(): string {
  const fromEnv = process.env.SECURITIES_MASTER_CSV_PATH?.trim()
    || process.env.EQUITY_L_CSV_PATH?.trim();
  if (fromEnv) {
    return resolvePath(process.cwd(), fromEnv);
  }
  for (const candidate of EQUITY_L_CANDIDATE_PATHS) {
    const resolved = resolvePath(process.cwd(), candidate);
    if (existsSync(resolved)) return resolved;
  }
  return resolvePath(process.cwd(), EQUITY_L_CANDIDATE_PATHS[0]);
}

/** Parse EQUITY_L.csv — keeps SERIES=EQ rows only. */
export function parseEquityLCsv(path: string): SecuritiesMasterRow[] {
  if (!existsSync(path)) {
    throw new Error(
      `EQUITY_L.csv not found at ${path}. ` +
      'Download from NSE and set SECURITIES_MASTER_CSV_PATH.',
    );
  }
  const raw = readFileSync(path, 'utf8');
  const grid = parseCsv(raw).filter((r) => r.length > 1 && r.some((c) => c.trim() !== ''));
  if (grid.length === 0) throw new Error('EQUITY_L.csv is empty');

  const headers = grid[0];
  const iSymbol  = pickCsvColumn(headers, ['Symbol', 'SYMBOL']);
  const iName    = pickCsvColumn(headers, ['NAME OF COMPANY', 'Company Name', 'Name']);
  const iSeries  = pickCsvColumn(headers, ['SERIES', 'Series']);
  const iIsin    = pickCsvColumn(headers, ['ISIN NUMBER', 'ISIN Code', 'ISIN']);
  const iListing = pickCsvColumn(headers, ['DATE OF LISTING', 'Date of Listing']);
  const iLot     = pickCsvColumn(headers, ['MARKET LOT', 'Market Lot']);
  const iFace    = pickCsvColumn(headers, ['FACE VALUE', 'Face Value']);

  if (iSymbol < 0) {
    throw new Error(`EQUITY_L.csv missing Symbol column. Headers: ${headers.join(', ')}`);
  }

  const seen = new Set<string>();
  const rows: SecuritiesMasterRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const symbol = String(r[iSymbol] ?? '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    const series = iSeries >= 0 ? String(r[iSeries] ?? '').trim().toUpperCase() : 'EQ';
    if (series !== 'EQ') continue;
    seen.add(symbol);
    const lotRaw = iLot >= 0 ? Number(r[iLot]) : NaN;
    const faceRaw = iFace >= 0 ? Number(r[iFace]) : NaN;
    rows.push({
      symbol,
      companyName: String((iName >= 0 ? r[iName] : symbol) ?? symbol).trim() || symbol,
      series,
      isin: iIsin >= 0 ? (String(r[iIsin] ?? '').trim() || null) : null,
      dateOfListing: iListing >= 0 ? (String(r[iListing] ?? '').trim() || null) : null,
      marketLot: Number.isFinite(lotRaw) ? lotRaw : null,
      faceValue: Number.isFinite(faceRaw) ? faceRaw : null,
    });
  }
  return rows;
}

export async function upsertSecuritiesMaster(
  rows: SecuritiesMasterRow[],
  opts: { dryRun?: boolean } = {},
): Promise<{ inserted: number; updated: number; total: number }> {
  if (opts.dryRun) {
    return { inserted: rows.length, updated: 0, total: rows.length };
  }

  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const result: any = await db.query(
      `INSERT INTO securities_master
        (symbol, company_name, series, isin, date_of_listing, market_lot, face_value, is_active, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'EQUITY_L')
       ON DUPLICATE KEY UPDATE
         company_name = VALUES(company_name),
         series = VALUES(series),
         isin = VALUES(isin),
         date_of_listing = VALUES(date_of_listing),
         market_lot = VALUES(market_lot),
         face_value = VALUES(face_value),
         is_active = 1,
         source = 'EQUITY_L',
         updated_at = CURRENT_TIMESTAMP`,
      [
        row.symbol, row.companyName, row.series, row.isin,
        row.dateOfListing, row.marketLot, row.faceValue,
      ],
    );
    if (result.affectedRows === 1) inserted++;
    else if (result.affectedRows === 2) updated++;
  }

  if (rows.length > 0) {
    await db.query(
      `UPDATE securities_master SET is_active = 0, updated_at = CURRENT_TIMESTAMP
       WHERE source = 'EQUITY_L' AND series = 'EQ'
         AND symbol NOT IN (${rows.map(() => '?').join(',')})`,
      rows.map((r) => r.symbol),
    );
  }

  return { inserted, updated, total: rows.length };
}

export async function loadActiveEqSymbolsFromMaster(): Promise<string[]> {
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM securities_master WHERE is_active = 1 AND series = 'EQ' ORDER BY symbol`,
  );
  return (rows as Array<{ symbol: string }>).map((r) => String(r.symbol).trim().toUpperCase()).filter(Boolean);
}

export interface SecuritiesMasterImportResult {
  csvPath: string;
  parsedRows: number;
  inserted: number;
  updated: number;
  total: number;
  dryRun: boolean;
}

/** Load EQUITY_L via SECURITIES_MASTER_CSV_PATH and upsert active EQ rows. */
export async function importActiveEqSecuritiesFromCsv(
  opts: { csvPath?: string; dryRun?: boolean } = {},
): Promise<SecuritiesMasterImportResult> {
  const csvPath = opts.csvPath ?? resolveEquityLCsvPath();
  const dryRun = opts.dryRun ?? false;
  const rows = parseEquityLCsv(csvPath);
  const upsert = await upsertSecuritiesMaster(rows, { dryRun });
  return {
    csvPath,
    parsedRows: rows.length,
    inserted: upsert.inserted,
    updated: upsert.updated,
    total: upsert.total,
    dryRun,
  };
}

export interface SecuritiesMasterValidationSummary {
  activeEqCount: number;
  inactiveEqCount: number;
  source: string;
  sql: {
    countActiveEq: string;
    countInactiveEq: string;
    sampleActive: string;
  };
}

export async function buildSecuritiesMasterValidationSummary(): Promise<SecuritiesMasterValidationSummary> {
  const [{ rows: activeRows }, { rows: inactiveRows }] = await Promise.all([
    db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM securities_master WHERE is_active = 1 AND series = 'EQ'`,
    ),
    db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM securities_master WHERE is_active = 0 AND series = 'EQ'`,
    ),
  ]);
  const activeEqCount = Number((activeRows[0] as { cnt?: number })?.cnt ?? 0);
  const inactiveEqCount = Number((inactiveRows[0] as { cnt?: number })?.cnt ?? 0);
  return {
    activeEqCount,
    inactiveEqCount,
    source: 'EQUITY_L',
    sql: {
      countActiveEq:
        "SELECT COUNT(*) AS active_eq FROM securities_master WHERE is_active = 1 AND series = 'EQ';",
      countInactiveEq:
        "SELECT COUNT(*) AS inactive_eq FROM securities_master WHERE is_active = 0 AND series = 'EQ';",
      sampleActive:
        "SELECT symbol, company_name, isin FROM securities_master WHERE is_active = 1 AND series = 'EQ' ORDER BY symbol LIMIT 20;",
    },
  };
}

export function logSecuritiesMasterValidation(summary: SecuritiesMasterValidationSummary): void {
  console.log(
    `[SECURITIES_MASTER] active_eq=${summary.activeEqCount} inactive_eq=${summary.inactiveEqCount} ` +
    `source=${summary.source}`,
  );
  console.log('[SECURITIES_MASTER SQL]');
  for (const sql of Object.values(summary.sql)) {
    console.log(`  ${sql}`);
  }
}
