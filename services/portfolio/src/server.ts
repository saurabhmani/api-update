// ════════════════════════════════════════════════════════════════
//  portfolio — skeleton
//
//  Owns: watchlists, portfolios, holdings (app.* schema in PG).
//  Exposes: CRUD endpoints.
//  Consumes: market.snapshot.updated to compute real-time MTM
//            (stubbed — see handler TODO).
// ════════════════════════════════════════════════════════════════

import '../../_shared/envLoader';
import { startHttpService, ok, err } from '../../_shared/httpService';
import { bus } from '@eventbus/bus';
import { pg } from '@/lib/db/postgres';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'portfolio' });
const PORT = Number(process.env.PORTFOLIO_PORT ?? 4500);

// In-memory cache of last-known prices to compute MTM without hitting
// PG for every request. Updated by the bus listener below.
const lastPrice = new Map<string, number>();

bus.subscribe('market.snapshot.updated', (ev) => {
  lastPrice.set(ev.payload.symbol, ev.payload.snapshot.price);
});

startHttpService({
  name: 'portfolio',
  version: '0.1.0',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/watchlists',
      handler: async (ctx) => {
        const userId = ctx.query.user_id;
        if (!userId) return err('BAD_REQUEST', 'user_id required', ctx.correlationId);
        const { rows } = await pg.query<{ id: string; name: string; symbols: string[]; is_default: boolean }>(
          `SELECT id, name, symbols, is_default FROM app.watchlists WHERE user_id = $1 ORDER BY name`,
          [userId],
        );
        return ok({ items: rows }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/portfolios',
      handler: async (ctx) => {
        const userId = ctx.query.user_id;
        if (!userId) return err('BAD_REQUEST', 'user_id required', ctx.correlationId);
        const { rows } = await pg.query<{ id: string; name: string; base_currency: string }>(
          `SELECT id, name, base_currency FROM app.portfolios WHERE user_id = $1 ORDER BY name`,
          [userId],
        );
        return ok({ items: rows }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/holdings',
      handler: async (ctx) => {
        const portfolioId = ctx.query.portfolio_id;
        if (!portfolioId) return err('BAD_REQUEST', 'portfolio_id required', ctx.correlationId);
        const { rows } = await pg.query<{
          id: number; symbol: string; quantity: string; avg_price: string; opened_at: Date; closed_at: Date | null;
        }>(
          `SELECT id, symbol, quantity, avg_price, opened_at, closed_at
             FROM app.portfolio_holdings
            WHERE portfolio_id = $1 AND closed_at IS NULL
            ORDER BY opened_at DESC`,
          [portfolioId],
        );
        // Overlay live prices from the bus cache for a real-time MTM.
        const enriched = rows.map(r => {
          const mkt = lastPrice.get(r.symbol);
          const qty = Number(r.quantity);
          const avg = Number(r.avg_price);
          return {
            ...r,
            last_price: mkt ?? null,
            mtm: mkt != null ? (mkt - avg) * qty : null,
          };
        });
        return ok({ items: enriched }, ctx.correlationId);
      },
    },
  ],
  probeDependencies: async () => {
    const h = await pg.healthCheck();
    return { postgres: h.ok ? 'ok' : 'down' };
  },
});
