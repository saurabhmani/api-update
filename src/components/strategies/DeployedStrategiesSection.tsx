'use client';

import Link from 'next/link';
import { Loading } from '@/components/ui';
import { useStrategyDeployments } from '@/hooks/useStrategyDeployments';
import { DeploymentStatusBadge } from './DeploymentStatusBadge';
import styles from '@/app/strategies/strategies.module.scss';

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function DeployedStrategiesSection() {
  const { data, isLoading, error } = useStrategyDeployments({ limit: 20 });

  if (isLoading) {
    return (
      <section className={styles.deployedSection}>
        <Loading text="Loading deployments…" />
      </section>
    );
  }

  if (error) {
    return null;
  }

  const deployed = data?.deployed ?? [];
  if (deployed.length === 0) {
    return null;
  }

  return (
    <section className={styles.deployedSection}>
      <h2 className={styles.sectionTitle}>
        Deployed
        <span className={styles.sectionCount}>{deployed.length}</span>
      </h2>
      <div className={styles.deploymentTableWrap}>
        <table className={styles.deploymentTable}>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Status</th>
              <th>Environment</th>
              <th>Deployed</th>
              <th>By</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deployed.map((row) => (
              <tr key={row.strategy_id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{row.displayName}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748B' }}>{row.category}</div>
                </td>
                <td>
                  <DeploymentStatusBadge status={row.deploymentLifecycle} compact />
                </td>
                <td style={{ textTransform: 'capitalize' }}>
                  {row.last_environment ?? (row.deploymentLifecycle === 'live' ? 'live' : 'paper')}
                </td>
                <td style={{ fontSize: '0.85rem', whiteSpace: 'nowrap' }}>
                  {fmtWhen(row.last_deployed_at ?? row.updated_at)}
                </td>
                <td style={{ fontSize: '0.85rem' }}>{row.last_deployed_by ?? '—'}</td>
                <td>
                  <Link
                    href={`/strategies/${row.strategy_id}`}
                    className="btn btn--outline btn--sm"
                  >
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
