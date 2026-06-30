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

export function resolveEquityLCsvPath(): string {
  const raw = process.env.SECURITIES_MASTER_CSV_PATH
    ?? process.env.EQUITY_L_CSV_PATH
    ?? 'EQUITY_L.csv';
  return resolvePath(process.cwd(), raw);
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

  await db.query(
    `UPDATE securities_master SET is_active = 0, updated_at = CURRENT_TIMESTAMP
     WHERE source = 'EQUITY_L' AND series = 'EQ'
       AND symbol NOT IN (${rows.map(() => '?').join(',')})`,
    rows.map((r) => r.symbol),
  );

  return { inserted, updated, total: rows.length };
}

export async function loadActiveEqSymbolsFromMaster(): Promise<string[]> {
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM securities_master WHERE is_active = 1 AND series = 'EQ' ORDER BY symbol`,
  );
  return (rows as Array<{ symbol: string }>).map((r) => String(r.symbol).trim().toUpperCase()).filter(Boolean);
}
