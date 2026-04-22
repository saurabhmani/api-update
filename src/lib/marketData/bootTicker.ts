// ════════════════════════════════════════════════════════════════
//  bootTicker — idempotent startup for the real-time pipeline
//
//  Responsibilities (in order):
//    1. Load the universe (default: top N symbols from
//       kite_instruments). Configurable via KITE_TICKER_UNIVERSE_SIZE.
//    2. Register the strategy runner (once) so the tickBus has a
//       consumer before the first frame arrives.
//    3. Attach a one-shot 'connect' listener on the KiteTicker
//       that subscribes the full universe AFTER the socket is open.
//       This is the critical contract the user asked for:
//          kiteTicker.on("connect", () => subscribe(tokens))
//    4. Call kiteTicker.connect() exactly once.
//
//  Called from:
//    - src/instrumentation.ts (Next.js server start hook)
//    - /api/kite/ticker GET — lazy fallback if instrumentation
//      didn't fire (Windows dev servers, serverless cold starts).
//
//  Guarded by a globalThis flag so that HMR re-imports, multiple
//  concurrent API hits, and the instrumentation hook all converge
//  on a single boot.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getTicker, type TickMode } from './kiteTicker';
import { getTickStore } from './tickStore';
import { installRedisTickBridge } from './redisTickBridge';
import { installTickVerifier } from './tickVerifier';
import { installTickSimulator } from './tickSimulator';
import { installYahooFallbackPoller } from './yahooFallbackPoller';
import { installMarketOpenWatcher } from './marketOpenWatcher';
import { getKiteStatus } from './kiteSession';
import { seedInstrumentMap } from './kiteInstruments';
import { syncNow as dynSyncNow } from './dynamicSubscriptionSync';
import { registerTickStrategyRunner } from '@/lib/signal-engine/live/tickStrategyRunner';
import { registerSignalExecutor } from '@/lib/execution/signalExecutor';
import { ensureExecutionSchema } from '@/lib/execution/schema';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'bootTicker' });

const GLOBAL_KEY = '__q365_ticker_booted__';
const DEFAULT_UNIVERSE_SIZE = 3000;
const KITE_MAX_SUBS_PER_CONNECTION = 3000;

interface NseUniverseRow {
  symbol:   string;
  token:    number;
  name:     string;
  exchange: string;
}

export interface BootResult {
  booted: boolean;
  alreadyBooted: boolean;
  universeSize: number;
  mode: TickMode;
}

async function loadUniverseSymbols(limit: number): Promise<string[]> {
  // Preferred source: a static JSON snapshot of the NSE universe
  // parsed from the operator-supplied Excel list. This avoids
  // depending on kite_instruments being populated and gives us the
  // full ~2.7k NSE EQ universe on day one.
  try {
    const mod = await import('@/data/nseUniverse.json');
    const rows = (mod as unknown as { default?: NseUniverseRow[] }).default
      ?? (mod as unknown as NseUniverseRow[]);
    console.log(`[bootTicker] nseUniverse.json loaded  rawRows=${Array.isArray(rows) ? rows.length : 'n/a'}`);
    if (Array.isArray(rows) && rows.length > 0) {
      // Pre-seed the in-memory symbol→token map so subscribe() never
      // depends on the Kite instruments CSV download succeeding.
      // Each nseUniverse.json row already carries its Kite token.
      const seedPairs = rows
        .filter((r) => r.symbol && Number.isFinite(Number(r.token)))
        .map((r) => ({ symbol: String(r.symbol), token: Number(r.token) }));
      const seeded = seedInstrumentMap(seedPairs);
      console.log(`[bootTicker] seeded ${seeded} symbol↔token entries from nseUniverse.json`);

      const symbols = rows
        .map((r) => String(r.symbol ?? '').trim().toUpperCase())
        .filter((s) => s.length > 0)
        .slice(0, limit);
      console.log(`[bootTicker] symbols count: ${symbols.length}  (source=nseUniverse.json, limit=${limit})`);
      log.info('Universe loaded from nseUniverse.json', { source: 'nseUniverse.json', count: symbols.length });
      return symbols;
    }
    console.warn('[bootTicker] nseUniverse.json empty or wrong shape — falling back to kite_instruments');
  } catch (err) {
    console.warn(`[bootTicker] nseUniverse.json load failed: ${(err as Error).message} — falling back to kite_instruments`);
  }

  const { rows } = await db.query(
    `SELECT tradingsymbol
     FROM kite_instruments
     WHERE exchange = 'NSE' AND instrument_type = 'EQ'
     ORDER BY instrument_token ASC
     LIMIT ?`,
    [limit],
  );
  const symbols = (rows as Array<{ tradingsymbol: string }>).map((r) => String(r.tradingsymbol));
  console.log(`[bootTicker] symbols count: ${symbols.length}  (source=kite_instruments, limit=${limit})`);
  log.info('Universe loaded from kite_instruments', { source: 'kite_instruments', count: symbols.length });
  return symbols;
}

