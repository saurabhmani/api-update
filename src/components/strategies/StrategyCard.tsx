'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui';
import type { StrategyHubSummary } from '@/lib/strategy-hub/types';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  strategy: StrategyHubSummary;
  featured?: boolean;
}

export function StrategyCard({ strategy, featured }: Props) {
  const perf = strategy.performance;

  return (
    <Link
      href={`/strategies/${strategy.strategyId}`}
      className={featured ? styles.cardFeatured : styles.card}
    >
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>{strategy.displayName}</h3>
        {strategy.paperTradingReady && (
          <Badge variant="green">Paper Ready</Badge>
        )}
      </div>

      <div className={styles.cardMeta}>
        <Badge variant="gray">{strategy.categoryLabel}</Badge>
        <Badge variant={strategy.direction === 'BUY' ? 'green' : 'red'}>{strategy.direction}</Badge>
        <Badge variant="orange">{strategy.riskProfileLabel}</Badge>
        {strategy.isActiveInRunner && <Badge variant="dark">Active</Badge>}
      </div>

      <p className={styles.cardExplanation}>{strategy.explanation}</p>

      <div className={styles.metrics}>
        <div>
          <div className={styles.metricLabel}>Win Rate</div>
          <div className={styles.metricValue}>
            {perf && perf.dataStatus !== 'INSUFFICIENT_DATA' ? `${perf.winRate.toFixed(1)}%` : '—'}
          </div>
        </div>
        <div>
          <div className={styles.metricLabel}>Signals</div>
          <div className={styles.metricValue}>{perf?.totalSignals ?? 0}</div>
        </div>
        <div>
          <div className={styles.metricLabel}>Health</div>
          <div className={styles.metricValue}>{perf?.healthScore ?? '—'}</div>
        </div>
      </div>
    </Link>
  );
}
