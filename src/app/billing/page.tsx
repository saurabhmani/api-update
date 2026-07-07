'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CreditCard, FileText, BarChart3, Wallet, Zap, RefreshCw,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Input, Loading, AlertBanner } from '@/components/ui';
import { fmt } from '@/lib/utils';
import styles from './billing.module.scss';

type Tab = 'billing' | 'wallet' | 'plans' | 'access' | 'usage' | 'invoices';

const TABS: { id: Tab; label: string }[] = [
  { id: 'billing', label: 'Billing' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'plans', label: 'Plans' },
  { id: 'access', label: 'Feature Access' },
  { id: 'usage', label: 'Usage Analytics' },
  { id: 'invoices', label: 'Invoices' },
];

const CREDIT_LABELS: Record<string, string> = {
  ai_builder: 'AI Builder',
  backtests: 'Deep Backtests',
  research_reports: 'Premium Research',
  premium_signals: 'Premium Signals',
  strategy_validation: 'Strategy Validation',
  market_scanner: 'Advanced Market Scanner',
};

const FEATURE_LABELS: Record<string, string> = {
  signals_basic: 'Limited Signals',
  watchlist_limited: 'Limited Watchlist',
  strategies_basic: 'Basic Strategies',
  backtests_basic: 'Basic Backtests',
  signals_advanced: 'More Signals',
  strategies_advanced: 'Advanced Strategies',
  strategy_hub: 'Strategy Hub Access',
  backtest_engine: 'Backtest Engine',
  performance_reports: 'Performance Reports',
  ai_strategy_builder: 'AI Strategy Builder',
  deep_backtests: 'Deep Backtests',
  premium_research: 'Premium Research',
  paper_trading: 'Paper Trading',
  strategy_deployment: 'Strategy Deployment',
  __all: 'All Enterprise Features',
};

const PLAN_ORDER = ['free', 'pro', 'premium', 'enterprise'];

async function readJson(res: Response, label: string) {
  const text = await res.text();
  if (!text.trim()) throw new Error(`${label} returned an empty response`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function badgeForStatus(status: string): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'paid' || status === 'active' || status === 'completed') return 'green';
  if (status === 'overdue' || status === 'past_due' || status === 'failed') return 'red';
  if (status === 'cancelled' || status === 'void' || status === 'expired') return 'gray';
  return 'orange';
}

