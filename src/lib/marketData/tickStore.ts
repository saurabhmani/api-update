/**
 * In-memory tick snapshot store (broker ticker removed).
 */

import { tickBus, type Tick } from './tickBus';
import type { TickData } from './tickTypes';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tickStore' });

export interface TickStoreStats {
  size: number;
  totalTicks: number;
  lastUpdatedTs: number | null;
  installedAt: number | null;
}

class TickStore {
  private map = new Map<string, TickData>();
  private totalTicks = 0;
  private lastUpdatedTs: number | null = null;
  private installedAt: number | null = null;
  private listening = false;

  install(): void {
    if (this.listening) return;
    this.listening = true;
    this.installedAt = Date.now();
    tickBus.on('tick', (t: Tick) => {
      if (!t?.symbol) return;
      this.map.set(String(t.symbol).toUpperCase(), t);
      this.totalTicks += 1;
      this.lastUpdatedTs = Date.now();
    });
    log.info('tickStore listening');
  }

  get(symbol: string): TickData | null {
    return this.map.get(String(symbol).toUpperCase()) ?? null;
  }

  snapshot(): TickData[] {
    return [...this.map.values()];
  }

  stats(): TickStoreStats {
    return {
      size: this.map.size,
      totalTicks: this.totalTicks,
      lastUpdatedTs: this.lastUpdatedTs,
      installedAt: this.installedAt,
    };
  }

  clear(): void {
    this.map.clear();
  }
}

const GLOBAL_KEY = '__q365_tick_store__';

export function getTickStore(): TickStore {
  const g = globalThis as unknown as Record<string, TickStore | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new TickStore();
  return g[GLOBAL_KEY]!;
}

export const tickStore = getTickStore();

/** @deprecated no-op — broker tick store backtest mode removed. */
export function setBacktestMode(_on: boolean): void {
  // no-op
}
