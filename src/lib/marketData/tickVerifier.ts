// ════════════════════════════════════════════════════════════════
//  tickVerifier — periodic cross-check of Kite vs Yahoo prices
//
//  Why this exists
//  ────────────────
//  During market hours the Kite WebSocket is the source of truth.
//  Yahoo is the fallback when Kite is offline or stale. A silent
//  drift between the two (e.g. a stuck Kite frame, a Yahoo cache
//  holding yesterday's close) cannot be diagnosed by looking at
//  either stream alone — you have to compare them.
//
//  This module samples a handful of subscribed symbols every
//  VERIFY_INTERVAL_MS, resolves both Kite and Yahoo, and emits a
//  single grep-friendly log line per sample:
//
//    [VERIFY] symbol=RELIANCE kite=2850.10 yahoo=2848.90 diff=1.20
//    [VERIFY] symbol=TCS      kite=3901.50 yahoo=null    diff=— (yahoo miss)
//    [VERIFY] symbol=INFY     kite=null    yahoo=1432.10 diff=— (kite stale)
//
//  Also catches the 30-second stale case explicitly: if a Kite tick
//  is older than STALE_THRESHOLD_MS, we log it as STALE and force
//  the resolver to fall through to Yahoo.
//
//  Cheap by design:
//    • Samples at most SAMPLE_SIZE symbols per tick (default 5).
//    • Skips entirely when the market is closed — no point
//      comparing two snapshots of yesterday's close.
//    • Fire-and-forget — never blocks the tick hot path.
// ════════════════════════════════════════════════════════════════

import { tryGetLiveTick, isFresh } from './kiteTicker';
import { fetchFromYahooCached }    from './priceCache';
import { getTickStore }            from './tickStore';
import { getMarketStatus }         from './marketHours';

const VERIFY_INTERVAL_MS =
  Number(process.env.TICK_VERIFY_INTERVAL_MS) || 60_000;

const STALE_THRESHOLD_MS =
  Number(process.env.TICK_STALE_THRESHOLD_MS) || 30_000;

const SAMPLE_SIZE =
  Number(process.env.TICK_VERIFY_SAMPLE_SIZE) || 5;

// Alert when absolute diff exceeds this fraction of the Kite price.
// 0.5% is generous — Yahoo can legitimately lag Kite by several
// ticks during fast moves, so tighter thresholds would spam the
// log. Anything >0.5% is worth a second look.
const DRIFT_ALERT_PCT =
  Number(process.env.TICK_VERIFY_ALERT_PCT) || 0.5;

interface VerifierState {
  installed: boolean;
  timer:     NodeJS.Timeout | null;
  sampled:   number;
  drifts:    number;
  stale:     number;
}

const GLOBAL_KEY = '__q365_tick_verifier__';

function getState(): VerifierState {
  const g = globalThis as unknown as Record<string, VerifierState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { installed: false, timer: null, sampled: 0, drifts: 0, stale: 0 };
  }
  return g[GLOBAL_KEY]!;
}

function pickSample(symbols: string[], n: number): string[] {
  if (symbols.length <= n) return symbols.slice();
  const out: string[] = [];
  const used = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(Math.random() * symbols.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(symbols[i]);
  }
  return out;
}

