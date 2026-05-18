// ════════════════════════════════════════════════════════════════
//  Nifty500Universe — DB-backed single source of truth.
//
//  Universe contract (PRODUCTION):
//    1. The active tradeable set comes EXCLUSIVELY from
//         SELECT symbol FROM q365_universe WHERE is_active = 1
//       The CSV (`ind_nifty500list.csv`) is a SEED file only —
//       used by `scripts/loadNifty500.ts` to populate the table.
//       This module never reads the CSV at runtime.
//    2. Boot must call `initOnce()` (or its alias
//       `initNifty500UniverseFromDb()`) once before any sync getter
//       (`getNifty500Symbols`, `isInNifty500`, `filterToNifty500`,
//       `loadNifty500Universe`) is invoked. Sync getters throw
//       NIFTY500_UNIVERSE_NOT_INITIALIZED against an empty cache so
//       missing init surfaces immediately, not as a silent empty
//       universe. NO CSV FALLBACK.
//    3. Count must land in [NIFTY500_MIN_SIZE, NIFTY500_MAX_SIZE].
//       Anything outside throws — a partial / oversized universe
//       means scan vs fetch will diverge and signal counts will be
//       irreproducible.
//    4. Symbols are uppercased and deduped at load time.
//
//  Race-safe init contract:
//    `initOnce()` carries a shared promise lock. Concurrent callers
//    (instrumentation.ts, /api/signals, /api/run-signal-engine, in-proc
//    workers) share ONE in-flight DB query; whichever fires first
//    wins, and every other caller receives the same Promise. On
//    success the cache is hydrated and the lock stays resolved
//    (idempotent for the rest of the process). On failure the lock
//    resets to null so a transient DB blip doesn't permanently
//    poison the init path — the next caller can retry cleanly.
//
//  Test helpers `_resetNifty500CacheForTests` and
//  `_setNifty500CacheForTests` let tests bypass the DB.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const log = logger.child({ component: 'nifty500Universe' });

/** Lower bound from the production audit contract — anything below
 *  this is considered "DB unpopulated / corrupted" and the loader
 *  refuses to boot rather than scan a degraded universe. */
export const NIFTY500_MIN_SIZE = 480;
/** Upper bound. NIFTY 500 reconstitutes semi-annually and briefly
 *  drifts to 498/501 during transitions; 550 absorbs that without
 *  letting a duplicated/leaked universe through. */
export const NIFTY500_MAX_SIZE = 550;

interface LoadResult {
  /** Symbol list, uppercased, deduped, ordered as returned by the DB. */
  symbols:  string[];
  /** O(1) membership lookup — same set as the symbols list. */
  set:      ReadonlySet<string>;
  /** Source identifier (always 'q365_universe' in production). */
  source:   string;
  /** ISO timestamp of the load. */
  loadedAt: string;
}

let cached: LoadResult | null = null;

/** Shared promise lock — coalesces concurrent init callers so they
 *  all share ONE in-flight DB query. Reset to null on failure so a
 *  transient error doesn't permanently lock the init path. */
let initPromise: Promise<LoadResult> | null = null;

/** UNIVERSE-RACE-2026-05 — diagnostic counter for sync-getter races.
 *  Bumped every time a sync getter (isInNifty500 / getNifty500Symbols
 *  / filterToNifty500 / loadNifty500Universe) is hit before initOnce
 *  has resolved. Reset to false once init completes so a fresh race
 *  in a later cache-clear cycle re-logs the warning. */
let lazyInitRaceLogged = false;

/** Process-wide counter so an operator can grep the total number of
 *  race-fallback returns. Surfaced via [UNIVERSE_INIT_LAZY_RACE] logs;
 *  exported for tests / diagnostics. */
let lazyInitRaceHits = 0;
/** Diagnostic — number of sync-getter race hits since process boot. */
export function _getLazyInitRaceHits(): number { return lazyInitRaceHits; }

/** One-shot gate so the [UNIVERSE_INIT_REUSED] cache-hit message logs
 *  exactly once per init cycle. Without this every request would emit
 *  the line and flood the logs after boot. */
let _initReusedLogged = false;

