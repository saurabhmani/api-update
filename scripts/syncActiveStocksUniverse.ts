/**
 * scripts/syncActiveStocksUniverse.ts
 *
 * Sync `src/data/active_stocks.json` → `q365_universe` (+ instruments).
 *
 * Usage:
 *   npx tsx scripts/syncActiveStocksUniverse.ts
 *   npx tsx scripts/syncActiveStocksUniverse.ts --dry-run
 *   npx tsx scripts/syncActiveStocksUniverse.ts --exclude-inav
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

interface ActiveStockRow {
  tradingsymbol?: string;
  name?: string;
  isin?: string | null;
  sector?: string | null;
  exchange?: string;
  segment?: string;
  instrument_type?: string;
}

function parseArgs(argv: string[]): { dryRun: boolean; excludeInav: boolean } {
  let dryRun = false;
  let excludeInav = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    if (a === '--exclude-inav') excludeInav = true;
  }
  return { dryRun, excludeInav };
}

function loadActiveStocks(excludeInav: boolean): ActiveStockRow[] {
  const jsonPath = resolvePath(process.cwd(), 'src/data/active_stocks.json');
  if (!existsSync(jsonPath)) {
    throw new Error(`active_stocks.json not found at ${jsonPath}`);
  }
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('active_stocks.json is empty or invalid');
  }

  const seen = new Set<string>();
  const out: ActiveStockRow[] = [];
  let skippedInav = 0;
  let skippedDup = 0;
  let skippedBlank = 0;

  for (const row of raw as ActiveStockRow[]) {
    const sym = String(row.tradingsymbol ?? '').trim().toUpperCase();
    if (!sym) {
      skippedBlank += 1;
      continue;
    }
    if (excludeInav && /INAV$/i.test(sym)) {
      skippedInav += 1;
      continue;
    }
    if (seen.has(sym)) {
      skippedDup += 1;
      continue;
    }
    seen.add(sym);
    out.push({
      ...row,
      tradingsymbol: sym,
      name: String(row.name ?? '').trim(),
      exchange: String(row.exchange ?? row.segment ?? 'NSE').trim().toUpperCase() || 'NSE',
    });
  }

  console.log(
    `[ACTIVE_STOCKS] parsed=${raw.length} unique=${out.length} ` +
    `skipped_blank=${skippedBlank} skipped_dup=${skippedDup} skipped_inav=${skippedInav}`,
  );
  return out;
}

async function main(): Promise<void> {
  const { dryRun, excludeInav } = parseArgs(process.argv.slice(2));
  const stocks = loadActiveStocks(excludeInav);

  if (dryRun) {
    console.log('[ACTIVE_STOCKS] dry-run — first 5:', stocks.slice(0, 5).map((s) => s.tradingsymbol));
    console.log(`[ACTIVE_STOCKS] would sync ${stocks.length} symbols to q365_universe`);
    return;
  }

  const { ensureAllSchemas } = await import('@/lib/db/ensureAllSchemas');
  const { db } = await import('@/lib/db');

  console.log('[ACTIVE_STOCKS] ensuring schemas...');
  await ensureAllSchemas();

  await db.query(`UPDATE q365_universe SET is_active = 0`);

  const BATCH = 50;
  let upserted = 0;
  for (let i = 0; i < stocks.length; i += BATCH) {
    const chunk = stocks.slice(i, i + BATCH);
    const vals: string[] = [];
    const params: unknown[] = [];
    const instVals: string[] = [];
    const instParams: unknown[] = [];

    for (const s of chunk) {
      const sym = s.tradingsymbol!;
      vals.push('(?, ?, ?, ?, 1)');
      params.push(sym, s.name || sym, s.isin ?? null, s.sector ?? null);
      instVals.push('(?, ?, ?, ?, 1)');
      instParams.push(`NSE_EQ|${sym}`, s.exchange || 'NSE', sym, s.name || sym);
    }

    await db.query(
      `INSERT INTO q365_universe (symbol, company_name, isin, sector, is_active)
       VALUES ${vals.join(',')}
       ON DUPLICATE KEY UPDATE
         company_name = VALUES(company_name),
         isin         = VALUES(isin),
         sector       = VALUES(sector),
         is_active    = 1`,
      params,
    );
    await db.query(
      `INSERT INTO instruments (instrument_key, exchange, tradingsymbol, name, is_active)
       VALUES ${instVals.join(',')}
       ON DUPLICATE KEY UPDATE
         tradingsymbol = VALUES(tradingsymbol),
         name          = VALUES(name),
         is_active     = 1`,
      instParams,
    );
    upserted += chunk.length;
  }

  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_universe WHERE is_active = 1`,
  );
  const active = Number((rows as Array<{ c: number }>)[0]?.c ?? 0);

  console.log(
    `[ACTIVE_STOCKS] sync complete upserted=${upserted} active_universe=${active}`,
  );
  console.log(
    '[ACTIVE_STOCKS] tip: set CANDLE_BACKFILL_UNIVERSE_LIMIT >= active count, then run candles:daily',
  );
}

main().catch((err) => {
  console.error('[ACTIVE_STOCKS] FAILED:', (err as Error)?.message ?? err);
  process.exit(1);
});
