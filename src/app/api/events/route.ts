// ════════════════════════════════════════════════════════════════
//  GET /api/events — Server-Sent Events (SSE) Stream
//
//  Pushes real-time events to connected browsers:
//    - signal:new      — new trading signal generated
//    - news:new        — news event ingested
//    - dexter:update   — Dexter intelligence refreshed
//    - pipeline:status — pipeline run completed
//
//  Browser usage:
//    const es = new EventSource('/api/events');
//    es.onmessage = (e) => { const data = JSON.parse(e.data); ... };
// ════════════════════════════════════════════════════════════════

import { eventBus, type BusEvent } from '@/lib/eventBus';

export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();

  // Cleanup state lives in this closure so both `start` and `cancel`
  // (the only path that fires on browser disconnect for ReadableStream)
  // can run the same teardown. The previous code monkey-patched
  // controller.close(), but client disconnect flows through cancel()
  // — so heartbeat intervals and eventBus subscriptions LEAKED on every
  // tab close. Over hours that's thousands of dead handlers + intervals.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat)   clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
  };

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`),
      );

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          cleanup();
        }
      }, 30_000);

      unsubscribe = eventBus.subscribe((event: BusEvent) => {
        try {
          const payload = JSON.stringify(event);
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${payload}\n\n`));
        } catch {
          // Client disconnected — cleanup will fire via cancel().
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
