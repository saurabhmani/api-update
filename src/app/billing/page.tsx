'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CreditCard, FileText, BarChart3, Wallet, Zap, RefreshCw,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Input, Loading, AlertBanner } from '@/components/ui';
import { fmt } from '@/lib/utils';
import styles from './billing.module.scss';

type Tab = 'billing' | 'wallet' | 'plans' | 'usage' | 'invoices';

const TABS: { id: Tab; label: string }[] = [
  { id: 'billing', label: 'Billing' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'plans', label: 'Plans' },
  { id: 'usage', label: 'Usage Analytics' },
  { id: 'invoices', label: 'Invoices' },
];

const CREDIT_LABELS: Record<string, string> = {
  ai_builder: 'AI Builder',
  backtests: 'Backtests',
  research_reports: 'Research Reports',
  premium_signals: 'Premium Signals',
};

export default function BillingPage() {
  const [tab, setTab] = useState<Tab>('billing');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wallet, setWallet] = useState<any>(null);
  const [subscription, setSubscription] = useState<any>(null);
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
        fetch('/api/wallet').then((r) => r.json()),
        fetch('/api/subscription').then((r) => r.json()),
        fetch('/api/billing/usage/analytics?days=30').then((r) => r.json()),
        fetch('/api/billing/invoices').then((r) => r.json()),
      ]);
      if (!wRes.ok && wRes.error) throw new Error(wRes.error);
      setWallet(wRes);
      setSubscription(sRes);
      setAnalytics(aRes.analytics);
      setInvoices(iRes.invoices ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load billing');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const upgrade = async (plan: string) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/subscription/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
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
      const res = await fetch('/api/wallet/recharge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creditType: rechargeType, amount: parseInt(rechargeAmount, 10) }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Recharge failed');
    } finally {
      setSaving(false);
    }
  };

  const currentPlan = subscription?.subscription?.plan ?? wallet?.plan ?? 'free';
  const plans = subscription?.plans ?? [];

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
                  <div className={styles.stat}><small>Total Credits</small><strong>{wallet?.totalBalance ?? 0}</strong></div>
                  <div className={styles.stat}><small>Status</small><strong>{subscription?.subscription?.status ?? 'active'}</strong></div>
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
              </>
            )}

            {tab === 'wallet' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
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
                    {currentPlan === p.id ? (
                      <Badge variant="green">Current Plan</Badge>
                    ) : (
                      <Button size="sm" onClick={() => upgrade(p.id)} loading={saving}>Upgrade</Button>
                    )}
                  </div>
                ))}
              </div>
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
                            <td>{new Date(l.created_at).toLocaleString()}</td>
                            <td>{CREDIT_LABELS[l.credit_type] ?? l.credit_type}</td>
                            <td>{l.feature_key ?? '—'}</td>
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
                          <td><Badge variant={inv.status === 'paid' ? 'green' : 'orange'}>{inv.status}</Badge></td>
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
                            <td><Badge variant={p.status === 'completed' ? 'green' : 'gray'}>{p.status}</Badge></td>
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
