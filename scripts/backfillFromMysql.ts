// ════════════════════════════════════════════════════════════════
//  backfillFromMysql.ts — one-shot MySQL → Postgres backfill
//
//  Usage:
//    tsx scripts/backfillFromMysql.ts --table=market_snapshots_current
//    tsx scripts/backfillFromMysql.ts --table=all --batch=500
//    tsx scripts/backfillFromMysql.ts --dry-run
//
//  DESIGN:
//    • Per-table loader — each mapping below owns its SELECT +
//      row→row transform + PG UPSERT SQL. Add a mapping and you've
//      added a backfillable table; no generic reflection.
//    • Batches of 500 by default. The PG side uses ON CONFLICT DO
//      UPDATE so re-running is idempotent.
//    • Progress is logged every batch; a --resume-from flag lets
//      you restart mid-run after an interruption.
//
//  ⚠  THIS FILE IS A SKELETON. The TABLE_MAPPINGS at the top list
//     the MySQL tables I do NOT know in your schema. Fill in:
//       - `mysqlTable`          (the actual MySQL table name)
//       - `selectSql`           (the SELECT that feeds the backfill)
//       - `pgInsertSql`         (ON CONFLICT DO UPDATE into target)
//       - `mapRow`              (MySQL row → PG params array)
//     Then `npm run db:backfill:pg -- --table=<name>` to run it.
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) {
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch { /* env optional */ }

import { pg } from '@/lib/db/postgres';
import { db as mysql } from '@/lib/db';

// ── Args ───────────────────────────────────────────────────────────
const argv = new Map(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const onlyTable = argv.get('table');
const batchSize = Number(argv.get('batch') ?? '500');
const dryRun    = argv.has('dry-run');
const resumeFrom = argv.get('resume-from');
const limitRows = argv.has('limit') ? Number(argv.get('limit')) : undefined;   // cap total rows per table
const sinceSpec = argv.get('since');                                            // e.g. "24h", "30m", "7d"

function parseSince(spec: string): number {
  const m = spec.match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`invalid --since: ${spec}`);
  const mul: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(m[1]) * (mul[(m[2] || 's').toLowerCase()] ?? 1);
}
const sinceSec = sinceSpec ? parseSince(sinceSpec) : undefined;

// ── Table mappings — FILL THESE IN BEFORE RUNNING ──────────────────

interface Mapping {
  name: string;
  mysqlTable: string;
  pgTable: string;                                    // e.g. 'market.snapshots_current'
  selectSql: string;                                  // must ORDER BY stable key
  pgInsertSql: string;                                // ON CONFLICT DO UPDATE
  mapRow: (row: Record<string, unknown>) => unknown[];
  resumeKeyFromRow?: (row: Record<string, unknown>) => string | number | null;
  /** Column in MySQL source that --since filters on. Must be comparable
   *  with "> NOW() - INTERVAL N MINUTE" on the MySQL side. */
  sinceColumn?: string;
  /** Numeric columns to sum per batch for cross-DB consistency check. */
  checksumColumns?: string[];
}

const TABLE_MAPPINGS: Mapping[] = [
  {
    name: 'market.snapshots_current',
    mysqlTable: 'TODO_your_mysql_snapshots_table',
    pgTable:    'market.snapshots_current',
    sinceColumn: 'fetched_at',
    checksumColumns: ['price', 'volume'],
    selectSql: `
      SELECT symbol, price, prev_close, \`change\` AS change_val, change_percent,
             open_price AS o, high_price AS h, low_price AS l, volume,
             source, data_quality, fetched_at
        FROM TODO_your_mysql_snapshots_table
       ORDER BY symbol ASC
    `,
    pgInsertSql: `
      INSERT INTO market.snapshots_current
        (symbol, price, prev_close, change, change_percent,
         open, high, low, volume, source, data_quality,
         fetched_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (symbol) DO UPDATE SET
        price = EXCLUDED.price,
        prev_close = EXCLUDED.prev_close,
        change = EXCLUDED.change,
        change_percent = EXCLUDED.change_percent,
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        volume = EXCLUDED.volume,
        source = EXCLUDED.source,
        data_quality = EXCLUDED.data_quality,
        fetched_at = EXCLUDED.fetched_at,
        updated_at = NOW()
    `,
    mapRow: (r) => [
      r.symbol, r.price, r.prev_close, r.change_val, r.change_percent,
      r.o, r.h, r.l, r.volume, r.source, r.data_quality, r.fetched_at,
    ],
    resumeKeyFromRow: (r) => String(r.symbol ?? ''),
  },
  {
    name: 'market.candles',
    mysqlTable: 'TODO_your_mysql_candles_table',
    pgTable:    'market.candles',
    sinceColumn: 'ts',
    checksumColumns: ['volume'],
    selectSql: `
      SELECT symbol, \`interval\` AS iv, ts, open, high, low, close, volume, source
        FROM TODO_your_mysql_candles_table
       ORDER BY symbol ASC, \`interval\` ASC, ts ASC
    `,
    pgInsertSql: `
      INSERT INTO market.candles (symbol, interval, ts, open, high, low, close, volume, source, ingested_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (symbol, interval, ts) DO UPDATE SET
        open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
        close = EXCLUDED.close, volume = EXCLUDED.volume, source = EXCLUDED.source
    `,
    mapRow: (r) => [r.symbol, r.iv, r.ts, r.open, r.high, r.low, r.close, r.volume, r.source],
  },
  {
    name: 'intel.corporate_events',
    mysqlTable: 'TODO_your_mysql_corporate_events_table',
    pgTable:    'intel.corporate_events',
    sinceColumn: 'ingested_at',
    selectSql: `
      SELECT symbol, event_type, event_date, details, source
        FROM TODO_your_mysql_corporate_events_table
       ORDER BY symbol ASC, event_type ASC, event_date ASC
    `,
    pgInsertSql: `
      INSERT INTO intel.corporate_events (symbol, event_type, event_date, details, source, ingested_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
      ON CONFLICT (symbol, event_type, event_date) DO UPDATE SET
        details = EXCLUDED.details, source = EXCLUDED.source
    `,
    mapRow: (r) => [r.symbol, r.event_type, r.event_date, JSON.stringify(r.details ?? {}), r.source],
  },
  {
    name: 'intel.news',
    mysqlTable: 'TODO_your_mysql_news_table',
    pgTable:    'intel.news',
    sinceColumn: 'published_at',
    selectSql: `
      SELECT external_id, headline, summary, source, url, symbols, sentiment,
             impact_score, categories, raw_payload, published_at
        FROM TODO_your_mysql_news_table
       ORDER BY published_at ASC
    `,
    pgInsertSql: `
      INSERT INTO intel.news (external_id, headline, summary, source, url, symbols,
                              sentiment, impact_score, categories, raw_payload, published_at)
      VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9::text[], $10::jsonb, $11)
      ON CONFLICT (external_id) DO UPDATE SET
        headline = EXCLUDED.headline,
        summary = EXCLUDED.summary,
        sentiment = EXCLUDED.sentiment,
        impact_score = EXCLUDED.impact_score
    `,
    mapRow: (r) => [
      r.external_id, r.headline, r.summary, r.source, r.url,
      r.symbols ?? [],
      r.sentiment, r.impact_score,
      r.categories ?? [],
      JSON.stringify(r.raw_payload ?? {}),
      r.published_at,
    ],
  },
  {
    name: 'auth.users',
    mysqlTable: 'TODO_your_mysql_users_table',
    pgTable:    'auth.users',
    sinceColumn: 'created_at',
    selectSql: `
      SELECT id, email, password_hash, display_name, role, is_active,
             mfa_secret, mfa_enabled, last_login_at, created_at, updated_at
        FROM TODO_your_mysql_users_table
       ORDER BY id ASC
    `,
    pgInsertSql: `
      INSERT INTO auth.users (id, email, password_hash, display_name, role, is_active,
                              mfa_secret, mfa_enabled, last_login_at, created_at, updated_at)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        display_name = EXCLUDED.display_name,
        is_active = EXCLUDED.is_active,
        last_login_at = EXCLUDED.last_login_at,
        updated_at = NOW()
    `,
    mapRow: (r) => [
      r.id, r.email, r.password_hash, r.display_name, r.role, !!r.is_active,
      r.mfa_secret, !!r.mfa_enabled, r.last_login_at, r.created_at, r.updated_at,
    ],
  },
  {
    name: 'app.watchlists',
    mysqlTable: 'TODO_your_mysql_watchlists_table',
    pgTable:    'app.watchlists',
    sinceColumn: 'updated_at',
    selectSql: `
      SELECT id, user_id, name, symbols, is_default, created_at, updated_at
        FROM TODO_your_mysql_watchlists_table
       ORDER BY user_id ASC, id ASC
    `,
    pgInsertSql: `
      INSERT INTO app.watchlists (id, user_id, name, symbols, is_default, created_at, updated_at)
      VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        symbols = EXCLUDED.symbols,
        is_default = EXCLUDED.is_default,
        updated_at = NOW()
    `,
    mapRow: (r) => [
      r.id, r.user_id, r.name,
      // symbols might be JSON-encoded or comma-sep in MySQL; coerce to array.
      Array.isArray(r.symbols) ? r.symbols :
        typeof r.symbols === 'string' ?
          (r.symbols.startsWith('[') ? JSON.parse(r.symbols) : r.symbols.split(',').map(s => s.trim())) :
          [],
      !!r.is_default, r.created_at, r.updated_at,
    ],
  },
];

// ── Runner ─────────────────────────────────────────────────────────

interface BatchReport {
  copied: number;
  mysqlCount: number;
  pgCount: number;
  mysqlChecksum: Record<string, number>;
  pgChecksum: Record<string, number>;
  mismatches: string[];
}

async function applyWithRetry(
  rows: Record<string, unknown>[],
  m: Mapping,
): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await pg.tx(async (client) => {
        for (const row of rows) {
          await client.query(m.pgInsertSql, m.mapRow(row));
        }
      });
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = 200 * Math.pow(2, attempt - 1);
        console.warn(`    retry ${attempt}/${MAX_ATTEMPTS - 1} after ${backoff}ms: ${err instanceof Error ? err.message : err}`);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function validateBatch(
  m: Mapping,
  sinceClause: string,
  sinceParamsMy: unknown[],
): Promise<BatchReport['mysqlCount'] extends infer _ ? Omit<BatchReport, 'copied' | 'mismatches'> & { mismatches: string[] } : never> {
  // Row counts on both sides (bounded by --since if given).
  const mysqlCountSql = `SELECT COUNT(*) AS c FROM \`${m.mysqlTable}\`${sinceClause}`;
  const pgCountSql    = `SELECT COUNT(*)::bigint AS c FROM ${m.pgTable}`;

  const [myCountRes, pgCountRes] = await Promise.all([
    mysql.query<{ c: number | string }>(mysqlCountSql, sinceParamsMy),
    pg.query<{ c: string }>(pgCountSql),
  ]);
  const mysqlCount = Number(myCountRes.rows[0]?.c ?? 0);
  const pgCount    = Number(pgCountRes.rows[0]?.c ?? 0);

  const mysqlChecksum: Record<string, number> = {};
  const pgChecksum: Record<string, number> = {};
  for (const col of m.checksumColumns ?? []) {
    const myRes = await mysql.query<{ s: number | string }>(`SELECT SUM(\`${col}\`) AS s FROM \`${m.mysqlTable}\`${sinceClause}`, sinceParamsMy);
    const pgRes = await pg.query<{ s: string }>(`SELECT SUM(${col}) AS s FROM ${m.pgTable}`);
    mysqlChecksum[col] = Number(myRes.rows[0]?.s ?? 0);
    pgChecksum[col]    = Number(pgRes.rows[0]?.s ?? 0);
  }

  const mismatches: string[] = [];
  if (!sinceClause) {
    // Strict equality only when doing a full table compare.
    if (mysqlCount !== pgCount) {
      mismatches.push(`row-count mysql=${mysqlCount} pg=${pgCount}`);
    }
    for (const col of m.checksumColumns ?? []) {
      const delta = Math.abs(mysqlChecksum[col] - pgChecksum[col]);
      const rel = delta / Math.max(1, Math.abs(mysqlChecksum[col]));
      if (delta > 0.01 && rel > 0.001) {
        mismatches.push(`sum(${col}) mysql=${mysqlChecksum[col]} pg=${pgChecksum[col]} Δ=${delta}`);
      }
    }
  }
  return { mysqlCount, pgCount, mysqlChecksum, pgChecksum, mismatches };
}

async function backfillOne(m: Mapping): Promise<void> {
  console.log(`\n── ${m.name} ← ${m.mysqlTable} ──`);
  if (m.mysqlTable.startsWith('TODO_')) {
    console.log('  (skipped — mapping not configured yet; edit TABLE_MAPPINGS)');
    return;
  }

  // Wire --since into the MySQL SELECT. We inject an additional
  // WHERE clause AFTER the ORDER BY-less body. The selectSql is
  // expected to NOT already include WHERE / LIMIT — we paginate
  // ourselves. For safety, we strip any existing LIMIT and append
  // our own at call time.
  let sinceClause = '';
  const sinceParamsMy: unknown[] = [];
  if (sinceSec && m.sinceColumn) {
    sinceClause = ` WHERE \`${m.sinceColumn}\` > DATE_SUB(NOW(), INTERVAL ${sinceSec} SECOND)`;
  }

  let copied = 0;
  let lastResumeKey: string | number | null = resumeFrom ?? null;
  let offset = 0;

  for (;;) {
    const capBatch = limitRows ? Math.min(batchSize, limitRows - copied) : batchSize;
    if (capBatch <= 0) break;

    // Build paged SELECT. If the mapping already uses ORDER BY (it
    // should), we splice WHERE before it.
    const paged = sinceClause
      ? m.selectSql.replace(/ORDER BY/i, `${sinceClause} ORDER BY`)
      : m.selectSql;
    const sql = `${paged} LIMIT ${capBatch} OFFSET ${offset}`;

    const { rows } = await mysql.query<Record<string, unknown>>(sql, sinceParamsMy);
    if (rows.length === 0) break;

    if (dryRun) {
      console.log(`  DRY  batch=${rows.length} copied=${copied}`);
    } else {
      await applyWithRetry(rows, m);
      lastResumeKey = m.resumeKeyFromRow?.(rows[rows.length - 1]) ?? lastResumeKey;
      console.log(`  OK   batch=${rows.length} copied=${copied + rows.length} resume=${lastResumeKey}`);
    }

    copied += rows.length;
    offset += rows.length;
    if (rows.length < capBatch) break;
    if (limitRows && copied >= limitRows) break;
  }

  console.log(`  → ${copied} rows processed`);

  if (!dryRun) {
    try {
      const report = await validateBatch(m, sinceClause, sinceParamsMy);
      console.log(`  validate  mysqlCount=${report.mysqlCount} pgCount=${report.pgCount}`);
      for (const col of m.checksumColumns ?? []) {
        console.log(`  validate  sum(${col}) mysql=${report.mysqlChecksum[col]} pg=${report.pgChecksum[col]}`);
      }
      if (report.mismatches.length > 0) {
        console.warn(`  ⚠ MISMATCHES:\n    ${report.mismatches.join('\n    ')}`);
        process.exitCode = 1;
      } else {
        console.log(`  validate  OK`);
      }
    } catch (err) {
      console.warn(`  validate  skipped: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function main(): Promise<void> {
  console.log('── backfillFromMysql.ts ──');
  console.log(
    `table=${onlyTable ?? 'all'} batch=${batchSize} ` +
    `dryRun=${dryRun} since=${sinceSpec ?? '(none)'} limit=${limitRows ?? '(none)'}`,
  );

  const todo = onlyTable && onlyTable !== 'all'
    ? TABLE_MAPPINGS.filter(m => m.name === onlyTable)
    : TABLE_MAPPINGS;

  if (!todo.length) {
    console.error(`no mapping matches --table=${onlyTable}`);
    process.exit(2);
  }

  const unmapped = todo.filter(m => m.mysqlTable.startsWith('TODO_'));
  if (unmapped.length > 0 && !dryRun) {
    console.warn(
      `\n⚠  ${unmapped.length} mapping(s) have placeholder mysqlTable names:`,
    );
    for (const u of unmapped) console.warn(`   - ${u.name}`);
    console.warn(
      '   Edit scripts/backfillFromMysql.ts and replace TODO_* with your real table names.\n',
    );
  }

  for (const m of todo) {
    try {
      await backfillOne(m);
    } catch (err) {
      console.error(`[backfill] FAILED ${m.name}:`, err);
      process.exitCode = 1;
    }
  }

  await pg.close();
}

main().catch(async (err) => {
  console.error('[backfill] fatal:', err);
  try { await pg.close(); } catch { /* ignore */ }
  process.exit(2);
});
