// ════════════════════════════════════════════════════════════════
//  ensureUniverseReady — entry-point safe-init guard.
//
//  Wraps the universe init pattern the spec mandates at every entry
//  point (/api/signals, /api/run-signal-engine, in-proc workers):
//
//    if (!isNifty500Initialized()) {
//      await initNifty500UniverseFromDb();
//    }
//
//  Plus a single try/catch so a route handler can return a clean 503
//  ("UNIVERSE_NOT_READY") instead of crashing into a generic 500
//  with the NIFTY500_UNIVERSE_NOT_INITIALIZED message in the body.
//
//  Idempotent + race-safe: the underlying `initOnce()` carries a
//  shared promise lock so concurrent callers share one in-flight DB
//  query. Cheap to call at the top of every request handler — once
//  the cache is hydrated this resolves to `{ ok: true }` without
//  touching the DB.
// ════════════════════════════════════════════════════════════════

import {
  isNifty500Initialized,
  initNifty500UniverseFromDb,
} from '@/lib/marketData/nifty500Universe';

export interface UniverseReady {
  ok:    boolean;
  error: string | null;
}

/** Ensure the universe cache is populated before continuing. */
export async function ensureUniverseReady(): Promise<UniverseReady> {
  if (isNifty500Initialized()) return { ok: true, error: null };
  try {
    await initNifty500UniverseFromDb();
    return { ok: true, error: null };
  } catch (err) {
    return {
      ok:    false,
      error: (err as Error)?.message ?? 'universe init failed',
    };
  }
}
