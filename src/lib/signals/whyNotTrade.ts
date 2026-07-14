// ════════════════════════════════════════════════════════════════
//  Phase 9 — Why-not-trade / why-may-fail (subscriber-facing)
//
//  Concise human reasons. Never expose stack traces, SQL, or raw
//  internal rejection codes without translation.
// ════════════════════════════════════════════════════════════════

export interface WhyNotTradeReason {
  code: string;
  message: string;
}

export interface WhyNotTradeInput {
  signalState: string;
  executionAllowed: boolean;
  distanceFromEntryR?: number | null;
  rewardRisk?: number | null;
  rejectionReason?: string | null;
  rejectionCodes?: string[] | null;
  missingFactors?: string[] | null;
  invalidationReason?: string | null;
  mtfAlignment?: string | null;
  regime?: string | null;
}

const PRODUCT_A_MIN_RR = 1.2;

/** Map internal codes / free text → clean subscriber copy. */
export function translateRejectionToSubscriberCopy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Strip technical noise
  if (/stack|Error:|ECONN|SQL|mysql|undefined is not|at Object\./i.test(s)) {
    return 'Setup did not clear Quantorus quality gates.';
  }

  const lower = s.toLowerCase();
  if (/61\.?8|fib|retracement|reaction/i.test(s)) {
    return 'Waiting for reaction confirmation at the Fib retracement zone.';
  }
  if (/1h.*fall|momentum.*fall|lower.?tf|mtf|multi.?time/i.test(s)) {
    return 'Higher-timeframe trend remains constructive, but lower-timeframe momentum is still falling.';
  }
  if (/beyond.*entry|past.?entry|entry.?zone|chase|extended/i.test(s)) {
    return 'Current price is beyond the valid entry zone.';
  }
  if (/reward.?risk|r:?r|risk.?reward/i.test(s) || /REJECTED_LOW_RR/i.test(s)) {
    return 'Reward-risk is below the Product A minimum.';
  }
  if (/confiden|REJECTED_LOW_CONFIDENCE/i.test(s)) {
    return 'Calibrated confidence is below the Product A floor.';
  }
  if (/confirm|awaiting|DEVELOPING|DEFERRED_WAIT/i.test(s)) {
    return 'Setup is on the watchlist awaiting confirmation.';
  }
  if (/stale|fresh|candle/i.test(s)) {
    return 'Market data freshness does not yet support an actionable entry.';
  }
  if (/regime|REJECTED_MARKET_REGIME/i.test(s)) {
    return 'Current market regime does not support this strategy.';
  }
  if (/invalid/i.test(s)) {
    return 'Signal was invalidated by price action or lifecycle rules.';
  }
  if (/expir/i.test(s)) {
    return 'Signal validity window has expired.';
  }
  // Soft-clean: drop code prefixes
  return s
    .replace(/^REJECTED_[A-Z_]+:?\s*/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function buildWhyNotTradeReasons(input: WhyNotTradeInput): WhyNotTradeReason[] {
  const out: WhyNotTradeReason[] = [];
  const push = (code: string, message: string) => {
    if (!out.some((r) => r.message === message)) out.push({ code, message });
  };

  if (input.signalState === 'invalidated') {
    push(
      'invalidated',
      translateRejectionToSubscriberCopy(input.invalidationReason)
        ?? 'Signal was invalidated and is no longer tradeable.',
    );
  }
  if (input.signalState === 'expired') {
    push('expired', 'Signal validity window has expired.');
  }

  if (input.distanceFromEntryR != null && input.distanceFromEntryR > 1.0) {
    push(
      'beyond_entry',
      `Current price is ${input.distanceFromEntryR.toFixed(1)}R beyond the valid entry zone.`,
    );
  }

  if (input.rewardRisk != null && input.rewardRisk < PRODUCT_A_MIN_RR) {
    push('low_rr', 'Reward-risk is below the Product A minimum.');
  }

  if (input.mtfAlignment && /misalign|conflict|falling|bearish.*1h|1h.*weak/i.test(input.mtfAlignment)) {
    push(
      'mtf',
      'Higher-timeframe trend remains constructive, but lower-timeframe momentum is still falling.',
    );
  }

  for (const f of input.missingFactors ?? []) {
    const msg = translateRejectionToSubscriberCopy(f);
    if (msg) push('missing_factor', msg);
  }

  for (const code of input.rejectionCodes ?? []) {
    const msg = translateRejectionToSubscriberCopy(code);
    if (msg) push(code, msg);
  }

  const fromReason = translateRejectionToSubscriberCopy(input.rejectionReason);
  if (fromReason) push('rejection', fromReason);

  if (!input.executionAllowed && out.length === 0 && input.signalState === 'watchlist') {
    push('watchlist', 'Setup is on the watchlist awaiting confirmation.');
  }

  return out.slice(0, 5);
}

export function buildWhyMayFail(input: {
  invalidationReason?: string | null;
  risks?: string[];
  regime?: string | null;
  distanceFromEntryR?: number | null;
  rewardRisk?: number | null;
}): string[] {
  const lines: string[] = [];
  if (input.invalidationReason) {
    const t = translateRejectionToSubscriberCopy(input.invalidationReason);
    if (t) lines.push(t);
  }
  for (const r of input.risks ?? []) {
    const t = translateRejectionToSubscriberCopy(r);
    if (t && !lines.includes(t)) lines.push(t);
  }
  if (input.distanceFromEntryR != null && input.distanceFromEntryR > 0.5) {
    lines.push('Late entry increases adverse excursion risk before targets.');
  }
  if (input.rewardRisk != null && input.rewardRisk < 1.5) {
    lines.push('Thin reward-risk leaves little room for path noise.');
  }
  if (input.regime && /sideways|high.?vol|bear|weak/i.test(input.regime)) {
    lines.push(`Regime (${input.regime}) historically challenges this setup type.`);
  }
  if (lines.length === 0) {
    lines.push('Unexpected volatility spike or news shock can invalidate the thesis before targets.');
  }
  return lines.slice(0, 4);
}
