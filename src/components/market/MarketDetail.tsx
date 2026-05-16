'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loading, Empty, Card } from '@/components/ui';
import { chartsApi } from '@/lib/apiClient';
import { useLiveTick } from '@/hooks/useLiveTick';
import { fmt, clsx } from '@/lib/utils';
import {
  Star, Bell, Maximize2, Copy, Check, TrendingUp, TrendingDown,
  Activity, AlertTriangle, Shield, Zap, Target, Brain, Layers,
  Newspaper, History, Clock, PieChart, Minus, DollarSign, Eye,
  BarChart2,
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import type { Candle } from '@/types';
import s from './MarketDetail.module.scss';

// ═══════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════

interface SignalData {
  signal: any;
  approved: boolean;
  confidence_score?: number;
  risk_score?: number;
  portfolio_fit_score?: number;
  opportunity_score?: number;
  conviction_band?: string;
  scenario_tag?: string;
  market_stance?: string;
  regime_alignment?: string;
  rejection_reasons?: string[];
  factor_scores?: Record<string, number>;
  // Live-vs-stored revalidation envelope. When `live_invalidated` is
  // true the stored signal is being shown but the live engine
  // disagrees — render the banner instead of a hard REJECTED pill so
  // the user understands the displayed BUY/SELL was the table's
  // promise but no longer reconfirms live.
  revalidation?: {
    status: 'consistent' | 'revalidated' | 'live_only' | 'stored_only' | 'no_data';
    display_source: 'stored' | 'live' | 'none';
    live_invalidated: boolean;
    banner: string | null;
    stored?: { direction: string | null; signal_status: string | null; confidence_score: number | null; generated_at: string | null; signal_id: number | null };
    live?: { direction: string | null; signal_status: string | null; confidence_score: number | null; rejection_reasons: string[]; rejection_codes: string[] };
  };
}

interface SignalHistory {
  direction: string;
  signal_type: string;
  confidence_score: number;
  risk_score: number;
  entry_price: number | null;
  stop_loss: number | null;
  target1: number | null;
  risk_reward: number | null;
  market_regime: string;
  generated_at: string;
}

interface NewsItem {
  id: number; title: string; source: string;
  url: string; published_at: string; sentiment?: string;
}

// Constants
const TABS = [
  { id: 'overview',  label: 'Overview'      },
  { id: 'signals',   label: 'Signals'       },
  { id: 'technicals',label: 'Technicals'    },
  { id: 'financials',label: 'Financials'    },
  { id: 'news',      label: 'News & Events' },
  { id: 'fit',       label: 'Portfolio Fit'  },
  { id: 'ai',        label: 'AI Insight'    },
  { id: 'history',   label: 'History'       },
] as const;

type TabId = typeof TABS[number]['id'];

const IV_OPTIONS = [
  { key: '1minute',  label: '1m'  },
  { key: '5minute',  label: '5m'  },
  { key: '15minute', label: '15m' },
  { key: '1day',     label: '1D'  },
] as const;

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

function barVariant(v: number): 'g' | 'y' | 'r' {
  return v >= 65 ? 'g' : v >= 40 ? 'y' : 'r';
}

function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const ist = new Date(istMs);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 555 && mins <= 930;
}

function reasonSent(text: string) {
  const t = text.toLowerCase();
  if (t.includes('above') || t.includes('bullish') || t.includes('strong')) return 'pos';
  if (t.includes('below') || t.includes('bearish') || t.includes('weak'))  return 'neg';
  return 'neu';
}

// Ring
function Ring({ value, max = 100, color = '#0B1F3A', size = 88 }: { value: number; max?: number; color?: string; size?: number }) {
  const sw = 6;
  const r = (size - sw * 2) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, (value / max) * 100)) / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E8ECF1" strokeWidth={sw} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={sw}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.7s ease' }} />
    </svg>
  );
}

// Fade wrapper
const Fade = ({ children, k }: { children: React.ReactNode; k: string }) => (
  <motion.div
    key={k}
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
    transition={{ duration: 0.2 }}
  >
    {children}
  </motion.div>
);

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════

interface Props {
  instrumentKey: string;  // e.g. NSE_EQ|NATCOPHARM
  symbol: string;         // e.g. NATCOPHARM
  exchange: string;       // e.g. NSE
}

