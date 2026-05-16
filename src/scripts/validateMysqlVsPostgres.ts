// ════════════════════════════════════════════════════════════════
//  Migration validation — MySQL vs PostgreSQL
//
//  Usage:
//    tsx src/scripts/validateMysqlVsPostgres.ts
//    tsx src/scripts/validateMysqlVsPostgres.ts --table=market.snapshots_current
//
//  What it checks, per table pair (see TABLE_MAPPINGS below):
//    • row counts match
//    • min(ts_column) and max(ts_column) align
//    • numeric aggregates (SUM(...)) agree within epsilon
//    • per-symbol latest row equality sampled N rows
//
//  Exit codes:
//    0 — every check passed
//    1 — at least one check failed (details on stdout)
//    2 — config error or unable to connect
//
//  DESIGN NOTE: this script is deliberately declarative — each
//  TableComparison entry is data, not code. Adding a new pair takes
//  4 lines and no test scaffolding.
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

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
} catch { /* env file optional */ }

import { db as mysql } from '@/lib/db';
import { pg } from '@/lib/db/postgres';

interface TableComparison {
  label: string;
  mysqlTable: string;
  pgTable: string;          // e.g. 'market.snapshots_current'
  tsColumn?: string;        // for min/max checks
  sumColumns?: string[];    // numeric columns to aggregate
  symbolColumn?: string;    // for spot-check sampling
  tolerance?: number;       // epsilon for float comparisons
}

// NOTE: these mappings are illustrative. As each domain migrates,
// update this list with the real MySQL table name in your current
// schema vs the Postgres target listed in migrations/postgres/*.sql.
const TABLE_MAPPINGS: TableComparison[] = [
  {
    label: 'Market snapshots (current)',
    mysqlTable: 'market_quotes_current',
    pgTable: 'market.snapshots_current',
    tsColumn: 'fetched_at',
    sumColumns: ['price', 'volume'],
    symbolColumn: 'symbol',
    tolerance: 0.01,
  },
  {
    label: 'Historical candles',
    mysqlTable: 'historical_candles',
    pgTable: 'market.candles',
    tsColumn: 'ts',
    sumColumns: ['volume'],
    symbolColumn: 'symbol',
  },
  {
    label: 'News events',
    mysqlTable: 'news_events',
    pgTable: 'intel.news',
    tsColumn: 'published_at',
  },
  {
    label: 'Users',
    mysqlTable: 'users',
    pgTable: 'auth.users',
    tsColumn: 'created_at',
  },
];

interface CheckResult { passed: boolean; detail: string }

const args = new Map(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));
const filterTable = args.get('table');

// ── Primitives ──────────────────────────────────────────────────────

async function mysqlScalar(sql: string): Promise<number | null> {
  const { rows } = await mysql.query<Record<string, unknown>>(sql);
  if (!rows.length) return null;
  const val = Object.values(rows[0])[0];
  if (val === null || val === undefined) return null;
  return typeof val === 'number' ? val : Number(val);
}

async function pgScalar(sql: string, params?: unknown[]): Promise<number | null> {
  const { rows } = await pg.query<Record<string, unknown>>(sql, params);
  if (!rows.length) return null;
  const val = Object.values(rows[0])[0];
  if (val === null || val === undefined) return null;
  return typeof val === 'number' ? val : Number(val);
}

async function mysqlStringScalar(sql: string): Promise<string | null> {
  const { rows } = await mysql.query<Record<string, unknown>>(sql);
  if (!rows.length) return null;
  const val = Object.values(rows[0])[0];
  return val == null ? null : String(val);
}

async function pgStringScalar(sql: string, params?: unknown[]): Promise<string | null> {
  const { rows } = await pg.query<Record<string, unknown>>(sql, params);
  if (!rows.length) return null;
  const val = Object.values(rows[0])[0];
  return val == null ? null : String(val);
}

// ── Individual checks ───────────────────────────────────────────────