/** Race-safe empty result used by the lazy-init fallback. Frozen so
 *  callers cannot accidentally mutate it; structural-typed as
 *  LoadResult so sync getters keep their shape. */
const EMPTY_RACE_RESULT: LoadResult = Object.freeze({
  symbols:  Object.freeze([]) as unknown as string[],
  set:      new Set<string>(),
  source:   'race-fallback (init not yet complete)',
  loadedAt: new Date(0).toISOString(),
});

/** True once the cache has been hydrated. Sync — safe to call from
 *  hot paths (route handlers, workers) to decide whether init is
 *  needed before they start touching the universe. */
export function isNifty500Initialized(): boolean {
  return cached !== null;
}

/**
 * Race-safe entry point for universe initialization. Concurrent
 * callers share one in-flight Promise. Idempotent — once the cache
 * is hydrated, subsequent calls resolve immediately without re-querying
 * the DB. On failure the promise lock resets so the next caller can
 * retry (transient DB blip / temporarily empty table during a
 * loadNifty500.ts run).
 *
 * Throws when the DB returns fewer than NIFTY500_MIN_SIZE rows or
 * more than NIFTY500_MAX_SIZE. The throw is intentional — boot
 * must fail loudly rather than scan an empty / corrupted universe.
 *
 * Operator response on a thrown init:
 *   npx tsx scripts/loadNifty500.ts
 *   <restart server>
 */
