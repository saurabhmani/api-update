'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Activity, BookOpen, Layers, RefreshCw, ShieldAlert, TrendingUp, Wallet,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Input, Loading, AlertBanner } from '@/components/ui';
import { changeClass, fmt } from '@/lib/utils';
import styles from './paper.module.scss';

type Tab = 'dashboard' | 'orders' | 'open' | 'closed' | 'risk';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'orders', label: 'Order Book' },
  { id: 'open', label: 'Open Positions' },
  { id: 'closed', label: 'Closed Positions' },
  { id: 'risk', label: 'Risk Settings' },
];

const emptyOrder = {
  symbol: '',
  side: 'BUY',
  orderType: 'MARKET',
  quantity: '',
  referencePrice: '',
  limitPrice: '',
  stopPrice: '',
  stopLoss: '',
  takeProfit: '',
  strategyId: '',
};

async function readJson(res: Response, label: string) {
  const text = await res.text();
  if (!text.trim()) throw new Error(`${label} returned an empty response`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function statusVariant(status: string): 'green' | 'red' | 'orange' | 'gray' {
  if (['FILLED', 'CLOSED', 'OPEN'].includes(status)) return 'green';
  if (status === 'REJECTED') return 'red';
  if (['CANCELLED', 'EXPIRED'].includes(status)) return 'gray';
  return 'orange';
}

export default function PaperTradingPage() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [positions, setPositions] = useState<any>(null);
  const [orders, setOrders] = useState<any>(null);
  const [risk, setRisk] = useState<any>(null);
  const [orderForm, setOrderForm] = useState(emptyOrder);
  const [riskForm, setRiskForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deployId, setDeployId] = useState('');

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const posUrl = refresh ? '/api/paper/positions?refresh=1' : '/api/paper/positions';
      const [pRes, oRes, rRes] = await Promise.all([
        fetch(posUrl).then((r) => readJson(r, 'Positions API')),
        fetch('/api/paper/orders').then((r) => readJson(r, 'Orders API')),
        fetch('/api/risk/settings').then((r) => readJson(r, 'Risk API')),
      ]);
      if (!pRes.ok) throw new Error(pRes.error || 'Failed to load positions');
      if (!oRes.ok) throw new Error(oRes.error || 'Failed to load orders');
      if (!rRes.ok) throw new Error(rRes.error || 'Failed to load risk settings');
      setPositions(pRes);
      setOrders(oRes);
      setRisk(rRes);
      if (rRes.profile?.risk) {
        const rr = rRes.profile.risk;
        setRiskForm({
          virtualCapital: String(rr.virtualCapital ?? ''),
          riskPerTradePct: String(rr.riskPerTradePct ?? ''),
          maxDailyLossPct: String(rr.maxDailyLossPct ?? ''),
          maxOpenPositions: String(rr.maxOpenPositions ?? ''),
          maxTradesPerDay: String(rr.maxTradesPerDay ?? ''),
          maxConsecutiveLosses: String(rr.maxConsecutiveLosses ?? ''),
          maxSymbolExposurePct: String(rr.maxSymbolExposurePct ?? ''),
          maxStrategyExposurePct: String(rr.maxStrategyExposurePct ?? ''),
          slippageBps: String(rr.slippageBps ?? ''),
          circuitBreakerDropPct: String(rr.circuitBreakerDropPct ?? ''),
          highVolatilityAtrPct: String(rr.highVolatilityAtrPct ?? ''),
        });
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(true); }, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const placeOrder = async () => {
    if (!orderForm.symbol || !orderForm.quantity) {
      setError('Symbol and quantity required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/paper/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: orderForm.symbol.toUpperCase(),
          side: orderForm.side,
          orderType: orderForm.orderType,
          role: orderForm.side === 'SELL' ? 'EXIT' : 'ENTRY',
          quantity: parseInt(orderForm.quantity, 10),
          referencePrice: orderForm.referencePrice ? parseFloat(orderForm.referencePrice) : undefined,
          limitPrice: orderForm.limitPrice ? parseFloat(orderForm.limitPrice) : undefined,
          stopPrice: orderForm.stopPrice ? parseFloat(orderForm.stopPrice) : undefined,
          stopLoss: orderForm.stopLoss ? parseFloat(orderForm.stopLoss) : undefined,
          takeProfit: orderForm.takeProfit ? parseFloat(orderForm.takeProfit) : undefined,
          strategyId: orderForm.strategyId || undefined,
          idempotencyKey: `ui-${Date.now()}`,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || data.code || 'Order rejected');
      setOrderForm(emptyOrder);
      await load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Order failed');
    } finally {
      setSaving(false);
    }
  };

  const closePosition = async (id: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/paper-trading/positions/${id}/close`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      await load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Close failed');
    } finally {
      setSaving(false);
    }
  };

  const saveRisk = async () => {
    setSaving(true);
    setError('');
    try {
      const body: Record<string, number> = {};
      for (const [k, v] of Object.entries(riskForm)) {
        if (v !== '') body[k] = Number(v);
      }
      const res = await fetch('/api/risk/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleKillSwitch = async () => {
    const active = !risk?.killSwitch?.active;
    setSaving(true);
    try {
      await fetch('/api/risk/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ killSwitchActive: active }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const deployStrategy = async () => {
    if (!deployId.trim()) return setError('Strategy ID required');
    setSaving(true);
    try {
      const res = await fetch('/api/paper/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId: deployId.trim() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || data.issues?.join(', '));
      setDeployId('');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setSaving(false);
    }
  };

  const mtm = positions?.mtm;
  const account = positions?.account;
  const killActive = risk?.killSwitch?.active;
  const closedPositions = positions?.closed ?? [];
  const strategyPerformance = Object.values(
    closedPositions.reduce((acc: Record<string, any>, p: any) => {
      const key = p.strategyId || 'Manual';
      const row = acc[key] ?? { strategyId: key, trades: 0, pnl: 0, wins: 0 };
      const pnl = Number(p.realizedPnl ?? 0);
      row.trades += 1;
      row.pnl += pnl;
      if (pnl > 0) row.wins += 1;
      acc[key] = row;
      return acc;
    }, {}),
  );

  return (
    <AppShell title="Paper Trading">
      <div className="page">
        <div className="page__header">
          <h1><Wallet size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Paper Trading</h1>
          <p>Virtual brokerage — simulated fills, real-time MTM, risk controls, and kill switch.</p>
        </div>

        {killActive && (
          <div className={styles.killActive}>
            <ShieldAlert size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Kill switch active — all new orders are blocked.
          </div>
        )}

        {error && <AlertBanner variant="error">{error}</AlertBanner>}

        <div className={styles.toolbar}>
          <Button variant="secondary" size="sm" onClick={() => load(true)} loading={refreshing}>
            <RefreshCw size={14} /> Refresh MTM
          </Button>
          {orders?.market && (
            <Badge variant={orders.market.isOpen ? 'green' : 'gray'}>
              {orders.market.label ?? (orders.market.isOpen ? 'Market Open' : 'Market Closed')}
            </Badge>
          )}
        </div>

        <nav className={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? styles.tabActive : styles.tab}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {loading ? <Loading /> : (
          <>
            {tab === 'dashboard' && (
              <>
                <div className={styles.stats}>
                  <div className={styles.stat}><small>Equity</small><strong>{fmt.currency(mtm?.equity ?? 0)}</strong></div>
                  <div className={styles.stat}><small>Cash</small><strong>{fmt.currency(mtm?.cashBalance ?? 0)}</strong></div>
                  <div className={styles.stat}>
                    <small>Unrealized P&L</small>
                    <strong className={changeClass(mtm?.unrealizedPnl ?? 0)}>{fmt.currency(mtm?.unrealizedPnl ?? 0)}</strong>
                  </div>
                  <div className={styles.stat}>
                    <small>Realized P&L</small>
                    <strong className={changeClass(mtm?.realizedPnl ?? 0)}>{fmt.currency(mtm?.realizedPnl ?? 0)}</strong>
                  </div>
                  <div className={styles.stat}>
                    <small>Daily P&L</small>
                    <strong className={changeClass(mtm?.dailyPnl ?? 0)}>{fmt.currency(mtm?.dailyPnl ?? 0)}</strong>
                  </div>
                  <div className={styles.stat}><small>Exposure</small><strong>{(mtm?.exposurePct ?? 0).toFixed(1)}%</strong></div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <Card title="Place Order" compact>
                    <div className={styles.formGrid}>
                      <Input label="Symbol" value={orderForm.symbol} onChange={(e) => setOrderForm((f) => ({ ...f, symbol: e.target.value }))} placeholder="RELIANCE" />
                      <label className={styles.fieldLabel}>
                        Side
                        <select value={orderForm.side} onChange={(e) => setOrderForm((f) => ({ ...f, side: e.target.value }))}>
                          <option value="BUY">Buy</option>
                          <option value="SELL">Sell / Exit</option>
                        </select>
                      </label>
                      <label className={styles.fieldLabel}>
                        Order Type
                        <select value={orderForm.orderType} onChange={(e) => setOrderForm((f) => ({ ...f, orderType: e.target.value }))}>
                          <option value="MARKET">Market</option>
                          <option value="LIMIT">Limit</option>
                          <option value="STOP">Stop</option>
                        </select>
                      </label>
                      <Input label="Quantity" type="number" value={orderForm.quantity} onChange={(e) => setOrderForm((f) => ({ ...f, quantity: e.target.value }))} />
                      <Input label="Ref Price" type="number" value={orderForm.referencePrice} onChange={(e) => setOrderForm((f) => ({ ...f, referencePrice: e.target.value }))} />
                      <Input label="Limit Price" type="number" value={orderForm.limitPrice} onChange={(e) => setOrderForm((f) => ({ ...f, limitPrice: e.target.value }))} />
                      <Input label="Stop Trigger" type="number" value={orderForm.stopPrice} onChange={(e) => setOrderForm((f) => ({ ...f, stopPrice: e.target.value }))} />
                      <Input label="Stop Loss" type="number" value={orderForm.stopLoss} onChange={(e) => setOrderForm((f) => ({ ...f, stopLoss: e.target.value }))} />
                      <Input label="Take Profit" type="number" value={orderForm.takeProfit} onChange={(e) => setOrderForm((f) => ({ ...f, takeProfit: e.target.value }))} />
                      <Input label="Strategy ID" value={orderForm.strategyId} onChange={(e) => setOrderForm((f) => ({ ...f, strategyId: e.target.value }))} />
                    </div>
                    <Button onClick={placeOrder} loading={saving} style={{ marginTop: 12 }}>Submit Paper Order</Button>
                  </Card>

                  <Card title="Deploy Strategy" compact>
                    <Input label="Strategy ID" value={deployId} onChange={(e) => setDeployId(e.target.value)} placeholder="lab strategy id" />
                    <Button variant="secondary" onClick={deployStrategy} loading={saving} style={{ marginTop: 12 }}>
                      <Layers size={14} /> Deploy to Paper
                    </Button>
                  </Card>
                </div>

                <Card title="Open Positions" compact style={{ marginTop: 16 }}>
                  {(positions?.open?.length ?? 0) === 0 ? <Empty icon={Activity} title="No open positions" /> : (
                    <table className={styles.table}>
                      <thead>
                        <tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&L</th><th>SL/TP</th></tr>
                      </thead>
                      <tbody>
                        {positions.open.map((p: any) => (
                          <tr key={p.id}>
                            <td><strong>{p.symbol}</strong></td>
                            <td>{p.quantity}</td>
                            <td>{fmt.currency(p.entryPrice)}</td>
                            <td>{fmt.currency(p.currentPrice ?? p.entryPrice)}</td>
                            <td className={changeClass(p.unrealizedPnl)}>{fmt.currency(p.unrealizedPnl)}</td>
                            <td>{p.stopLoss ? fmt.currency(p.stopLoss) : '—'} / {p.takeProfit ? fmt.currency(p.takeProfit) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>

                <Card title="Strategy-wise Performance" compact style={{ marginTop: 16 }}>
                  {strategyPerformance.length === 0 ? <Empty icon={TrendingUp} title="No closed strategy trades yet" /> : (
                    <table className={styles.table}>
                      <thead><tr><th>Strategy</th><th>Trades</th><th>Win Rate</th><th>Paper P&L</th></tr></thead>
                      <tbody>
                        {strategyPerformance.map((s: any) => (
                          <tr key={s.strategyId}>
                            <td><strong>{s.strategyId}</strong></td>
                            <td>{s.trades}</td>
                            <td>{s.trades ? ((s.wins / s.trades) * 100).toFixed(1) : '0.0'}%</td>
                            <td className={changeClass(s.pnl)}>{fmt.currency(s.pnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </>
            )}

            {tab === 'orders' && (
              <Card title="Order Book" action={<BookOpen size={16} />}>
                {(orders?.orders?.length ?? 0) === 0 ? <Empty icon={BookOpen} title="No orders yet" /> : (
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Order ID</th><th>Time</th><th>Symbol</th><th>Strategy</th><th>Side</th>
                        <th>Qty</th><th>Type</th><th>Status</th><th>Entry Price</th><th>Mode</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.orders.map((o: any) => (
                        <tr key={o.id}>
                          <td><code>{o.id}</code></td>
                          <td>{new Date(o.createdAt).toLocaleString()}</td>
                          <td><strong>{o.symbol}</strong></td>
                          <td>{o.strategyId ?? 'Manual'}</td>
                          <td>{o.side}</td>
                          <td>{o.quantity}</td>
                          <td>{o.orderType}</td>
                          <td>
                            <Badge variant={statusVariant(o.status)}>
                              {o.status}
                            </Badge>
                          </td>
                          <td>{o.avgFillPrice ? fmt.currency(o.avgFillPrice) : o.rejectReason ?? '—'}</td>
                          <td><Badge variant="gray">Paper</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {(orders?.history?.length ?? 0) > 0 && (
                  <p className={styles.hint}>Statuses shown: Pending, Filled, Rejected, Cancelled, Closed via linked position lifecycle.</p>
                )}
              </Card>
            )}

            {tab === 'open' && (
              <Card title="Open Positions" action={<Activity size={16} />}>
                {(positions?.open?.length ?? 0) === 0 ? <Empty icon={Activity} title="No open positions" /> : (
                  <table className={styles.table}>
                    <thead>
                      <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>P&L</th><th>SL</th><th>TP</th><th></th></tr>
                    </thead>
                    <tbody>
                      {positions.open.map((p: any) => (
                        <tr key={p.id}>
                          <td><strong>{p.symbol}</strong></td>
                          <td>{p.side}</td>
                          <td>{p.quantity}</td>
                          <td>{fmt.currency(p.entryPrice)}</td>
                          <td>{fmt.currency(p.currentPrice ?? p.entryPrice)}</td>
                          <td className={changeClass(p.unrealizedPnl)}>{fmt.currency(p.unrealizedPnl)}</td>
                          <td>{p.stopLoss ? fmt.currency(p.stopLoss) : '—'}</td>
                          <td>{p.takeProfit ? fmt.currency(p.takeProfit) : '—'}</td>
                          <td><Button size="sm" variant="outline" onClick={() => closePosition(p.id)} loading={saving}>Close</Button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}

            {tab === 'closed' && (
              <Card title="Closed Positions & Trade History" action={<TrendingUp size={16} />}>
                {(positions?.closed?.length ?? 0) === 0 ? <Empty icon={TrendingUp} title="No closed positions" /> : (
                  <table className={styles.table}>
                    <thead>
                      <tr><th>Position ID</th><th>Symbol</th><th>Strategy</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th><th>Closed</th></tr>
                    </thead>
                    <tbody>
                      {positions.closed.map((p: any) => (
                        <tr key={p.id}>
                          <td><code>{p.id}</code></td>
                          <td><strong>{p.symbol}</strong></td>
                          <td>{p.strategyId ?? 'Manual'}</td>
                          <td>{p.quantity}</td>
                          <td>{fmt.currency(p.entryPrice)}</td>
                          <td>{fmt.currency(p.currentPrice ?? 0)}</td>
                          <td className={changeClass(p.realizedPnl ?? 0)}>{fmt.currency(p.realizedPnl ?? 0)}</td>
                          <td><Badge variant="gray">{p.exitReason ?? 'CLOSE'}</Badge></td>
                          <td>{p.closedAt ? new Date(p.closedAt).toLocaleString() : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}

            {tab === 'risk' && (
              <Card title="Risk Settings" action={<ShieldAlert size={16} />}>
                <div className={styles.formGrid}>
                  {[
                    ['virtualCapital', 'Virtual Capital'],
                    ['riskPerTradePct', 'Risk Per Trade %'],
                    ['maxDailyLossPct', 'Max Daily Loss %'],
                    ['maxOpenPositions', 'Max Open Positions'],
                    ['maxTradesPerDay', 'Max Trades Per Day'],
                    ['maxConsecutiveLosses', 'Max Consecutive Losses'],
                    ['maxSymbolExposurePct', 'Max Symbol Exposure %'],
                    ['maxStrategyExposurePct', 'Max Strategy Exposure %'],
                    ['slippageBps', 'Slippage (bps)'],
                    ['circuitBreakerDropPct', 'Circuit Breaker Drop %'],
                    ['highVolatilityAtrPct', 'High Vol ATR %'],
                  ].map(([key, label]) => (
                    <Input
                      key={key}
                      label={label}
                      type="number"
                      value={riskForm[key] ?? ''}
                      onChange={(e) => setRiskForm((f) => ({ ...f, [key]: e.target.value }))}
                    />
                  ))}
                </div>
                <div className={styles.toolbar} style={{ marginTop: 16 }}>
                  <Button onClick={saveRisk} loading={saving}>Save Risk Settings</Button>
                  <Button variant={killActive ? 'success' : 'danger'} onClick={toggleKillSwitch} loading={saving}>
                    {killActive ? 'Deactivate Kill Switch' : 'Activate Kill Switch'}
                  </Button>
                </div>

                {(risk?.events?.length ?? 0) > 0 && (
                  <>
                    <h4 style={{ marginTop: 24, marginBottom: 8 }}>Recent Risk Events</h4>
                    <table className={styles.table}>
                      <thead><tr><th>Time</th><th>Code</th><th>Message</th><th>Symbol</th></tr></thead>
                      <tbody>
                        {risk.events.map((e: any) => (
                          <tr key={e.id}>
                            <td>{new Date(e.createdAt).toLocaleString()}</td>
                            <td><Badge variant={e.blocked ? 'red' : 'green'}>{e.code}</Badge></td>
                            <td>{e.message}</td>
                            <td>{e.symbol ?? '—'}</td>
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
