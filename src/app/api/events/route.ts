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

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`),
      );

      // Keep-alive heartbeat every 30s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      // Subscribe to event bus
      const unsubscribe = eventBus.subscribe((event: BusEvent) => {
        try {
          const payload = JSON.stringify(event);
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${payload}\n\n`));
        } catch {
          // Client disconnected
        }
      });

      // Cleanup on close — the AbortSignal is not available in all
      // runtimes, so we also guard the enqueue calls above.
      // When the client disconnects, enqueue throws and we clean up.
      const originalClose = controller.close.bind(controller);
      controller.close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        originalClose();
      };
    },
    cancel() {
      // Stream cancelled by client disconnect — cleanup handled above
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
