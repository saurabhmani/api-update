// ════════════════════════════════════════════════════════════════
//  marketOpenWatcher — wake the Kite socket up at the opening bell
//
//  Problem this solves
//  ────────────────────
//  The ticker reconnects on WS drop (exponential backoff in
//  kiteTicker.scheduleReconnect). That handles in-session blips, but
//  it does nothing for the two scenarios that matter most in prod:
//
//    (a) Server was booted BEFORE 09:15 IST. bootTicker will try to
//        connect, Kite will cheerfully accept the handshake, but
//        until the session starts there are zero packets on the
//        wire. The socket stays open and healthy — just empty.
//
//    (b) A token was refreshed mid-night. loginRequired=true kills
//        scheduleReconnect (by design — infinite 403 loops are worse
//        than a dead socket). After the overnight cron refreshes the
//        token, the ticker needs an explicit kick to reconnect.
//
//  This module fills both gaps with a single scheduled wake-up:
//    • At 09:14:00 IST each weekday, clear loginRequired (the token
//      may have been refreshed since the last reconnect attempt).
//    • Force a fresh ticker.connect() so the socket is green before
//      the first bell tick at 09:15:00.
//    • Trigger an immediate dynSubSync.syncNow() so the subscription
//      set is correct on wire from tick #1.
//
//  Zero effect outside market-open time. Pure scheduling — no bus
//  listeners, no polling, no heavy work on the hot path.
// ════════════════════════════════════════════════════════════════

import { getTicker } from './kiteTicker';
import { syncNow } from './dynamicSubscriptionSync';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'marketOpenWatcher' });

const GLOBAL_KEY = '__q365_market_open_watcher__';

// Wake up at 09:14:00 IST (one minute before the bell) so the WS
// handshake and the first subscribe frame are both complete by the
// time real ticks start flowing.
const OPEN_HOUR_IST = 9;
const OPEN_MIN_IST  = 14;

interface WatcherState {
  timer: NodeJS.Timeout | null;
  nextWakeAt: number | null;  // epoch ms
  fires: number;
  lastFireAt: number | null;
}

function getState(): WatcherState {
  const g = globalThis as unknown as Record<string, WatcherState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { timer: null, nextWakeAt: null, fires: 0, lastFireAt: null };
  }
  return g[GLOBAL_KEY]!;
}

/**
 * Compute the next 09:14 IST that falls on a weekday, strictly in the
 * future. Uses the same IST-as-UTC trick marketHours uses so we don't
 * need luxon / moment-tz. Returns an epoch-ms timestamp.
 */
function nextOpenEpochMs(from: number = Date.now()): number {
  // Shift wall clock into IST by adding 5h30m. getUTC* on the result
  // then reads as IST local time.
  const istNow = new Date(from + 5.5 * 3_600_000);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();

  // Candidate: today at 09:14 IST → subtract the 5h30m shift to get UTC.
  let candidateUtcMs = Date.UTC(y, m, d, OPEN_HOUR_IST, OPEN_MIN_IST, 0, 0)
                     - 5.5 * 3_600_000;

  // Walk forward until we land on a weekday that's also strictly in
  // the future. Holidays are NOT skipped here — the watcher still
  // fires on Republic Day etc., does a connect (which costs nothing
  // if the token is valid) and then sits quiet. Skipping holidays
  // would require a live NSE calendar feed that the rest of the
  // codebase has chosen to avoid.
  while (candidateUtcMs <= from) {
    candidateUtcMs += 86_400_000;
  }
  // Skip weekends. Weekday on IST wall clock:
  let weekday = new Date(candidateUtcMs + 5.5 * 3_600_000).getUTCDay();
  while (weekday === 0 || weekday === 6) {
    candidateUtcMs += 86_400_000;
    weekday = new Date(candidateUtcMs + 5.5 * 3_600_000).getUTCDay();
  }
  return candidateUtcMs;
}

