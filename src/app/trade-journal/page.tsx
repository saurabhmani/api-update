'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Modal, Input, Loading, Empty, AlertBanner } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import { BarChart3, BookOpen, CheckCircle2, Edit3, Plus, TrendingDown, TrendingUp, XCircle } from 'lucide-react';
import '@/styles/components/_intelligence.scss';
import '@/styles/components/_ui.scss';

const EMOTIONS = ['confident', 'fomo', 'fearful', 'calm', 'revenge', 'excited', 'uncertain'];
const STRATEGIES = ['Breakout', 'Reversal', 'Momentum', 'Support/Resistance', 'Trend Follow', 'Options Buy', 'Options Sell', 'Swing', 'Scalp', 'Other'];
const TIMEFRAMES = ['intraday', 'swing', 'positional', 'options'];
const MISTAKES = ['fomo-entry', 'late-entry', 'early-exit', 'ignored-stop', 'oversized', 'revenge-trade', 'no-plan', 'poor-risk-reward'];

const emptyForm = {
  tradingsymbol: '', exchange: 'NSE', direction: 'BUY', entry_price: '', exit_price: '',
  quantity: '', entry_date: new Date().toISOString().slice(0, 16), exit_date: '',
  strategy: '', timeframe: 'swing', notes: '', emotion_entry: '', emotion_exit: '',
  tags: [] as string[],
};

type TradeForm = typeof emptyForm;

interface TradeRow {
  id: number;
  tradingsymbol: string;
  exchange?: string;
  direction: 'BUY' | 'SELL';
  entry_price: number | string;
  exit_price?: number | string | null;
  quantity: number;
  entry_date: string;
  exit_date?: string | null;
  strategy?: string | null;
  timeframe?: string | null;
  notes?: string | null;
  outcome?: 'open' | 'win' | 'loss' | 'breakeven' | string;
  pnl?: number | string | null;
  pnl_pct?: number | string | null;
  emotion_entry?: string | null;
  emotion_exit?: string | null;
  tags?: string | string[] | null;
}

interface AnalyticsPayload {
  summary?: {
    total_trades: number;
    closed_trades: number;
    open_trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    avg_pnl: number;
    total_pnl: number;
    avg_hold_hours: number;
    profit_factor: number;
  };
  insights?: string[];
  day_performance?: Array<{ day: string; winRate: number; trades: number }>;
  tf_performance?: Array<{ timeframe: string; winRate: number; trades: number }>;
  mistake_performance?: Array<{ tag: string; trades: number; lossRate: number; pnl: number }>;
}

