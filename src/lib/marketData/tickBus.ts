/**
 * In-process tick pub/sub (broker ticker removed).
 * Events may still be published from warehouse poll paths.
 */

import { EventEmitter } from 'events';
import type { TickData } from './tickTypes';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tickBus' });

export type Tick = TickData;

const GLOBAL_KEY = '__q365_tick_bus__';

function getSingleton(): EventEmitter {
  const g = globalThis as unknown as Record<string, EventEmitter | undefined>;
  if (!g[GLOBAL_KEY]) {
    const bus = new EventEmitter();
    bus.setMaxListeners(256);
    g[GLOBAL_KEY] = bus;
    log.info('tickBus created (single-process)');
  }
  return g[GLOBAL_KEY]!;
}

export const tickBus = getSingleton();

export function publishTick(tick: Tick): void {
  tickBus.emit('tick', tick);
}