async function onOpenBell(): Promise<void> {
  const state = getState();
  state.fires += 1;
  state.lastFireAt = Date.now();

  const ticker = getTicker();
  const st0 = ticker.getStatus();
  console.log(
    `[MARKET_OPEN] wake fired  state=${st0.state}  loginRequired=${st0.loginRequired}  ` +
    `subscribed=${st0.subscribed}  fires=${state.fires}`,
  );
  log.info('Market-open wake fired', {
    state: st0.state, loginRequired: st0.loginRequired, subscribed: st0.subscribed,
  });

  // If the overnight token refresh landed, clear the poison flag so
  // scheduleReconnect is allowed to run. clearLoginRequired is a
  // no-op when the flag wasn't set, so this is safe to always call.
  ticker.clearLoginRequired();

  // Force a connect. If the socket is already open, ticker.connect()
  // returns instantly; if it's closed, this kicks the session up
  // without waiting for the next exponential-backoff slot (which can
  // be as far as 30s out by the time we're here).
  try {
    await ticker.connect();
  } catch (err: any) {
    // Don't throw — the scheduleReconnect loop will pick up retries.
    // We've done our job (cleared the flag, requested a connect).
    console.warn(`[MARKET_OPEN] connect request failed — ${err?.message ?? err}`);
    log.warn('Market-open connect failed', { error: err?.message });
  }

  // Immediate subscription reconcile — even if the 10s dynSubSync
  // tick is about to fire, doing it here means the very first post-
  // open tick has the right symbol set.
  try {
    const result = await syncNow();
    console.log(
      `[MARKET_OPEN] syncNow  target=${result.target}  added=${result.added}  ` +
      `removed=${result.removed}  onWire=${result.onWire}`,
    );
  } catch (err: any) {
    console.warn(`[MARKET_OPEN] syncNow failed — ${err?.message ?? err}`);
  }
}

function scheduleNext(): void {
  const state = getState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const wakeAt = nextOpenEpochMs();
  state.nextWakeAt = wakeAt;
  const delay = wakeAt - Date.now();
  const wakeIso = new Date(wakeAt).toISOString();
  const wakeIst = new Date(wakeAt + 5.5 * 3_600_000).toISOString().replace('Z', '+05:30');

  console.log(
    `[MARKET_OPEN] next wake scheduled  in=${Math.round(delay / 1000)}s  ` +
    `at_utc=${wakeIso}  at_ist=${wakeIst}`,
  );
  log.info('Market-open wake scheduled', { delayMs: delay, wakeIso, wakeIst });

  // setTimeout is limited to ~24.8 days per the Node spec. Our delay
  // can't exceed ~3 days (weekend gap), so we don't need the chunked-
  // setTimeout trick here — but clamp defensively anyway.
  const MAX_TIMEOUT_MS = 2 ** 31 - 1;
  const clamped = Math.min(Math.max(delay, 1000), MAX_TIMEOUT_MS);

  state.timer = setTimeout(() => {
    state.timer = null;
    void onOpenBell()
      .catch((err) => {
        console.error(`[MARKET_OPEN] ✗ handler threw — ${err?.message ?? err}`);
      })
      .finally(() => {
        // Chain the NEXT weekday's wake immediately after firing,
        // so we're ready for tomorrow (or Monday) without a manual
        // re-install.
        scheduleNext();
      });
  }, clamped);
  state.timer.unref?.();
}

/**
 * Start the watcher. Idempotent; safe across Next.js HMR.
 *
 * Installed from bootTicker after the initial ticker.connect so the
 * watcher's first fire is always strictly after boot.
 */
export function installMarketOpenWatcher(): void {
  const state = getState();
  if (state.timer) return;
  console.log('[MARKET_OPEN] installing watcher');
  scheduleNext();
}

export function uninstallMarketOpenWatcher(): void {
  const state = getState();
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.nextWakeAt = null;
}

export function getMarketOpenWatcherStats(): {
  installed: boolean;
  nextWakeAt: number | null;
  nextWakeIso: string | null;
  fires: number;
  lastFireAt: number | null;
} {
  const s = getState();
  return {
    installed: s.timer != null,
    nextWakeAt: s.nextWakeAt,
    nextWakeIso: s.nextWakeAt ? new Date(s.nextWakeAt).toISOString() : null,
    fires: s.fires,
    lastFireAt: s.lastFireAt,
  };
}
