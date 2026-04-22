/**
 * Quantorus365 — Standalone schema-ensure CLI
 *
 * Runs BOTH ensureAllSchemas (core tables) and ensureSignalEngineSchemas
 * (Phase 3/4 audit + additive q365_signals columns + market_data_daily
 * VIEW) in parallel, prints a summary, and exits.
 *
 * When to use
 * ───────────
 *   • Your app is throwing "reading 'bind'" on production and you
 *     suspect schema drift (missing column / missing table).
 *   • You've just pulled a commit that added new DDL and want to
 *     apply it without waiting for the first API request.
 *   • You want to confirm the server can connect to MySQL and create
 *     tables with the configured user's grants.
 *
 * Usage
 * ─────
 *   npm run db:ensure
 *
 * Exit code
 * ─────────
 *   0 — both layers ensured cleanly
 *   1 — one or both layers reported errors (details in stderr)
 */

import fs from 'fs';
import path from 'path';

// ── Load .env.local without dotenv — same pattern the other CLI
//    entry points (migrate.ts, scheduler.ts, manipulationScannerCli)
//    use so a cold PM2 / tsx process has the MYSQL_* vars set before
//    any @/ import runs.
try {
  const envFile = fs.readFileSync(
    path.resolve(process.cwd(), '.env.local'),
    'utf-8',
  );
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

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log('── Quantorus365 schema ensure ──');
  console.log(`Host:     ${process.env.MYSQL_HOST ?? '(not set)'}`);
  console.log(`Database: ${process.env.MYSQL_DATABASE ?? '(not set)'}`);
  console.log(`User:     ${process.env.MYSQL_USER ?? '(not set)'}`);
  console.log('');

  const { ensureSchemasSafely } = await import('./ensureSchemasSafely');
  const result = await ensureSchemasSafely();
  const elapsed = Date.now() - t0;

  console.log('');
  console.log(`── Summary (${elapsed}ms) ──`);
  console.log(
    `  core schemas:          ${result.coreOk ? '✓ OK' : '✗ FAILED'}` +
    `  (created=${result.coreCreated}, failed=${result.coreFailed})`,
  );
  if (!result.coreOk) console.log(`    error: ${result.coreError}`);
  console.log(`  signal-engine schemas: ${result.signalEngineOk ? '✓ OK' : '✗ FAILED'}`);
  if (!result.signalEngineOk) console.log(`    error: ${result.signalEngineError}`);

  if (result.coreOk && result.signalEngineOk) {
    console.log('\n✓ All schemas ensured. App can boot cleanly.');
    process.exit(0);
  } else {
    console.error(
      '\n✗ One or both schema layers failed — likely the MySQL user ' +
      "doesn't have CREATE / ALTER privileges on the database.",
    );
    console.error(
      '  Fix with: GRANT ALL PRIVILEGES ON <db>.* TO ' +
      "'<user>'@'localhost'; FLUSH PRIVILEGES;",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ensureSchemasCli threw unexpectedly:', err);
  process.exit(2);
});
