// ════════════════════════════════════════════════════════════════
//  Event contracts — the SINGLE source of truth for event names
//  and payload shapes. Every publisher and every subscriber imports
//  from this file so renaming an event is a compile-time break, not
//  a silent runtime mismatch.
//
//  Naming convention: dot-separated, past tense, noun-first.
//    market.snapshot.updated     (not market.updateSnapshot)
//    signal.generated            (not signal.generate)
//    alert.triggered             (not alert.trigger)
//
//  Every event carries:
//    • event   — the canonical name (redundant with bus routing
//                but useful in dead-letter / replay contexts)
//    • id      — unique per emission (for dedup on consumers)
//    • ts      — publisher-side epoch ms
//    • correlation_id — propagated from the originating request
// ════════════════════════════════════════════════════════════════

import type { MarketSnapshot, ProviderSource, DataQuality } from '@/types/market';

interface EventEnvelope<TName extends string, TPayload> {
  event: TName;
  id: string;
  ts: number;
  correlation_id: string;
  /** Idempotency key — stable across retries of the SAME logical
   *  event. Consumers dedup on this; publishers derive it from the
   *  business identity (e.g. `market.snapshot.updated` uses
   *  `${symbol}:${fetched_at_minute}`). Optional for backward
   *  compatibility, but publishing without one means at-least-once
   *  handlers will see duplicates. */
  idempotency_key?: string;
  payload: TPayload;
}

// ── Market ──────────────────────────────────────────────────────────

export interface MarketSnapshotUpdatedPayload {
  symbol: string;
  snapshot: MarketSnapshot;
  source: ProviderSource;
  data_quality: DataQuality;
}
export type MarketSnapshotUpdatedEvent =
  EventEnvelope<'market.snapshot.updated', MarketSnapshotUpdatedPayload>;

// ── Intelligence ────────────────────────────────────────────────────

export interface CorporateEventIngestedPayload {
  symbol: string;
  event_type: 'dividend' | 'split' | 'bonus' | 'merger' | 'result' | 'other';
  event_date: string;   // ISO yyyy-mm-dd
  details: Record<string, unknown>;
}
export type CorporateEventIngestedEvent =
  EventEnvelope<'corporate.event.ingested', CorporateEventIngestedPayload>;

// ── Signal ──────────────────────────────────────────────────────────

export interface SignalGeneratedPayload {
  symbol: string;
  action: 'buy' | 'sell' | 'hold';
  score: number;
  strategy: string;
  data_quality: DataQuality;
}
export type SignalGeneratedEvent =
  EventEnvelope<'signal.generated', SignalGeneratedPayload>;

// ── Alerts ──────────────────────────────────────────────────────────

export interface AlertTriggeredPayload {
  alert_id: string;
  user_id: string;
  symbol: string;
  condition: string;
  threshold?: number;
  observed_value: number;
}
export type AlertTriggeredEvent =
  EventEnvelope<'alert.triggered', AlertTriggeredPayload>;

// ── Discriminated union of every event type ─────────────────────────
//
// Subscribers can pattern-match: `if (e.event === 'market.snapshot.updated') e.payload...`
// — TypeScript narrows `payload` automatically.

export type QuantorusEvent =
  | MarketSnapshotUpdatedEvent
  | CorporateEventIngestedEvent
  | SignalGeneratedEvent
  | AlertTriggeredEvent;

export type EventName = QuantorusEvent['event'];

// Helper to build an envelope. Prefer this over hand-constructing so
// the id/ts fields are never forgotten.
import { randomUUID } from 'node:crypto';

export function makeEvent<TName extends EventName>(
  name: TName,
  payload: Extract<QuantorusEvent, { event: TName }>['payload'],
  correlation_id: string,
  idempotency_key?: string,
): Extract<QuantorusEvent, { event: TName }> {
  return {
    event: name,
    id: randomUUID(),
    ts: Date.now(),
    correlation_id,
    idempotency_key,
    payload,
  } as Extract<QuantorusEvent, { event: TName }>;
}
