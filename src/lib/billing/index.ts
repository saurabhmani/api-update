// Billing platform — public exports

export * from './types';
export { PLAN_CATALOG, CREDIT_TYPES, creditLabel, normalizePlan, canUpgrade, planRank } from './constants/plans';
export { ensureBillingTables } from './repository/billingRepository';
export {
  getSubscription,
  getOrCreateSubscription,
  upsertSubscription,
  getWalletBalances,
  debitCredits,
  creditWallet,
  rechargeWallet,
  recordUsage,
  listInvoices,
  getInvoiceById,
  markInvoicePaid,
  listPaymentTransactions,
  listCreditTransactions,
  listUsageLogs,
  setAdminOverride,
  getActiveOverrides,
} from './repository/billingRepository';
export { getWalletSummary, rechargeUserWallet } from './services/walletService';
export { checkPremiumAccess, consumePremiumAccess, getPremiumSummary } from './services/premiumAccess';
export {
  getSubscriptionDetails,
  subscribeToPlan,
  upgradeSubscription,
  listPlans,
} from './services/subscriptionService';
export { getUsageAnalytics } from './services/analyticsService';
