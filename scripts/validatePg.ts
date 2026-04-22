// ════════════════════════════════════════════════════════════════
//  validatePg.ts — Postgres schema integrity + smoke test
//
//  Run:
//    npm run db:check:pg
//    tsx scripts/validatePg.ts
//    tsx scripts/validatePg.ts --insert        # also insert a test row
//
//  Exits 0 on pass, 1 on any check failure. Safe to run against
//  production; the --insert test uses a sentinel symbol that the
//  script cleans up before it exits.
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

// Load .env.local (same hand-rolled parser as the migrate runner).
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
} catch { /* env optional */ }

import { pg } from '@/lib/db/postgres';

// ── Expected shape ──────────────────────────────────────────────────

const REQUIRED_SCHEMAS = ['auth', 'master', 'market', 'intel', 'app', 'ops'];
const REQUIRED_TABLES: Array<{ schema: string; name: string; tsColumn?: string }> = [
  { schema: 'auth',   name: 'users',                 tsColumn: 'created_at' },
  { schema: 'auth',   name: 'sessions',              tsColumn: 'created_at' },
  { schema: 'auth',   name: 'audit_logs',            tsColumn: 'created_at' },
  { schema: 'master', name: 'instruments',           tsColumn: 'updated_at' },
  { schema: 'master', name: 'sectors' },
  { schema: 'master', name: 'industries' },
  { schema: 'master', name: 'symbol_aliases' },
  { schema: 'market', name: 'snapshots_current',     tsColumn: 'updated_at' },
  { schema: 'market', name: 'snapshots_intraday',    tsColumn: 'ts' },
  { schema: 'market', name: 'candles',               tsColumn: 'ts' },
  { schema: 'market', name: 'historical_stats',      tsColumn: 'computed_at' },
  { schema: 'intel',  name: 'news',                  tsColumn: 'published_at' },
  { schema: 'intel',  name: 'corporate_events',      tsColumn: 'ingested_at' },
  { schema: 'intel',  name: 'announcements',         tsColumn: 'announced_at' },
  { schema: 'intel',  name: 'forecasts',             tsColumn: 'issued_at' },
  { schema: 'intel',  name: 'target_prices',         tsColumn: 'issued_at' },
  { schema: 'intel',  name: 'statements',            tsColumn: 'reported_at' },
  { schema: 'app',    name: 'watchlists',            tsColumn: 'updated_at' },
  { schema: 'app',    name: 'portfolios',            tsColumn: 'updated_at' },
  { schema: 'app',    name: 'portfolio_holdings',    tsColumn: 'updated_at' },
  { schema: 'app',    name: 'alerts',                tsColumn: 'updated_at' },
  { schema: 'app',    name: 'reports',               tsColumn: 'generated_at' },
  { schema: 'ops',    name: 'scheduler_runs',        tsColumn: 'started_at' },
  { schema: 'ops',    name: 'provider_health_logs',  tsColumn: 'created_at' },
  { schema: 'ops',    name: 'dead_letter_events',    tsColumn: 'created_at' },
  { schema: 'ops',    name: 'audit_raw_payloads',    tsColumn: 'fetched_at' },
];

const INSERT_MODE = process.argv.includes('--insert');
const TEST_SYMBOL = '__VALIDATE_PG_TEST__';

// ── Individual checks ───────────────────────────────────────────────

let failures = 0;
const fail = (msg: string) => { console.log(`  FAIL — ${msg}`); failures += 1; };
const ok   = (msg: string) => console.log(`  OK   — ${msg}`);

async function checkSchemas(): Promise<void> {
  console.log('\n── schemas ──');
  const { rows } = await pg.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name = ANY($1::text[])`,
    [REQUIRED_SCHEMAS],
  );
  const present = new Set(rows.map(r => r.schema_name));
  for (const s of REQUIRED_SCHEMAS) {
    if (present.has(s)) ok(`schema ${s} present`);
    else                fail(`schema ${s} MISSING`);
  }
}

async function checkTables(): Promise<void> {
  console.log('\n── tables ──');
  const { rows } = await pg.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = ANY($1::text[])`,
    [REQUIRED_SCHEMAS],
  );
  const present = new Set(rows.map(r => `${r.table_schema}.${r.table_name}`));
  for (const t of REQUIRED_TABLES) {
    const key = `${t.schema}.${t.name}`;
    if (present.has(key)) ok(`table ${key}`);
    else                  fail(`table ${key} MISSING`);
  }
}

