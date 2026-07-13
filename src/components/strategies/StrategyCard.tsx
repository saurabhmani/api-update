'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui';
import { DeploymentStatusBadge } from '@/components/strategies/DeploymentStatusBadge';
import { StrategyModeBadge } from '@/components/strategies/StrategyModeBadge';
import { StrategyModeControls } from '@/components/strategies/StrategyModeControls';
import { isDeployedLifecycle } from '@/lib/strategy-hub/deploymentLifecycle';
import type { StrategyHubSummary } from '@/lib/strategy-hub/types';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  strategy: StrategyHubSummary;
  featured?: boolean;
  compact?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (strategyId: string) => void;
  canManage?: boolean;
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

export function StrategyCard({
  strategy,
  featured,
  compact = false,
  selectable,
  selected,
  onToggleSelect,
  canManage,
}: Props) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const perf = strategy.performance;
  const [busyAction, setBusyAction] = useState<'backtest' | 'deploy' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [optimisticMode, setOptimisticMode] = useState<StrategyMode | null>(null);
  const alreadyDeployed = isDeployedLifecycle(strategy.deploymentLifecycle);
  const mode = (optimisticMode
    ?? strategy.effectiveStrategyMode
    ?? strategy.strategyMode) as StrategyMode | string;

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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategy-hub'] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-deployments'] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-detail', strategy.strategyId] }),
      ]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Paper deployment failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <article className={featured ? styles.cardFeatured : compact ? styles.cardCompact : styles.card}>
      <div className={styles.cardHeader}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
          {selectable && (
            <input
              type="checkbox"
              checked={!!selected}
              onChange={() => onToggleSelect?.(strategy.strategyId)}
              aria-label={`Select ${strategy.displayName}`}
              style={{ marginTop: 4, flexShrink: 0 }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <Link href={`/strategies/${strategy.strategyId}`} className={styles.cardTitleLink}>
              <h3 className={styles.cardTitle}>{strategy.displayName}</h3>
            </Link>
            <div className={styles.cardSubTitle}>
              {strategy.categoryLabel} · {strategy.marketType} · {strategy.timeframeLabel}
            </div>
          </div>
        </div>
        <Badge variant={statusVariant(strategy.cardStatus)}>{strategy.cardStatus}</Badge>
      </div>

      <div className={styles.cardMeta}>
        <Badge variant={strategy.direction === 'BUY' ? 'green' : strategy.direction === 'SELL' ? 'red' : 'gray'}>
          {strategy.direction}
        </Badge>
        <Badge variant="orange">{strategy.riskProfileLabel}</Badge>
        {!compact && <Badge variant="gray">{strategy.categoryLabel}</Badge>}
        <StrategyModeBadge mode={mode} compact />
        {strategy.paperTradingReady && <Badge variant="green">Paper Ready</Badge>}
        {!compact && strategy.hasModeOverride && <Badge variant="dark">Override</Badge>}
        {!compact && strategy.isActiveInRunner && <Badge variant="dark">Runner</Badge>}
        {!compact && <DeploymentStatusBadge status={strategy.deploymentLifecycle} compact />}
      </div>

      {!compact && <p className={styles.cardExplanation}>{strategy.explanation}</p>}

      <div className={compact ? styles.metricsCompact : styles.metrics}>
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
        {!compact && (
          <>
            <div>
              <div className={styles.metricLabel}>Signals</div>
              <div className={styles.metricValue}>{perf?.totalSignals ?? 0}</div>
            </div>
            <div>
              <div className={styles.metricLabel}>Health</div>
              <div className={styles.metricValue}>{perf?.healthScore ?? '—'}</div>
            </div>
          </>
        )}
      </div>

      {canManage && !compact && (
        <StrategyModeControls
          strategyId={strategy.strategyId}
          currentMode={mode}
          onChanged={(next) => setOptimisticMode(next)}
        />
      )}

      <div className={compact ? styles.cardActionsCompact : styles.cardActions}>
        <Link href={`/strategies/${strategy.strategyId}`} className="btn btn--primary btn--sm">
          View Details
        </Link>
        {compact ? (
          strategy.paperTradingReady && !alreadyDeployed ? (
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={deployToPaper}
              disabled={busyAction != null}
            >
              {busyAction === 'deploy' ? 'Deploying…' : 'Deploy'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--outline btn--sm"
              onClick={runBacktest}
              disabled={busyAction != null}
            >
              {busyAction === 'backtest' ? 'Queuing…' : 'Backtest'}
            </button>
          )
        ) : (
          <>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={runBacktest}
              disabled={busyAction != null}
            >
              {busyAction === 'backtest' ? 'Queuing…' : 'Run Backtest'}
            </button>
            <Link href={`/strategies/performance?strategyId=${encodeURIComponent(strategy.strategyId)}`} className="btn btn--outline btn--sm">
              Performance
            </Link>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={deployToPaper}
              disabled={busyAction != null || !strategy.paperTradingReady || alreadyDeployed}
              title={
                alreadyDeployed
                  ? 'Strategy is already deployed'
                  : strategy.paperTradingReady
                    ? 'Deploy to paper trading'
                    : 'Paper trading gates are not met'
              }
            >
              {busyAction === 'deploy'
                ? 'Deploying…'
                : alreadyDeployed
                  ? strategy.deploymentLifecycle === 'live'
                    ? 'Live'
                    : 'Deployed'
                  : 'Deploy to Paper'}
            </button>
          </>
        )}
      </div>

      {message && <div className={styles.cardMessage}>{message}</div>}
    </article>
  );
}
