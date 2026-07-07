'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui';
import type { StrategyHubSummary } from '@/lib/strategy-hub/types';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  strategy: StrategyHubSummary;
  featured?: boolean;
}

function statusVariant(status: StrategyHubSummary['cardStatus']): 'green' | 'orange' | 'gray' | 'dark' {
  if (status === 'Active') return 'green';
  if (status === 'Backtested') return 'dark';
  if (status === 'Premium') return 'orange';
  return 'gray';
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

export function StrategyCard({ strategy, featured }: Props) {
  const router = useRouter();
  const perf = strategy.performance;
  const [busyAction, setBusyAction] = useState<'backtest' | 'deploy' | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const runBacktest = async () => {
    setBusyAction('backtest');
    setMessage(null);
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            name: `Strategy Hub — ${strategy.displayName}`,
            strategies: [strategy.strategyId],
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Backtest failed');
      setMessage(`Backtest queued: ${String(body.runId ?? body.backtestId).slice(0, 8)}`);
      router.push('/backtesting');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Backtest failed');
    } finally {
      setBusyAction(null);
    }
  };

  const deployToPaper = async () => {
    setBusyAction('deploy');
    setMessage(null);
    try {
      const res = await fetch('/api/paper/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId: strategy.strategyId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const issues = Array.isArray(body.issues) ? `: ${body.issues.join(', ')}` : '';
        throw new Error(`${body.error ?? 'Paper deployment failed'}${issues}`);
      }
      setMessage(body.message ?? 'Strategy deployed to paper trading');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Paper deployment failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <article className={featured ? styles.cardFeatured : styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <Link href={`/strategies/${strategy.strategyId}`} className={styles.cardTitleLink}>
            <h3 className={styles.cardTitle}>{strategy.displayName}</h3>
          </Link>
          <div className={styles.cardSubTitle}>{strategy.marketType} · {strategy.timeframeLabel}</div>
        </div>
        <Badge variant={statusVariant(strategy.cardStatus)}>{strategy.cardStatus}</Badge>
      </div>

      <div className={styles.cardMeta}>
        <Badge variant="gray">{strategy.categoryLabel}</Badge>
        <Badge variant={strategy.direction === 'BUY' ? 'green' : strategy.direction === 'SELL' ? 'red' : 'gray'}>
          {strategy.direction}
        </Badge>
        <Badge variant="orange">{strategy.riskProfileLabel}</Badge>
        <Badge variant="gray">{strategy.deploymentStatus.replace(/_/g, ' ')}</Badge>
        {strategy.isActiveInRunner && <Badge variant="dark">Active</Badge>}
        {strategy.paperTradingReady && <Badge variant="green">Paper Ready</Badge>}
      </div>

      <p className={styles.cardExplanation}>{strategy.explanation}</p>

      <div className={styles.metrics}>
        <div>
          <div className={styles.metricLabel}>Win Rate</div>
          <div className={styles.metricValue}>
            {perf && perf.dataStatus !== 'INSUFFICIENT_DATA' ? fmtPct(perf.winRate) : '—'}
          </div>
        </div>
        <div>
          <div className={styles.metricLabel}>Trades</div>
          <div className={styles.metricValue}>{perf?.totalTrades ?? 0}</div>
        </div>
        <div>
          <div className={styles.metricLabel}>Max DD</div>
          <div className={styles.metricValue}>{perf ? fmtPct(perf.maxDrawdownPct) : '—'}</div>
        </div>
        <div>
          <div className={styles.metricLabel}>Risk</div>
          <div className={styles.metricValue}>{strategy.riskProfileLabel}</div>
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

      <div className={styles.cardActions}>
        <Link href={`/strategies/${strategy.strategyId}`} className="btn btn--outline btn--sm">
          View Details
        </Link>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={runBacktest}
          disabled={busyAction != null}
        >
          {busyAction === 'backtest' ? 'Queuing…' : 'Run Backtest'}
        </button>
        <Link href={`/strategies/performance?strategyId=${encodeURIComponent(strategy.strategyId)}`} className="btn btn--outline btn--sm">
          View Performance
        </Link>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={deployToPaper}
          disabled={busyAction != null || !strategy.paperTradingReady}
          title={strategy.paperTradingReady ? 'Deploy to paper trading' : 'Paper trading gates are not met'}
        >
          {busyAction === 'deploy' ? 'Deploying…' : 'Deploy to Paper'}
        </button>
      </div>

      {message && <div className={styles.cardMessage}>{message}</div>}
    </article>
  );
}
