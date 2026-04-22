// ════════════════════════════════════════════════════════════════
//  market-intelligence — news + corporate events + dedup
//
//  /news?symbol=RELIANCE → returns normalized, deduplicated news
//  /events?symbol=RELIANCE → returns corporate_events from PG
//  /health → standard health envelope
//
//  Every fetched news item is published as a
//  corporate.event.ingested with an idempotency_key equal to its
//  dedup_key — downstream consumers (alerting, signal-engine) dedup
//  automatically via the event bus.
// ════════════════════════════════════════════════════════════════

import '../../_shared/envLoader';
import { startHttpService, ok, err } from '../../_shared/httpService';
import { fetchNewsForSymbol } from './news';
import { bus } from '@eventbus/bus';
import { makeEvent } from '@contracts/events';
import { pg } from '@/lib/db/postgres';

const PORT = Number(process.env.MARKET_INTELLIGENCE_PORT ?? 4200);

async function publishIngested(
  symbol: string,
  items: { dedup_key: string; title: string; summary?: string; source?: string; published_at: string }[],
  correlationId: string,
): Promise<void> {
  for (const it of items) {
    await bus.publish(
      makeEvent('corporate.event.ingested', {
        symbol,
        event_type: 'other',
        event_date: it.published_at.slice(0, 10),
        details: { title: it.title, summary: it.summary, source: it.source },
      }, correlationId, it.dedup_key),
    );
  }
}

startHttpService({
  name: 'market-intelligence',
  version: '0.1.0',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/news',
      handler: async (ctx) => {
        const sym = ctx.query.symbol?.trim().toUpperCase();
        if (!sym) return err('BAD_REQUEST', 'symbol required', ctx.correlationId);
        const items = await fetchNewsForSymbol(sym);
        // Fire ingested events for downstream dedup/consumers.
        await publishIngested(sym, items, ctx.correlationId);
        return ok({ items }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/events',
      handler: async (ctx) => {
        const sym = ctx.query.symbol?.trim().toUpperCase();
        const since = ctx.query.since ?? '30d';
        const m = since.match(/^(\d+)([dmh])$/);
        const days = m && m[2] === 'd' ? Number(m[1]) : 30;
        try {
          const { rows } = sym
            ? await pg.query<{ id: number; symbol: string; event_type: string; event_date: string; details: unknown }>(
                `SELECT id, symbol, event_type, event_date::text AS event_date, details
                   FROM intel.corporate_events
                  WHERE symbol = $1
                    AND event_date > NOW() - ($2 || ' days')::interval
                  ORDER BY event_date DESC`,
                [sym, String(days)],
              )
            : await pg.query<{ id: number; symbol: string; event_type: string; event_date: string; details: unknown }>(
                `SELECT id, symbol, event_type, event_date::text AS event_date, details
                   FROM intel.corporate_events
                  WHERE event_date > NOW() - ($1 || ' days')::interval
                  ORDER BY event_date DESC
                  LIMIT 200`,
                [String(days)],
              );
          return ok({ items: rows }, ctx.correlationId);
        } catch {
          // PG table might be empty / migration not yet run; return empty rather than 500.
          return ok({ items: [] }, ctx.correlationId);
        }
      },
    },
  ],
  probeDependencies: async () => ({
    postgres: (await pg.healthCheck()).ok ? 'ok' : 'down',
    eventbus: bus.deadLetter().length > 0 ? 'degraded' : 'ok',
  }),
});
