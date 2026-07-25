/**
 * Per-provider tick fan-out. Adapters emit NormalizedTick; callers use onTick.
 */

import type { NormalizedTick, NormalizedTickHandler } from './types';

export class NormalizedTickBus {
  private readonly handlers = new Set<NormalizedTickHandler>();

  on(handler: NormalizedTickHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(tick: NormalizedTick): void {
    for (const handler of this.handlers) {
      try {
        handler(tick);
      } catch {
        /* never let a bad listener break the feed */
      }
    }
  }

  listenerCount(): number {
    return this.handlers.size;
  }

  clear(): void {
    this.handlers.clear();
  }
}
