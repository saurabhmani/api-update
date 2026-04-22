// ════════════════════════════════════════════════════════════════
//  cooldownStore — per-symbol, per-reason cooldowns in Redis.
//
//  Used by the trigger engine and batch scheduler to avoid
//  re-deep-fetching the same symbol every cycle. Reasons are kept
//  separate so a deep-fetch cooldown doesn't block a news refresh.
//
//  Keys:  cooldown:<reason>:<SYMBOL>
//  TTL:   per-reason (see schedulerConfig)
// ════════════════════════════════════════════════════════════════

import { cacheGet, cacheSet, cacheDel } from '@/lib/redis';
import { CONFIG } from './schedulerConfig';

export type CooldownReason = 'deep' | 'news' | 'hist' | 'corp';

interface CooldownRecord {
  setAt: number;          // epoch ms
  expiresAt: number;      // epoch ms
  triggeredBy?: string;   // e.g. "pctChange:3.2,volume:3.1x"
}

function key(reason: CooldownReason, symbol: string): string {
  return `cooldown:${reason}:${symbol.trim().toUpperCase()}`;
}

function ttlMsFor(reason: CooldownReason): number {
  switch (reason) {
    case 'deep': return CONFIG.deepCooldownMs;
    case 'news': return CONFIG.newsCooldownMs;
    case 'hist': return CONFIG.histCooldownMs;
    case 'corp': return 6 * 60 * 60 * 1000;   // 6h
  }
}

/** Apply jitter so cooldowns from a single cycle don't expire in lockstep. */
function withJitter(ttlMs: number): number {
  const jitter = ttlMs * 0.1 * (Math.random() - 0.5) * 2;   // ±10%
  return Math.max(60_000, Math.round(ttlMs + jitter));
}

export async function setCooldown(
  symbol: string,
  reason: CooldownReason = 'deep',
  opts: { ttlMs?: number; triggeredBy?: string } = {},
): Promise<void> {
  const ttlMs = withJitter(opts.ttlMs ?? ttlMsFor(reason));
  const rec: CooldownRecord = {
    setAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    triggeredBy: opts.triggeredBy,
  };
  // Redis TTL is in seconds — and the helper respects that.
  await cacheSet(key(reason, symbol), rec, Math.ceil(ttlMs / 1000));
}

export async function isCoolingDown(
  symbol: string,
  reason: CooldownReason = 'deep',
): Promise<boolean> {
  const rec = await cacheGet<CooldownRecord>(key(reason, symbol));
  if (!rec) return false;
  // Defensive: cacheSet already respects TTL, but if Redis returned a
  // stale value due to clock drift we still honor expiresAt.
  return rec.expiresAt > Date.now();
}

export async function getCooldownRemainingMs(
  symbol: string,
  reason: CooldownReason = 'deep',
): Promise<number> {
  const rec = await cacheGet<CooldownRecord>(key(reason, symbol));
  if (!rec) return 0;
  return Math.max(0, rec.expiresAt - Date.now());
}

export async function clearCooldown(
  symbol: string,
  reason: CooldownReason = 'deep',
): Promise<void> {
  await cacheDel(key(reason, symbol));
}

/** Batch helper used by triggerEngine: given a list of candidates,
 *  return only those NOT currently in cooldown for the given reason. */
export async function filterNotCoolingDown(
  symbols: string[],
  reason: CooldownReason = 'deep',
): Promise<string[]> {
  const results = await Promise.all(
    symbols.map(async s => ({ s, cold: await isCoolingDown(s, reason) })),
  );
  return results.filter(r => !r.cold).map(r => r.s);
}
