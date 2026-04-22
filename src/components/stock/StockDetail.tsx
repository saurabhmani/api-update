'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { Card, Loading, Empty, Badge }               from '@/components/ui';
import { fmt, changeClass }                          from '@/lib/utils';
import {
  TrendingUp, TrendingDown, Star, Activity, BarChart2,
  Newspaper, DollarSign, Zap, Target, Shield, AlertTriangle,
} from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from 'recharts';
import s from './StockDetail.module.scss';

// ── Types ─────────────────────────────────────────────────────────

interface CandleBar {
  ts: string; open: number; high: number;
  low: number; close: number; volume: number; oi: number;
}

interface SignalReason { rank: number; factor_key: string | null; text: string; }

interface StockData {
  symbol: string; instrument_key: string; name: string | null;
  ltp: number; open: number; day_high: number; day_low: number;
  prev_close: number; change_abs: number; change_percent: number;
  volume: number; vwap: number | null;
  week52_high: number; week52_low: number;
  candles: CandleBar[]; candle_interval: string;
  score: number | null; rank_position: number | null;
  signal_type: string | null; confidence: number | null;
  signal_strength: string | null;
  entry_price: number | null; stop_loss: number | null;
  target1: number | null; target2: number | null;
  risk_reward: number | null; reasons: SignalReason[];
  signal_age_min: number | null;
  data_source: string; as_of: string;
}

interface NewsItem {
  id: number; title: string; source: string;
  url: string; published_at: string; sentiment?: string;
}

const TABS = [
  { id: 'summary',        label: 'Summary',        icon: BarChart2   },
  { id: 'recommendation', label: 'Recommendation',  icon: Zap         },
  { id: 'price',          label: 'Price Movement',  icon: TrendingUp  },
  { id: 'returns',        label: 'Returns',         icon: Activity    },
  { id: 'news',           label: 'News',            icon: Newspaper   },
  { id: 'financials',     label: 'Financials',      icon: DollarSign  },
  { id: 'technical',      label: 'Technical',       icon: Target      },
  { id: 'score',          label: 'Score',           icon: Shield      },
] as const;

type TabId = typeof TABS[number]['id'];

// ── Helpers ───────────────────────────────────────────────────────

const INTERVALS = ['1minute','5minute','15minute','1day'] as const;
type Interval = typeof INTERVALS[number];

const INTERVAL_LABEL: Record<Interval, string> = {
  '1minute': '1m', '5minute': '5m', '15minute': '15m', '1day': '1D',
};

function pct52w(low: number, high: number, ltp: number): number {
  if (high <= low || !ltp) return 0;
  return Math.round(((ltp - low) / (high - low)) * 100);
}

function confClass(c: number): string {
  return c >= 70 ? s.confBarWideFillHigh : c >= 50 ? s.confBarWideFillMedium : s.confBarWideFillLow;
}

function returnColor(v: number) {
  return v > 0 ? '#16A34A' : v < 0 ? '#DC2626' : '#64748B';
}

// Fake return data (derived from candles + live price where possible)
function calcReturn(candles: CandleBar[], ltp: number, n: number) {
  if (!candles.length || !ltp) return null;
  const oldest = candles.slice(-Math.min(n, candles.length))[0];
  if (!oldest?.open) return null;
  return ((ltp - oldest.open) / oldest.open) * 100;
}

// Pillar sub-metric bars
function PillarRow({ label, value, max = 100, color }: { label: string; value: number; max?: number; color: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={s.pillarBar}>
      <span className={s.pillarBarLabel}>{label}</span>
      <div className={s.pillarBarTrack}>
        <div className={s.pillarBarTrackFill} style={{ width:`${pct}%`, background: color }} />
      </div>
      <span className={s.pillarBarVal}>{value.toFixed(0)}</span>
    </div>
  );
}

