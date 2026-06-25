// Subscription plan definitions — Free, Pro, Premium, Enterprise

import type { CreditType, PlanConfig, SubscriptionPlan } from '../types';

export const CREDIT_TYPES: CreditType[] = [
  'ai_builder',
  'backtests',
  'research_reports',
  'premium_signals',
];

export const PLAN_CATALOG: Record<SubscriptionPlan, PlanConfig> = {
  free: {
    id: 'free',
    name: 'Free',
    priceInr: 0,
    billingCycle: 'monthly',
    credits: {
      ai_builder: 3,
      backtests: 2,
      research_reports: 1,
      premium_signals: 5,
    },
    features: ['signals_basic', 'onboarding'],
    description: 'Essential market intelligence for getting started.',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceInr: 2999,
    billingCycle: 'monthly',
    credits: {
      ai_builder: 25,
      backtests: 20,
      research_reports: 10,
      premium_signals: 50,
    },
    features: [
      'signals_basic', 'signals_advanced', 'trade_setups', 'smart_watchlist_ranking',
      'smart_alerts_full', 'option_intelligence', 'onboarding',
    ],
    description: 'Active traders — advanced signals, setups, and option intelligence.',
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    priceInr: 7999,
    billingCycle: 'monthly',
    credits: {
      ai_builder: 100,
      backtests: 75,
      research_reports: 40,
      premium_signals: 200,
    },
    features: [
      'signals_basic', 'signals_advanced', 'trade_setups', 'smart_watchlist_ranking',
      'smart_alerts_full', 'option_intelligence', 'top_opportunities',
      'trader_analytics', 'market_explanation', 'onboarding',
    ],
    description: 'Power users — top opportunities, analytics, and deep research.',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceInr: 24999,
    billingCycle: 'monthly',
    credits: {
      ai_builder: 500,
      backtests: 500,
      research_reports: 200,
      premium_signals: 1000,
    },
    features: ['__all'],
    description: 'Teams and institutions — unlimited access with priority support.',
  },
};

export const PLAN_ORDER: SubscriptionPlan[] = ['free', 'pro', 'premium', 'enterprise'];

export function planRank(plan: SubscriptionPlan): number {
  return PLAN_ORDER.indexOf(plan);
}

export function canUpgrade(from: SubscriptionPlan, to: SubscriptionPlan): boolean {
  return planRank(to) > planRank(from);
}

export function creditLabel(type: CreditType): string {
  const labels: Record<CreditType, string> = {
    ai_builder: 'AI Builder',
    backtests: 'Backtests',
    research_reports: 'Research Reports',
    premium_signals: 'Premium Signals',
  };
  return labels[type];
}

export function normalizePlan(plan: string): SubscriptionPlan {
  if (plan === 'elite') return 'premium';
  if (PLAN_ORDER.includes(plan as SubscriptionPlan)) return plan as SubscriptionPlan;
  return 'free';
}
