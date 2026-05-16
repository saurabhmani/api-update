// ════════════════════════════════════════════════════════════════
//  signal-engine — skeleton
//
//  Owns: indicator calculations, scoring, trade signals.
//  Consumes: MarketDataProvider snapshots + historical candles.
//  Publishes: signal.generated events.
//
//  This skeleton wires transport + event subscriptions. The real
//  scoring / rejection / confidence pipeline lives in
//  src/lib/signal-engine/* and is called in via a TODO below.
// ════════════════════════════════════════════════════════════════

import '../../_shared/envLoader';
import { startHttpService, ok, err } from '../../_shared/httpService';
import { bus } from '@eventbus/bus';
import { makeEvent } from '@contracts/events';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'signal-engine' });
const PORT = Number(process.env.SIGNAL_ENGINE_PORT ?? 4400);

// Bus wiring — when a snapshot arrives, signal engine decides
// whether any strategy produces a signal. Publishing is via the
// canonical `signal.generated` event so alerting + reporting can
// subscribe without knowing the engine internals.
bus.subscribe('market.snapshot.updated', async (ev) => {
  log.debug('snapshot observed', {
    correlation_id: ev.correlation_id,
    symbol: ev.payload.symbol,
    source: ev.payload.source,
    data_quality: ev.payload.data_quality,
  });

  // Demo-quality momentum: real scoring is in
  // src/lib/signal-engine/* and will be wired here once extracted.
  const pct = ev.payload.snapshot.changePercent;
  if (Math.abs(pct) < 1.5) return;
  await bus.publish(
    makeEvent('signal.generated', {
      symbol: ev.payload.symbol,
      action: pct > 0 ? 'buy' : 'sell',
      score: Math.min(Math.abs(pct) / 5, 1),
      strategy: 'demo.momentum',
      data_quality: ev.payload.data_quality,
    }, ev.correlation_id, `sig:${ev.payload.symbol}:${Math.floor(ev.ts / 60_000)}`),
  );
});

startHttpService({
  name: 'signal-engine',
  version: '0.1.0',
  port: PORT,
  routes: [
    {
      method: 'POST',
      path: '/evaluate',
      handler: async (ctx) => {
        const body = ctx.body as { symbol?: string } | undefined;
        if (!body?.symbol) return err('BAD_REQUEST', 'symbol required', ctx.correlationId);
        // TODO: call into src/lib/signal-engine analyzeInstrument.
        return ok({ symbol: body.symbol, signal: null, reason: 'pipeline-not-wired' }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/signals',
      handler: async (ctx) => {
        // TODO: read from PG q365_signals equivalent once Phase-2 cutover.
        return ok({ items: [] }, ctx.correlationId);
      },
    },
  ],
  probeDependencies: async () => ({
    eventbus: bus.deadLetter().length > 0 ? 'degraded' : 'ok',
  }),
});