function parseTags(tags: TradeRow['tags']): string[] {
  if (Array.isArray(tags)) return tags.map(String);
  if (!tags) return [];
  try {
    const parsed = JSON.parse(String(tags));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toInputDate(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}

function formFromTrade(trade: TradeRow): TradeForm {
  return {
    tradingsymbol: trade.tradingsymbol ?? '',
    exchange: trade.exchange ?? 'NSE',
    direction: trade.direction ?? 'BUY',
    entry_price: String(trade.entry_price ?? ''),
    exit_price: trade.exit_price != null ? String(trade.exit_price) : '',
    quantity: String(trade.quantity ?? ''),
    entry_date: toInputDate(trade.entry_date) || new Date().toISOString().slice(0, 16),
    exit_date: toInputDate(trade.exit_date),
    strategy: trade.strategy ?? '',
    timeframe: trade.timeframe ?? 'swing',
    notes: trade.notes ?? '',
    emotion_entry: trade.emotion_entry ?? '',
    emotion_exit: trade.emotion_exit ?? '',
    tags: parseTags(trade.tags),
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export default function TradeJournalPage() {
  const [trades,  setTrades]  = useState<TradeRow[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(false);
  const [editingTrade, setEditingTrade] = useState<TradeRow | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<TradeRow | null>(null);
  const [form,    setForm]    = useState<TradeForm>(emptyForm);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, aRes] = await Promise.allSettled([
        fetch('/api/trade-journal?limit=200').then(r => r.json()),
        fetch('/api/trader-analytics').then(r => r.json()),
      ]);
      const tradeRows = tRes.status === 'fulfilled' ? (tRes.value.trades || []) : [];
      if (tRes.status === 'fulfilled') setTrades(tRes.value.trades || []);
      if (aRes.status === 'fulfilled') setAnalytics(aRes.value);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30 seconds (journal data changes on manual entry, not real-time)
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const openNewTrade = () => {
    setEditingTrade(null);
    setForm(emptyForm);
    setError('');
    setModal(true);
  };

  const openEditTrade = (trade: TradeRow) => {
    setEditingTrade(trade);
    setSelectedTrade(trade);
    setForm(formFromTrade(trade));
    setError('');
    setModal(true);
  };

  const saveTrade = async () => {
    if (!form.tradingsymbol || !form.entry_price || !form.quantity) return setError('Symbol, entry price and quantity are required');
    if (form.exit_price && !form.exit_date) return setError('Exit date is required when exit price is provided');
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        quantity: parseInt(form.quantity, 10),
        entry_price: parseFloat(form.entry_price),
        exit_price: form.exit_price ? parseFloat(form.exit_price) : undefined,
        exit_date: form.exit_date || undefined,
        tags: form.tags,
      };
      const res = await fetch('/api/trade-journal', {
        method: editingTrade ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingTrade ? { id: editingTrade.id, ...payload } : payload),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      setModal(false); setEditingTrade(null); setForm(emptyForm); await load();
    } catch (e: any) { setError(e.message || 'Failed to save trade'); }
    finally { setSaving(false); }
  };

  const field = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const toggleTag = (tag: string) => {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
    }));
  };

  const outcomeIcon = (o: string) =>
    o === 'win' ? <TrendingUp size={13} color="#16A34A" /> : o === 'loss' ? <TrendingDown size={13} color="#DC2626" /> : o === 'breakeven' ? <CheckCircle2 size={13} color="#D97706" /> : <XCircle size={13} color="#94A3B8" />;

  const summary = analytics?.summary;
  const insights = analytics?.insights ?? [];

  return (
    <AppShell title="Trade Journal">
      <Modal
        open={modal} onClose={() => { setModal(false); setError(''); setEditingTrade(null); setForm(emptyForm); }}
        title={editingTrade ? 'Review / Update Trade' : 'Log a Trade'}
        footer={<><Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button><Button onClick={saveTrade} loading={saving}>{editingTrade ? 'Update Trade' : 'Save Trade'}</Button></>}
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
          <textarea className="input" rows={4} value={form.notes} onChange={field('notes')} placeholder="Setup, thesis, execution review, lesson learned..." style={{ resize: 'vertical' }} />
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Mistake / Review Tags</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {MISTAKES.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`btn btn--sm ${form.tags.includes(tag) ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      </Modal>

      <div className="page">
        <div className="page__header">
          <div><h1>Trade Journal</h1><p>Log executions, review outcomes, track mistakes, and improve signal execution.</p></div>
          <Button onClick={openNewTrade}><Plus size={14} /> Log Trade</Button>
        </div>

        {/* Summary stats */}
        {summary && (
          <div className="grid-stats" style={{ marginBottom: 20 }}>
            {[
              { label: 'Total Trades',  value: summary.total_trades },
              { label: 'Open Trades',   value: summary.open_trades ?? 0 },
              { label: 'Win Rate',      value: `${summary.win_rate}%`,  cls: summary.win_rate >= 50 ? 'positive' : 'negative' },
              { label: 'Total P&L',     value: fmt.currency(summary.total_pnl ?? 0), cls: changeClass(summary.total_pnl ?? 0) },
              { label: 'Avg P&L',       value: fmt.currency(summary.avg_pnl ?? 0), cls: changeClass(summary.avg_pnl ?? 0) },
              { label: 'Profit Factor', value: (summary.profit_factor ?? 0).toFixed(2), cls: (summary.profit_factor ?? 0) >= 1 ? 'positive' : 'negative' },
              { label: 'Avg Hold',      value: `${(summary.avg_hold_hours ?? 0).toFixed(1)}h` },
            ].map(({ label, value, cls }) => (
              <div key={label} className="stat-card">
                <div className="stat-card__label">{label}</div>
                <div className={`stat-card__value ${cls || ''}`} style={{ fontSize: 20 }}>{loading ? '…' : value}</div>
              </div>
            ))}
          </div>
        )}

        <div className="grid-2" style={{ marginBottom: 20 }}>
          <Card title="Execution Insights">
            {loading ? <Loading text="Loading insights..." /> : insights.length === 0 ? (
              <p style={{ fontSize: 13, color: '#64748B' }}>No insights yet. Close a few trades to build review patterns.</p>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {insights.slice(0, 6).map((insight) => (
                  <div key={insight} className="reason-item">
                    <span className="reason-item__dot reason-item__dot--neutral" />
                    <div>{insight}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Mistake Patterns">
            {analytics?.mistake_performance?.length ? (
              <div style={{ display: 'grid', gap: 8 }}>
                {analytics.mistake_performance.slice(0, 5).map((m) => (
                  <div key={m.tag} className="option-intel__zone-row">
                    <div>
                      <strong>{m.tag}</strong>
                      <div style={{ fontSize: 11, color: '#64748B' }}>{m.trades} tagged trades · {m.lossRate}% loss rate</div>
                    </div>
                    <span className={changeClass(m.pnl)}>{fmt.currency(m.pnl)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: '#64748B' }}>Tag trades with mistakes to see repeat behavior.</p>
            )}
          </Card>
        </div>

        {/* Trades list */}
        <div style={{ display: 'grid', gridTemplateColumns: selectedTrade ? 'minmax(0, 1.7fr) minmax(300px, 0.8fr)' : '1fr', gap: 20 }}>
        <Card title="Trades" action={<Badge variant="gray">{trades.length} rows</Badge>} flush>
          {loading ? <Loading /> : trades.length === 0 ? (
            <Empty icon={BookOpen} title="No trades logged" description="Start journaling to track your performance and spot patterns."
              action={<Button onClick={openNewTrade}><Plus size={14} /> Log First Trade</Button>} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th><th>Symbol</th><th>Dir</th><th style={{ textAlign: 'right' }}>Entry</th>
                    <th style={{ textAlign: 'right' }}>Exit</th><th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>P&L</th><th>Strategy</th><th>Outcome</th><th>Mistakes</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => {
                    const tags = parseTags(t.tags);
                    const active = selectedTrade?.id === t.id;
                    return (
                    <tr key={t.id} onClick={() => setSelectedTrade(t)} style={{ cursor: 'pointer', background: active ? '#F8FAFC' : undefined }}>
                      <td style={{ fontSize: 11, color: '#64748B', whiteSpace: 'nowrap' }}>{fmt.date(t.entry_date)}</td>
                      <td><strong style={{ color: '#1E3A5F' }}>{t.tradingsymbol}</strong></td>
                      <td><span className={`signal-chip signal-chip--${t.direction}`}>{t.direction}</span></td>
                      <td style={{ textAlign: 'right' }}>{fmt.currency(num(t.entry_price))}</td>
                      <td style={{ textAlign: 'right' }}>{t.exit_price ? fmt.currency(num(t.exit_price)) : <span style={{ color: '#94A3B8' }}>Open</span>}</td>
                      <td style={{ textAlign: 'right' }}>{t.quantity}</td>
                      <td style={{ textAlign: 'right' }} className={changeClass(num(t.pnl))}>
                        {t.pnl != null ? fmt.currency(num(t.pnl)) : '—'}
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
                      <td style={{ fontSize: 11, color: '#94A3B8' }}>{tags.slice(0, 2).join(', ') || '—'}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditTrade(t);
                          }}
                        >
                          <Edit3 size={13} />
                        </Button>
                      </td>
                    </tr>
                  );})}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {selectedTrade && (
          <Card
            title="Trade Review"
            action={<Button size="sm" variant="secondary" onClick={() => openEditTrade(selectedTrade)}><Edit3 size={13} /> Edit</Button>}
          >
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ fontSize: 18, color: '#1E3A5F' }}>{selectedTrade.tradingsymbol}</strong>
                  <Badge variant={selectedTrade.outcome === 'win' ? 'green' : selectedTrade.outcome === 'loss' ? 'red' : 'gray'}>{selectedTrade.outcome || 'open'}</Badge>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: '#64748B' }}>
                  {selectedTrade.strategy || 'No strategy'} · {selectedTrade.timeframe || 'No timeframe'} · Entry emotion: {selectedTrade.emotion_entry || '—'}
                </p>
              </div>
              <div className="grid-stats">
                <div className="stat-card">
                  <div className="stat-card__label">P&L</div>
                  <div className={`stat-card__value ${changeClass(num(selectedTrade.pnl))}`} style={{ fontSize: 18 }}>{selectedTrade.pnl != null ? fmt.currency(num(selectedTrade.pnl)) : 'Open'}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-card__label">Return</div>
                  <div className={`stat-card__value ${changeClass(num(selectedTrade.pnl_pct))}`} style={{ fontSize: 18 }}>{selectedTrade.pnl_pct != null ? `${num(selectedTrade.pnl_pct).toFixed(2)}%` : '—'}</div>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94A3B8', fontWeight: 700, marginBottom: 6 }}>Notes / Lesson</div>
                <p style={{ fontSize: 13, color: '#334155', lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 }}>{selectedTrade.notes || 'No notes added yet.'}</p>
              </div>
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#94A3B8', fontWeight: 700, marginBottom: 6 }}>Mistake Tags</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {parseTags(selectedTrade.tags).length
                    ? parseTags(selectedTrade.tags).map((tag) => <Badge key={tag} variant="orange">{tag}</Badge>)
                    : <span style={{ fontSize: 12, color: '#94A3B8' }}>No mistake tags.</span>
                  }
                </div>
              </div>
            </div>
          </Card>
        )}
        </div>
      </div>
    </AppShell>
  );
}