async function sampleOnce(): Promise<void> {
  const state = getState();
  const market = getMarketStatus();
  if (!market.isOpen) {
    // Market is closed — no ticks expected. Emit a single,
    // grep-friendly line so the terminal is honest about what
    // mode the system is in, then skip the sampling work.
    console.log(
      `[MARKET] state=CLOSED (${market.label ?? 'closed'}) ` +
      `mode=last_close source=yahoo (no kite ticks expected)`,
    );
    return;
  }

  const store = getTickStore();
  const snapshot = store.snapshot();
  if (snapshot.length === 0) {
    // Market IS open but the tickStore is empty — this is a real
    // incident, not a normal transient. Log at error level so it
    // surfaces in alerting, paired with an [ERROR] tag the ops
    // playbook can grep for.
    console.error(
      `[ERROR] market=OPEN but no ticks in store — ` +
      `expected, since Kite has been removed. Yahoo is now the ` +
      `sole live-quote source and is polled per-request by the UI.`,
    );
    return;
  }

  // Second error condition: store has entries but every one of them
  // is stale beyond the 30s threshold — the socket is idle during
  // market hours, which should never happen on a live feed. Emit
  // [ERROR] so this pattern is distinguishable from "just logged out".
  const staleCount = snapshot.filter(
    (t) => !t.ts || (Date.now() - t.ts) > STALE_THRESHOLD_MS,
  ).length;
  if (staleCount === snapshot.length) {
    const newestTick = snapshot.reduce<number | null>(
      (acc, t) => (t.ts && (!acc || t.ts > acc) ? t.ts : acc),
      null,
    );
    const ageSec = newestTick ? Math.round((Date.now() - newestTick) / 1000) : null;
    console.error(
      `[ERROR] market=OPEN but all ${snapshot.length} ticks are stale ` +
      `(newest=${ageSec ?? '—'}s old, threshold=${STALE_THRESHOLD_MS / 1000}s) — ` +
      `Kite WebSocket appears idle. Falling back to Yahoo.`,
    );
  }

  const candidates = snapshot
    .map((t) => t.symbol)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);

  const sample = pickSample(candidates, SAMPLE_SIZE);

  for (const sym of sample) {
    const tick = tryGetLiveTick(sym);
    const tickFresh = tick != null && tick.lastPrice != null && isFresh(tick);
    const tickStale = tick != null && tick.lastPrice != null && !isFresh(tick, STALE_THRESHOLD_MS);
    const yahoo = await fetchFromYahooCached(sym).catch(() => null);

    const kitePrice  = tickFresh ? tick!.lastPrice : null;
    const yahooPrice = yahoo?.price ?? null;

    let note = '';
    let diffStr = '—';
    if (kitePrice != null && yahooPrice != null) {
      const absDiff = Math.abs(kitePrice - yahooPrice);
      const pctDiff = (absDiff / kitePrice) * 100;
      diffStr = absDiff.toFixed(2);
      if (pctDiff > DRIFT_ALERT_PCT) {
        note = ` ⚠ drift=${pctDiff.toFixed(2)}%`;
        state.drifts += 1;
      }
    } else if (!tickFresh && tickStale) {
      note = ' (kite stale >30s → yahoo fallback)';
      state.stale += 1;
    } else if (kitePrice == null) {
      note = ' (kite miss)';
    } else if (yahooPrice == null) {
      note = ' (yahoo miss)';
    }

    const kiteCell  = kitePrice  != null ? kitePrice.toFixed(2)  : 'null';
    const yahooCell = yahooPrice != null ? yahooPrice.toFixed(2) : 'null';

    console.log(
      `[VERIFY] symbol=${sym} kite=${kiteCell} yahoo=${yahooCell} diff=${diffStr}${note}`,
    );
    state.sampled += 1;
  }
}

/**
 * Install the periodic verifier. Idempotent — safe across Next.js
 * HMR reloads because the singleton lives on globalThis.
 */
export function installTickVerifier(): void {
  const state = getState();
  if (state.installed) return;

  state.timer = setInterval(() => {
    void sampleOnce().catch((err: Error) => {
      console.warn('[VERIFY] sample error:', err.message);
    });
  }, VERIFY_INTERVAL_MS);
  // Don't keep the process alive just for the verifier.
  state.timer.unref?.();
  state.installed = true;

  console.log(
    `[VERIFY] installed  interval=${VERIFY_INTERVAL_MS}ms  ` +
    `sample=${SAMPLE_SIZE}  stale_threshold=${STALE_THRESHOLD_MS}ms  ` +
    `drift_alert=${DRIFT_ALERT_PCT}%`,
  );
}

export function getTickVerifierStats(): {
  installed: boolean;
  sampled:   number;
  drifts:    number;
  stale:     number;
} {
  const s = getState();
  return { installed: s.installed, sampled: s.sampled, drifts: s.drifts, stale: s.stale };
}

export function uninstallTickVerifier(): void {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.installed = false;
}
