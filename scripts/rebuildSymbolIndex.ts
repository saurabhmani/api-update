/**
 * rebuildSymbolIndex — one-shot back-fill for q365_news_events rows
 * whose `symbols_json` is empty because they were ingested before the
 * current alias-map / resolver expansion. Reruns entity resolution on
 * each row's title + body with the CURRENT resolver and updates the
 * row in place.
 *
 * Fixes the observed "news_events_with_symbols = 0 while scoring has
 * real symbols" symptom: the scoring layer reads event.symbols from
 * in-memory output of the current resolver, but the DB column was
 * frozen at the older resolver's output because the dedup guard
 * overwrote nothing on re-ingestion.
 *
 * Run:  npm run news:rebuild-symbols
 * Flags:
 *   --dry-run     Scan and count, don't write.
 *   --limit=N     Cap rows to process (default: no cap).
 *   --empty-only  (default) Only process rows with empty symbols_json.
 *                 Pass --all to rescan every row.
 *
 * Exits 0 when at least one row was updated; 0 also when --dry-run
 * completed; 1 on DB/error.
 */
import fs    from 'fs';
import path  from 'path';
import mysql from 'mysql2/promise';

try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

require('tsconfig-paths/register');

const argv       = process.argv.slice(2);
const DRY_RUN    = argv.includes('--dry-run');
const ALL        = argv.includes('--all');
const LIMIT      = (() => {
  const flag = argv.find((a) => a.startsWith('--limit='));
  if (!flag) return null;
  const n = Number(flag.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = {
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m',
  };
  return `${map[col]}${s}\x1b[0m`;
}

async function main(): Promise<number> {
  const cfg = {
    host:     process.env.MYSQL_HOST     || '127.0.0.1',
    port:     Number(process.env.MYSQL_PORT || 3306),
    user:     process.env.MYSQL_USER     || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'quantorus365',
  };

  console.log(c('dim', `\n── rebuildSymbolIndex — ${cfg.host}:${cfg.port}/${cfg.database} ──`));
  console.log(c('dim', `  mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`));
  console.log(c('dim', `  scope:      ${ALL ? 'all rows' : 'empty symbols_json only'}`));
  console.log(c('dim', `  limit:      ${LIMIT ?? 'none'}\n`));

  // Lazy import of the entity resolver so path-alias registration takes effect.
  const { resolveEntities } = await import('@/lib/news-engine/entity-linking/entityResolver');

  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection(cfg);
    console.log(c('green', '✓') + ' DB connection OK');
  } catch (err: any) {
    console.log(c('red', '✗') + ` DB connection failed: ${err?.message}`);
    return 1;
  }

  // Select target rows.
  const where = ALL
    ? '1=1'
    : "(symbols_json IS NULL OR JSON_LENGTH(symbols_json) = 0)";
  const sql = `
    SELECT id, title, body
      FROM q365_news_events
     WHERE ${where}
     ORDER BY id DESC
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `;
  const [rows]: any = await conn.query(sql);

  console.log(c('dim', `  candidates: ${rows.length}\n`));

  let updated = 0;
  let stillEmpty = 0;
  let skipped = 0;

  for (const row of rows) {
    const title = String(row.title ?? '');
    const body  = row.body != null ? String(row.body) : null;
    if (!title) { skipped++; continue; }

    const entities = resolveEntities(title, body);
    const symbols: string[] = [];
    const sectors: string[] = [];
    const macro:   string[] = [];
    const comms:   string[] = [];
    for (const e of entities) {
      if (e.entityType === 'symbol')       symbols.push(e.entityValue);
      else if (e.entityType === 'sector')  sectors.push(e.entityValue);
      else if (e.entityType === 'macro_factor') macro.push(e.entityValue);
      else if (e.entityType === 'commodity')    comms.push(e.entityValue);
    }

    const uniqSymbols = Array.from(new Set(symbols));
    if (uniqSymbols.length === 0) { stillEmpty++; continue; }

    if (DRY_RUN) {
      updated++;
      console.log(
        c('yellow', '  [dry]') +
        ` id=${String(row.id).padStart(6)}  would set symbols=[${uniqSymbols.join(',')}]`,
      );
      continue;
    }

    await conn.query(
      `UPDATE q365_news_events
          SET symbols_json       = ?,
              sectors_json       = ?,
              macro_factors_json = ?,
              commodities_json   = ?,
              updated_at         = NOW()
        WHERE id = ?`,
      [
        JSON.stringify(uniqSymbols),
        JSON.stringify(Array.from(new Set(sectors))),
        JSON.stringify(Array.from(new Set(macro))),
        JSON.stringify(Array.from(new Set(comms))),
        row.id,
      ],
    );
    updated++;
  }

  await conn.end();

  console.log('');
  console.log(c('green', '✓') + ` updated:     ${updated}`);
  console.log(c('dim',   '  still empty: ') + `${stillEmpty}  ${c('dim', '(article text doesn’t mention any known company — resolver coverage gap)')}`);
  console.log(c('dim',   '  skipped:     ') + `${skipped}`);

  if (updated === 0 && stillEmpty === rows.length) {
    console.log(c('yellow', '\n⚠') + ' no rows gained symbols. Either the alias map still doesn’t cover the companies in your DB, or the rows really are index-level commentary with no specific stocks.');
  } else if (updated > 0) {
    console.log(c('green', '\n✓ rebuildSymbolIndex complete — run `npm run verify:news` to confirm.\n'));
  }

  return 0;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `\nrebuildSymbolIndex crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
