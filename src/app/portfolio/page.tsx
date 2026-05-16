'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, StatCard, Modal, Button, Input, Loading, Empty, AlertBanner } from '@/components/ui';
import { portfolioApi } from '@/lib/apiClient';
import { fmt, changeClass } from '@/lib/utils';
import { Briefcase, Plus, Trash2 } from 'lucide-react';
import type { PortfolioPosition, PortfolioSummary } from '@/types';

const empty = { tradingsymbol:'', exchange:'NSE', quantity:'', buy_price:'' };

export default function PortfolioPage() {
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [summary,   setSummary]   = useState<PortfolioSummary | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(false);
  const [form,      setForm]      = useState(empty); 
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  async function load() {
    setLoading(true);
    try {
      const [p, s] = await Promise.all([portfolioApi.positions(), portfolioApi.summary()]) as any[];
      setPositions(p.positions || []);
      setSummary(s.summary || null);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function addPosition() {
    if (!form.tradingsymbol || !form.quantity || !form.buy_price) return setError('All fields required');
    setSaving(true); setError('');
    try {
      await portfolioApi.add({ ...form, quantity: parseInt(form.quantity), buy_price: parseFloat(form.buy_price) });
      setModal(false); setForm(empty); await load();
    } catch (e: any) { setError(e.data?.error || 'Failed to add'); }
    finally { setSaving(false); }
  }

  async function deletePos(id: number) {
    if (!confirm('Remove this position?')) return;
    await portfolioApi.delete(id);
    setPositions(prev => prev.filter(p => p.id !== id));
  }

  const pnlCls = summary?.total_pnl != null && summary.total_pnl >= 0 ? 'positive' : 'negative';

  return (
    <AppShell title="Portfolio">
      <Modal
        open={modal} onClose={() => { setModal(false); setError(''); setForm(empty); }}
        title="Add Position"
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button>
            <Button onClick={addPosition} loading={saving}>Add Position</Button>
          </>
        }
      >
        {error && <AlertBanner variant="error">{error}</AlertBanner>}
        <Input label="Symbol (e.g. RELIANCE)" placeholder="RELIANCE" value={form.tradingsymbol} onChange={e => setForm(f => ({ ...f, tradingsymbol:e.target.value.toUpperCase() }))} />
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Input label="Quantity" type="number" min="1" placeholder="100" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity:e.target.value }))} />
          <Input label="Buy Price (₹)" type="number" min="0" placeholder="2500.00" value={form.buy_price} onChange={e => setForm(f => ({ ...f, buy_price:e.target.value }))} />
        </div>
        <div className="field">
          <label>Exchange</label>
          <select className="input" value={form.exchange} onChange={e => setForm(f => ({ ...f, exchange:e.target.value }))}>
            <option>NSE</option><option>BSE</option>
          </select>
        </div>
      </Modal>

      <div className="page">
        <div className="page__header">
          <div><h1>Portfolio</h1><p>{positions.length} positions</p></div>
          <Button onClick={() => setModal(true)}><Plus size={14} /> Add Position</Button>
        </div>

        {/* Summary */}
        <div className="grid-stats" style={{ marginBottom:24 }}>
          <StatCard label="Invested"      value={fmt.currency(summary?.total_invested)} icon={Briefcase} iconVariant="blue"   loading={loading} />
          <StatCard label="Current Value" value={fmt.currency(summary?.current_value)}  icon={Briefcase} iconVariant="green"  loading={loading} />
          <StatCard label="Total P&L"     value={<span className={pnlCls}>{fmt.currency(summary?.total_pnl)}</span>} icon={Briefcase} iconVariant={summary?.total_pnl != null && summary.total_pnl >= 0 ? 'green' : 'red'} loading={loading} />
          <StatCard label="P&L %"         value={<span className={pnlCls}>{fmt.percent(summary?.pnl_pct)}</span>} icon={Briefcase} iconVariant={summary?.pnl_pct != null && summary.pnl_pct >= 0 ? 'green' : 'red'} loading={loading} />
        </div>

        {/* Positions */}
        <Card flush>
          {loading ? <Loading /> : positions.length === 0 ? (
            <Empty icon={Briefcase} title="No positions" description="Add your first stock position." action={<Button onClick={() => setModal(true)}><Plus size={14} />Add Position</Button>} />
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th><th style={{ textAlign:'right' }}>Qty</th><th style={{ textAlign:'right' }}>Avg Buy</th>
                    <th style={{ textAlign:'right' }}>CMP</th><th style={{ textAlign:'right' }}>Invested</th>
                    <th style={{ textAlign:'right' }}>Current</th><th style={{ textAlign:'right' }}>P&L</th><th style={{ textAlign:'right' }}>P&L %</th><th />
                  </tr>
                </thead>
                <tbody>
                  {positions.map(p => {
                    const inv  = p.quantity * p.buy_price;
                    const cur  = p.quantity * (p.current_price ?? p.buy_price);
                    const pnl  = cur - inv;
                    const pct  = inv ? (pnl / inv) * 100 : 0;
                    return (
                      <tr key={p.id}>
                        <td><strong style={{ color:'#1E3A5F' }}>{p.tradingsymbol}</strong></td>
                        <td style={{ textAlign:'right' }}>{p.quantity}</td>
                        <td style={{ textAlign:'right' }}>{fmt.currency(p.buy_price)}</td>
                        <td style={{ textAlign:'right' }}>{fmt.currency(p.current_price)}</td>
                        <td style={{ textAlign:'right' }}>{fmt.currency(inv)}</td>
                        <td style={{ textAlign:'right' }}>{fmt.currency(cur)}</td>
                        <td style={{ textAlign:'right' }} className={changeClass(pnl)}>{fmt.currency(pnl)}</td>
                        <td style={{ textAlign:'right' }} className={changeClass(pct)}>{fmt.percent(pct)}</td>
                        <td><button className="btn btn--ghost btn--sm" style={{ color:'#EF4444' }} onClick={() => deletePos(p.id)}><Trash2 size={13} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
