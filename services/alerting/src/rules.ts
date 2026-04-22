// ════════════════════════════════════════════════════════════════
//  Alerting rules — schema, evaluator, trigger log
//
//  Rule shape
//  ──────────
//    id:        stable opaque id
//    user_id:   who receives the notification
//    symbol:    NSE symbol to watch (uppercased)
//    condition: 'price_above' | 'price_below' | 'pct_change_up'
//               | 'pct_change_down' | 'volume_spike'
//    threshold: numeric (meaning depends on condition)
//    status:    'active' | 'triggered' | 'expired'
//
//  Storage: in-memory Map today; the PG table `app.alerts` already
//  exists — swap `store` for a PG repo when you're ready. The
//  evaluator + transport above it never change.
//
//  Evaluation is strictly one-shot: a rule transitions to
//  'triggered' on first match and is NOT re-evaluated until the
//  operator reactivates it. This prevents alert storms when a
//  price oscillates around the threshold.
// ════════════════════════════════════════════════════════════════

import { bus } from '@eventbus/bus';
import { makeEvent, type MarketSnapshotUpdatedEvent } from '@contracts/events';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'alerting', component: 'rules' });

export type AlertCondition =
  | 'price_above'
  | 'price_below'
  | 'pct_change_up'
  | 'pct_change_down'
  | 'volume_spike';

export type AlertStatus = 'active' | 'triggered' | 'expired';

export interface AlertRule {
  id: string;
  user_id: string;
  symbol: string;
  condition: AlertCondition;
  threshold: number;
  status: AlertStatus;
  created_at: number;
  triggered_at?: number;
  triggered_value?: number;
}

// ── In-memory store ────────────────────────────────────────────────
//
// Intentionally flat Maps. When PG-backing is wired, every method
// below becomes an SQL call — the EXTERNAL signatures don't change.

const byId = new Map<string, AlertRule>();
const activeBySymbol = new Map<string, Set<string>>();   // symbol → Set<rule.id>

function addActive(rule: AlertRule): void {
  let set = activeBySymbol.get(rule.symbol);
  if (!set) { set = new Set(); activeBySymbol.set(rule.symbol, set); }
  set.add(rule.id);
}
function removeActive(rule: AlertRule): void {
  activeBySymbol.get(rule.symbol)?.delete(rule.id);
}

export function createRule(input: Omit<AlertRule, 'id' | 'status' | 'created_at'>): AlertRule {
  const id = `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const rule: AlertRule = {
    ...input,
    symbol: input.symbol.trim().toUpperCase(),
    id,
    status: 'active',
    created_at: Date.now(),
  };
  byId.set(id, rule);
  addActive(rule);
  log.info('rule created', { id, symbol: rule.symbol, condition: rule.condition, threshold: rule.threshold });
  return rule;
}

export function deleteRule(id: string): boolean {
  const rule = byId.get(id);
  if (!rule) return false;
  removeActive(rule);
  byId.delete(id);
  return true;
}

export function listRules(userId?: string): AlertRule[] {
  const all = [...byId.values()];
  return userId ? all.filter(r => r.user_id === userId) : all;
}

// ── Trigger history (for /history endpoint) ────────────────────────

export interface TriggerRecord {
  rule_id: string;
  user_id: string;
  symbol: string;
  condition: AlertCondition;
  threshold: number;
  observed_value: number;
  triggered_at: number;
  correlation_id: string;
}

const HISTORY_MAX = 1000;
const history: TriggerRecord[] = [];

export function recentHistory(limit = 100): TriggerRecord[] {
  return history.slice(-Math.max(1, Math.min(limit, history.length)));
}

// ── Evaluation ─────────────────────────────────────────────────────

interface EvalInput {
  price: number;
  changePercent: number;
  volume: number;
  prevVolume?: number;   // not always available; volume_spike best-effort
}

function evaluate(rule: AlertRule, x: EvalInput): { fired: boolean; observed: number } {
  switch (rule.condition) {
    case 'price_above':
      return { fired: x.price >  rule.threshold, observed: x.price };
    case 'price_below':
      return { fired: x.price <  rule.threshold, observed: x.price };
    case 'pct_change_up':
      return { fired: x.changePercent >  rule.threshold, observed: x.changePercent };
    case 'pct_change_down':
      return { fired: x.changePercent < -Math.abs(rule.threshold), observed: x.changePercent };
    case 'volume_spike': {
      if (!x.prevVolume || x.prevVolume <= 0) return { fired: false, observed: x.volume };
      const ratio = x.volume / x.prevVolume;
      return { fired: ratio > rule.threshold, observed: ratio };
    }
    default:
      return { fired: false, observed: 0 };
  }
}

// Track previous volume per symbol so volume_spike can compute
// tick-over-tick ratio without a DB query.
const prevVolume = new Map<string, number>();

export function attachBus(): void {
  bus.subscribe('market.snapshot.updated', async (ev: MarketSnapshotUpdatedEvent) => {
    const sym = ev.payload.symbol;
    const ids = activeBySymbol.get(sym);
    if (!ids || ids.size === 0) return;

    const snap = ev.payload.snapshot;
    const input: EvalInput = {
      price: snap.price,
      changePercent: snap.changePercent,
      volume: snap.volume,
      prevVolume: prevVolume.get(sym),
    };
    prevVolume.set(sym, snap.volume);

    for (const id of ids) {
      const rule = byId.get(id);
      if (!rule || rule.status !== 'active') continue;
      const { fired, observed } = evaluate(rule, input);
      if (!fired) continue;

      rule.status = 'triggered';
      rule.triggered_at = Date.now();
      rule.triggered_value = observed;
      removeActive(rule);

      const record: TriggerRecord = {
        rule_id: rule.id,
        user_id: rule.user_id,
        symbol: rule.symbol,
        condition: rule.condition,
        threshold: rule.threshold,
        observed_value: observed,
        triggered_at: rule.triggered_at,
        correlation_id: ev.correlation_id,
      };
      history.push(record);
      if (history.length > HISTORY_MAX) history.shift();

      log.info('alert triggered', record);

      // Publish downstream — delivery service (future) picks this up.
      await bus.publish(
        makeEvent('alert.triggered', {
          alert_id: rule.id,
          user_id: rule.user_id,
          symbol: rule.symbol,
          condition: rule.condition,
          threshold: rule.threshold,
          observed_value: observed,
        }, ev.correlation_id, `trig:${rule.id}:${rule.triggered_at}`),
      );
    }
  });
}