export default function BillingPage() {
  const [tab, setTab] = useState<Tab>('billing');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wallet, setWallet] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [rechargeType, setRechargeType] = useState('ai_builder');
  const [rechargeAmount, setRechargeAmount] = useState('10');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [wRes, sRes, aRes, iRes] = await Promise.all([
        fetch('/api/billing/wallet').then((r) => readJson(r, 'Wallet API')),
        fetch('/api/billing/subscription').then((r) => readJson(r, 'Subscription API')),
        fetch('/api/billing/usage/analytics?days=30').then((r) => readJson(r, 'Usage API')),
        fetch('/api/billing/invoices').then((r) => readJson(r, 'Invoices API')),
      ]);
      if (!wRes.ok && wRes.error) throw new Error(wRes.error);
      if (!sRes.ok && sRes.error) throw new Error(sRes.error);
      if (!aRes.ok && aRes.error) throw new Error(aRes.error);
      if (!iRes.ok && iRes.error) throw new Error(iRes.error);
      const pRes = await fetch('/api/billing/plans').then((r) => readJson(r, 'Plans API'));
      if (!pRes.ok && pRes.error) throw new Error(pRes.error);
      setWallet(wRes);
      setSubscription(sRes);
      setPlans(pRes.plans ?? []);
      setAnalytics(aRes.analytics);
      setInvoices(iRes.invoices ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load billing');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const changePlan = async (plan: string) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/billing/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = await readJson(res, 'Plan change API');
      if (!data.ok) throw new Error(data.error);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upgrade failed');
    } finally {
      setSaving(false);
    }
  };

  const recharge = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/billing/wallet/recharge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creditType: rechargeType, amount: parseInt(rechargeAmount, 10) }),
      });
      const data = await readJson(res, 'Recharge API');
      if (!data.ok) throw new Error(data.error);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Recharge failed');
    } finally {
      setSaving(false);
    }
  };

  const currentPlan = wallet?.plan ?? subscription?.subscription?.plan ?? 'free';
  const currentPlanRank = PLAN_ORDER.indexOf(currentPlan);
  const totalAvailable = wallet?.totalCreditsRemaining ?? wallet?.totalBalance ?? 0;
  const totalAllocated = (wallet?.wallets ?? []).reduce((sum: number, w: any) => sum + Number(w.monthlyAllocation ?? 0), 0);
  const usedCredits = (wallet?.transactions ?? [])
    .filter((t: any) => Number(t.amount) < 0)
    .reduce((sum: number, t: any) => sum + Math.abs(Number(t.amount)), 0);
  const creditTransactions = (wallet?.transactions ?? []).filter((t: any) => Number(t.amount) > 0);
  const debitTransactions = (wallet?.transactions ?? []).filter((t: any) => Number(t.amount) < 0);
  const latestInvoice = invoices[0];

  return (
    <AppShell title="Billing">
      <div className="page">
        <div className="page__header">
          <h1><CreditCard size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Billing & Credits</h1>
          <p>Manage your subscription, credit wallet, usage, and invoices.</p>
        </div>

        {error && <AlertBanner variant="error">{error}</AlertBanner>}

        <div style={{ marginBottom: 16 }}>
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
          <Badge variant="green" style={{ marginLeft: 8 }}>{currentPlan.toUpperCase()} Plan</Badge>
        </div>

        <nav className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? styles.tabActive : styles.tab} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        {loading ? <Loading /> : (
          <>
            {tab === 'billing' && (
              <>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Current Plan</small><strong>{currentPlan}</strong></div>
                  <div className={styles.stat}><small>Total Credits</small><strong>{Math.max(totalAllocated, totalAvailable)}</strong></div>
                  <div className={styles.stat}><small>Available Credits</small><strong>{totalAvailable}</strong></div>
                  <div className={styles.stat}><small>Used Credits</small><strong>{usedCredits}</strong></div>
                  <div className={styles.stat}>
                    <small>Payment Status</small>
                    <strong>{latestInvoice?.status ?? subscription?.subscription?.status ?? 'active'}</strong>
                  </div>
                  <div className={styles.stat}><small>Invoices</small><strong>{invoices.length}</strong></div>
                </div>
                <Card title="Credit Balances" compact>
                  <div className={styles.planGrid}>
                    {(wallet?.wallets ?? []).map((w: any) => (
                      <div key={w.creditType} className={styles.stat}>
                        <small>{CREDIT_LABELS[w.creditType] ?? w.creditType}</small>
                        <strong>{w.balance} / {w.monthlyAllocation}</strong>
                        <div className={styles.creditBar}>
                          <div className={styles.creditFill} style={{ width: `${Math.min(100, (w.balance / Math.max(w.monthlyAllocation, 1)) * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card title="Included Access" compact style={{ marginTop: 16 }}>
                  <div className={styles.featureList}>
                    {(wallet?.features ?? []).map((feature: string) => (
                      <Badge key={feature} variant="gray">{FEATURE_LABELS[feature] ?? feature}</Badge>
                    ))}
                  </div>
                </Card>
              </>
            )}

            {tab === 'wallet' && (
              <div className={styles.twoColumn}>
                <Card title="Recharge Credits" compact>
                  <div style={{ display: 'grid', gap: 12 }}>
                    <div className="field">
                      <label>Credit Type</label>
                      <select className="input" value={rechargeType} onChange={(e) => setRechargeType(e.target.value)}>
                        {Object.entries(CREDIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                    <Input label="Credits to add" type="number" value={rechargeAmount} onChange={(e) => setRechargeAmount(e.target.value)} />
                    <Button onClick={recharge} loading={saving}><Zap size={14} /> Recharge</Button>
                  </div>
                </Card>
                <Card title="Recent Transactions" compact>
                  {(wallet?.transactions?.length ?? 0) === 0 ? (
                    <Empty icon={Wallet} title="No transactions yet" />
                  ) : (
                    <table className={styles.table}>
                      <thead><tr><th>Time</th><th>Type</th><th>Amount</th><th>Balance</th></tr></thead>
                      <tbody>
                        {wallet.transactions.slice(0, 15).map((t: any) => (
                          <tr key={t.id}>
                            <td>{new Date(t.createdAt).toLocaleString()}</td>
                            <td>{CREDIT_LABELS[t.creditType] ?? t.creditType}</td>
                            <td className={t.amount >= 0 ? styles.positive : styles.negative}>{t.amount > 0 ? '+' : ''}{t.amount}</td>
                            <td>{t.balanceAfter}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
                <Card title="Debit Transactions" compact>
                  {debitTransactions.length === 0 ? (
                    <Empty icon={Wallet} title="No debit transactions yet" />
                  ) : (
                    <table className={styles.table}>
                      <thead><tr><th>Time</th><th>Credit</th><th>Reason</th><th>Amount</th><th>Balance</th></tr></thead>
                      <tbody>
                        {debitTransactions.slice(0, 15).map((t: any) => (
                          <tr key={t.id}>
                            <td>{new Date(t.createdAt).toLocaleString()}</td>
                            <td>{CREDIT_LABELS[t.creditType] ?? t.creditType}</td>
                            <td>{t.reason}</td>
                            <td className={styles.negative}>{t.amount}</td>
                            <td>{t.balanceAfter}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
                <Card title="Credit Transactions" compact>
                  {creditTransactions.length === 0 ? (
                    <Empty icon={Wallet} title="No credit transactions yet" />
                  ) : (
                    <table className={styles.table}>
                      <thead><tr><th>Time</th><th>Credit</th><th>Reason</th><th>Amount</th><th>Balance</th></tr></thead>
                      <tbody>
                        {creditTransactions.slice(0, 15).map((t: any) => (
                          <tr key={t.id}>
                            <td>{new Date(t.createdAt).toLocaleString()}</td>
                            <td>{CREDIT_LABELS[t.creditType] ?? t.creditType}</td>
                            <td>{t.reason}</td>
                            <td className={styles.positive}>+{t.amount}</td>
                            <td>{t.balanceAfter}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </div>
            )}

            {tab === 'plans' && (
              <div className={styles.planGrid}>
                {plans.map((p: any) => (
                  <div key={p.id} className={`${styles.planCard} ${currentPlan === p.id ? styles.current : ''}`}>
                    <strong>{p.name}</strong>
                    <div className={styles.planPrice}>{p.priceInr === 0 ? 'Free' : fmt.currency(p.priceInr)}<small>/mo</small></div>
                    <p style={{ fontSize: '0.85rem', color: '#64748B', minHeight: 40 }}>{p.description}</p>
                    <ul style={{ fontSize: '0.8rem', paddingLeft: 16, margin: '12px 0' }}>
                      {Object.entries(p.credits ?? {}).map(([k, v]) => (
                        <li key={k}>{CREDIT_LABELS[k] ?? k}: {String(v)}/mo</li>
                      ))}
                    </ul>
                    <div className={styles.featureList}>
                      {(p.features ?? []).slice(0, 8).map((feature: string) => (
                        <Badge key={feature} variant="gray">{FEATURE_LABELS[feature] ?? feature}</Badge>
                      ))}
                    </div>
                    {currentPlan === p.id ? (
                      <Badge variant="green">Current Plan</Badge>
                    ) : (
                      <Button size="sm" onClick={() => changePlan(p.id)} loading={saving}>
                        {PLAN_ORDER.indexOf(p.id) > currentPlanRank ? 'Upgrade' : 'Downgrade'}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === 'access' && (
              <Card title="Plan-based Feature Access" action={<Zap size={16} />}>
                <div className={styles.planGrid}>
                  {plans.map((p: any) => {
                    const active = currentPlan === p.id;
                    return (
                      <div key={p.id} className={`${styles.planCard} ${active ? styles.current : ''}`}>
                        <div className={styles.cardHeader}>
                          <strong>{p.name}</strong>
                          {active && <Badge variant="green">Active</Badge>}
                        </div>
                        <div className={styles.featureList}>
                          {(p.features ?? []).map((feature: string) => (
                            <Badge key={feature} variant={active ? 'green' : 'gray'}>
                              {FEATURE_LABELS[feature] ?? feature}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {tab === 'usage' && (
              <Card title="Usage Analytics (30 days)" action={<BarChart3 size={16} />}>
                {analytics ? (
                  <>
                    <div className={styles.stats}>
                      {Object.entries(analytics.byCreditType ?? {}).map(([k, v]: [string, any]) => (
                        <div key={k} className={styles.stat}>
                          <small>{CREDIT_LABELS[k] ?? k}</small>
                          <strong>{v.used} / {v.limit}</strong>
                        </div>
                      ))}
                    </div>
                    {analytics.topFeatures?.length > 0 && (
                      <>
                        <h4 style={{ marginTop: 20 }}>Top Features</h4>
                        <table className={styles.table}>
                          <thead><tr><th>Feature</th><th>Uses</th></tr></thead>
                          <tbody>
                            {analytics.topFeatures.map((f: any) => (
                              <tr key={f.feature}><td>{f.feature}</td><td>{f.count}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                    <h4 style={{ marginTop: 20 }}>Usage Logs</h4>
                    <table className={styles.table}>
                      <thead><tr><th>Time</th><th>Credit</th><th>Feature</th><th>Qty</th></tr></thead>
                      <tbody>
                        {(wallet?.usageLogs ?? []).slice(0, 20).map((l: any) => (
                          <tr key={l.id}>
                            <td>{new Date(l.createdAt ?? l.created_at).toLocaleString()}</td>
                            <td>{CREDIT_LABELS[l.creditType ?? l.credit_type] ?? l.creditType ?? l.credit_type}</td>
                            <td>{l.featureKey ?? l.feature_key ?? '—'}</td>
                            <td>{l.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : <Empty icon={BarChart3} title="No usage data" />}
              </Card>
            )}

            {tab === 'invoices' && (
              <Card title="Payment History" action={<FileText size={16} />}>
                {invoices.length === 0 ? (
                  <Empty icon={FileText} title="No invoices yet" />
                ) : (
                  <table className={styles.table}>
                    <thead>
                      <tr><th>Invoice</th><th>Plan</th><th>Amount</th><th>Status</th><th>Date</th></tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv: any) => (
                        <tr key={inv.id}>
                          <td><strong>{inv.invoiceNumber}</strong></td>
                          <td>{inv.plan}</td>
                          <td>{fmt.currency(inv.totalInr)}</td>
                          <td><Badge variant={badgeForStatus(inv.status)}>{inv.status}</Badge></td>
                          <td>{new Date(inv.createdAt).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(wallet?.payments?.length ?? 0) > 0 && (
                  <>
                    <h4 style={{ marginTop: 24 }}>Payment Transactions</h4>
                    <table className={styles.table}>
                      <thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead>
                      <tbody>
                        {wallet.payments.map((p: any) => (
                          <tr key={p.id}>
                            <td>{new Date(p.createdAt).toLocaleString()}</td>
                            <td>{fmt.currency(p.amountInr)}</td>
                            <td>{p.paymentMethod}</td>
                            <td><Badge variant={badgeForStatus(p.status)}>{p.status}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
