// ════════════════════════════════════════════════════════════════
//  GET /api/signals/stream  — Server-Sent Events
//
//  Long-lived HTTP stream that pushes the current top-50 signal
//  snapshot every STREAM_INTERVAL_MS. Replaces the dashboard's
//  polling-based refresh with a push model — the client opens one
//  connection at page load and receives new snapshots as the
//  rescore / regen loops mutate q365_signals on the server.
//
//  WHY SSE, NOT WEBSOCKET:
//    This is a one-way server-→-client stream. SSE is half the
//    complexity of a WebSocket for that use case: no frame protocol,
//    no handshake negotiation, browser auto-reconnect is built in,
//    and it rides plain HTTP so any proxy / CDN handles it fine.
//    The existing price-tick WS (`streamServer.ts`) stays untouched;
//    this SSE is a separate, lighter-weight channel for the signal
//    *list* itself (row add/remove/rerank), not per-tick prices.
//
//  CONNECTION LIFECYCLE:
//    1. Browser opens EventSource → this handler runs.
//    2. On connect we push an immediate snapshot (`event: snapshot`)
//       so the user sees data without waiting a full interval.
//    3. Every STREAM_INTERVAL_MS we push again (`event: signals`).
//    4. When the browser closes the tab / navigates away / refreshes,
//       req.signal fires abort. Our cleanup clears the timer and
//       closes the controller so no leaked loops survive.
//    5. On transport errors the BROWSER auto-reconnects after ~3s
//       (EventSource default) — we do nothing special.
//
//  RATE CONSIDERATIONS:
//    Per-connection getActiveSignals + enrichWithLiveLtp costs a
//    DB query + (for Kite-miss rows) up to N Yahoo fetches. The
//    Yahoo fetcher has its own 2s TTL cache, so a single user with
//    one dashboard open imposes at most one DB query every 5s and
//    rarely hits Yahoo twice for the same symbol. A small team of
//    5 operators = 5 connections = 1 DB query/second peak. Fine.
// ════════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { getActiveSignals } from '@/lib/signal-engine/repository/readSignals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STREAM_INTERVAL_MS = 5_000;

// Lazy load — enrichWithLiveLtp lives in the REST route file and
// is not yet a standalone module. We call a lighter path here:
// just read the DB + filter invalidation. Live prices still arrive
// over the existing WebSocket (useLivePrices). SSE is for the
// SIGNAL LIST mutating — not for per-tick prices.

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return new Response('Unauthorized', { status: 401 }); }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      // SSE framing helper. Events use named-event form so the
      // client can listen with addEventListener('snapshot', ...)
      // rather than the generic 'message' event — keeps snapshot
      // vs signals vs error handling on separate listeners.
      const send = (event: string, payload: unknown): void => {
        if (closed) return;
        try {
          const frame =
            `event: ${event}\n` +
            `data: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };

      // Abort wiring — fires when the browser closes the tab, the
      // user navigates away, or Next restarts. Without this the
      // setInterval below runs forever, leaking DB queries.
      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(tick);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', onAbort);

      // Initial comment frame — SSE recipients (and some proxies)
      // need *something* to see the connection is alive before the
      // first real event lands.
      controller.enqueue(encoder.encode(': connected\n\n'));

      // Core push. Called immediately on connect and then every
      // STREAM_INTERVAL_MS. Errors are caught and surfaced as an
      // 'error' event rather than killing the stream; the browser
      // would only auto-reconnect after `controller.close()`.
      async function push(firstTime = false): Promise<void> {
        if (closed) return;
        try {
          const t0 = Date.now();
          const signals = await getActiveSignals(50);
          const payload = {
            signals,
            count:    signals.length,
            ts:       Date.now(),
            elapsed:  Date.now() - t0,
          };
          send(firstTime ? 'snapshot' : 'signals', payload);
        } catch (err: any) {
          send('error', { error: err?.message ?? 'stream-fetch-failed' });
        }
      }

      // Immediate push so the user doesn't wait STREAM_INTERVAL_MS
      // for the first data frame.
      await push(true);

      const tick = setInterval(() => { void push(false); }, STREAM_INTERVAL_MS);

      // Keep-alive heartbeat every 20s — an SSE comment line that
      // stops intermediate proxies (nginx, Cloudflare) from closing
      // idle connections. The data itself is the 5s push, but if
      // push() ever stalls (long DB query), the heartbeat keeps the
      // socket from being reaped.
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch { closed = true; clearInterval(heartbeat); }
      }, 20_000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':     'text/event-stream; charset=utf-8',
      'Cache-Control':    'no-cache, no-store, no-transform',
      'Connection':       'keep-alive',
      // Tells nginx reverse-proxies not to buffer the response —
      // without this, events accumulate in the proxy until the
      // connection closes.
      'X-Accel-Buffering': 'no',
    },
  });
}
