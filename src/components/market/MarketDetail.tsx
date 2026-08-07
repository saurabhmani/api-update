'use client';

import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loading, Empty, Card, Modal } from '@/components/ui';
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
  AreaChart, Area, XAxis, YAxis, Tooltip, Brush,
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
  entry_price?: number | null;
  stop_loss?: number | null;
  target1?: number | null;
  target2?: number | null;
  risk_reward?: number | null;
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
  summary?: string | null;
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

function defaultChartBrushWindow(iv: string, len: number) {
  const windowSize = iv === '1day' ? 45 : iv === '1minute' ? 90 : 60;
  return { start: Math.max(0, len - windowSize), end: len - 1 };
}

function reasonSent(text: string) {
  const t = text.toLowerCase();
  if (t.includes('above') || t.includes('bullish') || t.includes('strong')) return 'pos';
  if (t.includes('below') || t.includes('bearish') || t.includes('weak'))  return 'neg';
  return 'neu';
}

function tradeLevel(...values: unknown[]): number | null {
  for (const v of values) {
    const x = Number(v);
    if (Number.isFinite(x) && x > 0) return x;
  }
  return null;
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
  const [tradeFallback, setTrade] = useState<{
    entry_price?: number | null;
    stop_loss?: number | null;
    target1?: number | null;
    target2?: number | null;
    risk_reward?: number | null;
    signal_type?: string | null;
  } | null>(null);
  const [metaRefreshAttempted, setMetaRefresh] = useState(false);
  const [portfolioFit, setPortfolioFit] = useState<{
    fitScore: number;
    sectorPenalty?: number;
    correlationPenalty?: number;
    strategyPenalty?: number;
    drawdownPenalty?: number;
    capacityScore?: number;
    warnings?: string[];
    notes?: string;
    sector?: string;
    portfolioContext?: {
      totalPositions?: number;
      sectorExposure?: Record<string, number>;
      drawdownPct?: number;
      correlationAvg?: number;
    };
  } | null>(null);
  const [sigHistory, setSigHist]  = useState<SignalHistory[]>([]);
  const [news, setNews]           = useState<NewsItem[]>([]);
  const [loading, setLoading]     = useState(true);
  const [added, setAdded]         = useState(false);
  const [copied, setCopied]       = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [alertPrice, setAlertPrice] = useState('');
  const [alertCondition, setAlertCondition] = useState<'above' | 'below'>('above');
  const [alertSaving, setAlertSaving] = useState(false);
  const [alertDone, setAlertDone]   = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartBrush, setChartBrush] = useState<{ start: number; end: number } | null>(null);

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
  // Prefer live portfolio-fit evaluation, then signal payload, then
  // the same min(100, conf+5) backfill used by /signals so the ring
  // is never blank for an approved institutional row.
  const fitFromSignal =
    (signalData?.portfolio_fit_score != null && signalData.portfolio_fit_score > 0
      ? signalData.portfolio_fit_score
      : null)
    ?? (sig?.portfolio_fit != null && Number(sig.portfolio_fit) > 0
      ? Number(sig.portfolio_fit)
      : null)
    ?? (tradeFallback && (tradeFallback as any).portfolio_fit != null
      ? Number((tradeFallback as any).portfolio_fit)
      : null);
  const fitScore =
    (portfolioFit?.fitScore != null && portfolioFit.fitScore > 0
      ? portfolioFit.fitScore
      : null)
    ?? fitFromSignal
    ?? (conf > 0 ? Math.min(100, conf + 5) : 0);
  const sigDir  = sig?.direction ?? tradeFallback?.signal_type ?? null;
  const entry   = tradeLevel(sig?.entry_price, signalData?.entry_price, tradeFallback?.entry_price);
  const sl      = tradeLevel(sig?.stop_loss, signalData?.stop_loss, tradeFallback?.stop_loss);
  const t1      = tradeLevel(sig?.target1, signalData?.target1, tradeFallback?.target1);
  const t2      = tradeLevel(sig?.target2, signalData?.target2, tradeFallback?.target2);
  const rr      = tradeLevel(sig?.risk_reward, signalData?.risk_reward, tradeFallback?.risk_reward);

  // ── Load ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function timedJson(url: string, ms = 12_000): Promise<any> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { signal: ctrl.signal, credentials: 'include' });
        if (!r.ok) return null;
        return await r.json();
      } finally {
        clearTimeout(timer);
      }
    }

    async function loadCore() {
      setLoading(true);
      setMetaRefresh(false);
      setPortfolioFit(null);

      const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
          p.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
          );
        });

      // Core page data only — do NOT wait on live signal revalidation.
      // `/api/signals?action=instrument` can run generateSignal() for a
      // long time and previously kept the whole detail page on Loading.
      const [iRes, cRes, qRes, stockRes] = await Promise.allSettled([
        timedJson(`/api/instruments?key=${encodeURIComponent(instrumentKey)}`),
        withTimeout(chartsApi.intraday(instrumentKey, '1minute'), 12_000),
        timedJson(`/api/market?resource=quote&symbol=${encodeURIComponent(symbol)}`),
        timedJson(`/api/stocks/${encodeURIComponent(symbol)}?interval=1day&limit=5`),
      ]);
      if (cancelled) return;

      if (iRes.status === 'fulfilled' && iRes.value?.instrument) setInst(iRes.value.instrument);
      else setInst({ tradingsymbol: symbol, exchange, instrument_type: 'EQ', name: symbol });

      if (cRes.status === 'fulfilled') {
        const payload = (cRes.value as any)?.data?.candles
          ? (cRes.value as any).data
          : (cRes.value as any);
        let next = payload?.candles || [];
        let usedInterval = '1minute';

        // Default load is 1m; fall back to daily warehouse when intraday is empty
        if (!next.length) {
          try {
            const daily = await chartsApi.historical(instrumentKey, 'days', '1day', undefined, undefined, 180);
            next = (daily as any)?.candles || [];
            if (next.length) {
              usedInterval = '1day';
              setIv('1day');
            }
          } catch { /* keep empty */ }
        }

        setCandles(next);
        setChartBrush(next.length > 0 ? defaultChartBrushWindow(usedInterval, next.length) : null);
      } else if (cRes.status === 'rejected') {
        console.warn('[MarketDetail] chart load failed', cRes.reason);
      }
      if (qRes.status === 'fulfilled' && qRes.value?.quote) {
        setQuote(qRes.value.quote);
        if (qRes.value.meta) setMeta(qRes.value.meta);
      }
      if (stockRes.status === 'fulfilled' && stockRes.value && !stockRes.value.error) {
        setTrade({
          entry_price:  stockRes.value.entry_price ?? null,
          stop_loss:    stockRes.value.stop_loss ?? null,
          target1:      stockRes.value.target1 ?? null,
          target2:      stockRes.value.target2 ?? null,
          risk_reward:  stockRes.value.risk_reward ?? null,
          signal_type:  stockRes.value.signal_type ?? null,
          portfolio_fit: stockRes.value.portfolio_fit ?? null,
        } as any);
      }

      setLoading(false);
    }

    async function loadSignal() {
      try {
        const sRes = await timedJson(
          `/api/signals?action=instrument&symbol=${encodeURIComponent(symbol)}`,
          20_000,
        );
        if (cancelled || !sRes || sRes.error) return;
        setSignal(sRes);
      } catch (err) {
        console.warn('[MarketDetail] signal load failed', err);
      }
    }

    void loadCore();
    void loadSignal();
    return () => { cancelled = true; };
  }, [instrumentKey, symbol, exchange]);

  // Lazy load per tab
  useEffect(() => {
    if (activeTab === 'news') {
      const company = meta?.companyName && meta.companyName !== symbol
        ? meta.companyName
        : '';
      const qs = new URLSearchParams({
        symbol,
        limit: '15',
      });
      if (company) qs.set('company', company);
      fetch(`/api/news?${qs.toString()}`)
        .then(r => r.json())
        .then(d => setNews(d.news ?? d.articles ?? []))
        .catch(() => setNews([]));
    }
    if (activeTab === 'history' && sigHistory.length === 0) {
      fetch(`/api/signals?action=history&symbol=${encodeURIComponent(symbol)}`)
        .then(r => r.json())
        .then(d => setSigHist(d.history ?? []))
        .catch(() => {});
    }
  }, [activeTab, symbol, meta?.companyName, sigHistory.length]);

  // Portfolio Fit tab — evaluate against current holdings.
  useEffect(() => {
    if (activeTab !== 'fit' || portfolioFit != null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portfolio-fit/evaluate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ticker: symbol,
            strategy: signalData?.scenario_tag ?? sig?.scenario_tag ?? 'swing',
            direction: sigDir ?? 'BUY',
          }),
        });
        if (!res.ok) return;
        const body = await res.json();
        const data = body?.data ?? body;
        if (cancelled || data?.fitScore == null) return;
        setPortfolioFit({
          fitScore:             Number(data.fitScore) || 0,
          sectorPenalty:        data.sectorPenalty,
          correlationPenalty:   data.correlationPenalty,
          strategyPenalty:      data.strategyPenalty,
          drawdownPenalty:      data.drawdownPenalty,
          capacityScore:        data.capacityScore,
          warnings:             data.warnings ?? [],
          notes:                data.notes ?? '',
          sector:               data.sector,
          portfolioContext:     data.portfolioContext,
        });
      } catch { /* keep signal-derived fallback */ }
    })();
    return () => { cancelled = true; };
  }, [activeTab, symbol, signalData?.scenario_tag, sig?.scenario_tag, sigDir, portfolioFit]);

  // Financials tab — retry fundamentals if the initial quote load had empty meta.
  useEffect(() => {
    if (activeTab !== 'financials' || metaRefreshAttempted) return;
    const missingFundamentals =
      pe == null
      && meta?.eps == null
      && meta?.marketCap == null
      && meta?.roe == null;
    if (!missingFundamentals) return;

    setMetaRefresh(true);
    fetch(`/api/market?resource=quote&symbol=${encodeURIComponent(symbol)}&force=1`)
      .then(r => r.ok ? r.json() : null)
      .then((d) => {
        if (d?.meta) setMeta(d.meta);
      })
      .catch(() => {});
  }, [activeTab, symbol, pe, meta?.eps, meta?.marketCap, meta?.roe, metaRefreshAttempted]);

  // Chart interval switch
  const switchInterval = useCallback(async (iv: string) => {
    setIv(iv);
    setChartLoading(true);
    try {
      const isDaily = iv === '1day';
      const data = isDaily
        ? await chartsApi.historical(instrumentKey, 'days', '1day', undefined, undefined, 180)
        : await chartsApi.intraday(instrumentKey, iv, 500);
      const next = (data as any).candles || [];
      setCandles(next);
      setChartBrush(next.length > 0 ? defaultChartBrushWindow(iv, next.length) : null);
    } catch {
      /* keep prior candles */
    } finally {
      setChartLoading(false);
    }
  }, [instrumentKey]);

  const resetChartZoom = useCallback(() => {
    if (!candles.length) return;
    setChartBrush(defaultChartBrushWindow(interval, candles.length));
  }, [candles.length, interval]);

  const openFullChart = useCallback(() => {
    if (candles.length && !chartBrush) {
      setChartBrush(defaultChartBrushWindow(interval, candles.length));
    }
    setChartOpen(true);
  }, [candles.length, chartBrush, interval]);

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

  const openAlertModal = () => {
    const defaultPrice = t1 ?? ltp ?? prevCls ?? '';
    setAlertPrice(defaultPrice != null && Number(defaultPrice) > 0 ? String(defaultPrice) : '');
    setAlertCondition(sigDir === 'SELL' ? 'below' : 'above');
    setAlertError(null);
    setAlertDone(false);
    setAlertOpen(true);
  };

  const submitAlert = async () => {
    const price = Number(alertPrice);
    if (!Number.isFinite(price) || price <= 0) {
      setAlertError('Enter a valid target price.');
      return;
    }
    setAlertSaving(true);
    setAlertError(null);
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrument_key: instrumentKey,
          tradingsymbol: symbol,
          condition: alertCondition,
          target_price: price,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setAlertDone(true);
      setTimeout(() => setAlertOpen(false), 1400);
    } catch (e) {
      setAlertError(e instanceof Error ? e.message : 'Could not create alert');
    } finally {
      setAlertSaving(false);
    }
  };

  const renderPriceChart = (
    height: number,
    opts?: { showBrush?: boolean; remountKey?: string },
  ) => {
    const showBrush = !!opts?.showBrush && candles.length > 4;
    const brushStart = chartBrush?.start ?? 0;
    const brushEnd = chartBrush?.end ?? Math.max(0, candles.length - 1);
    const visible = showBrush
      ? candles.slice(brushStart, brushEnd + 1)
      : candles;
    const mainHeight = showBrush ? Math.max(220, height - 56) : height;

    if (candles.length === 0) {
      return (
        <Empty icon={Activity} title="No chart data"
          description="Market may be closed or data not yet available." />
      );
    }

    const handleBrushChange = (range: { startIndex?: number; endIndex?: number }) => {
      if (range?.startIndex == null || range?.endIndex == null) return;
      const start = Math.max(0, range.startIndex);
      const end = Math.min(candles.length - 1, range.endIndex);
      if (end - start < 2) return;
      setChartBrush({ start, end });
    };

    return (
      <div key={opts?.remountKey ?? 'inline'}>
        <ResponsiveContainer width="100%" height={mainHeight}>
          <AreaChart
            data={visible}
            margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
          >
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
              minTickGap={showBrush ? 24 : 8}
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
              strokeWidth={1.5} fill="url(#cg)" dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        {showBrush && (
          <ResponsiveContainer width="100%" height={56}>
            <AreaChart
              data={candles}
              margin={{ top: 2, right: 12, bottom: 2, left: 0 }}
            >
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <XAxis dataKey="ts" hide />
              <Area
                type="monotone"
                dataKey="close"
                stroke="#CBD5E1"
                fill="#F1F5F9"
                strokeWidth={1}
                dot={false}
                isAnimationActive={false}
              />
              <Brush
                dataKey="ts"
                height={24}
                stroke="#64748B"
                fill="#F8FAFC"
                travellerWidth={10}
                startIndex={brushStart}
                endIndex={brushEnd}
                tickFormatter={v =>
                  interval === '1day'
                    ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
                    : new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
                }
                onChange={handleBrushChange}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    );
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
          <button className={s.heroBtn} onClick={openAlertModal}>
            <Bell size={11} /> Alert
          </button>
          <button className={s.heroBtn} onClick={openFullChart}>
            <Maximize2 size={11} /> Chart
          </button>
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

            {renderPriceChart(260)}
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
                        ['Entry Zone', entry != null ? fmt.currency(entry) : '-'],
                        ['Stop Loss', sl != null ? fmt.currency(sl) : '-'],
                        ['Target 1', t1 != null ? fmt.currency(t1) : '-'],
                        ['Target 2', t2 != null ? fmt.currency(t2) : '-'],
                        ['52W Support', week52L != null ? fmt.currency(week52L) : '-'],
                        ['52W Resistance', week52H != null ? fmt.currency(week52H) : '-'],
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
                      ['Debt/Equity', meta?.debtToEquity != null ? Number(meta.debtToEquity).toFixed(2) : '-'],
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
                    <Card title={`${symbol} · Latest News`} flush>
                      {news.map(item => (
                        <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" className={s.newsItem}>
                          <div className={s.newsIcon}><Newspaper size={14} /></div>
                          <div className={s.newsBody}>
                            <div className={s.newsTitle}>{item.title}</div>
                            {(item.summary) && (
                              <div style={{ fontSize: 12, color: '#64748B', marginTop: 2, lineHeight: 1.4 }}>
                                {String(item.summary).slice(0, 160)}
                              </div>
                            )}
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
                          {fitScore >= 65 ? 'Strong Fit' : fitScore >= 40 ? 'Moderate Fit' : fitScore > 0 ? 'Weak Fit' : 'Unavailable'}
                        </div>
                        {portfolioFit?.notes && (
                          <div style={{ fontSize: 12, color: '#64748B', marginTop: 8, textAlign: 'center', lineHeight: 1.4 }}>
                            {portfolioFit.notes}
                          </div>
                        )}
                      </div>
                    </Card>
                    <Card title="Factors">
                      {([
                        ['Sector Exposure', Math.max(0, 100 - (portfolioFit?.sectorPenalty ?? 0) * 2), portfolioFit?.sectorPenalty != null],
                        ['Strategy Conc.', Math.max(0, 100 - (portfolioFit?.strategyPenalty ?? 0) * 4), portfolioFit?.strategyPenalty != null],
                        ['Correlation Risk', Math.max(0, 100 - (portfolioFit?.correlationPenalty ?? 0) * 4), portfolioFit?.correlationPenalty != null],
                        ['Capacity', portfolioFit?.capacityScore ?? Math.min(100, fitScore * 0.9), portfolioFit?.capacityScore != null],
                        ['Drawdown Buffer', Math.max(0, 100 - (portfolioFit?.drawdownPenalty ?? 0) * 4), portfolioFit?.drawdownPenalty != null],
                      ] as [string, number, boolean][]).map(([l, v]) => {
                        const val = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
                        return (
                          <div key={l} className={s.fitFactor}>
                            <span className={s.fitFN}>{l}</span>
                            <div className={s.fitFBar}>
                              <div className={s.fitFBarFill} style={{ width: `${val}%`, background: val >= 55 ? '#16A34A' : '#D97706' }} />
                            </div>
                            <span className={s.fitFV}>{val.toFixed(0)}</span>
                          </div>
                        );
                      })}
                    </Card>
                  </div>

                  <Card title="Capital Allocation">
                    {([
                      ['Sector', portfolioFit?.sector ?? meta?.sector ?? '-'],
                      ['Recommended Size', fitScore >= 70 ? '2-3% of capital' : fitScore >= 40 ? '1-2% of capital' : 'Skip / size down'],
                      ['Open Positions', portfolioFit?.portfolioContext?.totalPositions != null
                        ? String(portfolioFit.portfolioContext.totalPositions)
                        : '-'],
                      ['Portfolio Corr.', portfolioFit?.portfolioContext?.correlationAvg != null
                        ? Number(portfolioFit.portfolioContext.correlationAvg).toFixed(2)
                        : (risk < 40 ? 'Low' : risk < 60 ? 'Moderate' : 'High')],
                      ['Portfolio Decision', fitScore >= 60 ? 'Approved' : fitScore >= 40 ? 'Review Required' : fitScore > 0 ? 'Blocked' : '-'],
                    ] as [string, string][]).map(([l, v]) => (
                      <div key={l} className={s.kv}>
                        <span className={s.kvL}>{l}</span>
                        <span className={s.kvV}>{v}</span>
                      </div>
                    ))}
                  </Card>

                  {portfolioFit?.warnings && portfolioFit.warnings.length > 0 && (
                    <Card title="Fit Warnings">
                      {portfolioFit.warnings.map((w, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#92400E', marginBottom: 6, display: 'flex', gap: 6 }}>
                          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2 }} />
                          <span>{w}</span>
                        </div>
                      ))}
                    </Card>
                  )}
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
            <div className={s.dpRow}><span className={s.dpRowL}>Size</span><span className={s.dpRowV}>{fitScore >= 70 ? '2-3%' : fitScore >= 40 ? '1-2%' : fitScore > 0 ? 'Skip' : '-'}</span></div>
            <div className={s.dpRow}><span className={s.dpRowL}>Correlation</span><span className={s.dpRowV}>{
              portfolioFit?.portfolioContext?.correlationAvg != null
                ? Number(portfolioFit.portfolioContext.correlationAvg).toFixed(2)
                : (risk < 40 ? 'Low' : risk < 60 ? 'Moderate' : 'High')
            }</span></div>
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

      <Modal
        open={alertOpen}
        onClose={() => setAlertOpen(false)}
        title={`Price Alert — ${symbol}`}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn--sm btn--secondary" onClick={() => setAlertOpen(false)}>
              Cancel
            </button>
            <button className="btn btn--sm btn--primary" onClick={() => void submitAlert()} disabled={alertSaving}>
              {alertSaving ? 'Saving…' : alertDone ? 'Saved' : 'Create Alert'}
            </button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
          <div style={{ color: '#64748B' }}>
            Current LTP: <strong style={{ color: '#0F172A' }}>{ltp != null ? fmt.currency(ltp) : '—'}</strong>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 600, color: '#334155' }}>Target price</span>
            <input
              type="number"
              step="0.05"
              value={alertPrice}
              onChange={(e) => setAlertPrice(e.target.value)}
              style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #E2E8F0' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontWeight: 600, color: '#334155' }}>Condition</span>
            <select
              value={alertCondition}
              onChange={(e) => setAlertCondition(e.target.value as 'above' | 'below')}
              style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid #E2E8F0' }}
            >
              <option value="above">Price goes above</option>
              <option value="below">Price goes below</option>
            </select>
          </label>
          {alertError && (
            <div style={{ color: '#B91C1C', fontSize: 12 }}>{alertError}</div>
          )}
          {alertDone && (
            <div style={{ color: '#047857', fontSize: 12 }}>Alert created. You can manage alerts from Notifications.</div>
          )}
        </div>
      </Modal>

      <Modal
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        title={`${symbol} — Full Chart`}
        wide
      >
        <div className={s.chartToolbar} style={{ marginBottom: 12 }}>
          <div className={s.ivGroup}>
            {IV_OPTIONS.map(iv => (
              <button
                key={iv.key}
                className={clsx(s.ivBtn, interval === iv.key && s['ivBtn--active'])}
                onClick={() => void switchInterval(iv.key)}
                disabled={chartLoading}
              >
                {iv.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {chartBrush && (chartBrush.start > 0 || chartBrush.end < candles.length - 1) && (
              <button
                type="button"
                className="btn btn--sm btn--secondary"
                onClick={resetChartZoom}
                disabled={chartLoading}
              >
                Reset zoom
              </button>
            )}
            <span style={{ fontSize: 11, color: '#94A3B8' }}>
              {chartLoading ? 'Loading…' : 'Drag handles on the navigator to zoom'}
            </span>
          </div>
        </div>
        {renderPriceChart(480, {
          showBrush: true,
          remountKey: chartOpen ? `modal-${interval}-${candles.length}` : 'closed',
        })}
      </Modal>
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
