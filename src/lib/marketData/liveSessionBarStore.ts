// ════════════════════════════════════════════════════════════════
//  liveSessionBarStore — in-memory session OHLCV bars from live ticks
//
//  During market hours each tick updates the current IST session bar
//  for its symbol. Historical daily bars come from the warehouse;
//  this store supplies the *live* completing bar appended on top.
//
//  Pure memory — no DB writes. Subscribes to tickBus once at boot.
// ════════════════════════════════════════════════════════════════

import { tickBus } from '@/lib/marketData/tickBus';
import { MARKET_TICK_EVENT, type MarketStreamTick } from '@/lib/marketData/marketStreamTypes';
import { isMarketOpen, getLatestCompletedTradingDay } from '@/lib/marketData/marketHours';
import type { Candle } from '@/lib/signal-engine';

export interface SessionBar {
  symbol:    string;
  sessionDate: string;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
  tickCount: number;
  updatedAt: number;
}

const GLOBAL_KEY = '__q365_live_session_bars__';

function sessionDateIst(now = Date.now()): string {
  return getLatestCompletedTradingDay(now);
}

/** Current session key — during the cash session this is today's date
 *  once the open has passed; pre-open still returns prior session. */
function activeSessionDate(now = Date.now()): string {
  if (!isMarketOpen()) return getLatestCompletedTradingDay(now);
  const ist = new Date(now + 5.5 * 3_600_000);
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

class LiveSessionBarStore {
  private readonly bars = new Map<string, SessionBar>();
  private listener: ((tick: MarketStreamTick) => void) | null = null;
  private installed = false;

  install(): void {
    if (this.installed) return;
    this.installed = true;

    this.listener = (tick: MarketStreamTick) => {
      if (!isMarketOpen()) return;
      if (!tick?.symbol || !Number.isFinite(tick.price) || tick.price <= 0) return;
      this.ingestTick(tick);
      // Freshness is recorded by the keyed tick pipeline / system poll —
      // do not double-write a global counter here.
    };
    tickBus.on(MARKET_TICK_EVENT, this.listener);
  }

  uninstall(): void {
    if (this.listener) {
      tickBus.off(MARKET_TICK_EVENT, this.listener);
      this.listener = null;
    }
    this.installed = false;
    this.bars.clear();
  }

  ingestTick(tick: MarketStreamTick): void {
    const sym = tick.symbol.toUpperCase();
    const session = activeSessionDate(tick.ts ?? Date.now());
    const price = tick.price;
    const volAdd = Number.isFinite(tick.volume) && tick.volume! > 0 ? tick.volume! : 0;

    const existing = this.bars.get(sym);
    if (!existing || existing.sessionDate !== session) {
      const open = Number.isFinite(tick.open) && tick.open! > 0 ? tick.open! : price;
      this.bars.set(sym, {
        symbol: sym,
        sessionDate: session,
        open,
        high: Math.max(open, price, tick.high ?? price),
        low:  Math.min(open, price, tick.low ?? price),
        close: price,
        volume: volAdd,
        tickCount: 1,
        updatedAt: tick.ts ?? Date.now(),
      });
      return;
    }

    existing.high = Math.max(existing.high, tick.high ?? price, price);
    existing.low  = Math.min(existing.low, tick.low ?? price, price);
    existing.close = price;
    existing.volume += volAdd;
    existing.tickCount += 1;
    existing.updatedAt = tick.ts ?? Date.now();
  }

  getBar(symbol: string): SessionBar | null {
    const sym = symbol.trim().toUpperCase();
    const bar = this.bars.get(sym);
    if (!bar) return null;
    if (!isMarketOpen()) return null;
    return bar;
  }

  toCandle(bar: SessionBar): Candle {
    return {
      ts:     `${bar.sessionDate}T15:30:00+05:30`,
      open:   bar.open,
      high:   bar.high,
      low:    bar.low,
      close:  bar.close,
      volume: bar.volume,
    };
  }

  getLivePrice(symbol: string): number | null {
    const bar = this.getBar(symbol);
    return bar?.close ?? null;
  }

  stats(): { symbols: number; lastUpdate: number | null } {
    let last: number | null = null;
    for (const b of this.bars.values()) {
      if (last == null || b.updatedAt > last) last = b.updatedAt;
    }
    return { symbols: this.bars.size, lastUpdate: last };
  }

  clear(): void {
    this.bars.clear();
  }
}

function getStore(): LiveSessionBarStore {
  const g = globalThis as unknown as Record<string, LiveSessionBarStore | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new LiveSessionBarStore();
  return g[GLOBAL_KEY]!;
}

export function installLiveSessionBarStore(): void {
  getStore().install();
}

export function getLiveSessionBar(symbol: string): SessionBar | null {
  return getStore().getBar(symbol);
}

export function getLiveSessionCandle(symbol: string): Candle | null {
  const bar = getStore().getBar(symbol);
  return bar ? getStore().toCandle(bar) : null;
}

export function getLiveSessionPrice(symbol: string): number | null {
  return getStore().getLivePrice(symbol);
}

export function getLiveSessionBarStats() {
  return getStore().stats();
}

export function _resetLiveSessionBarStoreForTests(): void {
  getStore().uninstall();
  delete (globalThis as any)[GLOBAL_KEY];
}
