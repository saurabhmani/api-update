// ════════════════════════════════════════════════════════════════
//  Canonical Data Guard — Enforcement Layer
//
//  PRD Rule: Canonical data is the ONLY source of truth.
//  No service can bypass the canonical layer.
//
//  This module provides:
//    1. Input validation (reject non-canonical inputs)
//    2. Bypass detection logging
//    3. Typed validators for common patterns
//
//  Usage:
//    import { requireInstrumentId, requirePortfolioId } from '@/lib/canonicalGuard';
//    const id = requireInstrumentId(input.instrumentId, input.ticker);
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const log = logger.child({ component: 'canonicalGuard' });

// ── Counters for monitoring ─────────────────────────────────────

let _bypassCount = 0;
let _validCount = 0;

export function getGuardStats() {
  return { bypasses: _bypassCount, valid: _validCount };
}

// ── Validators ──────────────────────────────────────────────────

/**
 * Validate that an instrumentId is present and positive.
 * If missing, logs a bypass warning with the caller context.
 * Returns the instrumentId or 0 if invalid.
 */
export function requireInstrumentId(
  instrumentId: number | null | undefined,
  tickerFallback: string,
  callerContext: string,
): number {
  if (instrumentId && instrumentId > 0) {
    _validCount++;
    return instrumentId;
  }
  _bypassCount++;
  log.warn('Canonical bypass: instrumentId missing, falling back to ticker', {
    ticker: tickerFallback,
    caller: callerContext,
    bypassCount: _bypassCount,
  });
  return 0;
}

/**
 * Validate that a portfolioId is present and positive.
 */
export function requirePortfolioId(
  portfolioId: number | null | undefined,
  callerContext: string,
): number {
  if (portfolioId && portfolioId > 0) {
    _validCount++;
    return portfolioId;
  }
  _bypassCount++;
  log.warn('Canonical bypass: portfolioId missing', {
    caller: callerContext,
    bypassCount: _bypassCount,
  });
  return 0;
}

/**
 * Log a detected bypass of the canonical layer.
 * Used when a service directly queries a raw table instead of
 * going through the canonical service.
 */
export function logBypass(
  service: string,
  table: string,
  reason: string,
): void {
  _bypassCount++;
  log.warn('Canonical data bypass detected', {
    service,
    table,
    reason,
    bypassCount: _bypassCount,
  });
}

/**
 * Validate a ticker is not being used as a primary key.
 * Returns true if the value looks like an ID, false if it's a ticker.
 */
export function isCanonicalId(value: string | number): boolean {
  if (typeof value === 'number') return value > 0;
  const num = Number(value);
  return Number.isInteger(num) && num > 0;
}
