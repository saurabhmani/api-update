// Wallet service — balance, recharge, transaction history

import {
  getOrCreateSubscription,
  getWalletBalances,
  listCreditTransactions,
  listPaymentTransactions,
  listUsageLogs,
  rechargeWallet,
} from '../repository/billingRepository';
import { PLAN_CATALOG } from '../constants/plans';
import type { CreditType } from '../types';

export async function getWalletSummary(userId: number) {
  const sub = await getOrCreateSubscription(userId);
  const wallets = await getWalletBalances(userId);
  const transactions = await listCreditTransactions(userId, 30);
  const payments = await listPaymentTransactions(userId, 20);
  const usageLogs = await listUsageLogs(userId, 50);
  const config = PLAN_CATALOG[sub.plan];

  return {
    plan: sub.plan,
    subscription: sub,
    wallets,
    credits: config.credits,
    totalBalance: wallets.reduce((s, w) => s + w.balance, 0),
    transactions,
    payments,
    usageLogs,
  };
}

export async function rechargeUserWallet(
  userId: number,
  creditType: CreditType,
  amount: number,
  referenceId?: string,
) {
  if (amount <= 0) throw new Error('Recharge amount must be positive');
  return rechargeWallet(userId, creditType, amount, 'recharge', referenceId);
}
