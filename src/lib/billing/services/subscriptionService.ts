// Subscription service — plans, upgrades, billing

import { canUpgrade, PLAN_CATALOG } from '../constants/plans';
import {
  createInvoice,
  getOrCreateSubscription,
  markInvoicePaid,
  upsertSubscription,
} from '../repository/billingRepository';
import type { SubscriptionPlan } from '../types';

export async function getSubscriptionDetails(userId: number) {
  const sub = await getOrCreateSubscription(userId);
  const config = PLAN_CATALOG[sub.plan];
  return { subscription: sub, plan: config };
}

export async function subscribeToPlan(
  userId: number,
  plan: SubscriptionPlan,
): Promise<{ ok: boolean; subscription?: Awaited<ReturnType<typeof upsertSubscription>>; invoice?: Awaited<ReturnType<typeof createInvoice>>; error?: string }> {
  const config = PLAN_CATALOG[plan];
  if (config.priceInr <= 0) {
    const sub = await upsertSubscription(userId, plan);
    return { ok: true, subscription: sub };
  }

  const sub = await upsertSubscription(userId, plan, { status: 'active' });
  const invoice = await createInvoice(userId, plan, [{
    description: `${config.name} Plan — Monthly`,
    quantity: 1,
    unitPriceInr: config.priceInr,
  }]);
  await markInvoicePaid(invoice.id, userId);
  return { ok: true, subscription: sub, invoice };
}

export async function upgradeSubscription(
  userId: number,
  targetPlan: SubscriptionPlan,
): Promise<{ ok: boolean; error?: string; subscription?: Awaited<ReturnType<typeof upsertSubscription>>; invoice?: Awaited<ReturnType<typeof createInvoice>> }> {
  const current = await getOrCreateSubscription(userId);
  if (!canUpgrade(current.plan, targetPlan)) {
    return { ok: false, error: `Cannot upgrade from ${current.plan} to ${targetPlan}` };
  }
  return subscribeToPlan(userId, targetPlan);
}

export function listPlans() {
  return Object.values(PLAN_CATALOG);
}
