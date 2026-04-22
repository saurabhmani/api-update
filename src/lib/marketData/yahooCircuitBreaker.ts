// ════════════════════════════════════════════════════════════════
//  Yahoo Circuit Breaker — IP-ban protection
//
//  When Kite is loginRequired for a full market session, the rescore
//  loop attempts a Yahoo fetch for every active signal every minute.
//  With 200 active signals × 360 market minutes = 72,000 requests
//  per session — well above Yahoo's soft limit (~2000/hour/IP).
//
//  This breaker trips after N consecutive failures (defaulted to
//  conservative values for a trading system — we prefer briefly
//  showing stale data over getting blacklisted for the day):
//
//    CLOSED   → normal operation. Every recordYahooFailure() increments
//               a counter. On recordYahooSuccess() the counter resets.
//    OPEN     → after `threshold` consecutive failures, we pause all
//               Yahoo calls for `pauseMs`. isYahooAvailable() returns
//               false; callers short-circuit their fetch.
//    HALF-OPEN→ after pauseMs elapses, isYahooAvailable() returns
//               true again and the next failure re-arms the breaker
//               at 1 instead of resuming from threshold. One
//               success fully closes it.
//
//  Thread-safety: Node is single-threaded per module; state lives
//  on a module-local object. For HMR safety we stash it on globalThis
//  under a stable symbol — repeated re-imports don't reset the count.
//
//  Tune via env:
//    YAHOO_BREAKER_THRESHOLD  (default 20)
//    YAHOO_BREAKER_PAUSE_MS   (default 300_000 = 5 min)
//    YAHOO_BREAKER_DISABLED=1 — opt-out entirely
// ════════════════════════════════════════════════════════════════

const GLOBAL_KEY = '__q365_yahoo_circuit_breaker__';

interface BreakerState {
  consecutiveFailures: number;
  pausedUntil:         number;
  trips:               number;       // lifetime trip count for diagnostics
  totalSuccesses:      number;
  totalFailures:       number;
  lastTripAt:          number | null;
  lastSuccessAt:       number | null;
}

function getState(): BreakerState {
  const g = globalThis as unknown as Record<string, BreakerState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      consecutiveFailures: 0,
      pausedUntil:         0,
      trips:               0,
      totalSuccesses:      0,
      totalFailures:       0,
      lastTripAt:          null,
      lastSuccessAt:       null,
    };
  }
  return g[GLOBAL_KEY]!;
}

function threshold(): number {
  const n = Number(process.env.YAHOO_BREAKER_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function pauseMs(): number {
  const n = Number(process.env.YAHOO_BREAKER_PAUSE_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

/**
 * Called before every Yahoo request. Returns false when the breaker
 * is tripped — the caller must NOT hit Yahoo and should return null
 * or whatever "no data" sentinel it uses. Breaker auto-closes
 * (moves to HALF-OPEN) after pauseMs has elapsed.
 */
export function isYahooAvailable(): boolean {
  if (process.env.YAHOO_BREAKER_DISABLED === '1') return true;
  const s = getState();
  if (Date.now() < s.pausedUntil) return false;
  return true;
}

/**
 * Called after a successful Yahoo response. Resets the consecutive-
 * failure counter. In HALF-OPEN this fully closes the breaker.
 */
export function recordYahooSuccess(): void {
  const s = getState();
  s.consecutiveFailures = 0;
  s.totalSuccesses++;
  s.lastSuccessAt = Date.now();
}

/**
 * Called after a failed Yahoo response (network error, null price,
 * 4xx/5xx, timeout). Increments the counter; when it hits threshold
 * the breaker trips OPEN for pauseMs.
 *
 * The `reason` is purely informational — it goes into a structured
 * log line so operators can tell a rate-limit trip apart from a
 * transient network blip when reading CloudWatch.
 */
export function recordYahooFailure(reason?: string): void {
  if (process.env.YAHOO_BREAKER_DISABLED === '1') return;
  const s = getState();
  s.consecutiveFailures++;
  s.totalFailures++;

  if (s.consecutiveFailures >= threshold() && Date.now() >= s.pausedUntil) {
    s.pausedUntil = Date.now() + pauseMs();
    s.trips++;
    s.lastTripAt = Date.now();
    s.consecutiveFailures = 0;
    console.warn(
      `[YAHOO BREAKER] ✗ TRIPPED — ${threshold()} consecutive failures  ` +
      `pausing ${Math.round(pauseMs() / 1000)}s  ` +
      `reason="${reason ?? 'unknown'}"  trip#${s.trips}`,
    );
  }
}

/** Diagnostic surface for /api/market-data/health or admin dashboards. */
export function getYahooBreakerStats(): {
  open:                boolean;
  pausedUntil:         number;
  msUntilReopen:       number;
  consecutiveFailures: number;
  trips:               number;
  totalSuccesses:      number;
  totalFailures:       number;
  lastTripAt:          number | null;
  lastSuccessAt:       number | null;
  threshold:           number;
  pauseMs:             number;
} {
  const s = getState();
  const now = Date.now();
  return {
    open:                s.pausedUntil <= now,
    pausedUntil:         s.pausedUntil,
    msUntilReopen:       Math.max(0, s.pausedUntil - now),
    consecutiveFailures: s.consecutiveFailures,
    trips:               s.trips,
    totalSuccesses:      s.totalSuccesses,
    totalFailures:       s.totalFailures,
    lastTripAt:          s.lastTripAt,
    lastSuccessAt:       s.lastSuccessAt,
    threshold:           threshold(),
    pauseMs:             pauseMs(),
  };
}

/** Manual reset — for an admin /api/admin/reset-yahoo-breaker endpoint. */
export function resetYahooBreaker(): void {
  const s = getState();
  s.consecutiveFailures = 0;
  s.pausedUntil = 0;
  console.log('[YAHOO BREAKER] manual reset — breaker closed');
}
