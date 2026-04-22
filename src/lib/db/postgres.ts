// ════════════════════════════════════════════════════════════════
//  PostgreSQL connection layer — side-by-side with MySQL
//
//  WHY THIS EXISTS SEPARATELY:
//    The legacy src/lib/db.ts is a MySQL pool with a Postgres-syntax
//    shim layered on top. During the Phase-2 migration we need BOTH
//    databases reachable from the same process so services can be
//    migrated one at a time, validated, and cut over without a big
//    bang. This file is the pure-pg side; it shares the same return
//    shape as `db.query()` so refactors become a one-line import swap.
//
//  ⚠  INSTALL BEFORE FIRST USE:
//      npm install pg @types/pg
//    This is the ONLY dependency change Phase 2 requires. Everything
//    else is additive source code.
//
//  ⚠  PACKAGE.JSON (per the user's constraint this file does NOT
//     modify it — manually add when you cut over):
//       "db:migrate:pg": "tsx src/lib/db/postgres/migrate.ts"
//
//  ENV RESOLUTION (first match wins):
//    1. POSTGRES_URL or DATABASE_URL_PG (connection string)
//    2. DATABASE_URL if it starts with postgres:// or postgresql://
//    3. Discrete PGHOST / PGUSER / PGPASSWORD / PGDATABASE / PGPORT
//
//  All three resolve through getPostgresConfig() — migration scripts
//  share the exact same resolution the pool uses.
// ════════════════════════════════════════════════════════════════

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'postgres' });

// Persist pool across Next.js hot reloads in dev — identical pattern to db.ts.
const g = global as unknown as { __pgPool?: Pool };

export interface PostgresConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

function isPgUrl(url: string | undefined): boolean {
  return !!url && /^postgres(ql)?:\/\//i.test(url);
}

export function getPostgresConfig(): PostgresConfig {
  const url =
    process.env.POSTGRES_URL?.trim() ||
    process.env.DATABASE_URL_PG?.trim() ||
    (isPgUrl(process.env.DATABASE_URL) ? process.env.DATABASE_URL!.trim() : undefined);

  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname?.slice(1) || 'quantorus365',
      ssl: parsed.searchParams.get('sslmode') === 'require' ? true : undefined,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
  }

  const host = process.env.PGHOST?.trim();
  const user = process.env.PGUSER?.trim();
  const database = process.env.PGDATABASE?.trim();
  const password = process.env.PGPASSWORD ?? '';
  const port = Number(process.env.PGPORT ?? 5432);

  if (!host || !user || !database) {
    throw new Error(
      'PostgreSQL connection not configured — set either POSTGRES_URL or ' +
      'PGHOST/PGUSER/PGPASSWORD/PGDATABASE in .env.local',
    );
  }

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: process.env.PGSSL === 'true' || undefined,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
}

export function getPg(): Pool {
  if (!g.__pgPool) {
    // Dynamic require so a `next build` without pg installed doesn't
    // explode at module-eval time. Any path that actually calls getPg()
    // without the module installed gets a clear error.
    //
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let pgMod: typeof import('pg');
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      pgMod = require('pg') as typeof import('pg');
    } catch (err) {
      throw new Error(
        `The 'pg' package is not installed. Run: npm install pg @types/pg`,
      );
    }

    const cfg = getPostgresConfig();
    const pool = new pgMod.Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
      max: cfg.max,
      idleTimeoutMillis: cfg.idleTimeoutMillis,
      connectionTimeoutMillis: cfg.connectionTimeoutMillis,
    });

    pool.on('error', (err) => {
      log.error('idle client error', { error: err.message });
    });

    g.__pgPool = pool;
    log.info('pg pool created', { host: cfg.host, database: cfg.database, max: cfg.max });
  }
  return g.__pgPool;
}

// ── Query surface — mirrors the legacy db.query shape ──────────────

export interface PgResult<T> {
  rows: T[];
  rowCount: number;
  insertId?: number;        // populated when SQL ends with `RETURNING id`
  affectedRows?: number;    // alias of rowCount for parity with MySQL shim
}

export const pg = {
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<PgResult<T>> {
    const pool = getPg();
    const res = await pool.query<T>(text, params as unknown[]);
    const rows = res.rows ?? [];
    const first = rows[0] as Record<string, unknown> | undefined;
    const insertId =
      first && typeof first.id === 'number' ? (first.id as number) :
      first && typeof first.id === 'string' && /^\d+$/.test(first.id) ? Number(first.id) :
      undefined;
    return {
      rows,
      rowCount: res.rowCount ?? rows.length,
      insertId,
      affectedRows: res.rowCount ?? rows.length,
    };
  },

  /** Transactional helper. The callback receives a PoolClient; commit
   *  is automatic unless the callback throws. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getPg().connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  },

  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      await getPg().query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Graceful shutdown — call from process SIGTERM handler. */
  async close(): Promise<void> {
    if (g.__pgPool) {
      await g.__pgPool.end();
      g.__pgPool = undefined;
    }
  },
};

export default pg;
