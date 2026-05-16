// ════════════════════════════════════════════════════════════════
//  Symbol Normalizer — Step 3.5 of the IndianAPI cutover.
//
//  Canonical form everyone uses internally:
//    { exchange: 'NSE' | 'BSE', symbol: 'RELIANCE', bseCode?: '500325' }
//
//  All resolver inputs and outputs use the canonical form. Per-provider
//  adapters convert at the boundary.
//
//  Why a dedicated module:
//    • The codebase historically had a Yahoo-suffix-aware
//      symbolNormalize.ts (`.NS` / `.BO`). That file is preserved for
//      backward compat with the legacy resolver chain. This module is
//      the new canonical path used by marketDataResolver and the
//      IndianAPI provider going forward.
//    • Resolver responses are keyed by `${exchange}:${symbol}` so that
//      'NSE:RELIANCE' and 'BSE:RELIANCE' (both legitimate) never collide.
// ════════════════════════════════════════════════════════════════

export type Exchange = 'NSE' | 'BSE';

export interface CanonicalSymbol {
  exchange: Exchange;
  symbol:   string;       // e.g. 'RELIANCE' (uppercase, no suffix)
  bseCode?: string;       // 6-digit BSE scrip code when applicable
}

/** `${exchange}:${symbol}` — the format every resolver consumer reads. */
export type CanonicalKey = string;

export function canonicalKey(s: CanonicalSymbol): CanonicalKey {
  return `${s.exchange}:${s.symbol}`;
}

// ── Normalisation primitives ──────────────────────────────────────

/** Strip whitespace, BOM, surrounding quotes; uppercase; collapse runs
 *  of whitespace; drop trailing `.NS` / `.BO` / `.BSE` Yahoo suffixes. */
function tidy(raw: string): string {
  let v = String(raw ?? '').trim();
  // Strip BOM at start.
  if (v.charCodeAt(0) === 0xFEFF) v = v.slice(1);
  // Strip surrounding quotes that sneak in from copy-pasted CSVs.
  v = v.replace(/^["']|["']$/g, '').trim();
  v = v.toUpperCase();
  // Yahoo suffixes — drop because they're a Yahoo-only artefact.
  v = v.replace(/\.(NS|BO|BSE)$/i, '');
  return v.replace(/\s+/g, '');
}

/** True when the input looks like a 6-digit BSE scrip code. */
function isBseCode(raw: string): boolean {
  return /^\d{6}$/.test(raw);
}

/** True when the input looks like an NSE/BSE-style ticker (alnum,
 *  ampersands, dashes, percent). RELIANCE, BAJAJ-AUTO, M&M, 360ONE,
 *  MCDOWELL-N all match; whitespace and dots fail (caught by `tidy`). */
function isNseLikeTicker(raw: string): boolean {
  return /^[A-Z0-9][A-Z0-9&\-%]*$/.test(raw);
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Best-effort canonicalisation. The optional `hint` is an exchange
 * the caller knows from context (e.g. "this came from the NSE
 * universe loader"). When unspecified, defaults to NSE — the
 * primary exchange this app trades.
 */
export function fromAny(
  raw: string,
  hint?: Exchange,
): CanonicalSymbol {
  const cleaned = tidy(raw);
  if (!cleaned) {
    return { exchange: hint ?? 'NSE', symbol: '' };
  }
  if (isBseCode(cleaned)) {
    return { exchange: 'BSE', symbol: cleaned, bseCode: cleaned };
  }
  // Default-NSE policy: anything that looks like a ticker gets the
  // NSE label unless the hint says BSE explicitly. The IndianAPI
  // single-symbol endpoint accepts the bare symbol name (no exchange
  // prefix), so this default is benign for IndianAPI calls; it only
  // matters for the canonicalKey + the NSE/BSE batch routing.
  const exchange: Exchange = hint ?? 'NSE';
  return { exchange, symbol: cleaned };
}

/** IndianAPI accepts the bare uppercase ticker. The exchange is
 *  expressed by which endpoint you hit (`/nse/...` vs `/bse/...`). */
export function toIndianApi(c: CanonicalSymbol): string {
  return c.symbol;
}

/** NSE direct fetch endpoint takes the bare ticker as the `symbol`
 *  query param — same value as canonical.symbol. */
export function toNse(c: CanonicalSymbol): string {
  return c.symbol;
}

/** Yahoo expects `<SYMBOL>.NS` for NSE and `<SYMBOL>.BO` for BSE.
 *  Caller is responsible for whether Yahoo is even allowed (gated by
 *  YAHOO_EMERGENCY_FALLBACK_ENABLED). */
export function toYahoo(c: CanonicalSymbol): string {
  return c.exchange === 'BSE' ? `${c.symbol}.BO` : `${c.symbol}.NS`;
}

/** Bulk variant — applies fromAny to every input, deduplicates by
 *  canonicalKey, and preserves first-seen order. Useful for resolver
 *  inputs where callers pass a flat string[] from the universe loader. */
export function fromManyToCanonical(
  inputs: string[],
  hint?: Exchange,
): CanonicalSymbol[] {
  const seen = new Set<string>();
  const out: CanonicalSymbol[] = [];
  for (const r of inputs) {
    const c = fromAny(r, hint);
    if (!c.symbol) continue;
    const k = canonicalKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** True when the canonical pair represents a valid tradeable symbol
 *  shape. Used by the resolver to drop garbage at the boundary. */
export function isValidCanonical(c: CanonicalSymbol): boolean {
  if (!c.symbol) return false;
  if (c.exchange === 'BSE' && c.bseCode) {
    return isBseCode(c.bseCode);
  }
  return isNseLikeTicker(c.symbol);
}
