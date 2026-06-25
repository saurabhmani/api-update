'use client';

import { useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { TrustDashboardPanel } from '@/components/trust/TrustDashboardPanel';
import { SignalBoardTable } from '@/components/trust/SignalBoardTable';
import { RegimeScanner } from '@/components/trust/RegimeScanner';
import { StrategyPerformanceTable } from '@/components/trust/StrategyPerformanceTable';
import { WatchlistPanel } from '@/components/trust/WatchlistPanel';
import styles from './trust.module.scss';

type TrustTab =
  | 'dashboard'
  | 'signals'
  | 'regime'
  | 'performance'
  | 'watchlist';

const TABS: { id: TrustTab; label: string }[] = [
  { id: 'dashboard',   label: 'Quant Dashboard' },
  { id: 'signals',     label: 'Signal Board' },
  { id: 'regime',      label: 'Market Regime' },
  { id: 'performance', label: 'Strategy Performance' },
  { id: 'watchlist',   label: 'Watchlist' },
];

export function TrustLayerClient() {
  const [tab, setTab] = useState<TrustTab>('dashboard');

  return (
    <AppShell title="Trust Layer">
      <div className="page">
        <div className="page__header">
          <h1>Trust Layer</h1>
          <p>Institutional transparency — live signals, regime, performance, and watchlist intelligence.</p>
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

        <div className={styles.panel}>
          {tab === 'dashboard'   && <TrustDashboardPanel />}
          {tab === 'signals'     && <SignalBoardTable />}
          {tab === 'regime'      && <RegimeScanner />}
          {tab === 'performance' && <StrategyPerformanceTable />}
          {tab === 'watchlist'   && <WatchlistPanel />}
        </div>
      </div>
    </AppShell>
  );
}
