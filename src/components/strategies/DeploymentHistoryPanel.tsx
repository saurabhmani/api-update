'use client';

import { Card, Loading } from '@/components/ui';
import { useStrategyDeployments } from '@/hooks/useStrategyDeployments';
import { DeploymentStatusBadge } from './DeploymentStatusBadge';
import { normalizeDeploymentLifecycle } from '@/lib/strategy-hub/deploymentLifecycle';
import styles from '@/app/strategies/strategies.module.scss';

function fmtWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface Props {
  strategyId: string;
}

export function DeploymentHistoryPanel({ strategyId }: Props) {
  const { data, isLoading, error } = useStrategyDeployments({ strategyId, limit: 30 });
  const audit = data?.audit ?? [];

  return (
    <Card title="Deployment History & Audit Log">
      {isLoading && <Loading text="Loading audit log…" />}
      {error && (
        <p style={{ margin: 0, color: '#DC2626', fontSize: '0.9rem' }}>
          Could not load deployment history.
        </p>
      )}
      {!isLoading && !error && audit.length === 0 && (
        <p style={{ margin: 0, color: '#64748B', fontSize: '0.9rem' }}>
          No deployment events recorded for this strategy yet.
        </p>
      )}
      {!isLoading && !error && audit.length > 0 && (
        <ul className={styles.auditList}>
          {audit.map((entry) => {
            const toLifecycle = normalizeDeploymentLifecycle(entry.to_status);
            const fromLifecycle = entry.from_status
              ? normalizeDeploymentLifecycle(entry.from_status)
              : null;
            return (
              <li key={entry.id} className={styles.auditItem}>
                <div className={styles.auditItemHeader}>
                  <DeploymentStatusBadge status={toLifecycle} compact />
                  <span className={styles.auditEvent}>{entry.event_type.replace(/_/g, ' ')}</span>
                  <span className={styles.auditEnv}>{entry.environment}</span>
                </div>
                <div className={styles.auditMeta}>
                  <span>{fmtWhen(entry.created_at)}</span>
                  {entry.actor && <span> · {entry.actor}</span>}
                  {fromLifecycle && fromLifecycle !== toLifecycle && (
                    <span>
                      {' '}
                      · {fromLifecycle.replace(/_/g, ' ')} → {toLifecycle.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