async function checkRowCountsAndTimestamps(): Promise<void> {
  console.log('\n── row counts + latest timestamps ──');
  for (const t of REQUIRED_TABLES) {
    const qualified = `${t.schema}.${t.name}`;
    try {
      const countRes = await pg.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${qualified}`);
      const count = Number(countRes.rows[0]?.c ?? 0);
      let latest = '—';
      if (t.tsColumn && count > 0) {
        const tsRes = await pg.query<{ t: string | null }>(
          `SELECT MAX(${t.tsColumn})::text AS t FROM ${qualified}`,
        );
        latest = tsRes.rows[0]?.t ?? '—';
      }
      ok(`${qualified.padEnd(36)} rows=${String(count).padStart(8)} latest=${latest}`);
    } catch (err) {
      fail(`${qualified} query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function checkMigrationsTable(): Promise<void> {
  console.log('\n── ops._migrations (tracking) ──');
  try {
    const { rows } = await pg.query<{ version: string; filename: string; applied_at: string }>(
      `SELECT version, filename, applied_at::text FROM ops._migrations ORDER BY version ASC`,
    );
    if (rows.length === 0) {
      fail('ops._migrations is empty — runner has not been executed yet');
      return;
    }
    for (const r of rows) ok(`applied v${r.version} (${r.filename}) at ${r.applied_at}`);
  } catch (err) {
    fail(`ops._migrations unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function smokeTestUpsertAndJsonb(): Promise<void> {
  if (!INSERT_MODE) return;
  console.log('\n── smoke test: UPSERT + JSONB round-trip ──');

  // UPSERT into market.snapshots_current — tests ON CONFLICT DO UPDATE
  // plus TIMESTAMPTZ + NUMERIC round-trip.
  const upsert = `
    INSERT INTO market.snapshots_current
      (symbol, price, prev_close, change, change_percent,
       open, high, low, volume, source, data_quality,
       fetched_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
    ON CONFLICT (symbol) DO UPDATE SET
      price          = EXCLUDED.price,
      prev_close     = EXCLUDED.prev_close,
      change         = EXCLUDED.change,
      change_percent = EXCLUDED.change_percent,
      volume         = EXCLUDED.volume,
      fetched_at     = EXCLUDED.fetched_at,
      updated_at     = NOW()
    RETURNING symbol, price::text AS price, fetched_at::text AS fetched_at
  `;
  const ins = await pg.query<{ symbol: string; price: string; fetched_at: string }>(
    upsert,
    [TEST_SYMBOL, 1234.56, 1200.00, 34.56, 2.88,
     1220.00, 1250.00, 1215.00, 987654,
     'db', 'live'],
  );
  if (ins.rows[0]?.symbol === TEST_SYMBOL) ok(`UPSERT insert OK (price=${ins.rows[0].price})`);
  else fail('UPSERT insert did not return the expected row');

  // Run the same UPSERT again with a different price to confirm the
  // UPDATE branch actually fires.
  const upd = await pg.query<{ price: string }>(
    upsert,
    [TEST_SYMBOL, 9999.99, 1200.00, 8799.99, 733.33,
     1220.00, 9999.99, 1215.00, 987654,
     'db', 'live'],
  );
  if (Number(upd.rows[0]?.price) === 9999.99) ok('UPSERT update branch OK');
  else fail(`UPSERT update branch expected 9999.99, got ${upd.rows[0]?.price}`);

  // JSONB round-trip via ops.scheduler_runs.by_source.
  const jsonPayload = { indian: 5, cache: 2, yahoo: 1, db: 0 };
  await pg.query(
    `INSERT INTO ops.scheduler_runs (label, started_at, by_source) VALUES ($1, NOW(), $2::jsonb)`,
    [`__validatePg__ ${new Date().toISOString()}`, JSON.stringify(jsonPayload)],
  );
  const { rows: jsonRows } = await pg.query<{ by_source: unknown }>(
    `SELECT by_source FROM ops.scheduler_runs WHERE label LIKE '__validatePg__%' ORDER BY started_at DESC LIMIT 1`,
  );
  const roundtrip = jsonRows[0]?.by_source as Record<string, number> | undefined;
  if (roundtrip && roundtrip.indian === 5 && roundtrip.cache === 2) ok('JSONB round-trip OK');
  else fail(`JSONB round-trip failed — got ${JSON.stringify(roundtrip)}`);

  // Cleanup sentinel rows.
  await pg.query(`DELETE FROM market.snapshots_current WHERE symbol = $1`, [TEST_SYMBOL]);
  await pg.query(`DELETE FROM ops.scheduler_runs WHERE label LIKE '__validatePg__%'`);
  ok('sentinel rows cleaned up');
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('── validatePg.ts ──');
  console.log(`host=${process.env.PGHOST ?? '(unset)'} db=${process.env.PGDATABASE ?? '(unset)'} insert=${INSERT_MODE}`);

  await checkSchemas();
  await checkTables();
  await checkRowCountsAndTimestamps();
  await checkMigrationsTable();
  await smokeTestUpsertAndJsonb();

  console.log(`\n[validatePg] done — failures=${failures}`);
  await pg.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[validatePg] fatal:', err);
  try { await pg.close(); } catch { /* ignore */ }
  process.exit(1);
});
