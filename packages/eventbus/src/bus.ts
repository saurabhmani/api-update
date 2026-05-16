// ════════════════════════════════════════════════════════════════
//  Event Bus — abstraction with an in-process default
//
//  WHY ABSTRACT:
//    Today everything runs in one Node process, so an EventEmitter
//    is enough. Tomorrow services split out and we need Redis
//    Streams / NATS / Kafka. By coding publishers + subscribers
//    against THIS interface, swapping the transport is a one-file
//    change (a new implementation of `EventBus`) — no publisher or
//    subscriber needs editing.
//
//  GUARANTEES we DO provide:
//    • At-least-once delivery inside the in-proc impl when the
//      subscriber is already registered.
//    • Dead-letter queue: handler throws → event is kept in a
//      bounded in-memory DLQ for inspection / manual replay.
//    • Retry: handler throws → bus retries up to maxAttempts with
//      exponential backoff before sending to the DLQ.
//
//  GUARANTEES we do NOT provide (yet):
//    • Durability across process restarts (in-proc is lossy by
//      design — Redis impl will add this).
//    • Ordering across different event names.
// ════════════════════════════════════════════════════════════════

import { EventEmitter } from 'node:events';
import type { QuantorusEvent, EventName } from '@contracts/events';

export interface PublishOptions {
  /** Max delivery attempts per subscriber before DLQ. Default 3. */
  maxAttempts?: number;
}

export type Handler<E extends QuantorusEvent = QuantorusEvent> = (event: E) => Promise<void> | void;

export interface EventBus {
  publish<E extends QuantorusEvent>(event: E, opts?: PublishOptions): Promise<void>;
  subscribe<N extends EventName>(
    name: N,
    handler: Handler<Extract<QuantorusEvent, { event: N }>>,
  ): () => void; // returns unsubscribe
  /** Dead-letter inspection — returns a copy of the current DLQ. */
  deadLetter(): DeadLetterRecord[];
  /** Clear DLQ (ops / tests). */
  clearDeadLetter(): void;
}

export interface DeadLetterRecord {
  event: QuantorusEvent;
  error: string;
  attempts: number;
  ts: number;
}

const DLQ_MAX = 1000;

// Idempotency cache — tracks keys seen per (event, listener) pair so
// a retry after a listener already committed doesn't re-execute the
// side-effect. Bounded size per pair; oldest entries evicted.
const DEDUP_MAX_PER_KEY = 10_000;

export class InProcessEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly dlq: DeadLetterRecord[] = [];
  // Key: `${eventName}:${handlerIdx}` → Set<idempotency_key>
  private readonly seen = new Map<string, Set<string>>();

  constructor() {
    // EventEmitter warns at 10 listeners by default — we expect many
    // services binding to the same event in a mono-process deployment.
    this.emitter.setMaxListeners(100);
  }

  private markSeen(key: string, idk: string): boolean {
    let set = this.seen.get(key);
    if (!set) {
      set = new Set<string>();
      this.seen.set(key, set);
    }
    if (set.has(idk)) return true;   // already processed
    set.add(idk);
    if (set.size > DEDUP_MAX_PER_KEY) {
      // Evict oldest — Set iteration order is insertion order.
      const first = set.values().next().value;
      if (first !== undefined) set.delete(first);
    }
    return false;
  }

  async publish<E extends QuantorusEvent>(event: E, opts: PublishOptions = {}): Promise<void> {
    const listeners = this.emitter.listeners(event.event) as Array<(e: QuantorusEvent) => Promise<void> | void>;
    // Deliver to each listener with retry independent of the others.
    await Promise.all(listeners.map((l, idx) => this.deliver(event, l, idx, opts.maxAttempts ?? 3)));
  }

  private async deliver(
    event: QuantorusEvent,
    handler: (e: QuantorusEvent) => Promise<void> | void,
    handlerIdx: number,
    maxAttempts: number,
  ): Promise<void> {
    // Idempotency: if this listener already committed the same
    // logical event (same idempotency_key), skip silently. The
    // dedup scope is per (eventName, listenerSlot) so different
    // services that both subscribe can each run once.
    if (event.idempotency_key) {
      const dedupKey = `${event.event}:${handlerIdx}`;
      if (this.markSeen(dedupKey, event.idempotency_key)) {
        return;
      }
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await handler(event);
        return;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          const backoff = 50 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    this.pushDeadLetter({
      event,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      attempts: maxAttempts,
      ts: Date.now(),
    });
  }

  subscribe<N extends EventName>(
    name: N,
    handler: Handler<Extract<QuantorusEvent, { event: N }>>,
  ): () => void {
    const wrapped = handler as unknown as (e: QuantorusEvent) => Promise<void> | void;
    this.emitter.on(name, wrapped);
    return () => this.emitter.off(name, wrapped);
  }

  deadLetter(): DeadLetterRecord[] {
    return [...this.dlq];
  }

  clearDeadLetter(): void {
    this.dlq.length = 0;
  }

  private pushDeadLetter(record: DeadLetterRecord): void {
    this.dlq.push(record);
    if (this.dlq.length > DLQ_MAX) this.dlq.shift();
  }
}

// Singleton — import THIS to get the process-wide bus. Services that
// later move out of this repo will swap this file's default export
// for a Redis/NATS adapter and nothing else changes.
export const bus: EventBus = new InProcessEventBus();
