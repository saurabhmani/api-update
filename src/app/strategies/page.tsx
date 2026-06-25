'use client';

import { useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import { StrategyHubGrid } from '@/components/strategies/StrategyHubGrid';
import { StrategyCard } from '@/components/strategies/StrategyCard';
import { useStrategyHub } from '@/hooks/useStrategyHub';
import { Target, Layers, ShieldCheck } from 'lucide-react';
import styles from './strategies.module.scss';

export default function StrategyHubPage() {
  const [category, setCategory] = useState<string | null>(null);
  const [paperReadyOnly, setPaperReadyOnly] = useState(false);
  const { data } = useStrategyHub({ category, paperReadyOnly, window: '90D' });

  return (
    <AppShell title="Strategy Hub">
      <div className="page">
        <div className="page__header">
          <h1>Strategy Hub</h1>
          <p>Registry-based strategy catalog — metadata, categories, performance, and paper-trading readiness.</p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
          <Card compact>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Target size={20} color="#1E40AF" />
              <div>
                <div style={{ fontSize: '0.75rem', color: '#64748B' }}>Total Strategies</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{data?.total ?? '—'}</div>
              </div>
            </div>
          </Card>
          <Card compact>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Layers size={20} color="#16A34A" />
              <div>
                <div style={{ fontSize: '0.75rem', color: '#64748B' }}>Categories</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{data?.categories.length ?? '—'}</div>
              </div>
            </div>
          </Card>
          <Card compact>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ShieldCheck size={20} color="#D97706" />
              <div>
                <div style={{ fontSize: '0.75rem', color: '#64748B' }}>Paper Ready</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                  {data?.strategies.filter((s) => s.paperTradingReady).length ?? '—'}
                </div>
              </div>
            </div>
          </Card>
        </div>

        {data && data.featured.length > 0 && !category && !paperReadyOnly && (
          <section style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: '1.1rem', marginBottom: 12 }}>Featured Strategies</h2>
            <div className={styles.grid}>
              {data.featured.map((s) => (
                <StrategyCard key={s.strategyId} strategy={s} featured />
              ))}
            </div>
          </section>
        )}

        <div className={styles.filters} style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={category === null ? styles.filterChipActive : styles.filterChip}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {(data?.categories ?? []).map((c) => (
            <button
              key={c.id}
              type="button"
              className={category === c.id ? styles.filterChipActive : styles.filterChip}
              onClick={() => setCategory(c.id)}
            >
              {c.label} ({c.strategyCount})
            </button>
          ))}
          <button
            type="button"
            className={paperReadyOnly ? styles.filterChipActive : styles.filterChip}
            onClick={() => setPaperReadyOnly((v) => !v)}
            style={{ marginLeft: 'auto' }}
          >
            Paper Ready Only
          </button>
        </div>

        <StrategyHubGrid category={category} paperReadyOnly={paperReadyOnly} />
      </div>
    </AppShell>
  );
}
