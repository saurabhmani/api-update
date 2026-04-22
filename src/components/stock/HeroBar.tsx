'use client';

import { Star, Bell, Maximize2, Copy, Check } from 'lucide-react';
import { fmt, clsx }    from '@/lib/utils';
import { isMarketOpen } from './helpers';
import { useLivePrice } from '@/lib/hooks/useLivePrice';
import FeedStatusBadge  from '@/components/ui/FeedStatusBadge';
import type { StockData } from './types';
import s from './StockDashboard.module.scss';

interface Props {
  data: StockData;
  inWatchlist: boolean;
  onAddWatchlist: () => void;
  onCopyPlan: () => void;
  copied: boolean;
}

export default function HeroBar({ data, inWatchlist, onAddWatchlist, onCopyPlan, copied }: Props) {
  // Overlay live ticks on the server-fetched snapshot. `live` is null
  // until the first WS frame for this symbol lands — we fall back to
  // `data` so the UI never flashes empty.
  const { live, connected, lastAt } = useLivePrice(data.symbol, { throttleMs: 150 });

  const ltp          = live?.price   ?? data.ltp;
  const changeAbs    = live?.change  ?? data.change_abs;
  const changePct    = live?.pChange ?? data.change_percent;
  const liveSource   = (live?.source as 'kite' | 'yahoo' | undefined) ?? null;

  const positive   = changePct >= 0;
  const marketOpen = isMarketOpen();
  const dir = (data.signal_type ?? 'HOLD').toLowerCase() as 'buy' | 'sell' | 'hold';

  return (
    <div className={s.hero}>
      {/* Row 1: Identity + Price */}
      <div className={s.heroRow}>
        <div className={s.heroIdentity}>
          <div className={s.heroSymbolLine}>
            <span className={s.heroSymbol}>{data.symbol}</span>
            <span className={clsx(s.heroPill, s['heroPill--exchange'])}>NSE</span>
            {data.signal_type && (
              <span className={clsx(s.heroPill, s[`heroPill--${dir}`])}>
                {data.signal_type}
              </span>
            )}
            {data.signal_strength && (
              <span className={clsx(s.heroPill, s['heroPill--regime'])}>
                {data.signal_strength}
              </span>
            )}
          </div>
          <span className={s.heroCompany}>{data.name ?? data.symbol}</span>
        </div>

        <div className={s.heroPrice}>
          <div className={s.heroLTP}>{fmt.currency(ltp)}</div>
          <div className={clsx(s.heroChange, positive ? s['heroChange--up'] : s['heroChange--down'])}>
            {positive ? '+' : ''}{fmt.currency(Math.abs(changeAbs))} ({positive ? '+' : ''}{changePct.toFixed(2)}%)
          </div>
          <div className={s.heroStatus} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={clsx(s.statusDot, marketOpen ? s['statusDot--open'] : s['statusDot--closed'])} />
            {marketOpen ? 'Market Open' : 'Market Closed'}
            <FeedStatusBadge connected={connected} lastAt={lastAt} source={liveSource} />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className={s.heroStats}>
        {([
          ['Open',       fmt.currency(data.open)],
          ['High',       fmt.currency(data.day_high)],
          ['Low',        fmt.currency(data.day_low)],
          ['Prev Close', fmt.currency(data.prev_close)],
          ['Volume',     fmt.volume(data.volume)],
          ['VWAP',       data.vwap != null ? fmt.currency(data.vwap) : '-'],
          ['Score',      data.score != null ? data.score.toFixed(1) : '-'],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label} className={s.heroStat}>
            <div className={s.heroStatLabel}>{label}</div>
            <div className={s.heroStatValue}>{value}</div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className={s.heroActions}>
        <button
          className={clsx(s.heroActionBtn, inWatchlist && s['heroActionBtn--active'])}
          onClick={onAddWatchlist}
          disabled={inWatchlist}
        >
          <Star size={12} fill={inWatchlist ? 'currentColor' : 'none'} />
          {inWatchlist ? 'Watchlisted' : 'Watchlist'}
        </button>
        <button className={s.heroActionBtn}>
          <Bell size={12} /> Alert
        </button>
        <button className={s.heroActionBtn}>
          <Maximize2 size={12} /> Full Chart
        </button>
        <button className={s.heroActionBtn} onClick={onCopyPlan}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy Plan'}
        </button>
      </div>
    </div>
  );
}
