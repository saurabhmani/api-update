// ════════════════════════════════════════════════════════════════
//  liveSignalRecalc — debounced per-symbol signal refresh on ticks
//
//  When the market is open and live ticks update a session bar,
//  re-run generateSignal() for symbols with active stored signals.
//  Results are emitted on tickBus as `live_signal_update` for SSE
//  bridges; the main signals table overlays live prices regardless.
// ════════════════════════════════════════════════════════════════

import { tickBus } from '@/lib/marketData/tickBus';
import { MARKET_TICK_EVENT, type MarketStreamTick } from '@/lib/marketData/marketStreamTypes';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { liveFeedBlocksApprovals } from '@/lib/marketData/liveFeedState';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'liveSignalRecalc' });

export const LIVE_SIGNAL_UPDATE_EVENT = 'live_signal_update' as const;

const DEBOUNCE_MS = Math.max(
  1_000,
  Number(process.env.LIVE_SIGNAL_RECALC_DEBOUNCE_MS) || 5_000,
);
const MAX_SYMBOLS_PER_CYCLE = Math.max(
  5,
  Number(process.env.LIVE_SIGNAL_RECALC_MAX_SYMBOLS) || 25,
);

interface PendingRecalc {
  symbol:        string;
  instrumentKey: string;
  exchange:      string;
  scheduledAt:   number;
  timer:         ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRecalc>();
const activeSymbols = new Set<string>();
let listener: ((tick: MarketStreamTick) => void) | null = null;
let installed = false;
let inFlight = 0;

async function loadActiveSignalSymbols(): Promise<Array<{
  symbol: string;
  instrument_key: string;
  exchange: string;
}>> {
  try {
    const { db } = await import('@/lib/db');
    const { rows } = await db.query<{
      symbol: string;
      instrument_key: string;
      exchange: string | null;
    }>(
      `       SELECT DISTINCT symbol, instrument_key, exchange
         FROM q365_confirmed_signal_snapshots
        WHERE status IN ('ACTIVE', 'APPROVED_SIGNAL')
          AND (invalidation_reason IS NULL OR invalidation_reason = '')
        UNION
       SELECT DISTINCT symbol,
              instrument_key,
              exchange
         FROM q365_signals
        WHERE status IN ('active', 'watchlist')
          AND (invalidation_reason IS NULL OR invalidation_reason = '')
        LIMIT ?`,
      [MAX_SYMBOLS_PER_CYCLE * 4],
    );
    return (rows as any[]).map((r) => ({
      symbol:        String(r.symbol ?? '').toUpperCase(),
      instrument_key: String(r.instrument_key ?? `NSE_EQ|${r.symbol}`),
      exchange:      String(r.exchange ?? 'NSE'),
    })).filter((r) => r.symbol);
  } catch (err) {
    log.warn('failed to load active signal symbols', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function refreshActiveSymbolSet(): Promise<void> {
  const rows = await loadActiveSignalSymbols();
  activeSymbols.clear();
  for (const r of rows) activeSymbols.add(r.symbol);
}

async function runRecalc(symbol: string, instrumentKey: string, exchange: string): Promise<void> {
  if (!isMarketOpen() || liveFeedBlocksApprovals()) return;
  if (inFlight >= 3) return;

  const { isDualSourceEnabled } = await import('@/lib/marketData/providerFlags');
  if (isDualSourceEnabled()) {
    const { getConfirmationForSymbol } = await import('@/lib/marketData/dualSource/dataSourceManager');
    const { confirmationAllowsSignalGeneration } = await import('@/lib/marketData/dualSource/confirmationEngine');
    const confirmation = getConfirmationForSymbol(symbol);
    if (!confirmation || !confirmationAllowsSignalGeneration(confirmation)) {
      log.debug('dual-source hold — signal recalc deferred', {
        symbol,
        status: confirmation?.status ?? 'no_confirmation',
      });
      return;
    }
  }

  inFlight += 1;
  try {
    const { generateSignal } = await import('@/lib/signal-engine/live/analyzeInstrument');
    const signal = await generateSignal(instrumentKey, symbol, exchange);
    tickBus.emit(LIVE_SIGNAL_UPDATE_EVENT, {
      symbol,
      instrumentKey,
      signal,
      recalculatedAt: Date.now(),
    });
  } catch (err) {
    log.debug('recalc failed', {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight -= 1;
  }
}

function scheduleRecalc(symbol: string, instrumentKey: string, exchange: string): void {
  const existing = pending.get(symbol);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    pending.delete(symbol);
    void runRecalc(symbol, instrumentKey, exchange);
  }, DEBOUNCE_MS);

  pending.set(symbol, {
    symbol,
    instrumentKey,
    exchange,
    scheduledAt: Date.now(),
    timer,
  });
}

function onTick(tick: MarketStreamTick): void {
  if (!isMarketOpen()) return;
  const sym = tick.symbol?.toUpperCase();
  if (!sym || !activeSymbols.has(sym)) return;

  const key = `NSE_EQ|${sym}`;
  scheduleRecalc(sym, key, 'NSE');
}

export async function installLiveSignalRecalc(): Promise<void> {
  if (installed) return;
  installed = true;

  await refreshActiveSymbolSet();
  setInterval(() => { void refreshActiveSymbolSet(); }, 60_000);

  listener = onTick;
  tickBus.on(MARKET_TICK_EVENT, listener);
  log.info('live signal recalc installed', { debounceMs: DEBOUNCE_MS });
}

export function uninstallLiveSignalRecalc(): void {
  if (listener) {
    tickBus.off(MARKET_TICK_EVENT, listener);
    listener = null;
  }
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  installed = false;
}

export function _resetLiveSignalRecalcForTests(): void {
  uninstallLiveSignalRecalc();
  activeSymbols.clear();
  inFlight = 0;
}
