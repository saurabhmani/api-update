// ════════════════════════════════════════════════════════════════
//  validateData.ts — live-data consistency check (MySQL ↔ Postgres)
//
//  Focuses on `market.snapshots_current` during the dual-write
//  window. For each symbol present in Postgres, look up the same
//  symbol in the MySQL target table and compare:
//    • price          (within tolerance)
//    • change_percent (within tolerance)
//    • volume         (absolute equality; discrepancies rare)
//    • fetched_at     (within 2 minutes — both should be recent)
//
//  Usage:
//    tsx scripts/validateData.ts                     # full sweep
//    tsx scripts/validateData.ts --symbol=RELIANCE   # one symbol
//    tsx scripts/validateData.ts --since=30m         # only rows updated in last 30min
//    tsx scripts/validateData.ts --limit=50          # cap sampled symbols
//
//  Reads MYSQL_DUAL_WRITE_TABLE from env — if unset, script exits 0
//  with a message ("dual-write not configured"). That way the job
//  is CI-safe before the operator picks the target table.
//
//  Exit codes:
//    0 — all checked symbols matched (or dual-write disabled)
//    1 — at least one mismatch
//    2 — config / connectivity error
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
} catch { /* optional */ }

import { pg } from '@/lib/db/postgres';
import { db as mysql } from '@/lib/db';

// ── Args ───────────────────────────────────────────────────────────

const argv = new Map(process.argv.slice(2).map(a => {
  const [k, v = 'true'] = a.replace(/^--/, '').split('=');
  return [k, v];
}));

const targetSymbol = argv.get('symbol')?.toUpperCase();
const sinceSpec = argv.get('since') ?? '60m';
const limit = Number(argv.get('limit') ?? '200');

const MYSQL_TABLE = process.env.MYSQL_DUAL_WRITE_TABLE?.trim() || null;

// ── Time-window parsing ────────────────────────────────────────────

function parseSince(spec: string): number {
  // Returns seconds of lookback. Accepts: "30m", "2h", "45", "1d".
  const m = spec.match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`invalid --since: ${spec}`);
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mul: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return n * (mul[unit] ?? 1);
}

const sinceSec = parseSince(sinceSpec);

// ── Fetchers ───────────────────────────────────────────────────────

interface SnapshotRow {
  symbol: string;
  price: number;
  change_percent: number;
  volume: number;
  fetched_at_ms: number;
}

async function pgSnapshots(): Promise<SnapshotRow[]> {
  const where = [`updated_at >= NOW() - ($1::int || ' seconds')::interval`];
  const params: unknown[] = [sinceSec];
  if (targetSymbol) {
    where.push(`symbol = $${params.length + 1}`);
    params.push(targetSymbol);
  }
  const sql = `
    SELECT symbol,
           price::float8          AS price,
           change_percent::float8 AS change_percent,
           volume::bigint         AS volume,
           (EXTRACT(EPOCH FROM fetched_at) * 1000)::bigint AS fetched_at_ms
      FROM market.snapshots_current
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT $${params.length + 1}
  `;
  params.push(limit);
  const { rows } = await pg.query<{
    symbol: string; price: number; change_percent: number; volume: string; fetched_at_ms: string;
  }>(sql, params);
  return rows.map(r => ({
    symbol: r.symbol,
    price: Number(r.price),
    change_percent: Number(r.change_percent),
    volume: Number(r.volume),
    fetched_at_ms: Number(r.fetched_at_ms),
  }));
}

async function mysqlSnapshot(symbol: string): Promise<SnapshotRow | null> {
  if (!MYSQL_TABLE) return null;
  // Column names match the default shape produced by
  // dualWriteSnapshotRepo.buildDefaultMysqlUpsert. If your MYSQL_DUAL_WRITE_SQL
  // diverges, adjust this query accordingly.
  const sql = `
    SELECT symbol,
           price                   AS price,
           change_percent          AS change_percent,
           volume                  AS volume,
           UNIX_TIMESTAMP(fetched_at) * 1000 AS fetched_at_ms
      FROM \`${MYSQL_TABLE}\`
     WHERE symbol = ?
     LIMIT 1
  `;
  const { rows } = await mysql.query<{
    symbol: string; price: number; change_percent: number; volume: number; fetched_at_ms: number;
  }>(sql, [symbol]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    symbol: r.symbol,
    price: Number(r.price),
    change_percent: Number(r.change_percent),
    volume: Number(r.volume),
    fetched_at_ms: Number(r.fetched_at_ms),
  };
}

// ── Comparison ─────────────────────────────────────────────────────

interface Mismatch {
  symbol: string;
  field: string;
  pg: unknown;
  mysql: unknown;
  delta?: number;
}

function compare(p: SnapshotRow, m: SnapshotRow): Mismatch[] {
  const out: Mismatch[] = [];
  const priceTol = 0.01;                  // 1 paisa
  const pctTol   = 0.05;                  // 5 bps
  const tsTol    = 2 * 60 * 1000;         // 2 minutes

  if (Math.abs(p.price - m.price) > priceTol) {
    out.push({ symbol: p.symbol, field: 'price', pg: p.price, mysql: m.price, delta: p.price - m.price });
  }
  if (Math.abs(p.change_percent - m.change_percent) > pctTol) {
    out.push({ symbol: p.symbol, field: 'change_percent', pg: p.change_percent, mysql: m.change_percent });
  }
  if (p.volume !== m.volume) {
    out.push({ symbol: p.symbol, field: 'volume', pg: p.volume, mysql: m.volume });
  }
  if (Math.abs(p.fetched_at_ms - m.fetched_at_ms) > tsTol) {
    out.push({ symbol: p.symbol, field: 'fetched_at', pg: new Date(p.fetched_at_ms).toISOString(), mysql: new Date(m.fetched_at_ms).toISOString() });
  }
  return out;
}

// ── Runner ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('── validateData.ts ──');
  console.log(`since=${sinceSpec} (${sinceSec}s) limit=${limit} symbol=${targetSymbol ?? '(all)'}`);
  console.log(`MYSQL_DUAL_WRITE_TABLE=${MYSQL_TABLE ?? '(unset)'}`);

  if (!MYSQL_TABLE) {
    console.log('\n[validateData] dual-write not configured — nothing to compare. Exiting OK.');
    await pg.close();
    process.exit(0);
  }

  const pgRows = await pgSnapshots();
  console.log(`\n[validateData] sampled ${pgRows.length} rows from Postgres.`);

  let checked = 0;
  let missingInMysql = 0;
  const mismatches: Mismatch[] = [];

  for (const p of pgRows) {
    const m = await mysqlSnapshot(p.symbol);
    checked += 1;
    if (!m) { missingInMysql += 1; continue; }
    mismatches.push(...compare(p, m));
  }

  console.log(`\n── summary ──`);
  console.log(`  checked:           ${checked}`);
  console.log(`  missing_in_mysql:  ${missingInMysql}`);
  console.log(`  field_mismatches:  ${mismatches.length}`);

  if (mismatches.length > 0) {
    console.log('\nSample mismatches (first 20):');
    for (const m of mismatches.slice(0, 20)) {
      const delta = m.delta !== undefined ? ` Δ=${m.delta}` : '';
      console.log(`  ${m.symbol.padEnd(12)} ${m.field.padEnd(16)} pg=${m.pg}   mysql=${m.mysql}${delta}`);
    }
  }

  await pg.close();
  process.exit(mismatches.length + missingInMysql > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[validateData] fatal:', err);
  try { await pg.close(); } catch { /* ignore */ }
  process.exit(2);
});
