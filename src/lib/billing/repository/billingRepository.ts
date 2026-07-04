// Billing — MySQL persistence + runtime migration

import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { cacheDel } from '@/lib/redis';
import { CREDIT_TYPES, PLAN_CATALOG, normalizePlan } from '../constants/plans';
import type {
  CreditType,
  InvoiceRecord,
  SubscriptionPlan,
  SubscriptionRecord,
  WalletBalance,
} from '../types';

let migrated = false;

export async function ensureBillingTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        plan VARCHAR(32) NOT NULL DEFAULT 'free',
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        billing_cycle VARCHAR(16) NOT NULL DEFAULT 'monthly',
        price_inr DECIMAL(12,2) NOT NULL DEFAULT 0,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        cancelled_at DATETIME,
        provider VARCHAR(32),
        provider_sub_id VARCHAR(128),
        metadata_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_subscriptions_plan (plan, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_wallets (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        credit_type VARCHAR(32) NOT NULL,
        balance INT NOT NULL DEFAULT 0,
        monthly_allocation INT NOT NULL DEFAULT 0,
        last_reset_at DATE,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_wallet_user_credit (user_id, credit_type),
        INDEX idx_user_wallets_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        credit_type VARCHAR(32) NOT NULL,
        amount INT NOT NULL,
        balance_after INT NOT NULL,
        reason VARCHAR(64) NOT NULL,
        reference_id VARCHAR(64),
        actor VARCHAR(100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credit_tx_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS billing_usage_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        credit_type VARCHAR(32) NOT NULL,
        feature_key VARCHAR(64),
        quantity INT NOT NULL DEFAULT 1,
        metadata_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_usage_events_user (user_id, created_at),
        INDEX idx_usage_events_type (credit_type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        invoice_number VARCHAR(32) NOT NULL UNIQUE,
        plan VARCHAR(32) NOT NULL,
        subtotal_inr DECIMAL(12,2) NOT NULL,
        tax_inr DECIMAL(12,2) NOT NULL DEFAULT 0,
        total_inr DECIMAL(12,2) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'draft',
        period_start DATE,
        period_end DATE,
        paid_at DATETIME,
        due_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invoices_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        invoice_id VARCHAR(64) NOT NULL,
        description TEXT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        unit_price_inr DECIMAL(12,2) NOT NULL,
        total_inr DECIMAL(12,2) NOT NULL,
        INDEX idx_invoice_items (invoice_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        invoice_id VARCHAR(64),
        amount_inr DECIMAL(12,2) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'completed',
        payment_method VARCHAR(32) NOT NULL DEFAULT 'manual',
        reference_id VARCHAR(128),
        metadata_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_payment_tx_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS billing_admin_overrides (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        override_type VARCHAR(32) NOT NULL,
        override_value VARCHAR(128) NOT NULL,
        reason TEXT,
        actor VARCHAR(100) NOT NULL,
        expires_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_override_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Keep legacy user_plans in sync
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_plans (
        user_id INT PRIMARY KEY,
        plan VARCHAR(32) NOT NULL DEFAULT 'free',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch {
    migrated = true;
  }
}

async function invalidatePlanCache(userId: number): Promise<void> {
  try { await cacheDel(`plan:${userId}`); } catch { /* noop */ }
}

export async function getSubscription(userId: number): Promise<SubscriptionRecord | null> {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT * FROM subscriptions WHERE user_id = ? LIMIT 1`, [userId],
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return mapSubscription(r);
}

function mapSubscription(r: Record<string, unknown>): SubscriptionRecord {
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    plan: normalizePlan(String(r.plan)),
    status: String(r.status) as SubscriptionRecord['status'],
    billingCycle: String(r.billing_cycle),
    priceInr: Number(r.price_inr),
    startedAt: String(r.started_at),
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    cancelledAt: r.cancelled_at ? String(r.cancelled_at) : null,
  };
}

export async function upsertSubscription(
  userId: number,
  plan: SubscriptionPlan,
  opts?: { status?: string; billingCycle?: string; expiresAt?: string },
): Promise<SubscriptionRecord> {
  await ensureBillingTables();
  const config = PLAN_CATALOG[plan];
  const existing = await getSubscription(userId);
  const id = existing?.id ?? `sub_${uuidv4().slice(0, 12)}`;
  const expires = opts?.expiresAt ?? null;

  await db.query(
    `INSERT INTO subscriptions
       (id, user_id, plan, status, billing_cycle, price_inr, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       plan=VALUES(plan), status=VALUES(status), billing_cycle=VALUES(billing_cycle),
       price_inr=VALUES(price_inr), expires_at=VALUES(expires_at), updated_at=NOW()`,
    [
      id, userId, plan, opts?.status ?? 'active',
      opts?.billingCycle ?? config.billingCycle, config.priceInr, expires,
    ],
  );

  await db.query(
    `INSERT INTO user_plans (user_id, plan, started_at, expires_at)
     VALUES (?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE plan=VALUES(plan), expires_at=VALUES(expires_at)`,
    [userId, plan, expires],
  );

  await seedWalletsForPlan(userId, plan);
  await invalidatePlanCache(userId);
  return (await getSubscription(userId))!;
}

export async function seedWalletsForPlan(userId: number, plan: SubscriptionPlan): Promise<void> {
  await ensureBillingTables();
  const config = PLAN_CATALOG[plan];
  const today = new Date().toISOString().slice(0, 10);
  for (const creditType of CREDIT_TYPES) {
    const allocation = config.credits[creditType];
    const walletId = `w_${userId}_${creditType}`;
    await db.query(
      `INSERT INTO user_wallets (id, user_id, credit_type, balance, monthly_allocation, last_reset_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         monthly_allocation=VALUES(monthly_allocation),
         balance=GREATEST(balance, VALUES(monthly_allocation)),
         last_reset_at=VALUES(last_reset_at), updated_at=NOW()`,
      [walletId, userId, creditType, allocation, allocation, today],
    );
  }
}

export async function getWalletBalances(userId: number): Promise<WalletBalance[]> {
  await ensureBillingTables();
  const sub = await getOrCreateSubscription(userId);
  await ensureWalletTypes(userId, sub.plan);
  await resetWalletsIfNeeded(userId, sub.plan);
  const { rows } = await db.query(
    `SELECT * FROM user_wallets WHERE user_id = ? ORDER BY credit_type`,
    [userId],
  );
  if (!rows.length) {
    await seedWalletsForPlan(userId, sub.plan);
    return getWalletBalances(userId);
  }
  return rows.map((r) => ({
    creditType: String((r as Record<string, unknown>).credit_type) as CreditType,
    balance: Number((r as Record<string, unknown>).balance),
    monthlyAllocation: Number((r as Record<string, unknown>).monthly_allocation),
    lastResetAt: (r as Record<string, unknown>).last_reset_at
      ? String((r as Record<string, unknown>).last_reset_at) : null,
  }));
}

async function ensureWalletTypes(userId: number, plan: SubscriptionPlan): Promise<void> {
  const config = PLAN_CATALOG[plan];
  const { rows } = await db.query(
    `SELECT credit_type FROM user_wallets WHERE user_id = ?`,
    [userId],
  );
  const existing = new Set(rows.map((r) => String((r as Record<string, unknown>).credit_type)));
  const today = new Date().toISOString().slice(0, 10);
  for (const creditType of CREDIT_TYPES) {
    if (existing.has(creditType)) continue;
    await db.query(
      `INSERT INTO user_wallets (id, user_id, credit_type, balance, monthly_allocation, last_reset_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`w_${userId}_${creditType}`, userId, creditType, config.credits[creditType], config.credits[creditType], today],
    );
  }
}

async function resetWalletsIfNeeded(userId: number, plan: SubscriptionPlan): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await db.query(
    `SELECT credit_type, last_reset_at FROM user_wallets WHERE user_id = ?`, [userId],
  );
  const config = PLAN_CATALOG[plan];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const resetAt = r.last_reset_at ? String(r.last_reset_at).slice(0, 10) : null;
    if (resetAt === today) continue;
    const creditType = String(r.credit_type) as CreditType;
    const allocation = config.credits[creditType];
    await db.query(
      `UPDATE user_wallets SET balance=?, monthly_allocation=?, last_reset_at=?, updated_at=NOW()
       WHERE user_id=? AND credit_type=?`,
      [allocation, allocation, today, userId, creditType],
    );
  }
}

export async function getOrCreateSubscription(userId: number): Promise<SubscriptionRecord> {
  let sub = await getSubscription(userId);
  if (sub) return sub;
  // Fallback to legacy user_plans
  const { rows } = await db.query(`SELECT plan, expires_at FROM user_plans WHERE user_id=?`, [userId]);
  const plan = normalizePlan(rows[0]?.plan ?? 'free');
  return upsertSubscription(userId, plan, {
    expiresAt: rows[0]?.expires_at ? String(rows[0].expires_at) : undefined,
  });
}

export async function debitCredits(
  userId: number,
  creditType: CreditType,
  amount: number,
  reason: string,
  referenceId?: string,
): Promise<{ ok: boolean; balance: number; error?: string }> {
  await ensureBillingTables();
  const balances = await getWalletBalances(userId);
  const wallet = balances.find((w) => w.creditType === creditType);
  if (!wallet || wallet.balance < amount) {
    return { ok: false, balance: wallet?.balance ?? 0, error: 'Insufficient credits' };
  }
  const newBalance = wallet.balance - amount;
  await db.query(
    `UPDATE user_wallets SET balance=?, updated_at=NOW() WHERE user_id=? AND credit_type=?`,
    [newBalance, userId, creditType],
  );
  await db.query(
    `INSERT INTO credit_transactions
       (user_id, credit_type, amount, balance_after, reason, reference_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, creditType, -amount, newBalance, reason, referenceId ?? null],
  );
  return { ok: true, balance: newBalance };
}

export async function creditWallet(
  userId: number,
  creditType: CreditType,
  amount: number,
  reason: string,
  actor?: string,
): Promise<number> {
  await ensureBillingTables();
  await getOrCreateSubscription(userId);
  const { rows } = await db.query(
    `SELECT balance FROM user_wallets WHERE user_id=? AND credit_type=?`,
    [userId, creditType],
  );
  const current = Number(rows[0]?.balance ?? 0);
  const newBalance = current + amount;
  await db.query(
    `UPDATE user_wallets SET balance=?, updated_at=NOW() WHERE user_id=? AND credit_type=?`,
    [newBalance, userId, creditType],
  );
  await db.query(
    `INSERT INTO credit_transactions
       (user_id, credit_type, amount, balance_after, reason, actor)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, creditType, amount, newBalance, reason, actor ?? null],
  );
  return newBalance;
}

export async function recordUsage(
  userId: number,
  creditType: CreditType,
  quantity: number,
  featureKey?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await ensureBillingTables();
  await db.query(
    `INSERT INTO billing_usage_events (user_id, credit_type, feature_key, quantity, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, creditType, featureKey ?? null, quantity, metadata ? JSON.stringify(metadata) : null],
  );
}

export async function getUsageStats(
  userId: number,
  days = 30,
): Promise<{ creditType: CreditType; total: number }[]> {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT credit_type, SUM(quantity) AS total FROM billing_usage_events
     WHERE user_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY credit_type`,
    [userId, days],
  );
  return rows.map((r) => ({
    creditType: String((r as Record<string, unknown>).credit_type) as CreditType,
    total: Number((r as Record<string, unknown>).total),
  }));
}

export async function getDailyUsage(userId: number, days = 30) {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT DATE(created_at) AS day, SUM(quantity) AS total
     FROM billing_usage_events WHERE user_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(created_at) ORDER BY day`,
    [userId, days],
  );
  return rows.map((r) => ({
    date: String((r as Record<string, unknown>).day).slice(0, 10),
    total: Number((r as Record<string, unknown>).total),
  }));
}

export async function getTopFeatures(userId: number, days = 30, limit = 10) {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT feature_key, SUM(quantity) AS total FROM billing_usage_events
     WHERE user_id=? AND feature_key IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY feature_key ORDER BY total DESC LIMIT ?`,
    [userId, days, limit],
  );
  return rows.map((r) => ({
    feature: String((r as Record<string, unknown>).feature_key),
    count: Number((r as Record<string, unknown>).total),
  }));
}

let invoiceSeq = 0;
export async function createInvoice(
  userId: number,
  plan: SubscriptionPlan,
  items: { description: string; quantity: number; unitPriceInr: number }[],
): Promise<InvoiceRecord> {
  await ensureBillingTables();
  invoiceSeq += 1;
  const id = `inv_${uuidv4().slice(0, 10)}`;
  const invoiceNumber = `Q365-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}${invoiceSeq}`;
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPriceInr, 0);
  const tax = Math.round(subtotal * 0.18 * 100) / 100;
  const total = subtotal + tax;
  const now = new Date();
  const periodEnd = new Date(now); periodEnd.setMonth(periodEnd.getMonth() + 1);

  await db.query(
    `INSERT INTO invoices
       (id, user_id, invoice_number, plan, subtotal_inr, tax_inr, total_inr, status,
        period_start, period_end, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', CURDATE(), ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
    [id, userId, invoiceNumber, plan, subtotal, tax, total, periodEnd.toISOString().slice(0, 10)],
  );
  for (const item of items) {
    await db.query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_inr, total_inr)
       VALUES (?, ?, ?, ?, ?)`,
      [id, item.description, item.quantity, item.unitPriceInr, item.quantity * item.unitPriceInr],
    );
  }
  return (await getInvoiceById(id))!;
}

export async function getInvoiceById(id: string): Promise<InvoiceRecord | null> {
  await ensureBillingTables();
  const { rows } = await db.query(`SELECT * FROM invoices WHERE id=? LIMIT 1`, [id]);
  if (!rows.length) return null;
  const inv = mapInvoice(rows[0] as Record<string, unknown>);
  const { rows: items } = await db.query(
    `SELECT * FROM invoice_items WHERE invoice_id=?`, [id],
  );
  inv.items = items.map((i) => ({
    description: String((i as Record<string, unknown>).description),
    quantity: Number((i as Record<string, unknown>).quantity),
    unitPriceInr: Number((i as Record<string, unknown>).unit_price_inr),
    totalInr: Number((i as Record<string, unknown>).total_inr),
  }));
  return inv;
}

function mapInvoice(r: Record<string, unknown>): InvoiceRecord {
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    invoiceNumber: String(r.invoice_number),
    plan: normalizePlan(String(r.plan)),
    subtotalInr: Number(r.subtotal_inr),
    taxInr: Number(r.tax_inr),
    totalInr: Number(r.total_inr),
    status: String(r.status) as InvoiceRecord['status'],
    periodStart: r.period_start ? String(r.period_start) : null,
    periodEnd: r.period_end ? String(r.period_end) : null,
    paidAt: r.paid_at ? String(r.paid_at) : null,
    dueAt: r.due_at ? String(r.due_at) : null,
    createdAt: String(r.created_at),
  };
}

