/**
 * Regression: rankings ↔ q365_signals ticker JOIN must not mix collations.
 *
 * Against a live MySQL (MYSQL_* in env): runs normalize + the exact join
 * that previously raised errno 1267, and asserts table collations.
 * Without DB credentials the structural contract tests still run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

const hasMysql =
  Boolean(process.env.MYSQL_HOST?.trim()) &&
  Boolean(process.env.MYSQL_DATABASE?.trim()) &&
  Boolean(process.env.MYSQL_USER?.trim());

describe('ticker collation contract (offline)', () => {
  it('migration 015 documents rankings + instruments unicode_ci convert', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'migrations/mysql/015_align_rankings_instruments_collation.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ALTER TABLE rankings/i);
    expect(sql).toMatch(/ALTER TABLE instruments/i);
    expect(sql).toMatch(/utf8mb4_unicode_ci/);
    expect(sql).toMatch(/CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/);
  });

  it('fetchFromMySQL joins rankings.instrument_key to q365_signals.instrument_key', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/rankingsService.ts'),
      'utf8',
    );
    expect(src).toMatch(/LEFT JOIN instruments i/);
    expect(src).toMatch(/FROM q365_signals/);
    expect(src).toMatch(/s\.instrument_key\s*=\s*r\.instrument_key/);
  });

  it('CREATE TABLE definitions pin unicode_ci for rankings and instruments', () => {
    const setup = readFileSync(
      resolve(process.cwd(), 'src/lib/db/setup.ts'),
      'utf8',
    );
    const migrate = readFileSync(
      resolve(process.cwd(), 'src/lib/db/migrate.ts'),
      'utf8',
    );
    expect(setup).toMatch(
      /CREATE TABLE IF NOT EXISTS rankings[\s\S]*COLLATE=utf8mb4_unicode_ci/,
    );
    expect(setup).toMatch(
      /CREATE TABLE IF NOT EXISTS instruments[\s\S]*COLLATE=utf8mb4_unicode_ci/,
    );
    expect(migrate).toMatch(
      /CREATE TABLE IF NOT EXISTS rankings[\s\S]*COLLATE=utf8mb4_unicode_ci/,
    );
    expect(migrate).toMatch(
      /CREATE TABLE IF NOT EXISTS instruments[\s\S]*COLLATE=utf8mb4_unicode_ci/,
    );
  });
});

describe.runIf(hasMysql)('ticker collation (live MySQL)', () => {
  beforeAll(async () => {
    const { config } = await import('dotenv');
    config({ path: '.env.local' });
    // Reset pool so SET NAMES from getDb() applies with fresh env.
    delete (global as any).__mysqlPool;
    const { normalizeTickerCollations } = await import(
      '@/lib/db/normalizeTickerCollations'
    );
    await normalizeTickerCollations();
  });

  it('rankings and instruments use utf8mb4_unicode_ci', async () => {
    const { db } = await import('@/lib/db');
    const { rows } = await db.query<{ TABLE_NAME: string; TABLE_COLLATION: string }>(
      `SELECT TABLE_NAME, TABLE_COLLATION
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('rankings', 'instruments', 'q365_signals')
        ORDER BY TABLE_NAME`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.TABLE_NAME, r.TABLE_COLLATION]));
    expect(byName.rankings).toBe('utf8mb4_unicode_ci');
    expect(byName.instruments).toBe('utf8mb4_unicode_ci');
    expect(byName.q365_signals).toBe('utf8mb4_unicode_ci');
  });

  it('ticker join on instrument_key executes without errno 1267', async () => {
    const { db } = await import('@/lib/db');
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM rankings r
         LEFT JOIN q365_signals s
           ON s.instrument_key = r.instrument_key
        LIMIT 1`,
    );
    expect(Number(rows[0]?.c)).toBeGreaterThanOrEqual(0);
  });

  it('windowed rankings↔instruments↔signals equality uses aligned collations', async () => {
    const { db } = await import('@/lib/db');
    // Bound work: only top-scoring rankings rows, still the same '=' ops as fetchFromMySQL.
    const { rows } = await db.query(
      `SELECT r.tradingsymbol AS symbol,
              COALESCE(r.instrument_key, CONCAT('NSE_EQ|', r.tradingsymbol)) AS instrument_key
         FROM (
           SELECT rankings.*,
                  ROW_NUMBER() OVER (PARTITION BY tradingsymbol ORDER BY score DESC) AS rn
             FROM rankings
            ORDER BY score DESC
            LIMIT 20
         ) r
         LEFT JOIN instruments i
           ON i.tradingsymbol = r.tradingsymbol
          AND (r.exchange IS NULL OR i.exchange = r.exchange OR i.exchange IS NULL)
         LEFT JOIN q365_signals s
           ON s.instrument_key = r.instrument_key
          AND s.status IN ('active', 'flagged')
        WHERE r.rn = 1
        LIMIT 5`,
    );
    expect(Array.isArray(rows)).toBe(true);
    for (const row of rows as Array<{ symbol?: string; instrument_key?: string }>) {
      expect(String(row.symbol || '')).toBeTruthy();
      if (row.instrument_key) {
        expect(String(row.instrument_key)).toMatch(/\|/);
      }
    }
  });
});
