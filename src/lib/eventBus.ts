// ════════════════════════════════════════════════════════════════
//  Event Bus — In-Process Pub/Sub for Real-Time SSE
//
//  Emits events when:
//    - New signal generated
//    - News ingested
//    - Dexter intelligence updated
//    - Pipeline status changes
//
//  Consumed by /api/events SSE endpoint → pushed to browsers.
//  No external dependencies (no Redis pub/sub needed for single-process).
// ════════════════════════════════════════════════════════════════

type EventType = 'signal:new' | 'news:new' | 'dexter:update' | 'pipeline:status';

interface BusEvent {
  type: EventType;
  data: Record<string, unknown>;
  timestamp: string;
}

type Listener = (event: BusEvent) => void;

class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type: EventType, data: Record<string, unknown> = {}): void {
    const event: BusEvent = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* listener error must not crash emitter */ }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

// Singleton — shared across all API routes in the same process
export const eventBus = new EventBus();
export type { BusEvent, EventType };
