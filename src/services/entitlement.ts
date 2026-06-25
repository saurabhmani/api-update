import { cacheGet, cacheSet } from '@/lib/redis';
import type { SessionUser } from '@/types';
import { FREE_DAILY_SIGNAL_LIMIT } from '@/lib/constants/features';
import { checkPremiumAccess, getPremiumSummary } from '@/lib/billing';
import { getOrCreateSubscription } from '@/lib/billing/repository/billingRepository';
import { normalizePlan } from '@/lib/billing/constants/plans';

export interface EntitlementResult {
  allowed:          boolean;
  plan:             string;
  upgrade_required: boolean;
  reason?:          string;
  credits_remaining?: number;
}

// ── Get user's current plan ───────────────────────────────────────
export async function getUserPlan(userId: number): Promise<string> {
  const cacheKey = `plan:${userId}`;
  const cached   = await cacheGet<string>(cacheKey);
  if (cached) return cached;

  const sub = await getOrCreateSubscription(userId);
  const plan = normalizePlan(sub.plan);
  await cacheSet(cacheKey, plan, 600);
  return plan;
}

// ── Check a specific feature ──────────────────────────────────────
export async function checkFeature(
  userId: number,
  featureKey: string,
  role: 'user' | 'admin' = 'user',
): Promise<EntitlementResult> {
  const result = await checkPremiumAccess(userId, featureKey, { role });
  return {
    allowed: result.allowed,
    plan: result.plan,
    upgrade_required: result.upgradeRequired,
    reason: result.reason,
    credits_remaining: result.creditsRemaining,
  };
}

// ── Check daily signal limit (free users) ─────────────────────────
export async function checkSignalDailyLimit(userId: number): Promise<{
  allowed: boolean; used: number; limit: number;
}> {
  const plan = await getUserPlan(userId);
  if (plan !== 'free') return { allowed: true, used: 0, limit: 999 };

  const today    = new Date().toISOString().split('T')[0];
  const redisKey = `signals:daily:${userId}:${today}`;
  const cached   = await cacheGet<number>(redisKey);
  const used     = cached ?? 0;

  return {
    allowed: used < FREE_DAILY_SIGNAL_LIMIT,
    used,
    limit: FREE_DAILY_SIGNAL_LIMIT,
  };
}

// ── Increment signal usage counter ────────────────────────────────
export async function incrementSignalUsage(userId: number): Promise<void> {
  const plan = await getUserPlan(userId);
  if (plan !== 'free') return;

  const today    = new Date().toISOString().split('T')[0];
  const redisKey = `signals:daily:${userId}:${today}`;
  const current  = (await cacheGet<number>(redisKey)) ?? 0;
  const now   = new Date();
  const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
  const ttl   = Math.floor((midnight.getTime() - now.getTime()) / 1000);
  await cacheSet(redisKey, current + 1, ttl);
}

// ── Get all user features at once ────────────────────────────────
export async function getAllUserFeatures(user: SessionUser): Promise<{
  plan: string; features: Record<string, boolean>;
  signals_used_today: number; signals_limit: number;
  wallets?: Awaited<ReturnType<typeof getPremiumSummary>>['wallets'];
  credits?: Record<string, number>;
}> {
  if (user.role === 'admin') {
    return { plan: 'enterprise', features: { __all: true }, signals_used_today: 0, signals_limit: 999 };
  }

  const summary = await getPremiumSummary(user.id, user.role);
  const features: Record<string, boolean> = {};
  for (const f of summary.features) features[f] = true;

  const { used, limit } = await checkSignalDailyLimit(user.id);
  const credits: Record<string, number> = {};
  for (const w of summary.wallets) credits[w.creditType] = w.balance;

  return {
    plan: summary.plan,
    features,
    signals_used_today: used,
    signals_limit: limit,
    wallets: summary.wallets,
    credits,
  };
}
