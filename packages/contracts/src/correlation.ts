// ════════════════════════════════════════════════════════════════
//  Correlation ID — one id per logical request, propagated across
//  every HTTP hop and every event published during that request.
//
//  Rule: every inbound service request MUST read (or mint) a
//  correlation id and attach it to every outbound call + log line.
//  This is what lets us trace "user clicked → gateway → ingestion →
//  event → alerting" as one unit in structured logs.
// ════════════════════════════════════════════════════════════════

import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';

export function newCorrelationId(): string {
  return randomUUID();
}

/** Extract correlation id from an incoming request header bag.
 *  Accepts both Next.js `Headers` and plain record shapes. */
export function readCorrelationId(headers: {
  get?(name: string): string | null;
  [k: string]: unknown;
}): string | null {
  if (typeof headers.get === 'function') {
    return headers.get(CORRELATION_HEADER);
  }
  const record = headers as Record<string, unknown>;
  const direct = record[CORRELATION_HEADER] ?? record[CORRELATION_HEADER.toUpperCase()];
  return typeof direct === 'string' ? direct : null;
}

/** Read-or-mint. Use this at every service entry point. */
export function ensureCorrelationId(headers: {
  get?(name: string): string | null;
  [k: string]: unknown;
}): string {
  return readCorrelationId(headers) ?? newCorrelationId();
}
