'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Loading, Empty }     from '@/components/ui';
import { clsx }               from '@/lib/utils';
import { BarChart2 }          from 'lucide-react';
import { buildTradePlanText } from './helpers';

// Types
import type { StockData, CandleBar, NewsItem, TabId, Interval } from './types';
import { TABS } from './types';

// Components
import HeroBar        from './HeroBar';
import StockChart     from './StockChart';
import DecisionPanel  from './panels/DecisionPanel';

// Tabs
import OverviewTab      from './tabs/OverviewTab';
import SignalsTab       from './tabs/SignalsTab';
import TechnicalsTab    from './tabs/TechnicalsTab';
import FinancialsTab    from './tabs/FinancialsTab';
import NewsTab          from './tabs/NewsTab';
import PortfolioFitTab  from './tabs/PortfolioFitTab';
import AIExplanationTab from './tabs/AIExplanationTab';
import DexterTab        from './tabs/DexterTab';
import HistoryTab       from './tabs/HistoryTab';

// Styles
import s from './StockDashboard.module.scss';

// ═══════════════════════════════════════════════════════════════════

interface Props {
  symbol: string;
}

export default function StockDashboard({ symbol }: Props) {
  // ── State ──────────────────────────────────────────────────────
  const [activeTab, setTab]       = useState<TabId>('overview');
  const [data, setData]           = useState<StockData | null>(null);
  const [candles, setCandles]     = useState<CandleBar[]>([]);
  const [interval, setInterval]   = useState<Interval>('1day');
  const [news, setNews]           = useState<NewsItem[]>([]);
  const [loading, setLoading]     = useState(true);
  const [chartLoad, setChartLoad] = useState(false);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [copied, setCopied]       = useState(false);
  const fetchedChart              = useRef<Set<string>>(new Set());

  // ── Data fetching ──────────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/stocks/${encodeURIComponent(symbol)}?interval=1day&limit=200`);
      if (!res.ok) throw new Error('Not found');
      const d: StockData = await res.json();
      setData(d);
      setCandles(d.candles ?? []);
      fetchedChart.current.add('1day');
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [symbol]);

  const loadNews = useCallback(async () => {
    try {
      const res = await fetch(`/api/news?q=${encodeURIComponent(symbol)}&limit=10`);
      const d   = await res.json();
      setNews(d.news ?? d.articles ?? []);
    } catch { setNews([]); }
  }, [symbol]);

  const loadChart = useCallback(async (iv: Interval) => {
    if (fetchedChart.current.has(iv)) return;
    setChartLoad(true);
    try {
      const res = await fetch(
        `/api/chart-data?symbol=${encodeURIComponent(symbol)}&interval=${iv}&limit=200`
      );
      const d = await res.json();
      if (d.candles?.length) {
        setCandles(d.candles);
        fetchedChart.current.add(iv);
      }
    } catch {}
    finally { setChartLoad(false); }
  }, [symbol]);

  useEffect(() => { loadDetail(); }, [loadDetail]);
  useEffect(() => { if (activeTab === 'news') loadNews(); }, [activeTab, loadNews]);

  // ── Actions ────────────────────────────────────────────────────
  const handleIntervalChange = (iv: Interval) => {
    setInterval(iv);
    loadChart(iv);
  };

  const handleAddWatchlist = async () => {
    try {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrument_key: `NSE_EQ|${symbol}` }),
      });
      setInWatchlist(true);
    } catch {}
  };

  const handleCopyPlan = () => {
    if (!data) return;
    navigator.clipboard.writeText(buildTradePlanText(data)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Loading / empty ────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center' }}>
        <Loading text={`Loading ${symbol}...`} />
      </div>
    );
  }

  if (!data) {
    return (
      <Empty
        icon={BarChart2}
        title={`No data for ${symbol}`}
        description="Run a rankings sync or wait for the scheduler to populate this symbol."
      />
    );
  }

  // ── Tab content ────────────────────────────────────────────────
  const tabContent: Record<TabId, React.ReactNode> = {
    'overview':      <OverviewTab data={data} candles={candles} />,
    'signals':       <SignalsTab data={data} />,
    'technicals':    <TechnicalsTab data={data} />,
    'financials':    <FinancialsTab data={data} />,
    'news':          <NewsTab news={news} symbol={symbol} />,
    'portfolio-fit': <PortfolioFitTab data={data} />,
    'ai':            <AIExplanationTab data={data} />,
    'dexter':        <DexterTab symbol={symbol} />,
    'history':       <HistoryTab data={data} />,
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className={s.dashboard}>

      {/* Hero */}
      <HeroBar
        data={data}
        inWatchlist={inWatchlist}
        onAddWatchlist={handleAddWatchlist}
        onCopyPlan={handleCopyPlan}
        copied={copied}
      />

      {/* Tabs */}
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

      {/* Body: main + decision panel */}
      <div className={s.body}>
        <div className={s.main}>
          {/* Chart always visible */}
          <StockChart
            data={data}
            candles={candles}
            interval={interval}
            chartLoading={chartLoad}
            onIntervalChange={handleIntervalChange}
          />

          {/* Active tab content */}
          {tabContent[activeTab]}
        </div>

        {/* Decision Panel */}
        <DecisionPanel
          data={data}
          onCopyPlan={handleCopyPlan}
          copied={copied}
        />
      </div>
    </div>
  );
}
