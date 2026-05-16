// ════════════════════════════════════════════════════════════════
//  Provider Payload Validator — Spec PROVIDER-NORMALIZE-2026-05.
//
//  Per-row validation gate that every provider adapter (IndianAPI,
//  NSE direct, Yahoo, …) consults BEFORE returning a MarketSnapshot
//  to its caller. Catches the cases the resolver-level data-quality
//  gate cannot see:
//    • price <= 0 / NaN / null / undefined / Infinity
//    • volume <= 0 during market hours
//    • OHLC fields with NaN / Infinity (zero is allowed — some plans
//      genuinely don't expose intraday OHLC, that's a downstream
//      problem, not an "invalid payload" problem)
//    • change / changePercent with NaN / Infinity
//
//  Producing one canonical `[PROVIDER_INVALID_PAYLOAD]` /
//  `[PROVIDER_REJECTED_SYMBOL]` log per rejection means SRE has a
//  single grep target across all providers, regardless of which
//  adapter caught the issue.
//
//  Pure module — no I/O. Validators are sync; logging is fire-and-
//  forget (console.warn / console.error).
// ════════════════════════════════════════════════════════════════

import type { MarketSnapshot } from '@/types/market';
import { isMarketOpen } from './marketHours';
import { recordInvalidPayload } from '@/lib/monitor/institutionalHealth';

export type PayloadRejectReason =
  | 'PRICE_NON_POSITIVE'
  | 'PRICE_NOT_FINITE'
  | 'VOLUME_ZERO_DURING_MARKET_HOURS'
  | 'VOLUME_NEGATIVE'
  | 'VOLUME_NOT_FINITE'
  | 'CHANGE_NOT_FINITE'
  | 'CHANGE_PCT_NOT_FINITE'
  | 'OHLC_NOT_FINITE'
  | 'PREV_CLOSE_NOT_FINITE'
  | 'TIMESTAMP_NOT_FINITE'
  | 'SYMBOL_EMPTY';

export interface PayloadValidationResult {
  ok:      boolean;
  reasons: PayloadRejectReason[];
}

export interface PayloadValidationOpts {
  /** Override the market-hours check. Used by tests + by callers
   *  that want to validate a closed-market snapshot (volume=0 is
   *  legitimate then). When omitted, isMarketOpen() decides. */
  marketOpen?: boolean;
  /** Set true when the payload is from a delayed source (Yahoo,
   *  cache, EOD snapshot). Volume=0 is tolerated then because the
   *  data is end-of-day and the source may not carry intraday vol. */
  allowZeroVolume?: boolean;
}

/**
 * Validate a raw MarketSnapshot. Returns the per-row decision and
 * the list of reasons why a row failed (multiple may fire at once).
 * Pure — does not log. Use `logProviderInvalidPayload` separately
 * when you need to emit telemetry.
 */
export function validateMarketSnapshot(
  snap: Partial<MarketSnapshot> | null | undefined,
  opts: PayloadValidationOpts = {},
): PayloadValidationResult {
  const reasons: PayloadRejectReason[] = [];
  if (!snap) {
    return { ok: false, reasons: ['PRICE_NON_POSITIVE'] };
  }

  if (!snap.symbol || typeof snap.symbol !== 'string' || snap.symbol.trim() === '') {
    reasons.push('SYMBOL_EMPTY');
  }

  // Price must be a strictly positive finite number. We accept
  // EITHER `price` OR `ltp` since adapters are inconsistent about
  // which they populate first; the canonical contract is that BOTH
  // exist on a valid MarketSnapshot, so we check the strict path.
  const checkPrice = (v: unknown, label: PayloadRejectReason): void => {
    if (v == null) { reasons.push(label); return; }
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) reasons.push('PRICE_NOT_FINITE');
    else if (n <= 0)         reasons.push('PRICE_NON_POSITIVE');
  };
  checkPrice(snap.price, 'PRICE_NON_POSITIVE');
  // ltp is an alias — only validated to spot ltp=NaN when price is OK.
  if (snap.ltp != null) {
    const ltpN = typeof snap.ltp === 'number' ? snap.ltp : Number(snap.ltp);
    if (!Number.isFinite(ltpN)) reasons.push('PRICE_NOT_FINITE');
  }

  // Volume floor. During market hours volume=0 is suspect (the symbol
  // hasn't traded a single share so far today, or the provider is
  // returning a placeholder). Closed-market snapshots are exempt by
  // default — the explicit `marketOpen` opt overrides.
  const marketOpen = opts.marketOpen ?? isMarketOpen();
  const allowZeroVolume = opts.allowZeroVolume === true;
  const vol = snap.volume == null ? null : (typeof snap.volume === 'number' ? snap.volume : Number(snap.volume));
  if (vol == null) {
    // No volume field at all — treat like 0 below.
    if (marketOpen && !allowZeroVolume) reasons.push('VOLUME_ZERO_DURING_MARKET_HOURS');
  } else if (!Number.isFinite(vol)) {
    reasons.push('VOLUME_NOT_FINITE');
  } else if (vol < 0) {
    reasons.push('VOLUME_NEGATIVE');
  } else if (vol === 0 && marketOpen && !allowZeroVolume) {
    reasons.push('VOLUME_ZERO_DURING_MARKET_HOURS');
  }

  // change / changePercent must not be NaN/Infinity. They CAN be 0
  // (genuinely flat day) and they CAN be negative (loser).
  const checkFinite = (v: unknown, label: PayloadRejectReason): void => {
    if (v == null) return; // null is acceptable — adapter may not expose it
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) reasons.push(label);
  };
  checkFinite(snap.change,        'CHANGE_NOT_FINITE');
  checkFinite(snap.changePercent, 'CHANGE_PCT_NOT_FINITE');
  checkFinite(snap.open,          'OHLC_NOT_FINITE');
  checkFinite(snap.high,          'OHLC_NOT_FINITE');
  checkFinite(snap.low,           'OHLC_NOT_FINITE');
  checkFinite(snap.prevClose,     'PREV_CLOSE_NOT_FINITE');
  checkFinite(snap.timestamp,     'TIMESTAMP_NOT_FINITE');

  // De-dup reasons array — multiple OHLC fields all firing with
  // NaN should produce a single OHLC_NOT_FINITE entry.
  const seen = new Set<PayloadRejectReason>();
  const deduped: PayloadRejectReason[] = [];
  for (const r of reasons) {
    if (!seen.has(r)) { seen.add(r); deduped.push(r); }
  }
  return { ok: deduped.length === 0, reasons: deduped };
}

