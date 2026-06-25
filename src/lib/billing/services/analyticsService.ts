// Usage analytics service

import { PLAN_CATALOG } from '../constants/plans';
import { CREDIT_TYPES } from '../constants/plans';
import {
  getDailyUsage,
  getOrCreateSubscription,
  getTopFeatures,
  getUsageStats,
  getWalletBalances,
} from '../repository/billingRepository';
import type { CreditType, UsageAnalytics } from '../types';

export async function getUsageAnalytics(userId: number, days = 30): Promise<UsageAnalytics> {
  const sub = await getOrCreateSubscription(userId);
  const config = PLAN_CATALOG[sub.plan];
  const stats = await getUsageStats(userId, days);
  const wallets = await getWalletBalances(userId);
  const byDay = await getDailyUsage(userId, days);
  const topFeatures = await getTopFeatures(userId, days);

  const byCreditType = {} as UsageAnalytics['byCreditType'];
  for (const ct of CREDIT_TYPES) {
    const used = stats.find((s) => s.creditType === ct)?.total ?? 0;
    const limit = config.credits[ct as CreditType];
    byCreditType[ct as CreditType] = { used, limit };
  }

  return {
    period: `last_${days}_days`,
    byCreditType,
    byDay,
    topFeatures,
  };
}