export async function listInvoices(userId: number, limit = 20): Promise<InvoiceRecord[]> {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT * FROM invoices WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => mapInvoice(r as Record<string, unknown>));
}

export async function markInvoicePaid(id: string, userId?: number): Promise<void> {
  await ensureBillingTables();
  const inv = await getInvoiceById(id);
  await db.query(
    `UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=?`, [id],
  );
  if (inv) {
    await recordPaymentTransaction({
      userId: userId ?? inv.userId,
      invoiceId: id,
      amountInr: inv.totalInr,
      status: 'completed',
      paymentMethod: 'subscription',
      referenceId: inv.invoiceNumber,
    });
  }
}

export async function recordPaymentTransaction(entry: {
  userId: number;
  invoiceId?: string;
  amountInr: number;
  status?: string;
  paymentMethod?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  await ensureBillingTables();
  const id = `pay_${uuidv4().slice(0, 12)}`;
  await db.query(
    `INSERT INTO payment_transactions
       (id, user_id, invoice_id, amount_inr, status, payment_method, reference_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, entry.userId, entry.invoiceId ?? null, entry.amountInr,
      entry.status ?? 'completed', entry.paymentMethod ?? 'manual',
      entry.referenceId ?? null, entry.metadata ? JSON.stringify(entry.metadata) : null,
    ],
  );
  return id;
}

export async function listPaymentTransactions(userId: number, limit = 50) {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT * FROM payment_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: String((r as Record<string, unknown>).id),
    userId: Number((r as Record<string, unknown>).user_id),
    invoiceId: (r as Record<string, unknown>).invoice_id ? String((r as Record<string, unknown>).invoice_id) : null,
    amountInr: Number((r as Record<string, unknown>).amount_inr),
    status: String((r as Record<string, unknown>).status),
    paymentMethod: String((r as Record<string, unknown>).payment_method),
    referenceId: (r as Record<string, unknown>).reference_id ? String((r as Record<string, unknown>).reference_id) : null,
    createdAt: String((r as Record<string, unknown>).created_at),
  }));
}

export async function listCreditTransactions(userId: number, limit = 50) {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT * FROM credit_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number((r as Record<string, unknown>).id),
    userId: Number((r as Record<string, unknown>).user_id),
    creditType: String((r as Record<string, unknown>).credit_type),
    amount: Number((r as Record<string, unknown>).amount),
    balanceAfter: Number((r as Record<string, unknown>).balance_after),
    reason: String((r as Record<string, unknown>).reason),
    referenceId: (r as Record<string, unknown>).reference_id ? String((r as Record<string, unknown>).reference_id) : null,
    createdAt: String((r as Record<string, unknown>).created_at),
  }));
}

export async function listUsageLogs(userId: number, limit = 100) {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT * FROM billing_usage_events WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number((r as Record<string, unknown>).id),
    userId: Number((r as Record<string, unknown>).user_id),
    creditType: String((r as Record<string, unknown>).credit_type),
    featureKey: (r as Record<string, unknown>).feature_key ? String((r as Record<string, unknown>).feature_key) : null,
    quantity: Number((r as Record<string, unknown>).quantity),
    createdAt: String((r as Record<string, unknown>).created_at),
  }));
}

export async function rechargeWallet(
  userId: number,
  creditType: CreditType,
  amount: number,
  paymentMethod = 'recharge',
  referenceId?: string,
): Promise<{ balance: number; paymentId: string }> {
  const balance = await creditWallet(userId, creditType, amount, 'recharge', 'user');
  const paymentId = await recordPaymentTransaction({
    userId,
    amountInr: amount * 10,
    status: 'completed',
    paymentMethod,
    referenceId,
    metadata: { creditType, credits: amount },
  });
  return { balance, paymentId };
}

export async function setAdminOverride(
  userId: number,
  overrideType: string,
  overrideValue: string,
  actor: string,
  reason?: string,
  expiresAt?: string,
): Promise<void> {
  await ensureBillingTables();
  await db.query(
    `INSERT INTO billing_admin_overrides (user_id, override_type, override_value, reason, actor, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, overrideType, overrideValue, reason ?? null, actor, expiresAt ?? null],
  );
  if (overrideType === 'plan') {
    await upsertSubscription(userId, normalizePlan(overrideValue));
  }
  if (overrideType === 'credits') {
    const [creditType, amount] = overrideValue.split(':');
    if (creditType && amount) {
      await creditWallet(userId, creditType as CreditType, Number(amount), 'admin_override', actor);
    }
  }
  await invalidatePlanCache(userId);
}

export async function getActiveOverrides(userId: number) {
  await ensureBillingTables();
  const { rows } = await db.query(
    `SELECT * FROM billing_admin_overrides WHERE user_id=?
     AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC`,
    [userId],
  );
  return rows;
}

export async function getAdminOverridePlan(userId: number): Promise<SubscriptionPlan | null> {
  const overrides = await getActiveOverrides(userId);
  const planOverride = overrides.find(
    (o) => String((o as Record<string, unknown>).override_type) === 'plan',
  );
  if (!planOverride) return null;
  return normalizePlan(String((planOverride as Record<string, unknown>).override_value));
}
