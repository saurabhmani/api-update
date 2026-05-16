// ════════════════════════════════════════════════════════════════
//  PostgreSQL migration runner
//
//  Usage:
//    tsx src/lib/db/postgres/migrate.ts
//
//  (Register in package.json scripts as:
//     "db:migrate:pg": "tsx src/lib/db/postgres/migrate.ts"
//   — this runner does NOT touch package.json itself, per the
//   Phase-2 no-dependency-change rule. Add it manually.)
//
//  Behavior:
//    • Reads migrations/postgres/*.sql in lexical order
//    • Tracks applied versions in ops._migrations (bootstrapped lazily)
//    • Idempotent: re-running is a no-op if every file already applied
//    • Each file runs in its own transaction; a failure aborts the run
//
//  Versioning:
//    Filenames MUST start with a zero-padded numeric prefix
//    (001_*, 002_*, …). The prefix is stored as the version. Never
//    rename or renumber a file once it has been applied to any env.
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Load .env.local before any @/ import that might touch config. Same
// hand-rolled parser the other CLI entry points use (ensureSchemasCli,
// setup.ts, seedUsers.ts) — avoids a dotenv dependency.
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

import { pg } from '../postgres';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../migrations/postgres');

interface MigrationFile {
  version: string;
  filename: string;
  fullpath: string;
  sql: string;
  checksum: string;
}

function discoverMigrations(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations dir not found: ${MIGRATIONS_DIR}`);
  }
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    // Files starting with `_` (e.g. _rollback.sql) are manual-only
    // helpers, not migrations. Skip them silently.
    .filter(f => !f.startsWith('_'))
    .sort()
    .map(filename => {
      const m = filename.match(/^(\d+)_/);
      if (!m) throw new Error(`Migration filename missing numeric prefix: ${filename}`);
      const fullpath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(fullpath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      return { version: m[1], filename, fullpath, sql, checksum };
    });
}

async function ensureMetaTable(): Promise<void> {
  // ops schema is created by 001 — but we need its migrations table
  // to exist before ANY migration runs, so bootstrap it here in a
  // default schema reachable regardless of search_path.
  await pg.query(`
    CREATE SCHEMA IF NOT EXISTS ops;
    CREATE TABLE IF NOT EXISTS ops._migrations (
      version     TEXT        PRIMARY KEY,
      filename    TEXT        NOT NULL,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

interface AppliedRow { version: string; checksum: string; filename: string }

async function getApplied(): Promise<Map<string, AppliedRow>> {
  const { rows } = await pg.query<AppliedRow>(
    `SELECT version, checksum, filename FROM ops._migrations`,
  );
  return new Map(rows.map(r => [r.version, r]));
}

async function applyOne(file: MigrationFile): Promise<void> {
  await pg.tx(async (client) => {
    await client.query(file.sql);
    await client.query(
      `INSERT INTO ops._migrations (version, filename, checksum)
       VALUES ($1, $2, $3)
       ON CONFLICT (version) DO UPDATE SET
         filename   = EXCLUDED.filename,
         checksum   = EXCLUDED.checksum,
         applied_at = NOW()`,
      [file.version, file.filename, file.checksum],
    );
  });
}

async function run(): Promise<void> {
  const started = Date.now();
  console.log(`[migrate:pg] discovering migrations in ${MIGRATIONS_DIR}`);
  const files = discoverMigrations();
  console.log(`[migrate:pg] found ${files.length} files`);

  await ensureMetaTable();
  const applied = await getApplied();

  let appliedCount = 0;
  let drift = 0;
  for (const file of files) {
    const existing = applied.get(file.version);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        drift += 1;
        console.warn(
          `[migrate:pg] ⚠ checksum drift for ${file.filename} — ` +
          `file contents changed since last apply. Create a NEW migration instead of editing.`,
        );
      }
      continue;
    }
    console.log(`[migrate:pg] applying ${file.filename} (v${file.version})`);
    await applyOne(file);
    appliedCount += 1;
  }

  const elapsed = Date.now() - started;
  console.log(
    `[migrate:pg] done — applied=${appliedCount} drift=${drift} ` +
    `total=${files.length} elapsedMs=${elapsed}`,
  );

  if (drift > 0) process.exitCode = 2;
  await pg.close();
}

run().catch(async (err) => {
  console.error('[migrate:pg] FAILED:', err);
  try { await pg.close(); } catch { /* ignore */ }
  process.exit(1);
});
