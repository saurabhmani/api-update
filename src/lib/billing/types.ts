// SaaS Billing — types

export type SubscriptionPlan = 'free' | 'pro' | 'premium' | 'enterprise';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';
export type CreditType = 'ai_builder' | 'backtests' | 'research_reports' | 'premium_signals';
export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'overdue';

export interface PlanConfig {
  id: SubscriptionPlan;
  name: string;
  priceInr: number;
  billingCycle: 'monthly' | 'annual';
  credits: Record<CreditType, number>;
  features: string[];
  description: string;
}

export interface WalletBalance {
  creditType: CreditType;
  balance: number;
  monthlyAllocation: number;
  lastResetAt?: string | null;
}

export interface WalletSummary {
  userId: number;
  plan: SubscriptionPlan;
  wallets: WalletBalance[];
  totalCreditsRemaining: number;
}

export interface UsageEvent {
  id: number;
  userId: number;
  creditType: CreditType;
  featureKey?: string | null;
  quantity: number;
  createdAt: string;
}

export interface SubscriptionRecord {
  id: string;
  userId: number;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  billingCycle: string;
  priceInr: number;
  startedAt: string;
  expiresAt?: string | null;
  cancelledAt?: string | null;
}

export interface InvoiceRecord {
  id: string;
  userId: number;
  invoiceNumber: string;
  plan: SubscriptionPlan;
  subtotalInr: number;
  taxInr: number;
  totalInr: number;
  status: InvoiceStatus;
  periodStart?: string | null;
  periodEnd?: string | null;
  paidAt?: string | null;
  dueAt?: string | null;
  createdAt: string;
  items?: InvoiceItem[];
}

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPriceInr: number;
  totalInr: number;
}

export interface PremiumAccessResult {
  allowed: boolean;
  plan: SubscriptionPlan;
  upgradeRequired: boolean;
  creditType?: CreditType;
  creditsRemaining?: number;
  reason?: string;
}

export interface UsageAnalytics {
  period: string;
  byCreditType: Record<CreditType, { used: number; limit: number }>;
  byDay: Array<{ date: string; total: number }>;
  topFeatures: Array<{ feature: string; count: number }>;
}

export interface AdminOverride {
  userId: number;
  overrideType: 'plan' | 'credits' | 'feature';
  overrideValue: string;
  reason?: string;
  actor: string;
  expiresAt?: string;
}