export default function MarketDetail({ instrumentKey, symbol, exchange }: Props) {
  // State
  const [activeTab, setTab]       = useState<TabId>('overview');
  const [inst, setInst]           = useState<any>(null);
  const [quote, setQuote]         = useState<any>(null);
  const [meta, setMeta]           = useState<any>(null);
  const [candles, setCandles]     = useState<Candle[]>([]);
  const [interval, setIv]         = useState('1minute');
  const [signalData, setSignal]   = useState<SignalData | null>(null);
  const [sigHistory, setSigHist]  = useState<SignalHistory[]>([]);
  const [news, setNews]           = useState<NewsItem[]>([]);
  const [loading, setLoading]     = useState(true);
  const [added, setAdded]         = useState(false);
  const [copied, setCopied]       = useState(false);

  // Live tick
  const { ticks } = useLiveTick([instrumentKey], 'full');
  const tick = ticks[instrumentKey] ?? null;

  // Merged data
  const ltp     = tick?.ltp        ?? quote?.lastPrice         ?? null;
  const open    = tick?.open       ?? quote?.open              ?? null;
  const high    = tick?.high       ?? quote?.dayHigh           ?? null;
  const low     = tick?.low        ?? quote?.dayLow            ?? null;
  const volume  = tick?.volume     ?? quote?.totalTradedVolume ?? null;
  const pctChg  = tick?.pct_change ?? quote?.pChange           ?? null;
  const netChg  = tick?.net_change ?? quote?.change            ?? null;
  const prevCls = quote?.previousClose ?? null;
  const vwap    = quote?.vwap ?? null;
  const pe      = meta?.pe ?? null;
  const marketCap = meta?.marketCap ?? null;
  const week52H = meta?.week52High ?? quote?.fiftyTwoWeekHigh ?? null;
  const week52L = meta?.week52Low  ?? quote?.fiftyTwoWeekLow  ?? null;
  const isFO    = meta?.isFNO || instrumentKey.includes('_FO');
  const oi      = tick?.oi ?? null;
  const positive = (pctChg ?? 0) >= 0;

  // Signal quick access — handles approved, rejected, revalidated, and no-data states.
  //
  // `revalidation` is set by /api/signals?action=instrument since the
  // stored-vs-live merge fix. It tells us:
  //   - `status`           : consistent | revalidated | live_only | stored_only
  //   - `live_invalidated` : true when stored APPROVED but live disagrees
  // The `revalidated` case must NOT render the REJECTED pill — the
  // displayed signal IS the authoritative BUY/SELL the main /signals
  // table promised; the banner communicates the live disagreement.
  const sig          = signalData?.signal;
  const reval        = signalData?.revalidation;
  const isRevalidated = reval?.status === 'revalidated';
  // approved=false ONLY when the engine has nothing to show — i.e.
  // pure live rejection with no stored row backing it. The
  // revalidated case ships approved=true so the BUY chip / trade
  // levels still render.
  const sigApproved   = signalData?.approved === true && !isRevalidated;
  const sigRejected   = signalData != null && signalData.approved === false && !isRevalidated;
  const hasSignalData = signalData != null;
  const conf    = signalData?.confidence_score ?? sig?.confidence ?? 0;
  const risk    = signalData?.risk_score ?? sig?.risk_score ?? 0;
  const fitScore = signalData?.portfolio_fit_score ?? sig?.portfolio_fit ?? 0;
  const sigDir  = sig?.direction ?? null;
  const entry   = sig?.entry_price ?? null;
  const sl      = sig?.stop_loss ?? null;
  const t1      = sig?.target1 ?? null;
  const t2      = sig?.target2 ?? null;
  const rr      = sig?.risk_reward ?? null;

  // ── Load ───────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      setLoading(true);
      const [iRes, cRes, qRes, sRes] = await Promise.allSettled([
        fetch(`/api/instruments?key=${encodeURIComponent(instrumentKey)}`).then(r => r.json()),
        chartsApi.intraday(instrumentKey, '1minute'),
        fetch(`/api/market?resource=quote&symbol=${encodeURIComponent(symbol)}`).then(r => r.json()),
        fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(symbol)}`)
          .then(r => r.ok ? r.json() : null),
      ]);

      if (iRes.status === 'fulfilled' && iRes.value?.instrument) setInst(iRes.value.instrument);
      else setInst({ tradingsymbol: symbol, exchange, instrument_type: 'EQ', name: symbol });

      if (cRes.status === 'fulfilled') setCandles((cRes.value as any).candles || []);
      if (qRes.status === 'fulfilled' && qRes.value?.quote) {
        setQuote(qRes.value.quote);
        if (qRes.value.meta) setMeta(qRes.value.meta);
      }
      if (sRes.status === 'fulfilled' && sRes.value && !sRes.value.error) {
        setSignal(sRes.value);
      }

      setLoading(false);
    }
    load();
  }, [instrumentKey, symbol, exchange]);

  // Lazy load per tab
  useEffect(() => {
    if (activeTab === 'news' && news.length === 0) {
      fetch(`/api/news?q=${encodeURIComponent(symbol)}&limit=10`)
        .then(r => r.json())
        .then(d => setNews(d.news ?? d.articles ?? []))
        .catch(() => {});
    }
    if (activeTab === 'history' && sigHistory.length === 0) {
      fetch(`/api/signals?action=history&symbol=${encodeURIComponent(symbol)}`)
        .then(r => r.json())
        .then(d => setSigHist(d.history ?? []))
        .catch(() => {});
    }
  }, [activeTab, symbol]);

  // Chart interval switch
  const switchInterval = useCallback(async (iv: string) => {
    setIv(iv);
    try {
      const isDaily = iv === '1day';
      const data = isDaily
        ? await chartsApi.historical(instrumentKey, 'days', '1')
        : await chartsApi.intraday(instrumentKey, iv);
      setCandles((data as any).candles || []);
    } catch {}
  }, [instrumentKey]);

  // Actions
  const addWatch = async () => {
    try {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument_key: instrumentKey, tradingsymbol: symbol, exchange, name: inst?.name || symbol }),
      });
      setAdded(true);
    } catch {}
  };

  const copyPlan = () => {
    const text = [
      `${symbol} — ${sigDir ?? 'No Signal'}`,
      `Confidence: ${conf}%`,
      `Entry: ${entry ?? '-'}  SL: ${sl ?? '-'}`,
      `T1: ${t1 ?? '-'}  T2: ${t2 ?? '-'}`,
      `R:R: 1:${rr ?? '-'}`,
      `Risk: ${risk}  Fit: ${fitScore}`,
      '', 'Quantorus365',
    ].join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Loading ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center' }}>
        <Loading text={`Loading ${symbol}...`} />
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════

  return (
    <div className={s.page}>

      {/* ══ HERO ════════════════════════════════════════════════ */}
      <motion.div
        className={s.hero}
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className={s.heroTop}>
          <div className={s.heroLeft}>
            <div className={s.symbolRow}>
              <span className={s.symbol}>{inst?.tradingsymbol ?? symbol}</span>
              <span className={clsx(s.pill, s['pill--exchange'])}>{exchange}</span>
              {inst?.instrument_type && inst.instrument_type !== 'EQ' && (
                <span className={clsx(s.pill, s['pill--segment'])}>{inst.instrument_type}</span>
              )}
              {isFO && <span className={clsx(s.pill, s['pill--fo'])}>F&O</span>}
              {sigDir && (sigApproved || isRevalidated) && (
                <span className={clsx(s.pill, s[`pill--${sigDir.toLowerCase()}`])}>{sigDir}</span>
              )}
              {isRevalidated && (
                <span
                  className={clsx(s.pill, s['pill--regime'])}
                  title={reval?.banner ?? 'Live engine no longer confirms the stored signal'}
                >
                  REVALIDATED
                </span>
              )}
              {sigRejected && (
                <span className={clsx(s.pill, s['pill--hold'])}>REJECTED</span>
              )}
              {signalData?.scenario_tag && (
                <span className={clsx(s.pill, s['pill--regime'])}>{signalData.scenario_tag}</span>
              )}
              {signalData?.market_stance && (
                <span className={clsx(s.pill, s['pill--regime'])}>{signalData.market_stance}</span>
              )}
            </div>
            <span className={s.companyName}>
              {meta?.companyName ?? inst?.name ?? symbol}
              {meta?.sector && ` · ${meta.sector}`}
              {meta?.industry && ` · ${meta.industry}`}
            </span>
          </div>

          <div className={s.heroRight}>
            {ltp != null && <div className={s.ltp}>{fmt.currency(ltp)}</div>}
            {netChg != null && (
              <div className={clsx(s.change, positive ? s['change--up'] : s['change--down'])}>
                {positive ? '+' : ''}{fmt.currency(Math.abs(netChg))} ({fmt.percent(pctChg)})
              </div>
            )}
            <div className={s.marketStatus}>
              <span className={clsx(s.dot, isMarketOpen() ? s['dot--open'] : s['dot--closed'])} />
              {isMarketOpen() ? 'Market Open' : 'Market Closed'}
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div className={s.heroStats}>
          {([
            ['Open',  fmt.currency(open)],
            ['High',  fmt.currency(high)],
            ['Low',   fmt.currency(low)],
            ['Prev',  fmt.currency(prevCls)],
            ['Vol',   fmt.volume(volume)],
            ['VWAP',  fmt.currency(vwap)],
            [isFO ? 'OI' : 'P/E', isFO ? fmt.volume(oi) : (pe != null ? Number(pe).toFixed(2) : '-')],
          ] as [string, string][]).map(([l, v]) => (
            <div key={l} className={s.hStat}>
              <div className={s.hStatLabel}>{l}</div>
              <div className={s.hStatValue}>{v}</div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className={s.heroActions}>
          <button className={clsx(s.heroBtn, added && s['heroBtn--active'])} onClick={addWatch} disabled={added}>
            <Star size={11} fill={added ? 'currentColor' : 'none'} />
            {added ? 'Watchlisted' : 'Watchlist'}
          </button>
          <button className={s.heroBtn}><Bell size={11} /> Alert</button>
          <button className={s.heroBtn}><Maximize2 size={11} /> Chart</button>
          <button className={s.heroBtn} onClick={copyPlan}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy Plan'}
          </button>
        </div>
      </motion.div>

      {/* ══ TABS ════════════════════════════════════════════════ */}
      <div className={s.tabBar} role="tablist">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={activeTab === id}
            className={clsx(s.tab, activeTab === id && s['tab--active'])}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ══ BODY ════════════════════════════════════════════════ */}
      <div className={s.body}>
        <div className={s.main}>

          {/* ── Chart ─────────────────────────────────────────── */}
          <motion.div
            className={s.chartCard}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.3 }}
          >
            <div className={s.chartToolbar}>
              <span className={s.chartTitle}>{symbol} Price</span>
              <div className={s.ivGroup}>
                {IV_OPTIONS.map(iv => (
                  <button
                    key={iv.key}
                    className={clsx(s.ivBtn, interval === iv.key && s['ivBtn--active'])}
                    onClick={() => switchInterval(iv.key)}
                  >
                    {iv.label}
                  </button>
                ))}
              </div>
            </div>

            {candles.length === 0 ? (
              <Empty icon={Activity} title="No chart data"
                description="Market may be closed or data not yet available." />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={candles} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={positive ? '#16A34A' : '#DC2626'} stopOpacity={0.1} />
                      <stop offset="100%" stopColor={positive ? '#16A34A' : '#DC2626'} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
                  <XAxis
                    dataKey="ts"
                    tickFormatter={v =>
                      interval === '1day'
                        ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
                        : new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                    }
                    tick={{ fontSize: 10, fill: '#94A3B8' }}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tickFormatter={v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    tick={{ fontSize: 10, fill: '#94A3B8' }} width={55}
                  />
                  <Tooltip
                    formatter={(v: any) => [fmt.currency(v), 'Close']}
                    labelFormatter={v => new Date(v).toLocaleString('en-IN')}
                    contentStyle={{ borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 11 }}
                  />
                  {prevCls && <ReferenceLine y={prevCls} stroke="#94A3B8" strokeDasharray="4 4" label={{ value: 'Prev', fill: '#94A3B8', fontSize: 9 }} />}
                  {entry && <ReferenceLine y={entry} stroke="#0B1F3A" strokeDasharray="4 4" label={{ value: 'Entry', fill: '#0B1F3A', fontSize: 9 }} />}
                  {sl    && <ReferenceLine y={sl} stroke="#DC2626" strokeDasharray="4 4" label={{ value: 'SL', fill: '#DC2626', fontSize: 9 }} />}
                  {t1    && <ReferenceLine y={t1} stroke="#16A34A" strokeDasharray="4 4" label={{ value: 'T1', fill: '#16A34A', fontSize: 9 }} />}
                  <Area type="monotone" dataKey="close" stroke={positive ? '#16A34A' : '#DC2626'}
                    strokeWidth={1.5} fill="url(#cg)" dot={false} activeDot={{ r: 3 }} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </motion.div>

          {/* ── Tab Content ────────────────────────────────────── */}
          <AnimatePresence mode="wait">
            {/* OVERVIEW */}
            {activeTab === 'overview' && (
              <Fade k="overview">
                <div className={s.panel}>
                  {/* Stats cards */}
                  <div className={s.statsRow}>
                    {([
                      ['LTP',    fmt.currency(ltp)],
                      ['Open',   fmt.currency(open)],
                      ['High',   fmt.currency(high)],
                      ['Low',    fmt.currency(low)],
                      ['Volume', fmt.volume(volume)],
                      [isFO ? 'OI' : 'P/E', isFO ? fmt.volume(oi) : (pe != null ? Number(pe).toFixed(2) : '-')],
                    ] as [string, string][]).map(([l, v]) => (
                      <div key={l} className={s.statCard}>
                        <div className={s.statLabel}>{l}</div>
                        <div className={s.statValue}>{v}</div>
                      </div>
                    ))}
                  </div>

                  {/* Extended details */}
                  <Card title="Market Details">
                    {meta?.surveillance && (
                      <div className={s.survBanner}>
                        <strong>Surveillance:</strong> {meta.survDesc ?? meta.surveillance}
                      </div>
                    )}
                    <div className={s.detailGrid}>
                      {prevCls != null && <DI label="Prev Close" value={fmt.currency(prevCls)} />}
                      {vwap != null && <DI label="VWAP" value={fmt.currency(vwap)} />}
                      {marketCap != null && <DI label="Market Cap" value={fmt.volume(marketCap)} />}
                      {meta?.eps != null && <DI label="EPS" value={fmt.currency(meta.eps)} />}
                      {meta?.beta != null && <DI label="Beta" value={Number(meta.beta).toFixed(2)} />}
                      {meta?.pbRatio != null && <DI label="P/B" value={Number(meta.pbRatio).toFixed(2)} />}
                      {meta?.roe != null && <DI label="ROE" value={`${Number(meta.roe).toFixed(1)}%`} />}
                      {meta?.dividendYield != null && <DI label="Div Yield" value={`${Number(meta.dividendYield).toFixed(2)}%`} />}
                      {week52H != null && <DI label="52W High" value={fmt.currency(week52H)} color="#16A34A" />}
                      {week52L != null && <DI label="52W Low" value={fmt.currency(week52L)} color="#DC2626" />}
                      {meta?.upperCP != null && <DI label="Upper Circuit" value={fmt.currency(Number(meta.upperCP))} color="#16A34A" />}
                      {meta?.lowerCP != null && <DI label="Lower Circuit" value={fmt.currency(Number(meta.lowerCP))} color="#DC2626" />}
                      {meta?.faceValue != null && <DI label="Face Value" value={`₹${meta.faceValue}`} />}
                      {meta?.issuedSize != null && <DI label="Shares Out" value={fmt.volume(meta.issuedSize)} />}
                      {meta?.listingDate && <DI label="Listed" value={fmt.date(meta.listingDate)} />}
                      {meta?.isin && <DI label="ISIN" value={meta.isin} mono />}
                    </div>
                  </Card>
                </div>
              </Fade>
            )}

            {/* SIGNALS */}
            {activeTab === 'signals' && (
              <Fade k="signals">
                <div className={s.panel}>
                  {sig ? (
                    <Card>
                      <div className={s.kv}><span className={s.kvL}>Direction</span><span className={s.kvV}>{sigDir}</span></div>
                      <div className={s.kv}><span className={s.kvL}>Strategy</span><span className={s.kvV}>{sig.signal_type ?? sig.strategy_code ?? '-'}</span></div>
                      <div className={s.kv}><span className={s.kvL}>Confidence</span><span className={s.kvV}>{conf}%</span></div>
                      <div className={s.confBar}>
                        <div className={clsx(s.confFill, s[`confFill--${barVariant(conf)}`])} style={{ width: `${conf}%` }} />
                      </div>
                      <div className={s.kv}><span className={s.kvL}>Risk</span><span className={s.kvV}>{risk}</span></div>
                      <div className={s.kv}><span className={s.kvL}>Conviction</span><span className={s.kvV}>{signalData?.conviction_band ?? '-'}</span></div>
                      <div className={s.kv}><span className={s.kvL}>Regime</span><span className={s.kvV}>{sig.market_regime ?? signalData?.regime_alignment ?? '-'}</span></div>

                      <div style={{ marginTop: 12 }} />
                      <div className={s.levelsGrid}>
                        <LvlBox label="Entry" value={entry} mod="entry" />
                        <LvlBox label="Stop Loss" value={sl} mod="stop" />
                        <LvlBox label="Target 1" value={t1} mod="target" />
                        <LvlBox label="Target 2" value={t2} mod="target" />
                      </div>

                      {rr != null && (
                        <div style={{ fontSize: 12, color: '#64748B', textAlign: 'center', marginTop: 8 }}>
                          R:R <strong style={{ color: '#0B1120' }}>1:{rr}</strong>
                        </div>
                      )}

                      {sig.reasons?.length > 0 && (
                        <div style={{ marginTop: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', marginBottom: 4 }}>Rationale</div>
                          <div className={s.reasons}>
                            {sig.reasons.map((r: any, i: number) => (
                              <div key={i} className={s.reasonRow}>
                                <div className={clsx(s.rDot, s[`rDot--${reasonSent(r.text)}`])} />
                                <span className={s.rText}>{r.text}</span>
                                {r.factor_key && <span className={s.rKey}>{r.factor_key}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </Card>
                  ) : signalData && !signalData.approved ? (
                    <Card>
                      <div style={{ textAlign: 'center', padding: 16 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#B91C1C', marginBottom: 6 }}>Signal Rejected</div>
                        {signalData.rejection_reasons?.map((r, i) => (
                          <div key={i} style={{ fontSize: 12, color: '#64748B', marginBottom: 2 }}>{r}</div>
                        ))}
                      </div>
                    </Card>
                  ) : (
                    <div className={s.empty}>
                      <div className={s.emptyIcon}><Zap size={20} /></div>
                      <div className={s.emptyTitle}>No signal available</div>
                      <div className={s.emptyDesc}>Signal engine has not processed this instrument yet.</div>
                    </div>
                  )}
                  <div className={s.disclaimer}>
                    Signals are generated by Quantorus365's rule-based algorithm. Not financial advice.
                  </div>
                </div>
              </Fade>
            )}

            {/* TECHNICALS */}
            {activeTab === 'technicals' && (
              <Fade k="technicals">
                <div className={s.panel}>
                  <div className={s.grid2}>
                    <Card title="Momentum">
                      {([
                        ['Direction', sigDir ?? '-', sigDir === 'BUY' ? 'bullish' : sigDir === 'SELL' ? 'bearish' : 'neutral'],
                        ['Confidence', `${conf}%`, conf >= 60 ? 'bullish' : conf >= 40 ? 'neutral' : 'bearish'],
                        ['Risk Score', `${risk}`, risk <= 40 ? 'bullish' : risk <= 60 ? 'neutral' : 'bearish'],
                      ] as [string, string, string][]).map(([n, v, chip]) => (
                        <div key={n} className={s.techRow}>
                          <span className={s.techN}>{n}</span>
                          <span className={s.techV}>{v}</span>
                          <span className={clsx(s.techChip, s[`techChip--${chip}`])}>{chip}</span>
                        </div>
                      ))}
                    </Card>
                    <Card title="Price Structure">
                      {([
                        ['Day Range', `${fmt.currency(low)} - ${fmt.currency(high)}`],
                        ['Volume', fmt.volume(volume)],
                        ['52W High', fmt.currency(week52H)],
                        ['52W Low', fmt.currency(week52L)],
                      ] as [string, string][]).map(([n, v]) => (
                        <div key={n} className={s.techRow}>
                          <span className={s.techN}>{n}</span>
                          <span className={s.techV}>{v}</span>
                        </div>
                      ))}
                    </Card>
                    <Card title="Support & Resistance">
                      {([
                        ['Entry Zone', entry ? fmt.currency(entry) : '-'],
                        ['Stop Loss', sl ? fmt.currency(sl) : '-'],
                        ['Target 1', t1 ? fmt.currency(t1) : '-'],
                        ['Target 2', t2 ? fmt.currency(t2) : '-'],
                      ] as [string, string][]).map(([n, v]) => (
                        <div key={n} className={s.techRow}>
                          <span className={s.techN}>{n}</span>
                          <span className={s.techV}>{v}</span>
                        </div>
                      ))}
                    </Card>
                  </div>
                </div>
              </Fade>
            )}

            {/* FINANCIALS */}
            {activeTab === 'financials' && (
              <Fade k="financials">
                <div className={s.panel}>
                  <Card title="Valuation & Fundamentals">
                    {([
                      ['P/E (Trailing)', pe != null ? Number(pe).toFixed(2) : '-'],
                      ['P/E (Forward)', meta?.forwardPe != null ? Number(meta.forwardPe).toFixed(2) : '-'],
                      ['P/E (Sector)', meta?.sectorPe != null ? Number(meta.sectorPe).toFixed(2) : '-'],
                      ['P/B Ratio', meta?.pbRatio != null ? Number(meta.pbRatio).toFixed(2) : '-'],
                      ['EPS', meta?.eps != null ? fmt.currency(meta.eps) : '-'],
                      ['ROE', meta?.roe != null ? `${Number(meta.roe).toFixed(1)}%` : '-'],
                      ['Beta', meta?.beta != null ? Number(meta.beta).toFixed(2) : '-'],
                      ['Div Yield', meta?.dividendYield != null ? `${Number(meta.dividendYield).toFixed(2)}%` : '-'],
                      ['Market Cap', marketCap != null ? fmt.volume(marketCap) : '-'],
                    ] as [string, string][]).map(([l, v]) => (
                      <div key={l} className={s.kv}>
                        <span className={s.kvL}>{l}</span>
                        <span className={s.kvV}>{v}</span>
                      </div>
                    ))}
                  </Card>
                </div>
              </Fade>
            )}

            {/* NEWS */}
            {activeTab === 'news' && (
              <Fade k="news">
                <div className={s.panel}>
                  {news.length === 0 ? (
                    <div className={s.empty}>
                      <div className={s.emptyIcon}><Newspaper size={20} /></div>
                      <div className={s.emptyTitle}>No news for {symbol}</div>
                      <div className={s.emptyDesc}>News aggregates from financial APIs and exchange disclosures.</div>
                    </div>
                  ) : (
                    <Card title="Latest News" flush>
                      {news.map(item => (
                        <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" className={s.newsItem}>
                          <div className={s.newsIcon}><Newspaper size={14} /></div>
                          <div className={s.newsBody}>
                            <div className={s.newsTitle}>{item.title}</div>
                            <div className={s.newsMeta}>
                              <span>{item.source}</span><span>&middot;</span>
                              <span>{new Date(item.published_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
                              {item.sentiment && (
                                <span className={clsx(s.sentChip, s[`sentChip--${item.sentiment}`])}>{item.sentiment}</span>
                              )}
                            </div>
                          </div>
                        </a>
                      ))}
                    </Card>
                  )}
                </div>
              </Fade>
            )}

            {/* PORTFOLIO FIT */}
            {activeTab === 'fit' && (
              <Fade k="fit">
                <div className={s.panel}>
                  <div className={s.grid2}>
                    <Card title="Fit Score">
                      <div className={s.fitCenter}>
                        <div className={s.fitRingWrap}>
                          <Ring value={fitScore} size={100} color={fitScore >= 65 ? '#16A34A' : fitScore >= 40 ? '#D97706' : '#DC2626'} />
                          <div className={s.fitRingVal}>
                            {fitScore > 0 ? fitScore.toFixed(0) : '-'}
                            <span className={s.fitRingSub}>/ 100</span>
                          </div>
                        </div>
                        <div className={s.fitRingCap}>
                          {fitScore >= 65 ? 'Strong Fit' : fitScore >= 40 ? 'Moderate' : 'Weak Fit'}
                        </div>
                      </div>
                    </Card>
                    <Card title="Factors">
                      {([
                        ['Sector Exposure', Math.min(100, fitScore * 0.85)],
                        ['Correlation Risk', Math.min(100, 100 - risk * 0.6)],
                        ['Capital Impact',   Math.min(100, fitScore * 0.75)],
                      ] as [string, number][]).map(([l, v]) => (
                        <div key={l} className={s.fitFactor}>
                          <span className={s.fitFN}>{l}</span>
                          <div className={s.fitFBar}>
                            <div className={s.fitFBarFill} style={{ width: `${v}%`, background: v >= 55 ? '#16A34A' : '#D97706' }} />
                          </div>
                          <span className={s.fitFV}>{v.toFixed(0)}</span>
                        </div>
                      ))}
                    </Card>
                  </div>
                </div>
              </Fade>
            )}

            {/* AI */}
            {activeTab === 'ai' && (
              <Fade k="ai">
                <div className={s.panel}>
                  <div className={s.aiBlock}>
                    <div className={s.aiBlockTitle}><Brain size={14} /> Decision Summary</div>
                    <p className={s.aiText}>
                      {sig
                        ? `${symbol} shows a ${sigDir} signal with ${conf}% confidence (${signalData?.conviction_band ?? 'moderate'} conviction). Scenario: ${signalData?.scenario_tag ?? '-'}, Stance: ${signalData?.market_stance ?? '-'}.`
                        : `${symbol} does not have an active signal. The engine did not find a high-conviction setup at the current price level.`
                      }
                    </p>
                  </div>
                  {sig && (
                    <>
                      <div className={s.aiBlock}>
                        <div className={s.aiBlockTitle}><Target size={14} /> Trade Narrative</div>
                        <div className={s.aiCallout}>
                          {sigDir === 'BUY'
                            ? `Entry near ${entry ? fmt.currency(entry) : 'current levels'} with stop at ${sl ? fmt.currency(sl) : 'defined level'}. R:R of 1:${rr ?? '-'} meets system threshold.`
                            : `Bearish pressure detected. Reduce exposure or implement protective measures.`
                          }
                        </div>
                      </div>
                      <div className={s.aiBlock}>
                        <div className={s.aiBlockTitle}><AlertTriangle size={14} /> Invalidation</div>
                        <p className={s.aiText}>
                          Setup invalidated if price moves beyond stop at {sl ? fmt.currency(sl) : 'defined level'}. Watch for volume spikes against direction, regime changes, or confidence drops below 50%.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </Fade>
            )}

            {/* HISTORY */}
            {activeTab === 'history' && (
              <Fade k="history">
                <div className={s.panel}>
                  {sigHistory.length > 0 ? (
                    <Card title="Signal History">
                      <div className={s.timeline}>
                        {sigHistory.map((h, i) => (
                          <div key={i} className={s.tlItem}>
                            <div className={clsx(s.tlDot, h.direction === 'BUY' ? s['tlDot--entry'] : s['tlDot--signal'])} />
                            <div className={s.tlDate}>{fmt.datetime(h.generated_at)}</div>
                            <div className={s.tlTitle}>{h.direction} — {h.signal_type}</div>
                            <div className={s.tlDesc}>
                              Conf {h.confidence_score}% · Risk {h.risk_score} · Entry {h.entry_price ? fmt.currency(h.entry_price) : '-'} · R:R 1:{h.risk_reward ?? '-'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                  ) : (
                    <div className={s.empty}>
                      <div className={s.emptyIcon}><History size={20} /></div>
                      <div className={s.emptyTitle}>No signal history</div>
                      <div className={s.emptyDesc}>Past signals will appear here once generated.</div>
                    </div>
                  )}
                </div>
              </Fade>
            )}
          </AnimatePresence>
        </div>

        {/* ══ DECISION PANEL ════════════════════════════════════ */}
        <motion.aside
          className={s.dp}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2, duration: 0.3 }}
        >
          {/* Signal Intelligence */}
          <div className={s.dpCardTop}>
            <div className={s.dpSectionLabel}>Signal Intelligence</div>
            {(sigApproved || isRevalidated) && sigDir ? (
              <div className={clsx(s.dpVerdict, s[`dpVerdict--${sigDir}`])}>
                {sigDir === 'BUY' ? <TrendingUp size={15} /> : sigDir === 'SELL' ? <TrendingDown size={15} /> : <Minus size={15} />}
                {sigDir}
                {isRevalidated && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: '#92400E', fontWeight: 600 }}>
                    REVALIDATED
                  </span>
                )}
              </div>
            ) : sigRejected ? (
              <div className={clsx(s.dpVerdict, s['dpVerdict--HOLD'])}>
                <Shield size={15} /> Rejected
              </div>
            ) : (
              <div className={clsx(s.dpVerdict, s['dpVerdict--none'])}>No Active Signal</div>
            )}

            {/* Show scores whenever we have signal data (approved or rejected) */}
            {hasSignalData && (
              <>
                <div className={s.dpRow}>
                  <span className={s.dpRowL}>Confidence</span>
                  <span className={s.dpRowV}>
                    <span className={s.dpBar}><span className={clsx(s.dpBarFill, s[`dpBarFill--${barVariant(conf)}`])} style={{ width: `${conf}%` }} /></span>
                    {conf}%
                  </span>
                </div>
                <div className={s.dpRow}>
                  <span className={s.dpRowL}>Risk</span>
                  <span className={s.dpRowV}>
                    <span className={s.dpBar}><span className={clsx(s.dpBarFill, s[`dpBarFill--${barVariant(100 - risk)}`])} style={{ width: `${risk}%` }} /></span>
                    {risk}
                  </span>
                </div>
                <div className={s.dpRow}>
                  <span className={s.dpRowL}>Fit</span>
                  <span className={s.dpRowV}>
                    <span className={s.dpBar}><span className={clsx(s.dpBarFill, s[`dpBarFill--${barVariant(fitScore)}`])} style={{ width: `${fitScore}%` }} /></span>
                    {fitScore > 0 ? fitScore.toFixed(0) : '-'}
                  </span>
                </div>
                {signalData?.conviction_band && (
                  <div className={s.dpRow}>
                    <span className={s.dpRowL}>Conviction</span>
                    <span className={s.dpRowV}>{signalData.conviction_band}</span>
                  </div>
                )}
                {signalData?.scenario_tag && (
                  <div className={s.dpRow}>
                    <span className={s.dpRowL}>Scenario</span>
                    <span className={s.dpRowV}>{signalData.scenario_tag}</span>
                  </div>
                )}
                {signalData?.market_stance && (
                  <div className={s.dpRow}>
                    <span className={s.dpRowL}>Stance</span>
                    <span className={s.dpRowV}>{signalData.market_stance}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Readiness */}
          {hasSignalData && (
            <div className={s.dpCard}>
              <div className={s.dpSectionLabel}>Execution</div>
              <div className={clsx(
                s.dpReadiness,
                isRevalidated
                  ? s['dpReadiness--wait']
                  : sigApproved && conf >= 65
                    ? s['dpReadiness--go']
                    : conf >= 45 && sigApproved
                      ? s['dpReadiness--wait']
                      : s['dpReadiness--no']
              )}>
                {isRevalidated
                  ? <AlertTriangle size={13} />
                  : sigApproved && conf >= 65
                    ? <Check size={13} />
                    : conf >= 45 && sigApproved
                      ? <AlertTriangle size={13} />
                      : <Shield size={13} />}
                {isRevalidated
                  ? 'Signal Changed / Revalidated'
                  : sigApproved && conf >= 65
                    ? 'Ready'
                    : sigApproved && conf >= 45
                      ? 'Caution'
                      : sigRejected
                        ? 'Rejected by Engine'
                        : 'Not Recommended'}
              </div>
              {isRevalidated && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#92400E', lineHeight: 1.5 }}>
                  {reval?.banner ?? 'Live engine no longer confirms the stored signal.'}
                  {reval?.live?.confidence_score != null && (
                    <> Live confidence: <strong>{reval.live.confidence_score}</strong>.</>
                  )}
                  {reval?.live?.rejection_reasons && reval.live.rejection_reasons.length > 0 && (
                    <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>
                      {reval.live.rejection_reasons.slice(0, 3).map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {sigRejected && signalData?.rejection_reasons && signalData.rejection_reasons.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#64748B', lineHeight: 1.5 }}>
                  {signalData.rejection_reasons.slice(0, 3).map((r, i) => (
                    <div key={i}>• {r}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Trade Plan — also rendered for revalidated rows so the
              user can still see the levels the main /signals table
              promised, but suppressed for pure rejections. */}
          {(sigApproved || isRevalidated) && sig && (
            <div className={s.dpCard}>
              <div className={s.dpSectionLabel}>Trade Plan</div>
              <div className={s.dpLevels}>
                <DPLvl label="Entry" value={entry} mod="entry" />
                <DPLvl label="Stop" value={sl} mod="stop" />
                <DPLvl label="Target 1" value={t1} mod="target" />
                <DPLvl label="Target 2" value={t2} mod="target" />
              </div>
              {rr != null && (
                <div className={s.dpRR}>
                  <span className={s.dpRRLabel}>R:R</span>
                  <span className={s.dpRRVal}>1:{rr}</span>
                </div>
              )}
            </div>
          )}

          {/* Portfolio Fit */}
          <div className={s.dpCard}>
            <div className={s.dpSectionLabel}>Portfolio Fit</div>
            <div className={s.dpRow}><span className={s.dpRowL}>Score</span><span className={s.dpRowV}>{fitScore > 0 ? `${fitScore.toFixed(0)}/100` : '-'}</span></div>
            <div className={s.dpRow}><span className={s.dpRowL}>Size</span><span className={s.dpRowV}>2-3%</span></div>
            <div className={s.dpRow}><span className={s.dpRowL}>Correlation</span><span className={s.dpRowV}>{risk < 40 ? 'Low' : risk < 60 ? 'Moderate' : 'High'}</span></div>
          </div>

          {/* Event Risk */}
          <div className={s.dpCard}>
            <div className={s.dpSectionLabel}>Event Risk</div>
            <div className={s.dpEventRisk}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Verify corporate announcements before execution.</span>
            </div>
          </div>

          {/* Copy */}
          <button className={clsx(s.dpCopy, copied && s['dpCopy--done'])} onClick={copyPlan}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy Trade Plan'}
          </button>
        </motion.aside>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Tiny sub-components (kept in same file — too small to extract)
// ═══════════════════════════════════════════════════════════════════

function DI({ label, value, color, mono }: { label: string; value: string; color?: string; mono?: boolean }) {
  return (
    <div className={s.detailItem}>
      <div className={s.detailItemLabel}>{label}</div>
      <div className={s.detailItemValue} style={{
        color: color ?? undefined,
        fontFamily: mono ? 'var(--font-mono, monospace)' : undefined,
        fontSize: mono ? 12 : undefined,
      }}>{value}</div>
    </div>
  );
}

function LvlBox({ label, value, mod }: { label: string; value: number | null; mod: string }) {
  return (
    <div className={s.lvlBox}>
      <div className={s.lvlBoxL}>{label}</div>
      <div className={clsx(s.lvlBoxV, s[`lvlBoxV--${mod}`])}>
        {value != null ? fmt.currency(value) : '-'}
      </div>
    </div>
  );
}

function DPLvl({ label, value, mod }: { label: string; value: number | null; mod: string }) {
  return (
    <div className={s.dpLevel}>
      <div className={s.dpLevelLabel}>{label}</div>
      <div className={clsx(s.dpLevelVal, s[`dpLevelVal--${mod}`])}>
        {value != null ? fmt.currency(value) : '-'}
      </div>
    </div>
  );
}
