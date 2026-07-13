'use client';

import { Loading } from '@/components/ui';
import { useStrategyHub } from '@/hooks/useStrategyHub';
import { StrategyCard } from './StrategyCard';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  category: string | null;
  featuredOnly?: boolean;
  paperReadyOnly?: boolean;
  timeframe?: string | null;
  direction?: string | null;
  marketType?: string | null;
  status?: string | null;
  risk?: string | null;
  excludeIds?: string[];
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (strategyId: string) => void;
  canManage?: boolean;
  onStrategiesLoaded?: (ids: string[]) => void;
}

export function StrategyHubGrid({
  category,
  featuredOnly,
  paperReadyOnly,
  timeframe,
  direction,
  marketType,
  status,
  risk,
  excludeIds = [],
  selectable,
  selectedIds,
  onToggleSelect,
  canManage,
}: Props) {
  const { data, isLoading, error } = useStrategyHub({
    category,
    featuredOnly,
    paperReadyOnly,
    timeframe,
    direction,
    marketType,
    status,
    risk,
    window: '90D',
  });

  if (isLoading) return <Loading text="Loading strategies…" />;
  if (error || !data) {
    return <p style={{ color: '#DC2626' }}>Unable to load strategy registry.</p>;
  }

  const exclude = new Set(excludeIds);
  const rows = data.strategies.filter((s) => !exclude.has(s.strategyId));

  if (rows.length === 0) {
    return <p style={{ color: '#94A3B8', textAlign: 'center', padding: 32 }}>No strategies match the selected filters.</p>;
  }

  return (
    <div className={styles.grid}>
      {rows.map((s) => (
        <StrategyCard
          key={s.strategyId}
          strategy={s}
          featured={s.isFeatured}
          compact
          selectable={selectable}
          selected={selectedIds?.has(s.strategyId)}
          onToggleSelect={onToggleSelect}
          canManage={canManage}
        />
      ))}
    </div>
  );
}