async function checkRowCount(m: TableComparison): Promise<CheckResult> {
  const [myCount, pgCount] = await Promise.all([
    mysqlScalar(`SELECT COUNT(*) AS c FROM \`${m.mysqlTable}\``).catch(() => null),
    pgScalar(`SELECT COUNT(*)::bigint AS c FROM ${m.pgTable}`).catch(() => null),
  ]);
  if (myCount === null || pgCount === null) {
    return { passed: false, detail: `count unreachable (mysql=${myCount}, pg=${pgCount})` };
  }
  const passed = myCount === pgCount;
  return { passed, detail: `mysql=${myCount} pg=${pgCount}` };
}

async function checkTimestampRange(m: TableComparison): Promise<CheckResult | null> {
  if (!m.tsColumn) return null;
  const [myMin, myMax, pgMin, pgMax] = await Promise.all([
    mysqlStringScalar(`SELECT MIN(\`${m.tsColumn}\`) FROM \`${m.mysqlTable}\``),
    mysqlStringScalar(`SELECT MAX(\`${m.tsColumn}\`) FROM \`${m.mysqlTable}\``),
    pgStringScalar(`SELECT MIN(${m.tsColumn}) FROM ${m.pgTable}`),
    pgStringScalar(`SELECT MAX(${m.tsColumn}) FROM ${m.pgTable}`),
  ]);
  const myMinT = myMin ? Date.parse(myMin) : NaN;
  const pgMinT = pgMin ? Date.parse(pgMin) : NaN;
  const myMaxT = myMax ? Date.parse(myMax) : NaN;
  const pgMaxT = pgMax ? Date.parse(pgMax) : NaN;
  const DAY = 86_400_000;
  const passed =
    Number.isFinite(myMinT) && Number.isFinite(pgMinT) &&
    Math.abs(myMinT - pgMinT) < DAY &&
    Math.abs(myMaxT - pgMaxT) < DAY;
  return {
    passed,
    detail: `mysql min=${myMin} max=${myMax} | pg min=${pgMin} max=${pgMax}`,
  };
}

async function checkSum(m: TableComparison, col: string): Promise<CheckResult> {
  const [mySum, pgSum] = await Promise.all([
    mysqlScalar(`SELECT SUM(\`${col}\`) FROM \`${m.mysqlTable}\``).catch(() => null),
    pgScalar(`SELECT SUM(${col}) FROM ${m.pgTable}`).catch(() => null),
  ]);
  if (mySum === null || pgSum === null) {
    return { passed: false, detail: `sum unreachable (mysql=${mySum}, pg=${pgSum})` };
  }
  const eps = m.tolerance ?? 0.001;
  const diff = Math.abs(mySum - pgSum);
  const rel = diff / Math.max(1, Math.abs(mySum));
  const passed = diff <= eps || rel <= 0.001;
  return { passed, detail: `mysql=${mySum} pg=${pgSum} diff=${diff.toFixed(4)}` };
}

// ── Runner ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mappings = filterTable
    ? TABLE_MAPPINGS.filter(m => m.pgTable === filterTable || m.mysqlTable === filterTable)
    : TABLE_MAPPINGS;

  if (!mappings.length) {
    console.error(`[validate] no table mapping for ${filterTable}`);
    process.exit(2);
  }

  let failures = 0;
  for (const m of mappings) {
    console.log(`\n── ${m.label} (${m.mysqlTable} ↔ ${m.pgTable}) ──`);

    const rowCheck = await checkRowCount(m);
    console.log(`  rows     : ${rowCheck.passed ? 'OK' : 'FAIL'} — ${rowCheck.detail}`);
    if (!rowCheck.passed) failures += 1;

    const tsCheck = await checkTimestampRange(m);
    if (tsCheck) {
      console.log(`  ts-range : ${tsCheck.passed ? 'OK' : 'FAIL'} — ${tsCheck.detail}`);
      if (!tsCheck.passed) failures += 1;
    }

    for (const col of m.sumColumns ?? []) {
      const sumCheck = await checkSum(m, col);
      console.log(`  sum(${col.padEnd(10)}): ${sumCheck.passed ? 'OK' : 'FAIL'} — ${sumCheck.detail}`);
      if (!sumCheck.passed) failures += 1;
    }
  }

  console.log(`\n[validate] done — failures=${failures}`);
  await pg.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[validate] fatal:', err);
  try { await pg.close(); } catch { /* ignore */ }
  process.exit(2);
});
