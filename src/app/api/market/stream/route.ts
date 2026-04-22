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

      const send = (data: string) => {
        try { controller.enqueue(enc.encode(`data: ${data}\n\n`)); } catch {}
      };

      // Send initial snapshot from Redis
      for (const key of keys) {
        const tick = await getTick(key);
        if (tick) send(JSON.stringify(tick));
      }

      // Poll Redis every 2s and push updates
      const interval = setInterval(async () => {
        for (const key of keys) {
          const tick = await getTick(key);
          if (tick) send(JSON.stringify(tick));
        }
      }, 2000);

      // Heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(': heartbeat\n\n')); } catch {}
      }, 15000);

      req.signal.addEventListener('abort', () => {
        clearInterval(interval);
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      });
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
