'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Modal, Input, Loading, Empty, AlertBanner } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import { BookOpen, Plus, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import '@/styles/components/_intelligence.scss';
import '@/styles/components/_ui.scss';

const EMOTIONS = ['confident', 'fomo', 'fearful', 'calm', 'revenge', 'excited', 'uncertain'];
const STRATEGIES = ['Breakout', 'Reversal', 'Momentum', 'Support/Resistance', 'Trend Follow', 'Options Buy', 'Options Sell', 'Swing', 'Scalp', 'Other'];
const TIMEFRAMES = ['intraday', 'swing', 'positional', 'options'];

const emptyForm = {
  tradingsymbol: '', exchange: 'NSE', direction: 'BUY', entry_price: '', exit_price: '',
  quantity: '', entry_date: new Date().toISOString().slice(0, 16), exit_date: '',
  strategy: '', timeframe: 'swing', notes: '', emotion_entry: '', emotion_exit: '',
};

export default function TradeJournalPage() {
  const [trades,  setTrades]  = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(false);
  const [form,    setForm]    = useState(emptyForm);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, aRes] = await Promise.allSettled([
        fetch('/api/trade-journal').then(r => r.json()),
        fetch('/api/trader-analytics').then(r => r.json()),
      ]);
      if (tRes.status === 'fulfilled') setTrades(tRes.value.trades || []);
      if (aRes.status === 'fulfilled') setSummary(aRes.value.summary);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30 seconds (journal data changes on manual entry, not real-time)
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const addTrade = async () => {
    if (!form.tradingsymbol || !form.entry_price || !form.quantity) return setError('Symbol, entry price and quantity are required');
    setSaving(true); setError('');
    try {
      const res = await fetch('/api/trade-journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, quantity: parseInt(form.quantity), entry_price: parseFloat(form.entry_price), exit_price: form.exit_price ? parseFloat(form.exit_price) : undefined }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      setModal(false); setForm(emptyForm); await load();
    } catch (e: any) { setError(e.message || 'Failed to save trade'); }
    finally { setSaving(false); }
  };

  const field = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const outcomeIcon = (o: string) =>
    o === 'win' ? <TrendingUp size={13} color="#16A34A" /> : o === 'loss' ? <TrendingDown size={13} color="#DC2626" /> : <Minus size={13} color="#94A3B8" />;

  return (
    <AppShell title="Trade Journal">
      <Modal
        open={modal} onClose={() => { setModal(false); setError(''); setForm(emptyForm); }}
        title="Log a Trade"
        footer={<><Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button><Button onClick={addTrade} loading={saving}>Save Trade</Button></>}
      >
        {error && <AlertBanner variant="error">{error}</AlertBanner>}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="Symbol *" placeholder="RELIANCE" value={form.tradingsymbol} onChange={field('tradingsymbol')} />
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Direction</label>
            <select className="input" value={form.direction} onChange={field('direction')}>
              <option>BUY</option><option>SELL</option>
            </select>
          </div>
          <Input label="Entry Price ₹ *" type="number" value={form.entry_price} onChange={field('entry_price')} />
          <Input label="Quantity *" type="number" value={form.quantity} onChange={field('quantity')} />
          <Input label="Exit Price ₹" type="number" value={form.exit_price} onChange={field('exit_price')} placeholder="Leave blank if open" />
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Exchange</label>
            <select className="input" value={form.exchange} onChange={field('exchange')}><option>NSE</option><option>BSE</option><option>NFO</option></select>
          </div>
          <Input label="Entry Date *" type="datetime-local" value={form.entry_date} onChange={field('entry_date')} />
          <Input label="Exit Date" type="datetime-local" value={form.exit_date} onChange={field('exit_date')} />
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Strategy</label>
            <select className="input" value={form.strategy} onChange={field('strategy')}>
              <option value="">Select...</option>
              {STRATEGIES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Timeframe</label>
            <select className="input" value={form.timeframe} onChange={field('timeframe')}>
              {TIMEFRAMES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Emotion at Entry</label>
            <select className="input" value={form.emotion_entry} onChange={field('emotion_entry')}>
              <option value="">Select...</option>
              {EMOTIONS.map(e => <option key={e}>{e}</option>)}
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Emotion at Exit</label>
            <select className="input" value={form.emotion_exit} onChange={field('emotion_exit')}>
              <option value="">Select...</option>
              {EMOTIONS.map(e => <option key={e}>{e}</option>)}
            </select>
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Notes</label>
          <textarea className="input" rows={3} value={form.notes} onChange={field('notes')} placeholder="What was the setup? What went right/wrong?" style={{ resize: 'vertical' }} />
        </div>
      </Modal>

      <div className="page">
        <div className="page__header">
          <div><h1>Trade Journal</h1><p>{trades.length} trades logged</p></div>
          <Button onClick={() => setModal(true)}><Plus size={14} /> Log Trade</Button>
        </div>

        {/* Summary stats */}
        {summary && (
          <div className="grid-stats" style={{ marginBottom: 20 }}>
            {[
              { label: 'Total Trades',  value: summary.total_trades },
              { label: 'Win Rate',      value: `${summary.win_rate}%`,  cls: summary.win_rate >= 50 ? 'positive' : 'negative' },
              { label: 'Avg P&L',       value: fmt.currency(summary.avg_pnl), cls: changeClass(summary.avg_pnl) },
              { label: 'Avg Hold',      value: `${summary.avg_hold_hours?.toFixed(1)}h` },
            ].map(({ label, value, cls }) => (
              <div key={label} className="stat-card">
                <div className="stat-card__label">{label}</div>
                <div className={`stat-card__value ${cls || ''}`} style={{ fontSize: 20 }}>{loading ? '…' : value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Trades list */}
        <Card flush>
          {loading ? <Loading /> : trades.length === 0 ? (
            <Empty icon={BookOpen} title="No trades logged" description="Start journaling to track your performance and spot patterns."
              action={<Button onClick={() => setModal(true)}><Plus size={14} /> Log First Trade</Button>} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th><th>Symbol</th><th>Dir</th><th style={{ textAlign: 'right' }}>Entry</th>
                    <th style={{ textAlign: 'right' }}>Exit</th><th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>P&L</th><th>Strategy</th><th>Outcome</th><th>Emotion</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t: any) => (
                    <tr key={t.id}>
                      <td style={{ fontSize: 11, color: '#64748B', whiteSpace: 'nowrap' }}>{fmt.date(t.entry_date)}</td>
                      <td><strong style={{ color: '#1E3A5F' }}>{t.tradingsymbol}</strong></td>
                      <td><span className={`signal-chip signal-chip--${t.direction}`}>{t.direction}</span></td>
                      <td style={{ textAlign: 'right' }}>{fmt.currency(t.entry_price)}</td>
                      <td style={{ textAlign: 'right' }}>{t.exit_price ? fmt.currency(t.exit_price) : <span style={{ color: '#94A3B8' }}>Open</span>}</td>
                      <td style={{ textAlign: 'right' }}>{t.quantity}</td>
                      <td style={{ textAlign: 'right' }} className={changeClass(t.pnl)}>
                        {t.pnl != null ? fmt.currency(t.pnl) : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: '#64748B' }}>{t.strategy || '—'}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {outcomeIcon(t.outcome)}
                          <span style={{ fontSize: 12, fontWeight: 600, color: t.outcome === 'win' ? '#16A34A' : t.outcome === 'loss' ? '#DC2626' : '#94A3B8' }}>
                            {t.outcome || 'open'}
                          </span>
                        </div>
                      </td>
                      <td style={{ fontSize: 11, color: '#94A3B8' }}>{t.emotion_entry || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
