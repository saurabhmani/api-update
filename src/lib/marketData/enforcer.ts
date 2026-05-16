// ════════════════════════════════════════════════════════════════
//  Provider-enforcement tripwire
//
//  PURPOSE:
//    Catch any code path that calls Kite / Yahoo / a direct fetcher // @deprecated marker
//    without going through MarketDataProvider. Acts as a regression
//    guardrail during Phase-1 Tier-0 cleanup so we don't introduce
//    new direct callers while we migrate the existing ones.
//
//  MECHANISM:
//    Provider adapters wrap their upstream calls in
//    `withProviderFrame(...)`. That sets a thread-local flag via
//    AsyncLocalStorage for the duration of the call. Any module on
//    the other side (yahoo.ts, priceCache.ts, resolver.ts, // @deprecated marker
//    getLivePrice.ts) calls `assertProviderFrame('<api>')` at the
//    top of its public entry points. When the flag IS set, the
//    call is legitimate; when it isn't, the enforcer acts.
//
//  MODES (env: ENFORCE_PROVIDER):
//    unset / 'off'   → silent (default — ship safely in prod)
//    'warn'          → console.warn per violation, counts kept
//    'throw'         → throws ProviderBypassError (use in CI/tests)
//
//  WHY THIS SHAPE:
//    No decorator magic. No monkey-patching of existing modules.
//    Wiring into a legacy module is exactly one line at function top.
//    AsyncLocalStorage is the only way to thread caller context
//    through arbitrary promise chains without explicit arg passing.
// ════════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';

type Mode = 'off' | 'warn' | 'throw';

function readMode(): Mode {
  const raw = (process.env.ENFORCE_PROVIDER ?? '').toLowerCase().trim();
  if (raw === 'throw' || raw === '1' || raw === 'true') return 'throw';
  if (raw === 'warn') return 'warn';
  return 'off';
}

interface Frame { via: 'provider'; at: number }
const als = new AsyncLocalStorage<Frame>();

export class ProviderBypassError extends Error {
  constructor(public readonly api: string, public readonly stack0: string) {
    super(
      `Direct call to "${api}" bypassed MarketDataProvider. Route through ` +
      `src/providers/MarketDataProvider.ts instead.`,
    );
    this.name = 'ProviderBypassError';
  }
}

// In-process counters — exposed via getViolations() for health
// dashboards and for tests to assert "0 bypasses after refactor".
const violations = new Map<string, { count: number; lastAt: number; lastStack?: string }>();

export function getViolations(): Array<{ api: string; count: number; lastAt: number; lastStack?: string }> {
  return [...violations.entries()].map(([api, v]) => ({ api, ...v }));
}

export function resetViolations(): void {
  violations.clear();
}

/** Adapter-side helper: run `fn` inside a provider frame so any
 *  downstream `assertProviderFrame` call sees the flag set. */
export function withProviderFrame<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ via: 'provider', at: Date.now() }, fn);
}

/** Synchronous variant — rare but useful for chart utilities that
 *  compose provider calls without awaiting inside. */
export function withProviderFrameSync<T>(fn: () => T): T {
  return als.run({ via: 'provider', at: Date.now() }, fn);
}

/** Called by LEGACY target modules at the top of their entry points.
 *  In `off` mode this is essentially free (one ALS lookup). */
export function assertProviderFrame(api: string): void {
  if (als.getStore()) return;                   // legitimate: inside provider frame

  const mode = readMode();
  if (mode === 'off') return;

  // Grab a short stack excerpt — enough to identify the offending
  // file at the violation site without flooding logs.
  const stack = new Error().stack?.split('\n').slice(2, 6).join('\n') ?? '';

  const record = violations.get(api) ?? { count: 0, lastAt: 0 };
  record.count += 1;
  record.lastAt = Date.now();
  record.lastStack = stack;
  violations.set(api, record);

  if (mode === 'throw') {
    throw new ProviderBypassError(api, stack);
  }

  // warn mode — one line per violation so grep works, plus the stack.
  // eslint-disable-next-line no-console
  console.warn(
    `[provider-enforcer] BYPASS api=${api} count=${record.count}\n${stack}`,
  );
}

/** Test helper: tell the enforcer this call is authorized because
 *  it's coming from outside the provider but with explicit opt-in
 *  (e.g. admin debug routes, migration backfill scripts). Use
 *  sparingly — every use is a documented exception. */
export function withExplicitBypass<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ via: 'provider', at: Date.now() }, async () => {
    // eslint-disable-next-line no-console
    if (readMode() !== 'off') console.info(`[provider-enforcer] explicit bypass: ${reason}`);
    return fn();
  });
}