export async function bootTicker(): Promise<BootResult> {
  const g = globalThis as unknown as Record<string, BootResult | undefined>;
  if (g[GLOBAL_KEY]) {
    return { ...g[GLOBAL_KEY]!, booted: false, alreadyBooted: true };
  }

  const rawSize = Number(process.env.KITE_TICKER_UNIVERSE_SIZE);
  const universeSize = Math.min(
    KITE_MAX_SUBS_PER_CONNECTION,
    Number.isFinite(rawSize) && rawSize > 0 ? rawSize : DEFAULT_UNIVERSE_SIZE,
  );
  // Mode 'full' gives OHLC + depth; 'quote' gives OHLC only; 'ltp'
  // is LTP-only. We default to 'full' so the strategy engine has
  // the full book available per tick. Override via env if bandwidth
  // becomes a concern (each 'full' packet is ~184 bytes vs 44 for
  // quote and 8 for ltp).
  const rawMode = String(process.env.KITE_TICKER_MODE ?? 'full').toLowerCase();
  const mode: TickMode =
    rawMode === 'ltp' || rawMode === 'quote' || rawMode === 'full'
      ? (rawMode as TickMode)
      : 'full';

  log.info('Starting boot', { universeSize, mode });

  // Token status banner — printed once per server start so the operator
  // can immediately see whether the daily Kite OAuth has been done.
  // Maps directly to the failure mode the UI banner exposes to users.
  try {
    const apiKey = process.env.KITE_API_KEY?.trim();
    const auth = await getKiteStatus();
    let ageMin: number | null = null;
    if (apiKey) {
      const { rows } = await db.query<{ created_at: Date }>(
        `SELECT created_at FROM kite_tokens
         WHERE api_key = ?
         ORDER BY (user_id = 0) DESC, updated_at DESC
         LIMIT 1`,
        [apiKey],
      );
      const row = (rows as any[])[0];
      if (row?.created_at) {
        ageMin = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 60_000);
      }
    }
    const label = auth === 'ok' ? 'VALID' : auth === 'expired' ? 'EXPIRED' : 'MISSING';
    log.info('Kite token status', { status: label, ageMin, loginRequired: getTicker().getStatus().loginRequired });
    if (auth !== 'ok') {
      log.warn('Kite token not usable — visit /api/kite/login to refresh');
    }
  } catch (err: any) {
    log.warn('Token status probe failed', { error: err?.message });
  }

  // 1a. Execution DB schema must exist before the executor runs
  //     its first INSERT. Idempotent — CREATE TABLE IF NOT EXISTS.
  await ensureExecutionSchema();

  // 1b. Strategy runner BEFORE subscribe so the first tick has a
  //     consumer listening on the bus. Registration is idempotent.
  registerTickStrategyRunner();

  // 1c. Signal executor — listens on tickBus('signal') and routes
  //     accepted signals through the risk manager and position
  //     sizer to placeOrder (entry + stop + target). Idempotent.
  registerSignalExecutor();

  // 2. Load the universe from the instruments table.
  const symbols = await loadUniverseSymbols(universeSize);
  log.info('Loaded symbols', { count: symbols.length });
  if (symbols.length === 0) {
    console.error('[ERROR] No tokens to subscribe — universe is empty. Check nseUniverse.json / kite_instruments.');
    log.warn('Universe is empty — did kite_instruments finish loading?');
  }

  const ticker = getTicker();

  // 3. CRITICAL: subscribe only after the socket is open. The
  //    'connect' event is emitted by kiteTicker inside onOpen,
  //    AFTER reconnect replay — so both first-boot and any future
  //    reconnection are covered here.
  //
  //    We use `on` (not `once`) because:
  //      - First connect: subscribes the full universe
  //      - Later reconnect: re-applies the same universe (the
  //        internal `subs` set on the ticker already replays, but
  //        if the process was restarted mid-session we need this
  //        listener to put the universe back on the wire)
  ticker.on('connect', async () => {
    try {
      log.info('Connect received — subscribing full universe baseline');
      console.log(`[bootTicker] connect handler fired  universe=${symbols.length}  mode=${mode}`);

      // 1) BASELINE: subscribe every symbol the app knows about (up to
      //    the Kite 3000/connection cap). This is what the user-facing
      //    UI depends on — partial subscription = stale columns.
      //    subscribeSymbols is additive and already-subscribed tokens
      //    are a no-op, so reconnect replay from inside the ticker
      //    does not double-subscribe.
      const res = await ticker.subscribeSymbols(symbols, mode);
      console.log(
        `[WS] Subscribed ${res.resolved.length} baseline instruments  mode=${mode}  ` +
        `unknown=${res.unknown.length}`
      );
      log.info('Baseline subscribed', {
        resolved: res.resolved.length,
        unknown:  res.unknown.length,
        mode,
      });

      // 2) ADDITIVE LAYER: run dynamicSubscriptionSync once so any
      //    browser view-demand symbols NOT in the baseline (e.g. a
      //    symbol from a dynamic search) also land on the wire.
      //    Baseline is never torn down — see dynSubSync unsubscribe
      //    gate (DYN_SUB_UNSUBSCRIBE env).
      try {
        const syncResult = await dynSyncNow();
        log.info('Additive demand sync', {
          onWire:  syncResult.onWire,
          target:  syncResult.target,
          added:   syncResult.added,
          removed: syncResult.removed,
        });
      } catch (e: any) {
        log.warn('Additive demand sync failed', { error: e?.message });
      }

      // 3) Install downstream consumers
      const tickStore = getTickStore();
      tickStore.install();
      installRedisTickBridge();
      installTickVerifier();
      // Off by default. Activates only when MARKET_SIMULATE=1 AND
      // the real market is closed — see src/lib/marketData/tickSimulator.ts.
      installTickSimulator();
      const totalTokens: number = ticker.getStatus().subscribed;
      log.info('Post-subscribe status', { totalSubscribedTokens: totalTokens, tickStoreSize: tickStore.size() });
    } catch (err: any) {
      log.error('Subscribe on connect failed', { error: err?.message });
    }
  });

  // 4a. Wire up the Yahoo fallback poller BEFORE the socket opens so
  //     its bus listener is attached when the first Kite tick arrives.
  //     The poller sits idle until the health check observes >30s of
  //     Kite silence during market hours, then pushes Yahoo frames
  //     onto the same tickBus the Kite path uses. Stops automatically
  //     when Kite ticks resume.
  try {
    installYahooFallbackPoller();
  } catch (err: any) {
    log.warn('Yahoo fallback poller install failed', { error: err?.message });
  }

  // 4b. Schedule the daily market-open wake-up. Fires at 09:14 IST
  //     each weekday: clears loginRequired (token may have been
  //     refreshed overnight), forces ticker.connect(), and runs an
  //     immediate subscription sync. Ensures the socket is green by
  //     the opening bell without waiting for a backoff slot.
  try {
    installMarketOpenWatcher();
  } catch (err: any) {
    log.warn('Market-open watcher install failed', { error: err?.message });
  }

  // 4c. Dev-mode tick simulator. OFF by default. When MARKET_SIMULATE=1
  //     is set AND the real market is closed AND NODE_ENV !== 'production',
  //     the simulator drives synthetic ticks through the same bus so
  //     the pipeline can be exercised after hours. Never runs in prod.
  //     installTickSimulator() is a no-op when not enabled.
  try {
    const tickStore = getTickStore();
    tickStore.install();
    installTickSimulator();
  } catch (err: any) {
    log.warn('Simulator install path failed', { error: err?.message });
  }

  // 5. Fire the socket. connect() is itself guarded (state check +
  //    connectPromise), so even if bootTicker races with a manual
  //    /api/kite/ticker call the connection stays a singleton.
  try {
    await ticker.connect();
  } catch (err: any) {
    log.error('Connect failed', { error: err?.message });
    // Don't mark as booted — next call will retry. This is important
    // when the kite access_token isn't minted yet (e.g. server starts
    // before the daily login). The retry path lets bootTicker
    // succeed automatically once the callback route finishes.
    throw err;
  }

  const result: BootResult = {
    booted: true,
    alreadyBooted: false,
    universeSize: symbols.length,
    mode,
  };
  g[GLOBAL_KEY] = result;
  log.info('Boot complete');
  return result;
}

/** Non-throwing variant — use from request handlers that must not
 *  500 on a boot failure. Logs and returns a sentinel. */
export async function bootTickerSafe(): Promise<BootResult | { booted: false; error: string }> {
  try {
    return await bootTicker();
  } catch (err: any) {
    return { booted: false, error: err?.message ?? 'boot failed' };
  }
}