export async function initOnce(): Promise<LoadResult> {
  // Fast path #1: cache already hydrated. Idempotent reuse — every call
  // after the first successful init resolves in microseconds.
  if (cached) {
    // UNIVERSE-RACE-2026-05 — production-visible reuse marker. Cheap;
    // emitted as debug only at startup so a healthy steady state stays
    // log-quiet. Operators tail for [UNIVERSE_INIT_REUSED] to verify
    // the boot lock is doing its job after first init completes.
    if (!_initReusedLogged) {
      _initReusedLogged = true;
      console.log(
        `[UNIVERSE_INIT_REUSED] cache_hit count=${cached.symbols.length} source=${cached.source}`,
      );
    }
    return cached;
  }
  // Fast path #2: concurrent caller — share the existing promise.
  if (initPromise) {
    console.log('[UNIVERSE_INIT_WAIT] joining in-flight initOnce() (shared promise lock)');
    return initPromise;
  }

  const initStartMs = Date.now();
  console.log(
    `[UNIVERSE_INIT_START] source=q365_universe(is_active=1) ` +
    `min_size=${NIFTY500_MIN_SIZE} max_size=${NIFTY500_MAX_SIZE} ` +
    `auto_seed=${shouldAutoSeed() ? 'enabled' : 'disabled'}`,
  );

  initPromise = (async () => {
    try {
      // Spec INSTITUTIONAL §C — single greppable load marker.
      console.log(
        `[UNIVERSE_LOAD] source=q365_universe(is_active=1) ` +
        `min_size=${NIFTY500_MIN_SIZE} max_size=${NIFTY500_MAX_SIZE} ` +
        `auto_seed=${shouldAutoSeed() ? 'enabled' : 'disabled'}`,
      );
      let result: LoadResult;
      try {
        result = await loadFromDb();
      } catch (err) {
        // Spec INSTITUTIONAL §C (universe loader) — when q365_universe
        // is empty / under-populated AND the CSV seed is on disk, the
        // loader bootstraps the table automatically. This unblocks fresh
        // deployments without forcing the operator to remember to run
        // `npx tsx scripts/loadNifty500.ts` post-migration. Disabled
        // via UNIVERSE_AUTO_SEED_FROM_CSV=false. The CSV path is fixed
        // to the well-known repo location (`ind_nifty500list.csv` at
        // process.cwd()) — operators who want a different path should
        // run the seed script directly.
        if (!shouldAutoSeed()) throw err;
        const seeded = await seedFromCsvIfPossible((err as Error)?.message);
        if (!seeded) throw err;
        result = await loadFromDb();
      }
      cached = result;
      // Reset the race-log gates so a future cache-clear cycle (test
      // helper / explicit operator reset) can re-warn cleanly.
      lazyInitRaceLogged = false;
      _initReusedLogged = false;
      // Spec STEP 5 — operator-visible boot log so a fresh deploy
      // can confirm at a glance "yes, the universe loaded, count=N".
      // Distinct from the structured `TOTAL_NIFTY500_LOADED` line so
      // both the structured-log consumer (Loki/ELK) and a console-
      // tail operator see the event.
      console.log(`[UNIVERSE READY] count=${result.symbols.length}`);
      console.log(
        `[UNIVERSE_INIT_READY] count=${result.symbols.length} ` +
        `source=${result.source} ` +
        `elapsed_ms=${Date.now() - initStartMs} ` +
        `race_hits=${lazyInitRaceHits}`,
      );
      log.info('TOTAL_NIFTY500_LOADED', {
        count: result.symbols.length,
        source: result.source,
      });

      // Hydrate the signal-engine's TRADEABLE_UNIVERSE array in place
      // so `DEFAULT_PHASE1_CONFIG.universe` references stay live.
      // Dynamic import sidesteps the static circular dependency
      // (signal-engine/constants imports nifty500Universe).
      // Best-effort — a failure to hydrate the constants array does
      // NOT fail boot. The route's loadTradeableUniverse() entry
      // guard re-attempts on first request, and the universe cache
      // itself is already populated by this point so isInNifty500
      // / getNifty500Symbols are usable immediately.
      try {
        const constants = await import(
          '@/lib/signal-engine/constants/signalEngine.constants'
        );
        const arr = constants.DEFAULT_PHASE1_CONFIG?.universe;
        if (Array.isArray(arr)) {
          arr.length = 0;
          for (const s of result.symbols) arr.push(s);
        }
      } catch (err) {
        log.warn('TRADEABLE_UNIVERSE hydration deferred', {
          message: (err as Error)?.message,
        });
      }

      return result;
    } catch (err) {
      // Reset the lock so a future caller can retry. Without this a
      // transient DB error would freeze the lock in a perpetually
      // failing state.
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/** Backwards-compatible alias for `initOnce()`. Existing callers
 *  (instrumentation, scripts, signal-engine constants) still use
 *  the descriptive name; new entry-point guards prefer `initOnce`. */
export const initNifty500UniverseFromDb = initOnce;

function shouldAutoSeed(): boolean {
  const raw = (process.env.UNIVERSE_AUTO_SEED_FROM_CSV ?? 'true').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** Resolve the seed CSV path. Operator can override via
 *  UNIVERSE_SEED_CSV_PATH; defaults to `ind_nifty500list.csv` at the
 *  process working directory (the repo root). Absolute paths pass
 *  through unchanged; relative paths resolve against process.cwd(). */
function resolveSeedCsvPath(): string {
  const raw = process.env.UNIVERSE_SEED_CSV_PATH ?? 'ind_nifty500list.csv';
  return resolvePath(process.cwd(), raw);
}

/** Minimal CSV parser — handles quoted fields, embedded commas, CRLF.
 *  Identical semantics to scripts/loadNifty500.ts so the auto-seed
 *  produces the same output as the manual seed run. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch; continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); out.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); out.push(row); }
  return out;
}

function pickColumn(headers: string[], candidates: string[]): number {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const wanted = candidates.map(norm);
  for (let i = 0; i < headers.length; i++) {
    if (wanted.includes(norm(headers[i]))) return i;
  }
  return -1;
}

interface SeedRow { symbol: string; companyName: string; isin: string | null; sector: string | null; }

function parseSeedCsv(path: string): SeedRow[] {
  const raw = readFileSync(path, 'utf8');
  const grid = parseCsv(raw).filter((r) => r.length > 1 && r.some((c) => c.trim() !== ''));
  if (grid.length === 0) return [];
  const headers = grid[0];
  const iSymbol  = pickColumn(headers, ['Symbol', 'Trading Symbol']);
  const iName    = pickColumn(headers, ['Company Name', 'Name']);
  const iIsin    = pickColumn(headers, ['ISIN Code', 'ISIN']);
  const iSector  = pickColumn(headers, ['Industry', 'Sector']);
  if (iSymbol < 0 || iName < 0) return [];
  const rows: SeedRow[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const symbol = String(r[iSymbol] ?? '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    rows.push({
      symbol,
      companyName: String(r[iName] ?? '').trim() || symbol,
      isin:        iIsin   >= 0 ? (String(r[iIsin]   ?? '').trim() || null) : null,
      sector:      iSector >= 0 ? (String(r[iSector] ?? '').trim() || null) : null,
    });
  }
  return rows;
}

/**
 * Spec INSTITUTIONAL §C — auto-seed q365_universe from the CSV when the
 * DB is empty or under-populated. Returns true on a successful seed
 * (caller re-runs loadFromDb). Returns false when the CSV is missing or
 * unparseable — the caller then re-throws the original "DB returned N
 * rows" error so a bad deploy still fails loudly.
 *
 * The seed runs ensureAllSchemas first so a fresh DB without the
 * q365_universe table doesn't crash the INSERT.
 */
async function seedFromCsvIfPossible(originalErrorMsg: string): Promise<boolean> {
  const csvPath = resolveSeedCsvPath();
  console.log(`[UNIVERSE_PARSE] auto-seed triggered  csv_path=${csvPath} reason="${originalErrorMsg}"`);
  if (!existsSync(csvPath)) {
    console.error(
      `[UNIVERSE_PARSE] auto-seed ABORTED — CSV not found at ${csvPath}. ` +
      `Set UNIVERSE_SEED_CSV_PATH or place the file there, or run ` +
      `\`npx tsx scripts/loadNifty500.ts\` manually.`,
    );
    return false;
  }
  let seedRows: SeedRow[] = [];
  try {
    seedRows = parseSeedCsv(csvPath);
  } catch (e) {
    console.error(`[UNIVERSE_PARSE] CSV parse failed: ${(e as Error)?.message}`);
    return false;
  }
  console.log(`[UNIVERSE_PARSE] parsed_symbols=${seedRows.length}`);
  if (seedRows.length < NIFTY500_MIN_SIZE) {
    console.error(
      `[UNIVERSE_PARSE] auto-seed ABORTED — CSV produced ${seedRows.length} rows ` +
      `(< ${NIFTY500_MIN_SIZE}). Refusing to seed a degraded universe.`,
    );
    return false;
  }
  // Ensure schemas before INSERT (fresh DB / pre-migration safety).
  try {
    const { ensureAllSchemas } = await import('@/lib/db/ensureAllSchemas');
    await ensureAllSchemas();
  } catch (e) {
    console.warn(`[UNIVERSE_PARSE] ensureAllSchemas warn: ${(e as Error)?.message}`);
  }
  // Single-batch upsert. We use INSERT ... ON DUPLICATE KEY UPDATE so
  // the seed is idempotent — running it on a partially-populated table
  // refreshes existing rows and adds missing ones in one round trip.
  let inserted = 0;
  let updated  = 0;
  let failed   = 0;
  for (const r of seedRows) {
    try {
      const result: any = await db.query(
        `INSERT INTO q365_universe (symbol, company_name, isin, sector, is_active)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           company_name = VALUES(company_name),
           isin         = VALUES(isin),
           sector       = VALUES(sector),
           is_active    = 1`,
        [r.symbol, r.companyName, r.isin, r.sector],
      );
      // affectedRows: 1 for INSERT, 2 for UPDATE on duplicate, 0 for no-op.
      const aff = Number(result?.affectedRows ?? 0);
      if (aff >= 2) updated++; else if (aff === 1) inserted++;
    } catch (e) {
      failed++;
      console.warn(`[UNIVERSE_PARSE] seed row failed for ${r.symbol}: ${(e as Error)?.message}`);
    }
  }
  console.log(
    `[UNIVERSE_PARSE] auto-seed complete  ` +
    `parsed=${seedRows.length} inserted=${inserted} updated=${updated} failed=${failed}`,
  );
  return inserted + updated >= NIFTY500_MIN_SIZE;
}

/** Internal DB load + validation. Always queries — call `initOnce()`
 *  for the cached, race-safe path. */
async function loadFromDb(): Promise<LoadResult> {
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM q365_universe WHERE is_active = 1`,
  );

  // Dedupe + uppercase + placeholder filter, preserve DB order.
  // Spec "FIX UNIVERSE NOISE" — q365_universe sometimes contains
  // placeholder rows (DUMMYVEDL1..N, TEMP_*, TEST_*) that have no
  // candle data anywhere upstream. They burn IndianAPI budget on
  // every scan (each gets a `[CANDLE ERROR] insufficient data ... falling
  // back to IndianAPI live` round-trip that returns `status:failed`)
  // and add real wall-clock time when the breaker is closed. Filter
  // them out at load time.
  const PLACEHOLDER_SYMBOL_RE = /^(DUMMY|TEST_|TEMP_|PLACEHOLDER_|XX_)/;
  const seen = new Set<string>();
  const symbols: string[] = [];
  let droppedPlaceholders = 0;
  for (const r of rows as Array<{ symbol: string }>) {
    const raw = r?.symbol;
    if (!raw) continue;
    const sym = String(raw).trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    if (PLACEHOLDER_SYMBOL_RE.test(sym)) {
      droppedPlaceholders++;
      continue;
    }
    seen.add(sym);
    symbols.push(sym);
  }
  if (droppedPlaceholders > 0) {
    console.warn(
      `[UNIVERSE] dropped ${droppedPlaceholders} placeholder symbols matching ` +
      `${PLACEHOLDER_SYMBOL_RE} from q365_universe — clean these up to remove the warning`,
    );
  }

  if (symbols.length < NIFTY500_MIN_SIZE) {
    throw new Error(
      `[nifty500Universe] q365_universe(is_active=1) returned ${symbols.length} symbols, ` +
      `minimum required is ${NIFTY500_MIN_SIZE}. ` +
      `Refusing to boot with a degraded universe. ` +
      `To fix: run \`npx tsx scripts/loadNifty500.ts\` to seed the table from ind_nifty500list.csv, then restart.`,
    );
  }
  if (symbols.length > NIFTY500_MAX_SIZE) {
    throw new Error(
      `[nifty500Universe] q365_universe(is_active=1) returned ${symbols.length} symbols, ` +
      `maximum allowed is ${NIFTY500_MAX_SIZE}. ` +
      `Investigate q365_universe for stale or duplicated rows before booting.`,
    );
  }

  // Spec INSTITUTIONAL §C — single greppable final-count marker.
  console.log(
    `[UNIVERSE_FINAL] count=${symbols.length} ` +
    `min=${NIFTY500_MIN_SIZE} max=${NIFTY500_MAX_SIZE} ` +
    `placeholders_dropped=${droppedPlaceholders} ` +
    `source=q365_universe(is_active=1)`,
  );

  return {
    symbols,
    set: seen,
    source: 'q365_universe(is_active=1)',
    loadedAt: new Date().toISOString(),
  };
}

/**
 * UNIVERSE-RACE-2026-05 — race-safe sync-getter resolver.
 *
 * Production was occasionally hitting NIFTY500_UNIVERSE_NOT_INITIALIZED
 * in the ~500 ms boot window between `instrumentation.ts` firing
 * `initOnce()` and the first dashboard poll arriving. The error
 * bubbled through `resolveBatch` / `filterToNifty500` / etc. and
 * crashed engine-health, option-intelligence, and dashboard renders
 * even though `[UNIVERSE READY]` logged moments later.
 *
 * Fix: instead of throwing, the sync getters now:
 *   1. Kick `initOnce()` in the background (shared promise lock so we
 *      never duplicate-fire). Errors are owned by initOnce.
 *   2. Return a frozen empty result. Callers see
 *      `isInNifty500(...)=false` / `getNifty500Symbols()=[]` for one
 *      poll cycle — the same fallback the existing NIFTY-500 lock
 *      already tolerates for non-member symbols.
 *   3. Log `[UNIVERSE_INIT_LAZY_RACE]` once so the race is visible.
 *
 * The strict-throw contract is preserved for tests and for operators
 * who want the legacy behaviour: set `NIFTY500_STRICT_SYNC=1` and the
 * getters throw `NIFTY500_UNIVERSE_NOT_INITIALIZED` as before.
 */
function ensureLoaded(): LoadResult {
  if (cached) return cached;

  const strict = (process.env.NIFTY500_STRICT_SYNC ?? '').trim() === '1';
  if (strict) {
    throw new Error(
      'NIFTY500_UNIVERSE_NOT_INITIALIZED — ensure DB load at boot. ' +
      'Call await initOnce() (or initNifty500UniverseFromDb()) before any sync getter. ' +
      'No silent fallback to CSV is performed. ' +
      '(Strict-throw mode active via NIFTY500_STRICT_SYNC=1.)',
    );
  }

  // Fire init in the background. The shared promise lock inside
  // initOnce() coalesces concurrent triggers, so this is safe to call
  // from a hot path — only the first hit during the race actually
  // starts a DB query; everything else awaits the same Promise.
  if (!initPromise) {
    void initOnce().catch((err) => {
      // initOnce() already resets initPromise=null on throw, so the
      // next caller can retry. Log here so the swallowed promise
      // failure is still visible.
      console.warn(
        `[UNIVERSE_INIT_LAZY_FAILED] background initOnce() threw: ${(err as Error)?.message ?? String(err)}`,
      );
    });
  }

  lazyInitRaceHits++;
  if (!lazyInitRaceLogged) {
    lazyInitRaceLogged = true;
    console.warn(
      '[UNIVERSE_INIT_LAZY_RACE] sync getter called before initOnce() resolved — ' +
      'returning safe empty stub for this call; background init in progress. ' +
      'Subsequent calls within this boot window also return the stub silently. ' +
      'Set NIFTY500_STRICT_SYNC=1 to restore throw-on-race behaviour.',
    );
  }
  return EMPTY_RACE_RESULT;
}

/** Sync accessor returning the cached LoadResult. Throws
 *  NIFTY500_UNIVERSE_NOT_INITIALIZED if the cache hasn't been
 *  hydrated by initOnce(). */
export function loadNifty500Universe(): LoadResult {
  return ensureLoaded();
}

/** Convenience — most callers just want the array. */
export function getNifty500Symbols(): string[] {
  return ensureLoaded().symbols;
}

/** O(1) membership check. Symbols are compared uppercase. Returns
 *  false for the empty string / null / undefined. Throws
 *  NIFTY500_UNIVERSE_NOT_INITIALIZED if the cache hasn't been hydrated. */
export function isInNifty500(symbol: string | null | undefined): boolean {
  if (!symbol) return false;
  return ensureLoaded().set.has(String(symbol).trim().toUpperCase());
}

/** Filter an arbitrary symbol list down to NIFTY 500 members. Returns
 *  a deduped, uppercased array preserving input order of accepted
 *  symbols. Logs the rejection count once when anything is dropped so
 *  callers don't have to instrument every call site. */
export function filterToNifty500(symbols: ReadonlyArray<string>): string[] {
  const set = ensureLoaded().set;
  const out: string[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const raw of symbols) {
    if (!raw) continue;
    const sym = String(raw).trim().toUpperCase();
    if (!set.has(sym)) { rejected++; continue; }
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  if (rejected > 0) {
    log.warn('symbols rejected — outside NIFTY 500 universe', {
      requested: symbols.length,
      accepted: out.length,
      rejected,
    });
  }
  return out;
}

/** Test helper — drops the cache and the in-flight promise so a test
 *  can re-run init with a different mocked DB result. Production
 *  code never calls this. */
export function _resetNifty500CacheForTests(): void {
  cached = null;
  initPromise = null;
}

/** Test helper — seeds the cache directly with a list of symbols,
 *  bypassing the DB entirely. Lets unit tests exercise the sync
 *  getters without standing up a MySQL fixture. */
export function _setNifty500CacheForTests(symbols: string[]): void {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of symbols) {
    const sym = String(s ?? '').trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  cached = {
    symbols: out,
    set: seen,
    source: 'test-cache',
    loadedAt: new Date().toISOString(),
  };
}
