// ════════════════════════════════════════════════════════════════
//  ensureSchemasSafely — one call that covers BOTH schema layers
//
//  Problem this solves
//  ────────────────────
//  The app has two schema-ensure entry points:
//    1. ensureAllSchemas()             (src/lib/db/ensureAllSchemas.ts)
//       — core users/portfolio/q365_* tables + market data + alerts
//    2. ensureSignalEngineSchemas()    (src/lib/signal-engine/repository/ensureSchemas.ts)
//       — Phase 3/4 trade plan, position sizing, portfolio fit,
//         execution readiness, risk snapshots, news tables, and the
//         q365_signals additive column migration (portfolio_fit_score,
//         regime_alignment, sector, etc.)
//
//  Different API routes call different subsets. /api/signals calls
//  (2) but not (1); /api/auth calls (1) but not (2); a legacy route
//  that does neither would hit missing tables and Next 14 would
//  surface the error as a generic "reading 'bind'" crash.
//
//  This helper runs BOTH in parallel with per-layer try/catch, so:
//    • A failure in one layer doesn't block the other
//    • Callers can always `await ensureSchemasSafely()` without fear
//      of throwing — the function never rejects
//    • The underlying `_ensured` caches in each module still short-
//      circuit subsequent calls once a clean run has landed
//
//  Idempotent + cheap — after the first successful run each call
//  returns in sub-millisecond time because both layers cache.
// ════════════════════════════════════════════════════════════════

import { ensureAllSchemas } from './ensureAllSchemas';

/**
 * Run every schema-ensure the app knows about, in parallel, swallowing
 * per-layer errors. Safe to call from any route handler's prelude —
 * this function NEVER throws.
 *
 * Returns a summary so callers that care about observability can log it;
 * most callers will just `void ensureSchemasSafely()` or
 * `await ensureSchemasSafely()` and ignore the result.
 */
export interface EnsureSchemasSafelyResult {
  coreOk: boolean;
  signalEngineOk: boolean;
  coreCreated:    number;
  coreFailed:     number;
  coreError?:         string;
  signalEngineError?: string;
}

export async function ensureSchemasSafely(): Promise<EnsureSchemasSafelyResult> {
  const [coreResult, sigResult] = await Promise.allSettled([
    ensureAllSchemas(),
    // Dynamic import so this module has zero load-time dependency on
    // the signal-engine graph — callers outside the signal-engine
    // package (e.g. /api/auth, /api/market/...) don't pay the import
    // cost of the entire engine just to ensure their own tables.
    import('@/lib/signal-engine/repository/ensureSchemas').then(
      (m) => m.ensureSignalEngineSchemas(),
    ),
  ]);

  // ensureAllSchemas catches per-DDL errors internally and returns a
  // counts object — so a "fulfilled" promise does NOT mean success.
  // We have to inspect the count. Treat any DDL failure as not-OK so
  // the CLI exit code and the instrumentation log reflect reality.
  let coreOk = false;
  let coreCreated = 0;
  let coreFailed  = 0;
  let coreError: string | undefined;
  if (coreResult.status === 'fulfilled') {
    coreCreated = coreResult.value.created;
    coreFailed  = coreResult.value.failed;
    coreOk      = coreFailed === 0;
    if (coreFailed > 0) {
      coreError = `${coreFailed} DDL(s) failed — see [ensureAllSchemas] lines above`;
    }
  } else {
    const msg = (coreResult.reason as Error)?.message ?? String(coreResult.reason);
    coreError = msg;
    console.error('[ensureSchemasSafely] core schemas threw:', msg);
  }

  const out: EnsureSchemasSafelyResult = {
    coreOk,
    signalEngineOk: sigResult.status === 'fulfilled',
    coreCreated,
    coreFailed,
    coreError,
  };

  if (sigResult.status === 'rejected') {
    const msg = (sigResult.reason as Error)?.message ?? String(sigResult.reason);
    out.signalEngineError = msg;
    console.error('[ensureSchemasSafely] signal-engine schemas failed:', msg);
  }
  return out;
}
