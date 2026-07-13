'use client';

import { Card, Loading } from '@/components/ui';
import { StrategyModeBadge } from './StrategyModeBadge';
import { useStrategyManagement } from '@/hooks/useStrategyManagement';
import { strategyModeLabel } from '@/lib/strategy-hub/strategyModeDisplay';
import styles from '@/app/strategies/strategies.module.scss';

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface Props {
  strategyId?: string;
  limit?: number;
}

export function ModeActivityPanel({ strategyId, limit = 15 }: Props) {
  const { data, isLoading, error } = useStrategyManagement({ strategyId, limit });
  const activity = data?.activity ?? [];

  return (
    <Card title="Mode Change Activity">
      {isLoading && <Loading text="Loading activity…" />}
      {error && (
        <p style={{ margin: 0, color: '#DC2626', fontSize: '0.9rem' }}>
          Could not load mode activity.
        </p>
      )}
      {!isLoading && !error && activity.length === 0 && (
        <p style={{ margin: 0, color: '#64748B', fontSize: '0.9rem' }}>
          No mode changes recorded yet.
        </p>
      )}
      {!isLoading && !error && activity.length > 0 && (
        <ul className={styles.auditList}>
          {activity.map((entry) => (
            <li key={entry.id} className={styles.auditItem}>
              <div className={styles.auditItemHeader}>
                {!strategyId && (
                  <strong style={{ fontSize: '0.85rem' }}>{entry.displayName}</strong>
                )}
                <StrategyModeBadge mode={entry.to_mode} compact />
                <span className={styles.auditEvent}>{entry.source}</span>
              </div>
              <div className={styles.auditMeta}>
                <span>{fmtWhen(entry.created_at)}</span>
                {entry.actor && <span> · {entry.actor}</span>}
                {entry.from_mode && (
                  <span>
                    {' '}
                    · {strategyModeLabel(entry.from_mode)} → {strategyModeLabel(entry.to_mode)}
                  </span>
                )}
                {entry.reason && <span> · {entry.reason}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
