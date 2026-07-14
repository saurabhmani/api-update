// ════════════════════════════════════════════════════════════════
//  Phase 9 — Manual execution support (Product A)
//
//  Allowed: copy plan, watchlist, alerts, capital calculator, journal.
//  Prohibited: broker orders, auto-execute/modify/close, credentials.
// ════════════════════════════════════════════════════════════════

export const PRODUCT_A_ALLOWED_ACTIONS = [
  'copy_trade_plan',
  'add_to_watchlist',
  'alert_entry_valid',
  'alert_expire_or_invalidate',
  'capital_risk_calculator',
  'manual_trade_journal',
] as const;

export const PRODUCT_A_PROHIBITED_ACTIONS = [
  'place_order',
  'auto_execute',
  'auto_modify',
  'auto_close',
  'broker_credential_collection',
] as const;

export type ProductAAllowedAction = (typeof PRODUCT_A_ALLOWED_ACTIONS)[number];
export type ProductAProhibitedAction = (typeof PRODUCT_A_PROHIBITED_ACTIONS)[number];

export interface ManualPositionSizing {
  capitalInr: number;
  riskPct: number;
  riskAmountInr: number;
  entry: number;
  stopLoss: number;
  riskPerShare: number;
  /** Illustrative only — not a broker order size. */
  illustrativeQuantity: number;
  notionalInr: number;
  note: string;
}

export function computeManualPositionSizing(input: {
  capitalInr: number;
  entry: number;
  stopLoss: number;
  riskPct: number;
}): ManualPositionSizing {
  const capital = Math.max(0, input.capitalInr);
  const riskPct = Math.min(5, Math.max(0.1, input.riskPct));
  const riskAmount = (capital * riskPct) / 100;
  const riskPerShare = Math.abs(input.entry - input.stopLoss);
  const qty =
    riskPerShare > 0 && Number.isFinite(riskPerShare)
      ? Math.max(0, Math.floor(riskAmount / riskPerShare))
      : 0;
  return {
    capitalInr: Math.round(capital * 100) / 100,
    riskPct,
    riskAmountInr: Math.round(riskAmount * 100) / 100,
    entry: input.entry,
    stopLoss: input.stopLoss,
    riskPerShare: Math.round(riskPerShare * 100) / 100,
    illustrativeQuantity: qty,
    notionalInr: Math.round(qty * input.entry * 100) / 100,
    note: 'Illustrative sizing for manual execution only — Product A never places broker orders.',
  };
}

/** Format a trade plan as plain text for clipboard copy. */
export function formatTradePlanCopy(plan: {
  symbol: string;
  direction: string;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  target3: number | null;
  rewardRisk: number | null;
  validUntil: string | null;
}): string {
  const lines = [
    `Quantorus Product A — Manual Trade Plan`,
    `Symbol: ${plan.symbol}  Direction: ${plan.direction}`,
    `Entry: ${plan.entry ?? '—'}`,
    `Stop: ${plan.stop ?? '—'}`,
    `T1: ${plan.target1 ?? '—'}  T2: ${plan.target2 ?? '—'}  T3: ${plan.target3 ?? '—'}`,
    `R:R: ${plan.rewardRisk != null ? plan.rewardRisk.toFixed(2) : '—'}`,
    `Valid until: ${plan.validUntil ?? '—'}`,
    ``,
    `Manual execution only. No broker order is placed by Quantorus.`,
  ];
  return lines.join('\n');
}

export function isProhibitedAction(action: string): boolean {
  return (PRODUCT_A_PROHIBITED_ACTIONS as readonly string[]).includes(action);
}
