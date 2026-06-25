'use client';

import { Loading } from '@/components/ui';
import { useStrategyHub } from '@/hooks/useStrategyHub';
import { StrategyCard } from './StrategyCard';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  category: string | null;
  featuredOnly?: boolean;
  paperReadyOnly?: boolean;
}

export function StrategyHubGrid({ category, featuredOnly, paperReadyOnly }: Props) {
  const { data, isLoading, error } = useStrategyHub({
    category,
    featuredOnly,
    paperReadyOnly,
    window: '90D',
  });

  if (isLoading) return <Loading text="Loading strategies…" />;
  if (error || !data) {
    return <p style={{ color: '#DC2626' }}>Unable to load strategy registry.</p>;
  }

  const rows = data.strategies;

  if (rows.length === 0) {
    return <p style={{ color: '#94A3B8', textAlign: 'center', padding: 32 }}>No strategies match the selected filters.</p>;
  }

  return (
    <div className={styles.grid}>
      {rows.map((s) => (
        <StrategyCard key={s.strategyId} strategy={s} featured={s.isFeatured} />
      ))}
    </div>
  );
}
