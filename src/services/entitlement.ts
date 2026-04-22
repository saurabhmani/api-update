import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import type { SessionUser } from '@/types';
import { FREE_DAILY_SIGNAL_LIMIT } from '@/lib/constants/features';

export interface EntitlementResult {
  allowed:          boolean;
  plan:             string;
  upgrade_required: boolean;
  reason?:          string;
}

// ── Get user's current plan ───────────────────────────────────────
export async function getUserPlan(userId: number): Promise<string> {
  const cacheKey = `plan:${userId}`;
  const cached   = await cacheGet<string>(cacheKey);
  if (cached) return cached;

  const { rows } = await db.query(
    `SELECT plan FROM user_plans WHERE user_id=?`, [userId]
  );
  const plan = rows[0]?.plan ?? 'free';
  await cacheSet(cacheKey, plan, 600); // cache 10 min
  return plan;
}

// ── Check a specific feature ──────────────────────────────────────
export async function checkFeature(
  userId: number,
  featureKey: string,
  role: 'user' | 'admin' = 'user'
): Promise<EntitlementResult> {
  // Admins always get everything
  if (role === 'admin') return { allowed: true, plan: 'admin', upgrade_required: false };

  const plan = await getUserPlan(userId);

  // Check entitlement
  const { rows } = await db.query(
    `SELECT enabled FROM feature_entitlements WHERE plan=? AND feature_key=?`,
    [plan, featureKey]
  );

  if (!rows.length) return { allowed: true, plan, upgrade_required: false }; // unknown feature = allow
  if (rows[0].enabled) return { allowed: true, plan, upgrade_required: false };

  return {
    allowed:          false,
    plan,
    upgrade_required: true,
    reason:           `This feature requires a higher plan. You are on ${plan}.`,
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
  // TTL = seconds until midnight
  const now   = new Date();
  const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
  const ttl   = Math.floor((midnight.getTime() - now.getTime()) / 1000);
  await cacheSet(redisKey, current + 1, ttl);
}

// ── Get all user features at once ────────────────────────────────
export async function getAllUserFeatures(user: SessionUser): Promise<{
  plan: string; features: Record<string, boolean>;
  signals_used_today: number; signals_limit: number;
}> {
  if (user.role === 'admin') {
    return { plan: 'admin', features: { __all: true }, signals_used_today: 0, signals_limit: 999 };
  }

  const plan = await getUserPlan(user.id);
  const { rows } = await db.query(
    `SELECT feature_key, enabled FROM feature_entitlements WHERE plan=?`, [plan]
  );

  const features: Record<string, boolean> = {};
  for (const row of rows) features[row.feature_key] = row.enabled;

  const { used, limit } = await checkSignalDailyLimit(user.id);

  return { plan, features, signals_used_today: used, signals_limit: limit };
}