/**
 * Emit `[PROVIDER_INVALID_PAYLOAD]` + `[PROVIDER_REJECTED_SYMBOL]`
 * telemetry for a rejection. `rawSnapshot` is captured truncated so
 * the log stays under ~1KB even when upstream sends a verbose blob.
 */
export function logProviderInvalidPayload(
  provider: string,
  symbol:   string,
  reasons:  PayloadRejectReason[],
  rawSnapshot: unknown,
): void {
  // Truncated raw snapshot — keep under 200 chars so SRE log lines
  // stay scannable. JSON.stringify will throw on circular refs, so
  // wrap in try.
  let rawCompact: string;
  try {
    const s = typeof rawSnapshot === 'string' ? rawSnapshot : JSON.stringify(rawSnapshot);
    rawCompact = s.length > 200 ? s.slice(0, 197) + '...' : s;
  } catch {
    rawCompact = '[unserialisable]';
  }
  console.warn('[PROVIDER_INVALID_PAYLOAD]', {
    provider,
    symbol,
    reasons,
    raw_snapshot: rawCompact,
  });
  console.warn('[PROVIDER_REJECTED_SYMBOL]', {
    provider,
    symbol,
    reason: reasons[0] ?? 'UNKNOWN',
    reason_count: reasons.length,
  });
  // Bump SRE counters so /api/system/institutional-health surfaces
  // the rejection rate without parsing logs.
  recordInvalidPayload(provider, reasons[0] ?? null);
}

/**
 * Throwable error type for adapters that prefer fail-fast over
 * returning an empty result. Carries the structured rejection info
 * so the upstream catch can decide whether to retry, fall back, or
 * propagate.
 */
export class InvalidProviderPayloadError extends Error {
  readonly provider: string;
  readonly symbol:   string;
  readonly reasons:  PayloadRejectReason[];
  constructor(provider: string, symbol: string, reasons: PayloadRejectReason[]) {
    super(`${provider}:${symbol} payload invalid — ${reasons.join(', ')}`);
    this.name = 'InvalidProviderPayloadError';
    this.provider = provider;
    this.symbol   = symbol;
    this.reasons  = reasons;
  }
}

/**
 * One-shot validate-and-throw. Convenience helper for adapters that
 * want fail-fast semantics: if the payload is invalid, it logs +
 * throws InvalidProviderPayloadError. Otherwise returns the snapshot
 * unchanged. Generic over the snapshot type so an adapter that
 * returns an extended shape (e.g. `MarketSnapshot & { source }`)
 * keeps its narrow type.
 */
export function assertValidSnapshot<T extends Partial<MarketSnapshot>>(
  provider: string,
  snap: T,
  raw: unknown,
  opts?: PayloadValidationOpts,
): T {
  const result = validateMarketSnapshot(snap, opts);
  if (!result.ok) {
    const sym = snap?.symbol ?? '?';
    logProviderInvalidPayload(provider, String(sym), result.reasons, raw);
    throw new InvalidProviderPayloadError(provider, String(sym), result.reasons);
  }
  return snap;
}
