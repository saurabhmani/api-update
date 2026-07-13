'use client';

import { useStrategyManagement } from '@/hooks/useStrategyManagement';
import styles from '@/app/strategies/strategies.module.scss';

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function StrategyManagementDashboard() {
  const { data, isLoading, error } = useStrategyManagement({ limit: 20 });

  if (isLoading || error || !data) return null;

  const s = data.status;

  return (
    <section className={styles.statusBar}>
      <div className={styles.statusBarItems}>
        <div className={styles.statusBarItem}>
          <span className={styles.statusBarValue}>{s.totalRegistered}</span>
          <span className={styles.statusBarLabel}>Registered</span>
        </div>
        <div className={styles.statusBarItem}>
          <span className={styles.statusBarValue}>{s.activeCount}</span>
          <span className={styles.statusBarLabel}>Active</span>
        </div>
        <div className={styles.statusBarItem}>
          <span className={styles.statusBarValue}>{s.watchlistCount}</span>
          <span className={styles.statusBarLabel}>Watchlist</span>
        </div>
        <div className={styles.statusBarItem}>
          <span className={styles.statusBarValue}>{s.currentlyRunning}</span>
          <span className={styles.statusBarLabel}>Running</span>
        </div>
        <div className={styles.statusBarItem}>
          <span className={styles.statusBarValue}>{s.disabledCount}</span>
          <span className={styles.statusBarLabel}>Disabled</span>
        </div>
      </div>
      <span className={styles.statusBarMeta}>Updated {fmtWhen(s.lastUpdated)}</span>
    </section>
  );
}
