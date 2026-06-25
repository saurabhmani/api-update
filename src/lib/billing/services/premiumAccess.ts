// Premium Access Layer — feature gating + credit checks

import { PLAN_CATALOG } from '../constants/plans';
import {
  debitCredits,
  getActiveOverrides,
  getAdminOverridePlan,
  getOrCreateSubscription,
  getWalletBalances,
  recordUsage,
} from '../repository/billingRepository';
import type { CreditType, PremiumAccessResult, SubscriptionPlan } from '../types';

const FEATURE_CREDIT_MAP: Record<string, CreditType> = {
  ai_builder: 'ai_builder',
  strategy_lab: 'ai_builder',
  backtest: 'backtests',
  backtesting: 'backtests',
  research_report: 'research_reports',
  reports: 'research_reports',
  premium_signals: 'premium_signals',
  signals_advanced: 'premium_signals',
  top_opportunities: 'premium_signals',
};

const FEATURE_PLAN_REQUIREMENT: Record<string, SubscriptionPlan> = {
  trade_setups: 'pro',
  smart_watchlist_ranking: 'pro',
  smart_alerts_full: 'pro',
  option_intelligence: 'pro',
  top_opportunities: 'premium',
  trader_analytics: 'premium',
  market_explanation: 'premium',
};

function planRank(p: SubscriptionPlan): number {
  return ['free', 'pro', 'premium', 'enterprise'].indexOf(p);
}

export async function checkPremiumAccess(
  userId: number,
  featureKey: string,
  opts?: { role?: string; creditCost?: number },
): Promise<PremiumAccessResult> {
  if (opts?.role === 'admin') {
    return { allowed: true, plan: 'enterprise', upgradeRequired: false };
  }

  const overridePlan = await getAdminOverridePlan(userId);
  const sub = await getOrCreateSubscription(userId);
  const plan = overridePlan ?? sub.plan;
  const config = PLAN_CATALOG[plan];

  if (config.features.includes('__all')) {
    return { allowed: true, plan, upgradeRequired: false };
  }

  const requiredPlan = FEATURE_PLAN_REQUIREMENT[featureKey];
  if (requiredPlan && planRank(plan) < planRank(requiredPlan)) {
    return {
      allowed: false,
      plan,
      upgradeRequired: true,
      reason: `${featureKey} requires ${requiredPlan} plan or higher`,
    };
  }

  if (!config.features.includes(featureKey) && requiredPlan) {
    return {
      allowed: false,
      plan,
      upgradeRequired: true,
      reason: `Feature not included in ${plan} plan`,
    };
  }

  const creditType = FEATURE_CREDIT_MAP[featureKey];
  if (creditType) {
    const wallets = await getWalletBalances(userId);
    const wallet = wallets.find((w) => w.creditType === creditType);
    const cost = opts?.creditCost ?? 1;
    if (!wallet || wallet.balance < cost) {
      return {
        allowed: false,
        plan,
        upgradeRequired: true,
        creditType,
        creditsRemaining: wallet?.balance ?? 0,
        reason: `Insufficient ${creditType} credits`,
      };
    }
    return {
      allowed: true,
      plan,
      upgradeRequired: false,
      creditType,
      creditsRemaining: wallet.balance,
    };
  }

  return { allowed: true, plan, upgradeRequired: false };
}

export async function consumePremiumAccess(
  userId: number,
  featureKey: string,
  opts?: { creditCost?: number; metadata?: Record<string, unknown> },
): Promise<PremiumAccessResult> {
  const check = await checkPremiumAccess(userId, featureKey);
  if (!check.allowed) return check;

  const creditType = FEATURE_CREDIT_MAP[featureKey];
  if (creditType) {
    const cost = opts?.creditCost ?? 1;
    const debit = await debitCredits(userId, creditType, cost, `usage:${featureKey}`);
    if (!debit.ok) {
      return {
        allowed: false,
        plan: check.plan,
        upgradeRequired: true,
        creditType,
        creditsRemaining: debit.balance,
        reason: debit.error,
      };
    }
    await recordUsage(userId, creditType, cost, featureKey, opts?.metadata);
    return { ...check, creditsRemaining: debit.balance };
  }

  await recordUsage(userId, 'premium_signals', 1, featureKey, opts?.metadata);
  return check;
}

export async function getPremiumSummary(userId: number, role?: string) {
  const sub = await getOrCreateSubscription(userId);
  const overridePlan = await getAdminOverridePlan(userId);
  const plan = role === 'admin' ? 'enterprise' as SubscriptionPlan : (overridePlan ?? sub.plan);
  const wallets = await getWalletBalances(userId);
  const overrides = await getActiveOverrides(userId);
  const config = PLAN_CATALOG[plan];
  return {
    plan,
    subscription: sub,
    wallets,
    features: config.features,
    credits: config.credits,
    overrides,
    totalCreditsRemaining: wallets.reduce((s, w) => s + w.balance, 0),
  };
}