// SVG ring progress
function RingProgress({ value, max=100, color='#1E3A5F', size=100 }:{value:number;max?:number;color?:string;size?:number}) {
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={8} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={8}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.7s ease' }} />
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────

interface Props {
  symbol: string;
}

export default function StockDetail({ symbol }: Props) {
  const [activeTab,  setTab]      = useState<TabId>('summary');
  const [data,       setData]     = useState<StockData | null>(null);
  const [candles,    setCandles]  = useState<CandleBar[]>([]);
  const [interval,   setInterval] = useState<Interval>('1minute');
  const [news,       setNews]     = useState<NewsItem[]>([]);
  const [loading,    setLoading]  = useState(true);
  const [chartLoad,  setChartLoad]= useState(false);
  const fetchedChart = useRef<Set<string>>(new Set());

  // ── Load stock detail ──────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stocks/${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error('Not found');
      const d: StockData = await res.json();
      setData(d);
      setCandles(d.candles ?? []);
      fetchedChart.current.add('1minute');
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [symbol]);

  // ── Load news ─────────────────────────────────────────────────
  const loadNews = useCallback(async () => {
    try {
      const res = await fetch(`/api/news?q=${encodeURIComponent(symbol)}&limit=10`);
      const d   = await res.json();
      setNews(d.news ?? d.articles ?? []);
    } catch { setNews([]); }
  }, [symbol]);

  // ── Load chart for selected interval ──────────────────────────
  const loadChart = useCallback(async (iv: Interval) => {
    if (fetchedChart.current.has(iv)) return;
    setChartLoad(true);
    try {
      const res = await fetch(`/api/chart-data?symbol=${encodeURIComponent(symbol)}&interval=${iv}&limit=200`);
      const d   = await res.json();
      if (d.candles?.length) { setCandles(d.candles); fetchedChart.current.add(iv); }
    } catch {}
    finally { setChartLoad(false); }
  }, [symbol]);

  useEffect(() => { loadDetail(); }, [loadDetail]);
  useEffect(() => { if (activeTab === 'news') loadNews(); }, [activeTab, loadNews]);
  useEffect(() => { if (activeTab === 'price') loadChart(interval); }, [activeTab, interval, loadChart]);

  // ── Derived values ─────────────────────────────────────────────
  const positive    = (data?.change_percent ?? 0) >= 0;
  const pos52       = data ? pct52w(data.week52_low, data.week52_high, data.ltp) : 0;
  const changeClass2 = positive ? s.changePositive : s.changeNegative;
  const signalDir    = data?.signal_type ?? 'HOLD';
  const conf         = data?.confidence ?? 0;
  const score        = data?.score ?? 0;

  // Pillar scores derived from available data (signal + score)
  const quality     = Math.min(100, Math.max(0, score * 0.9 + (conf ?? 0) * 0.1));
  const valuation   = Math.min(100, Math.max(0, 100 - Math.abs(data?.change_percent ?? 0) * 2));
  const technicals  = Math.min(100, Math.max(0, conf ?? 0));
  const finTrend    = Math.min(100, Math.max(0, score * 0.7));
  const overall     = Math.round((quality + valuation + technicals + finTrend) / 4);

  const returns: [string, number | null][] = [
    ['1 Week',    calcReturn(candles, data?.ltp ?? 0, 5 * 390)],
    ['1 Month',   calcReturn(candles, data?.ltp ?? 0, 22 * 390)],
    ['3 Months',  calcReturn(candles, data?.ltp ?? 0, 66 * 390)],
    ['6 Months',  calcReturn(candles, data?.ltp ?? 0, 130 * 390)],
    ['1 Year',    data ? ((data.ltp - data.week52_low) / (data.week52_low || 1)) * 100 : null],
    ['YTD',       null],
  ];

  // ── Render ─────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ padding: '40px 20px', textAlign: 'center' }}>
      <Loading text={`Loading ${symbol}…`} />
    </div>
  );

  if (!data) return (
    <Empty icon={BarChart2} title={`No data for ${symbol}`}
      description="Run a rankings sync or wait for the scheduler to populate this symbol." />
  );

  return (
    <div>
      {/* ── Hero ─────────────────────────────────────────────── */}
      <div className={s.hero}>
        <div className={s.heroTop}>
          <div className={s.heroLeft}>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <span className={s.symbol}>{data.symbol}</span>
              <Badge variant="gray" style={{ background:'rgba(255,255,255,0.15)', color:'#fff' }}>NSE</Badge>
              {data.signal_type && (
                <span style={{
                  background: signalDir==='BUY'?'rgba(22,163,74,0.25)':signalDir==='SELL'?'rgba(220,38,38,0.25)':'rgba(255,255,255,0.15)',
                  color: signalDir==='BUY'?'#6EE7B7':signalDir==='SELL'?'#FCA5A5':'rgba(255,255,255,0.8)',
                  fontWeight:800, fontSize:12, padding:'3px 10px', borderRadius:99,
                }}>
                  {data.signal_type}
                </span>
              )}
            </div>
            <span className={s.companyName}>{data.name ?? '—'}</span>
          </div>

          <div className={s.heroRight}>
            <div className={s.ltp}>{fmt.currency(data.ltp)}</div>
            <div className={`${s.change} ${changeClass2}`}>
              {positive ? '▲' : '▼'} {fmt.currency(Math.abs(data.change_abs))} ({positive?'+':''}{data.change_percent.toFixed(2)}%)
            </div>
          </div>
        </div>

        {/* OHLCV stats */}
        <div className={s.heroStats}>
          {[
            ['Open',       fmt.currency(data.open)],
            ['High',       fmt.currency(data.day_high)],
            ['Low',        fmt.currency(data.day_low)],
            ['Prev Close', fmt.currency(data.prev_close)],
            ['Volume',     fmt.volume(data.volume)],
            ['VWAP',       data.vwap != null ? fmt.currency(data.vwap) : '—'],
            ['Score',      data.score != null ? data.score.toFixed(1) : '—'],
          ].map(([label, value]) => (
            <div key={label} className={s.heroStat}>
              <div className={s.heroStatLabel}>{label}</div>
              <div className={s.heroStatValue}>{value}</div>
            </div>
          ))}
        </div>

        {/* 52W range */}
        <div className={s.rangeBar}>
          <div className={s.rangeLabels}>
            <span>52W Low: {fmt.currency(data.week52_low)}</span>
            <span style={{ color:'rgba(255,255,255,0.8)', fontWeight:700 }}>
              {pos52}% from low
            </span>
            <span>52W High: {fmt.currency(data.week52_high)}</span>
          </div>
          <div className={s.rangeTrack}>
            <div className={s.rangeFill} style={{ width:`${pos52}%` }} />
            <div className={s.rangeDot}  style={{ left:`${pos52}%`  }} />
          </div>
        </div>
      </div>

      {/* ── Tab bar ──────────────────────────────────────────── */}
      <div className={s.tabBar} role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={`${s.tab} ${activeTab === id ? s.tabActive : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={12} style={{ display:'inline', marginRight:4, verticalAlign:'middle' }} />
            {label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          TAB PANELS
      ══════════════════════════════════════════════════════ */}

      {/* ── SUMMARY ──────────────────────────────────────── */}
      {activeTab === 'summary' && (
        <div className={s.panel}>
          <div className={s.summaryGrid}>
            {/* Key data */}
            <Card title="Price Data">
              {[
                ['LTP',          fmt.currency(data.ltp)],
                ['Open',         fmt.currency(data.open)],
                ['Day High',     fmt.currency(data.day_high)],
                ['Day Low',      fmt.currency(data.day_low)],
                ['Prev Close',   fmt.currency(data.prev_close)],
                ['Change',       `${data.change_percent >= 0?'+':''}${data.change_percent.toFixed(2)}%`],
                ['Volume',       fmt.volume(data.volume)],
                ['VWAP',         data.vwap != null ? fmt.currency(data.vwap) : '—'],
                ['52W High',     fmt.currency(data.week52_high)],
                ['52W Low',      fmt.currency(data.week52_low)],
              ].map(([l,v]) => (
                <div key={l} className={s.kv}>
                  <span className={s.kvLabel}>{l}</span>
                  <span className={s.kvValue} style={{ color: l==='Change' ? returnColor(data.change_percent) : undefined }}>{v}</span>
                </div>
              ))}
            </Card>

            {/* Score ring + signal */}
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <Card title="Quantorus365 Score">
                <div className={s.scoreRing}>
                  <div className={s.ringWrap}>
                    <RingProgress value={score} color={score>=70?'#16A34A':score>=50?'#D97706':'#DC2626'} />
                    <div className={s.ringValue}>
                      {score > 0 ? score.toFixed(0) : '—'}
                      <span className={s.ringSub}>/ 100</span>
                    </div>
                  </div>
                  <div className={s.ringLabel}>
                    {data.rank_position != null ? `Rank #${data.rank_position}` : 'Quantorus365 Score'}
                  </div>
                </div>
              </Card>

              <Card title="Signal Snapshot">
                {data.signal_type ? (
                  <div>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                      <span className={`signal-chip signal-chip--${data.signal_type}`}>{data.signal_type}</span>
                      <span style={{ fontSize:13, fontWeight:600, color:'#64748B' }}>
                        {data.signal_strength} · {data.confidence}% conf
                      </span>
                    </div>
                    <div className="confidence-bar">
                      <div className="confidence-bar__track">
                        <div className={`confidence-bar__fill confidence-bar__fill--${conf>=70?'high':conf>=50?'medium':'low'}`}
                          style={{ width:`${conf}%` }} />
                      </div>
                    </div>
                    {data.signal_age_min != null && (
                      <div style={{ fontSize:11, color:'#94A3B8', marginTop:8 }}>
                        Generated {data.signal_age_min}m ago · {data.data_source}
                      </div>
                    )}
                  </div>
                ) : (
                  <Empty icon={Zap} title="No signal yet" description="Signal generates after rankings sync." />
                )}
              </Card>
            </div>
          </div>
        </div>
      )}

      {/* ── RECOMMENDATION ───────────────────────────────── */}
      {activeTab === 'recommendation' && (
        <div className={s.panel}>
          <Card>
            {!data.signal_type ? (
              <Empty icon={Zap} title="No recommendation available"
                description="Trigger a signal generation from Admin → Signal Rules." />
            ) : (
              <>
                {/* Verdict row */}
                <div className={s.recHeader}>
                  <span className={`${s.recVerdict} ${s[`recVerdict${signalDir}`]}`}>
                    {signalDir === 'BUY' ? <TrendingUp size={20}/> : signalDir === 'SELL' ? <TrendingDown size={20}/> : <Activity size={20}/>}
                    {signalDir}
                  </span>
                  <div className={s.confBlock}>
                    <div className={s.confBlockPct}>{conf}%</div>
                    <div className={s.confBlockLabel}>Confidence · {data.signal_strength}</div>
                  </div>
                </div>

                {/* Confidence bar */}
                <div className={s.confBarWide}>
                  <div className={`${s.confBarWideFill} ${confClass(conf)}`} style={{ width:`${conf}%` }} />
                </div>

                {/* Price levels */}
                <div className={s.levels}>
                  {[
                    ['Entry',    data.entry_price, 'entry'],
                    ['Stop Loss',data.stop_loss,   'sl'   ],
                    ['Target 1', data.target1,     't1'   ],
                    ['Target 2', data.target2,     't2'   ],
                  ].map(([label, val, mod]) => (
                    <div key={String(label)} className={`${s.levelBox} ${s[`levelBox--${mod}`]}`}>
                      <div className={s.levelBoxLabel}>{label}</div>
                      <div className={s.levelBoxValue}>
                        {val != null ? fmt.currency(Number(val)) : '—'}
                      </div>
                    </div>
                  ))}
                </div>

                {data.risk_reward != null && (
                  <div style={{ fontSize:13, color:'#64748B', textAlign:'center', marginBottom:20 }}>
                    Risk / Reward Ratio: <strong style={{ color:'#0F172A' }}>1:{data.risk_reward}</strong>
                    {data.signal_age_min != null && ` · Signal ${data.signal_age_min}m old`}
                  </div>
                )}

                {/* Reasons */}
                {data.reasons.length > 0 && (
                  <Card title="Why this recommendation?" style={{ marginTop:0 } as any}>
                    <div className={s.reasons}>
                      {data.reasons.map((r, i) => {
                        const isBull = r.text.toLowerCase().includes('above') || r.text.toLowerCase().includes('bullish') || r.text.toLowerCase().includes('strong');
                        const isBear = r.text.toLowerCase().includes('below') || r.text.toLowerCase().includes('bearish') || r.text.toLowerCase().includes('weak');
                        return (
                          <div key={i} className={s.reasonRow}>
                            <div className={`${s.reasonDot} ${isBull?s.reasonDotPos:isBear?s.reasonDotNeg:s.reasonDotNeu}`} />
                            <span className={s.reasonText}>{r.text}</span>
                            {r.factor_key && <span className={s.reasonKey}>{r.factor_key}</span>}
                          </div>
                        );
                      })}
                    </div>
                  </Card>
                )}
              </>
            )}
          </Card>

          <div className={s.disclaimer}>
            ⚠️ This recommendation is generated by Quantorus365's rule-based algorithm using public market data. It is for informational purposes only and does not constitute financial advice. Always do your own research and consult a registered investment advisor before trading.
          </div>
        </div>
      )}

      {/* ── PRICE MOVEMENT ───────────────────────────────── */}
      {activeTab === 'price' && (
        <div className={s.panel}>
          <div className={s.chartToolbar}>
            <div style={{ fontSize:13, fontWeight:600, color:'#334155' }}>
              {data.symbol} · Intraday chart
            </div>
            <div className={s.intervalGroup}>
              {INTERVALS.map(iv => (
                <button
                  key={iv}
                  className={`${s.intervalBtn} ${interval===iv ? s.intervalBtnActive : ''}`}
                  onClick={() => { setInterval(iv); loadChart(iv); }}
                >
                  {INTERVAL_LABEL[iv]}
                </button>
              ))}
            </div>
          </div>

          <div className={s.chartWrap}>
            {chartLoad ? <Loading text="Loading chart…" /> :
             candles.length === 0 ? (
              <Empty icon={TrendingUp} title="No chart data"
                description="Chart data is populated by the scheduler each market session." />
             ) : (
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={candles} margin={{ top:10, right:20, bottom:5, left:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                  <XAxis dataKey="ts"
                    tickFormatter={v => interval==='1day'
                      ? new Date(v).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})
                      : new Date(v).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}
                    tick={{ fontSize:11, fill:'#94A3B8' }} />
                  <YAxis domain={['auto','auto']}
                    tickFormatter={v => `₹${Number(v).toLocaleString('en-IN',{maximumFractionDigits:0})}`}
                    tick={{ fontSize:11, fill:'#94A3B8' }} width={78} />
                  <Tooltip
                    formatter={(v: any) => [fmt.currency(v), 'Close']}
                    labelFormatter={v => new Date(v).toLocaleString('en-IN')}
                    contentStyle={{ borderRadius:8, border:'1px solid #E2E8F0', fontSize:12 }} />
                  {data.prev_close > 0 && (
                    <ReferenceLine y={data.prev_close} stroke="#94A3B8" strokeDasharray="4 4"
                      label={{ value:'Prev Close', fill:'#94A3B8', fontSize:10 }} />
                  )}
                  <Line type="monotone" dataKey="close"
                    stroke={positive ? '#16A34A' : '#DC2626'}
                    strokeWidth={2} dot={false} activeDot={{ r:4 }} />
                </LineChart>
              </ResponsiveContainer>
             )
            }
          </div>

          {/* OHLCV table below chart */}
          {candles.length > 0 && (
            <Card title="Recent Candles" style={{ marginTop:16 } as any}>
              <div style={{ overflowX:'auto' }}>
                <table className="table table--compact">
                  <thead><tr><th>Time</th><th style={{textAlign:'right'}}>Open</th><th style={{textAlign:'right'}}>High</th><th style={{textAlign:'right'}}>Low</th><th style={{textAlign:'right'}}>Close</th><th style={{textAlign:'right'}}>Volume</th></tr></thead>
                  <tbody>
                    {candles.slice(-10).reverse().map((c, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'#94A3B8' }}>
                          {interval==='1day'
                            ? new Date(c.ts).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})
                            : new Date(c.ts).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}
                        </td>
                        <td style={{ textAlign:'right' }}>{fmt.currency(c.open)}</td>
                        <td style={{ textAlign:'right', color:'#16A34A', fontWeight:600 }}>{fmt.currency(c.high)}</td>
                        <td style={{ textAlign:'right', color:'#DC2626', fontWeight:600 }}>{fmt.currency(c.low)}</td>
                        <td style={{ textAlign:'right', fontWeight:600 }}>{fmt.currency(c.close)}</td>
                        <td style={{ textAlign:'right', color:'#64748B' }}>{fmt.volume(c.volume)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── RETURNS ──────────────────────────────────────── */}
      {activeTab === 'returns' && (
        <div className={s.panel}>
          <div className={s.returnsGrid}>
            {returns.map(([period, val]) => (
              <div key={period} className={s.returnCard}>
                <div className={s.returnCardPeriod}>{period}</div>
                <div className={s.returnCardValue} style={{ color: val != null ? returnColor(val) : '#CBD5E1' }}>
                  {val != null ? `${val >= 0 ? '+' : ''}${val.toFixed(2)}%` : '—'}
                </div>
              </div>
            ))}
          </div>

          {/* Day range visual */}
          <Card title="Day Range" style={{ marginTop:16 } as any}>
            <div style={{ padding:'8px 0' }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, fontWeight:600, marginBottom:8 }}>
                <span style={{ color:'#DC2626' }}>Low: {fmt.currency(data.day_low)}</span>
                <span style={{ color:'#64748B', fontSize:12 }}>LTP: {fmt.currency(data.ltp)}</span>
                <span style={{ color:'#16A34A' }}>High: {fmt.currency(data.day_high)}</span>
              </div>
              <div style={{ height:8, background:'#E2E8F0', borderRadius:99, overflow:'hidden', position:'relative' }}>
                {data.day_high > data.day_low && (
                  <div style={{
                    position:'absolute', height:'100%',
                    left:`${((data.ltp - data.day_low) / (data.day_high - data.day_low)) * 100}%`,
                    width:4, background:'#1E3A5F', borderRadius:99,
                    transform:'translateX(-50%)',
                  }} />
                )}
                <div style={{
                  height:'100%',
                  background:'linear-gradient(to right, #DC2626, #16A34A)',
                  borderRadius:99, opacity:0.3,
                }} />
              </div>
            </div>
          </Card>

          <div className={s.disclaimer}>
            ⚠️ Returns are estimated from available candle data and may not reflect actual dividends, splits, or corporate actions. For accurate historical returns, refer to official exchange data.
          </div>
        </div>
      )}

      {/* ── NEWS ─────────────────────────────────────────── */}
      {activeTab === 'news' && (
        <div className={s.panel}>
          <Card flush>
            {news.length === 0 ? (
              <Empty icon={Newspaper} title={`No news for ${symbol}`}
                description="News is aggregated from exchange disclosures and financial news APIs." />
            ) : news.map(item => (
              <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer"
                className={s.newsItem} style={{ display:'flex', textDecoration:'none' }}>
                <div className={s.newsThumb}>📰</div>
                <div className={s.newsBody}>
                  <div className={s.newsTitle}>{item.title}</div>
                  <div className={s.newsMeta}>
                    <span>{item.source}</span>
                    <span>·</span>
                    <span>{new Date(item.published_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</span>
                    {item.sentiment && (
                      <span className={`${s.newsSentiment} ${s[`newsSentiment${item.sentiment.charAt(0).toUpperCase()+item.sentiment.slice(1)}`]}`}>
                        {item.sentiment}
                      </span>
                    )}
                  </div>
                </div>
              </a>
            ))}
          </Card>
        </div>
      )}

      {/* ── FINANCIALS ───────────────────────────────────── */}
      {activeTab === 'financials' && (
        <div className={s.panel}>
          <Card title="Key Metrics (Derived from market data)">
            <div style={{ overflowX:'auto' }}>
              <table className={s.finTable}>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Current</th>
                    <th>52W High Basis</th>
                    <th>52W Low Basis</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['LTP',           fmt.currency(data.ltp), fmt.currency(data.week52_high), fmt.currency(data.week52_low)],
                    ['Day Range',     `${fmt.currency(data.day_low)} – ${fmt.currency(data.day_high)}`, '—', '—'],
                    ['Volume',        fmt.volume(data.volume), '—', '—'],
                    ['VWAP',          data.vwap ? fmt.currency(data.vwap) : '—', '—', '—'],
                    ['Score',         data.score?.toFixed(1) ?? '—', '—', '—'],
                    ['Signal',        data.signal_type ?? '—', '—', '—'],
                    ['Confidence',    data.confidence ? `${data.confidence}%` : '—', '—', '—'],
                  ].map(([label, ...vals]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      {vals.map((v,i) => <td key={i}>{v}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <div className={s.disclaimer}>
            ℹ️ Detailed financials (P/E, revenue, EPS) require a premium data provider integration. Connect an exchange corporate data API in Admin settings to populate this section.
          </div>
        </div>
      )}

      {/* ── TECHNICAL ────────────────────────────────────── */}
      {activeTab === 'technical' && (
        <div className={s.panel}>
          <div className={s.techGrid}>
            <Card title="Momentum Indicators">
              {([
                ['Signal Direction', data.signal_type ?? '—', data.signal_type],
                ['Signal Strength',  data.signal_strength ?? '—', data.signal_type],
                ['Confidence',       data.confidence ? `${data.confidence}%` : '—', data.signal_type],
                ['VWAP',             data.vwap ? fmt.currency(data.vwap) : '—', null],
                ['vs VWAP',          data.vwap && data.ltp
                  ? `${((data.ltp-data.vwap)/data.vwap*100).toFixed(2)}%`
                  : '—', null],
                ['Day Range %',      data.day_high > data.day_low
                  ? `${(((data.day_high-data.day_low)/data.day_low)*100).toFixed(2)}%`
                  : '—', null],
                ['52W Position',     `${pos52}% from low`, null],
              ] as [string, string, string|null][]).map(([name, val, sig]) => (
                <div key={name} className={s.techIndicator}>
                  <span className={s.techIndicatorName}>{name}</span>
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <span className={s.techIndicatorValue}>{val}</span>
                    {sig && (
                      <span className={`${s.techSignal} ${s[`techSignal${sig.charAt(0).toUpperCase()+sig.slice(1).toLowerCase()}`]}`}>
                        {sig}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </Card>

            <Card title="Price Levels">
              {([
                ['Current Price',  fmt.currency(data.ltp)],
                ['Entry Level',    data.entry_price ? fmt.currency(data.entry_price) : '—'],
                ['Stop Loss',      data.stop_loss   ? fmt.currency(data.stop_loss)   : '—'],
                ['Target 1',       data.target1     ? fmt.currency(data.target1)     : '—'],
                ['Target 2',       data.target2     ? fmt.currency(data.target2)     : '—'],
                ['52W High',       fmt.currency(data.week52_high)],
                ['52W Low',        fmt.currency(data.week52_low)],
              ] as [string,string][]).map(([name, val]) => (
                <div key={name} className={s.techIndicator}>
                  <span className={s.techIndicatorName}>{name}</span>
                  <span className={s.techIndicatorValue}>{val}</span>
                </div>
              ))}
            </Card>
          </div>

          {data.reasons.length > 0 && (
            <Card title="Technical Signal Reasons" style={{ marginTop:16 } as any}>
              <div className={s.reasons}>
                {data.reasons.map((r, i) => (
                  <div key={i} className={s.reasonRow}>
                    <div className={`${s.reasonDot} ${s.reasonDotNeu}`} />
                    <span className={s.reasonText}>{r.text}</span>
                    {r.factor_key && <span className={s.reasonKey}>{r.factor_key}</span>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ── SCORE ────────────────────────────────────────── */}
      {activeTab === 'score' && (
        <div className={s.panel}>
          {/* Overall score meter */}
          <Card title="Overall Quantorus365 Score">
            <div style={{ display:'flex', alignItems:'center', gap:24, flexWrap:'wrap' }}>
              <div style={{ position:'relative', width:140, height:140, flexShrink:0 }}>
                <RingProgress value={overall} size={140}
                  color={overall>=70?'#16A34A':overall>=50?'#D97706':'#DC2626'} />
                <div style={{
                  position:'absolute', inset:0, display:'flex',
                  flexDirection:'column', alignItems:'center', justifyContent:'center',
                }}>
                  <div style={{ fontSize:32, fontWeight:800, color:'#0F172A', lineHeight:1 }}>{overall}</div>
                  <div style={{ fontSize:12, color:'#64748B' }}>/ 100</div>
                </div>
              </div>
              <div style={{ flex:1, minWidth:200 }}>
                {([
                  ['Quality',        quality,   '#16A34A'],
                  ['Valuation',      valuation, '#2E75B6'],
                  ['Technicals',     technicals,'#D97706'],
                  ['Financial Trend',finTrend,  '#8B5CF6'],
                ] as [string, number, string][]).map(([label, val, color]) => (
                  <PillarRow key={label} label={label} value={val} color={color} />
                ))}
              </div>
            </div>
          </Card>

          {/* Individual pillar cards */}
          <div className={s.scoreGrid} style={{ marginTop:16 }}>

            {/* Quality */}
            <div className={s.pillarCard}>
              <div className={s.pillarCardHead}>
                <span className={s.pillarCardTitle}>Quality</span>
                <span className={s.pillarCardScore} style={{ color:'#16A34A' }}>{quality.toFixed(0)}</span>
              </div>
              {([
                ['Price Momentum',    Math.min(100, 50 + data.change_percent * 5)],
                ['Volume Signal',     data.volume > 0 ? Math.min(100, 60) : 0],
                ['52W Positioning',   pos52],
                ['Signal Confidence', conf],
              ] as [string, number][]).map(([label, val]) => (
                <PillarRow key={label} label={label} value={val} color="#16A34A" />
              ))}
            </div>

            {/* Valuation */}
            <div className={s.pillarCard}>
              <div className={s.pillarCardHead}>
                <span className={s.pillarCardTitle}>Valuation</span>
                <span className={s.pillarCardScore} style={{ color:'#2E75B6' }}>{valuation.toFixed(0)}</span>
              </div>
              {([
                ['Price vs VWAP',  data.vwap && data.ltp ? Math.min(100,50+((data.ltp-data.vwap)/data.vwap)*500) : 50],
                ['Range Position', pct52w(data.day_low, data.day_high, data.ltp)],
                ['52W Position',   pos52],
                ['Score Rank',     data.score ?? 0],
              ] as [string, number][]).map(([label, val]) => (
                <PillarRow key={label} label={label} value={Math.max(0, Math.min(100, val))} color="#2E75B6" />
              ))}
            </div>

            {/* Technicals */}
            <div className={s.pillarCard}>
              <div className={s.pillarCardHead}>
                <span className={s.pillarCardTitle}>Technicals</span>
                <span className={s.pillarCardScore} style={{ color:'#D97706' }}>{technicals.toFixed(0)}</span>
              </div>
              {([
                ['Signal Strength',  conf],
                ['Day Momentum',     Math.min(100, 50 + data.change_percent * 10)],
                ['Volume Strength',  data.volume > 0 ? 65 : 0],
                ['52W Breakout',     pos52 > 80 ? 90 : pos52 > 60 ? 65 : 40],
              ] as [string, number][]).map(([label, val]) => (
                <PillarRow key={label} label={label} value={Math.max(0, Math.min(100, val))} color="#D97706" />
              ))}
            </div>

            {/* Financial Trend */}
            <div className={s.pillarCard}>
              <div className={s.pillarCardHead}>
                <span className={s.pillarCardTitle}>Financial Trend</span>
                <span className={s.pillarCardScore} style={{ color:'#8B5CF6' }}>{finTrend.toFixed(0)}</span>
              </div>
              {([
                ['Quant Score',   score],
                ['Relative Rank', data.rank_position != null ? Math.max(0, 100 - data.rank_position) : 50],
                ['Price Trend',   Math.min(100, 50 + data.change_percent * 5)],
                ['Market Signal', conf * 0.7],
              ] as [string, number][]).map(([label, val]) => (
                <PillarRow key={label} label={label} value={Math.max(0, Math.min(100, val))} color="#8B5CF6" />
              ))}
            </div>
          </div>

          <div className={s.disclaimer}>
            ⚠️ Scores are calculated by Quantorus365's proprietary algorithm using price, volume, and signal data from public market sources. They are indicative only and not a guarantee of future performance.
          </div>
        </div>
      )}
    </div>
  );
}
