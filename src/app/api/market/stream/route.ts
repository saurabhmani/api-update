import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getTick } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSession();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const keys = (req.nextUrl.searchParams.get('keys') || '')
    .split(',').map(k => k.trim()).filter(Boolean);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // Pre-declare interval handles + closed flag so the abort listener
      // (registered up-front) can safely tear down even if it fires
      // during the initial snapshot await loop below — when the intervals
      // would otherwise be uninitialised. Same TDZ-safety pattern as
      // /api/signals/stream.
      let closed = false;
      let interval:  ReturnType<typeof setInterval> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (interval)  clearInterval(interval);
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener('abort', cleanup);

      const send = (data: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`data: ${data}\n\n`)); } catch { cleanup(); }
      };

      // Send initial snapshot from Redis
      for (const key of keys) {
        if (closed) return;
        const tick = await getTick(key);
        if (tick) send(JSON.stringify(tick));
      }

      // Guards against overlapping ticks: if the previous poll is still
      // in flight when the next 2s tick fires, skip it. Without this,
      // a slow Redis (>2s) lets callbacks pile up and explode CPU.
      let polling = false;
      interval = setInterval(async () => {
        if (closed || polling) return;
        polling = true;
        try {
          for (const key of keys) {
            if (closed) return;
            const tick = await getTick(key);
            if (tick) send(JSON.stringify(tick));
          }
        } finally {
          polling = false;
        }
      }, 2000);

      heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(enc.encode(': heartbeat\n\n')); } catch { cleanup(); }
      }, 15000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
