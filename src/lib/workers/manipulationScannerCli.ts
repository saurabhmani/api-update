// ════════════════════════════════════════════════════════════════
//  Manipulation Scanner — CLI entrypoint
//
//  Invoked by PM2 (cron_restart '0 13 * * *') and `npm run
//  manipulation-scan`. Performs the bootstrap that a standalone tsx
//  process needs, then hands off to the pure worker library.
//
//  Why this file exists as a separate module:
//    The library (`manipulationScanner.ts`) is also imported by the
//    Next.js API route `/api/manipulation/run`. Top-level side effects
//    in the library (tsconfig-paths/register, synchronous .env.local
//    reads) break `next build` page-data collection — the build-time
//    evaluator doubles-up on path resolution inside webpack and fails
//    with "Failed to collect page data for /api/manipulation/run".
//
//    Moving the bootstrap into this CLI-only wrapper keeps the library
//    pure. Next.js gets a side-effect-free import; PM2 gets a file
//    that bootstraps env + path aliases before touching any `@/...`
//    import.
//
//  Why explicit require() instead of import:
//    tsconfig.json has `module: esnext`. Under ESM semantics, all
//    `import` statements are hoisted above top-level code, so a
//    conventional `import { runManipulationScan }` would resolve the
//    library (and its `@/lib/db` chain) BEFORE the env loader runs.
//    Using sequential `require()` calls guarantees the bootstrap
//    completes before the library is loaded, regardless of module mode.
// ════════════════════════════════════════════════════════════════

// 1. Register tsconfig path aliases so `@/...` resolves under tsx.
require('tsconfig-paths/register');

// 2. Load .env.local synchronously. PM2 runs this as a standalone tsx
//    process, so Next.js's automatic env loader never fires and
//    DATABASE_URL would otherwise be undefined when db.ts initializes.
//    Prefers DOTENV_CONFIG_PATH (set by ecosystem.config.js) over cwd
//    because PM2's saved cwd can drift from the deploy path after a
//    dump/restore cycle.
const fs = require('fs') as typeof import('fs');
const pathMod = require('path') as typeof import('path');
const envPath = process.env.DOTENV_CONFIG_PATH || pathMod.resolve(process.cwd(), '.env.local');
try {
  const envFile = fs.readFileSync(envPath, 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (err) {
  // Don't swallow silently — if the env file can't be read, the next DB
  // call will throw with a confusing "MYSQL not configured" error. Log
  // the real reason so the operator sees it in pm2 logs.
  console.warn(`[manipulation-scanner] env load failed at ${envPath}: ${(err as Error).message}`);
}

// 3. Now safe to load the library — env + path aliases are ready.
const { runManipulationScan } = require('./manipulationScanner') as
  typeof import('./manipulationScanner');

runManipulationScan()
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.failed > 0 && r.snapshotsPersisted === 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('[manipulation-scanner] fatal:', err);
    process.exit(1);
  });
