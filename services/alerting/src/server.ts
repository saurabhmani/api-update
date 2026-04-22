// ════════════════════════════════════════════════════════════════
//  alerting — HTTP surface over the rules engine
//
//  /rules       POST/GET/DELETE — manage user alert rules
//  /history     GET             — recent triggered alerts
//  /health      GET             — standard envelope + DLQ status
// ════════════════════════════════════════════════════════════════

import '../../_shared/envLoader';
import { startHttpService, ok, err } from '../../_shared/httpService';
import { createRule, deleteRule, listRules, recentHistory, attachBus, type AlertCondition } from './rules';
import { bus } from '@eventbus/bus';

const PORT = Number(process.env.ALERTING_PORT ?? 4300);

const VALID_CONDITIONS: AlertCondition[] =
  ['price_above', 'price_below', 'pct_change_up', 'pct_change_down', 'volume_spike'];

startHttpService({
  name: 'alerting',
  version: '0.1.0',
  port: PORT,
  onStart: () => { attachBus(); },
  routes: [
    {
      method: 'GET',
      path: '/rules',
      handler: async (ctx) => {
        const userId = ctx.query.user_id;
        return ok({ items: listRules(userId) }, ctx.correlationId);
      },
    },
    {
      method: 'POST',
      path: '/rules',
      handler: async (ctx) => {
        const b = ctx.body as {
          user_id?: string; symbol?: string; condition?: AlertCondition; threshold?: number;
        } | undefined;
        if (!b?.user_id || !b?.symbol || !b?.condition || typeof b.threshold !== 'number') {
          return err('BAD_REQUEST', 'user_id, symbol, condition, threshold all required', ctx.correlationId);
        }
        if (!VALID_CONDITIONS.includes(b.condition)) {
          return err('BAD_REQUEST', `condition must be one of ${VALID_CONDITIONS.join(',')}`, ctx.correlationId);
        }
        const rule = createRule({
          user_id: b.user_id,
          symbol: b.symbol,
          condition: b.condition,
          threshold: b.threshold,
        });
        return ok(rule, ctx.correlationId);
      },
    },
    {
      method: 'DELETE',
      path: '/rules',
      handler: async (ctx) => {
        const id = ctx.query.id;
        if (!id) return err('BAD_REQUEST', 'id required', ctx.correlationId);
        const deleted = deleteRule(id);
        if (!deleted) return err('NOT_FOUND', 'rule not found', ctx.correlationId);
        return ok({ id, deleted: true }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/history',
      handler: async (ctx) => {
        const limit = Number(ctx.query.limit ?? '100');
        return ok({ items: recentHistory(limit) }, ctx.correlationId);
      },
    },
  ],
  probeDependencies: async () => ({
    eventbus: bus.deadLetter().length > 0 ? 'degraded' : 'ok',
  }),
});
