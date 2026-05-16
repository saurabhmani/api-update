// ════════════════════════════════════════════════════════════════
//  tickPropagator — bridges fresh MarketSnapshots into the per-symbol
//  tick channel that /api/market/stream subscribers read from.
//
//  Why: setTick() existed in src/lib/redis.ts but had no live writer.
//  /api/market/stream polled getTick(key) every 2s and never saw a
//  payload — useLiveTick consumers (watchlist, MarketDetail) showed
//  "Live" indicator but no actual prices. This module is the one
//  writer of `tick:<key>` keys; every successful IndianAPI snapshot
//  refresh fans through here so the SSE side has data to emit.
//
//  Failure-mode contract:
//    • Never throws. setTick is fire-and-forget; cacheSet (Redis+mem)
//      already swallows transport failures.
//    • Best-effort multi-key fanout: clients subscribe with different
//      key conventions (bare 'RELIANCE', Upstox 'NSE_EQ|RELIANCE',
//      'NSE:RELIANCE'). We write under each so all conventions work
//      without changing the SSE route or the consumer hook.
//    • Concurrency dedupe: a 1s minimum interval per symbol prevents
//      the resolver primary path AND the provider batch path from
//      double-writing the same tick within the same poll window.
// ════════════════════════════════════════════════════════════════

import { setTick } from '@/lib/redis';
import { logger } from '@/lib/logger';
import type { MarketSnapshot } from '@/types/market';
import type { Tick } from '@/types';

const log = logger.child({ component: 'tickPropagator' });

// Live tick TTL — short enough that an idle symbol falls out of the
// stream within a poll cycle or two, long enough that a 5s SSE poll
// always sees the most recent write. The SSE route polls every 2s.
const TICK_TTL_S = 15;

// Minimum interval per symbol between successive setTick writes.
// Multiple ingress paths (resolver primary, provider batch, single-
// symbol getLiveSnapshot) can all resolve the same symbol within
// a few hundred ms. Without this, Redis sees N redundant writes per
// symbol per refresh; the SSE consumer would also receive identical
// payloads back-to-back. 1s is well below the 2s SSE poll cadence.
const MIN_PUBLISH_INTERVAL_MS = 1_000;
const lastPublishedAt = new Map<string, number>();

/** Convert a canonical MarketSnapshot to the Tick shape /api/market/stream
 *  emits. Maps prevClose → close (the SSE Tick uses the legacy field
 *  name) and exposes change/pct_change so the dashboard's net-change
 *  badge can render without a second fetch. */
function snapshotToTick(snap: MarketSnapshot, instrumentKey: string): Tick {
  const now = Date.now();
  return {
    instrument_key: instrumentKey,
    ltp:        snap.price,
    open:       Number.isFinite(snap.open)         ? snap.open        : null,
    high:       Number.isFinite(snap.high)         ? snap.high        : null,
    low:        Number.isFinite(snap.low)          ? snap.low         : null,
    close:      Number.isFinite(snap.prevClose)    ? snap.prevClose   : null,
    volume:     Number.isFinite(snap.volume)       ? snap.volume      : null,
    net_change: Number.isFinite(snap.change)       ? snap.change      : null,
    pct_change: Number.isFinite(snap.changePercent)? snap.changePercent : null,
    ts: new Date(snap.timestamp && snap.timestamp > 0 ? snap.timestamp : now).toISOString(),
  };
}

/**
 * Publish one snapshot to the tick channel under every alias the
 * useLiveTick consumers may subscribe with:
 *   - bare symbol            (e.g. 'RELIANCE')
 *   - Upstox-style key       (e.g. 'NSE_EQ|RELIANCE') ← WatchlistItem
 *   - colon-prefixed         (e.g. 'NSE:RELIANCE')
 *
 * Returns silently on invalid input. Callers fire-and-forget — the
 * resolver / provider write paths must not block on tick publishing.
 */
export async function propagateTick(snap: MarketSnapshot | null | undefined): Promise<void> {
  if (!snap || typeof snap.symbol !== 'string') return;
  const sym = snap.symbol.trim().toUpperCase();
  if (!sym) return;
  if (!Number.isFinite(snap.price) || snap.price <= 0) return;

  const now = Date.now();
  const last = lastPublishedAt.get(sym) ?? 0;
  if (now - last < MIN_PUBLISH_INTERVAL_MS) return;
  lastPublishedAt.set(sym, now);

  const aliases = [sym, `NSE_EQ|${sym}`, `NSE:${sym}`];
  await Promise.all(
    aliases.map((key) => setTick(key, snapshotToTick(snap, key), TICK_TTL_S)),
  ).catch((err) => {
    // setTick already swallows Redis errors internally; this only
    // catches a synchronous throw (shouldn't happen). Log once.
    log.warn('propagateTick failed (non-fatal)', {
      symbol: sym,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.debug('tick update', { symbol: sym, price: snap.price });
}

/** Bulk variant — used by the resolver / batch-snapshot paths. */
export async function propagateTicks(
  snaps: ReadonlyArray<MarketSnapshot | null | undefined>,
): Promise<void> {
  if (!snaps || snaps.length === 0) return;
  await Promise.all(snaps.map((s) => propagateTick(s)));
}

/** Test-only: clear the dedupe map so tests don't suppress writes
 *  across cases. Not exported from the package barrel. */
export function _resetTickPropagatorForTests(): void {
  lastPublishedAt.clear();
}
