'use client';

import { useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, StatCard } from '@/components/ui';
import { useStrategyDetail } from '@/hooks/useStrategyDetail';
import { CheckCircle2, XCircle, ArrowLeft, Target, Shield, TrendingUp } from 'lucide-react';
import styles from '../strategies.module.scss';

const WINDOWS = ['7D', '30D', '90D', '180D', '1Y'] as const;

interface Props {
  strategyId: string;
}

export default function StrategyDetailPage({ strategyId }: Props) {
  const [window, setWindow] = useState<string>('90D');
  const { data, isLoading, error } = useStrategyDetail(strategyId, window);

  if (isLoading) return <AppShell title="Strategy"><Loading text="Loading strategy…" /></AppShell>;
  if (error || !data) {
    return (
      <AppShell title="Strategy">
        <div className="page">
          <p style={{ color: '#DC2626' }}>Strategy not found.</p>
          <Link href="/strategies">← Back to Strategy Hub</Link>
        </div>
      </AppShell>
    );
  }

  const perf = data.performanceDetail;

  return (
    <AppShell title={data.displayName}>
      <div className="page">
        <div className={styles.breadcrumb}>
          <Link href="/strategies">Strategy Hub</Link> / {data.displayName}
        </div>

        <div className="page__header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1>{data.displayName}</h1>
            <p>{data.explanation}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <Badge variant="gray">{data.categoryLabel}</Badge>
              <Badge variant={data.direction === 'BUY' ? 'green' : 'red'}>{data.direction}</Badge>
              <Badge variant="orange">{data.riskProfileLabel}</Badge>
              <Badge variant="gray">{data.timeframe}</Badge>
              {data.paperTradingReady && <Badge variant="green">Paper Trading Ready</Badge>}
              {data.isActiveInRunner && <Badge variant="dark">Engine Active</Badge>}
            </div>
          </div>
          <Link href="/strategies" className="btn btn--outline btn--sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ArrowLeft size={14} /> Hub
          </Link>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginBottom: 24 }}>
          <StatCard
            label="Win Rate"
            value={perf ? `${perf.winRate.toFixed(1)}%` : '—'}
            icon={TrendingUp}
            iconVariant="blue"
          />
          <StatCard
            label="Total Signals"
            value={perf?.totalSignals ?? 0}
            icon={Target}
            iconVariant="green"
          />
          <StatCard
            label="Health Score"
            value={perf?.strategyHealthScore ?? '—'}
            icon={Shield}
            iconVariant="orange"
          />
          <StatCard
            label="Expectancy (R)"
            value={perf ? perf.expectancy.toFixed(2) : '—'}
            icon={TrendingUp}
            iconVariant="blue"
          />
        </div>

        <div className={styles.detailGrid}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title="Strategy Metadata">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: '0.9rem' }}>
                <div><strong>Entry Type:</strong> {data.entryType.replace(/_/g, ' ')}</div>
                <div><strong>Confidence Weight:</strong> {data.defaultConfidenceWeight}</div>
                <div><strong>RSI Range:</strong> {data.idealRsiRange[0]}–{data.idealRsiRange[1]}</div>
                {data.minAdx != null && <div><strong>Min ADX:</strong> {data.minAdx}</div>}
                {data.minVolumeExpansion != null && <div><strong>Min Volume:</strong> {data.minVolumeExpansion}x</div>}
                <div><strong>Version:</strong> {data.version}</div>
                <div><strong>Deployment:</strong> {data.deploymentStatus.replace(/_/g, ' ')}</div>
              </div>
            </Card>

            <Card title="Market Regime Gates">
              <div style={{ fontSize: '0.9rem' }}>
                <div style={{ marginBottom: 8 }}>
                  <strong>Allowed:</strong>{' '}
                  {data.allowedRegimes.map((r) => <Badge key={r} variant="green" style={{ marginRight: 4 }}>{r}</Badge>)}
                </div>
                <div>
                  <strong>Blocked:</strong>{' '}
                  {data.blockedRegimes.map((r) => <Badge key={r} variant="red" style={{ marginRight: 4 }}>{r}</Badge>)}
                </div>
              </div>
            </Card>

            <Card title="Invalidation Logic">
              <p style={{ margin: 0, fontSize: '0.9rem', color: '#64748B' }}>{data.invalidation}</p>
            </Card>

            {perf && (
              <Card
                title="Performance Detail"
                action={
                  <select
                    className="input"
                    style={{ width: 80, padding: '4px 8px' }}
                    value={window}
                    onChange={(e) => setWindow(e.target.value)}
                  >
                    {WINDOWS.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                }
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, fontSize: '0.85rem' }}>
                  <div><strong>Profit Factor:</strong> {perf.profitFactor.toFixed(2)}</div>
                  <div><strong>Max Drawdown:</strong> {perf.maxDrawdownPct.toFixed(1)}%</div>
                  <div><strong>Avg Return:</strong> {perf.averageReturnPct.toFixed(2)}%</div>
                  <div><strong>Target Hit Rate:</strong> {perf.targetHitRate.toFixed(1)}%</div>
                  <div><strong>Stop Hit Rate:</strong> {perf.stopHitRate.toFixed(1)}%</div>
                  <div><strong>Recommendation:</strong> {perf.recommendation}</div>
                  <div><strong>Source:</strong> {perf.performanceSource}</div>
                </div>
              </Card>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title="Paper Trading Readiness">
              <div style={{ fontSize: '2rem', fontWeight: 700, marginBottom: 8, color: data.paperTrading.ready ? '#16A34A' : '#D97706' }}>
                {data.paperTrading.score}%
              </div>
              <ul className={styles.checkList}>
                {data.paperTrading.checks.map((c) => (
                  <li key={c.name} className={styles.checkItem}>
                    {c.pass
                      ? <CheckCircle2 size={16} color="#16A34A" />
                      : <XCircle size={16} color="#DC2626" />}
                    <span style={{ color: c.pass ? '#1E293B' : '#94A3B8' }}>{c.name}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Risk Profile">
              <div style={{ fontSize: '0.9rem' }}>
                <Badge variant="orange" style={{ marginBottom: 8 }}>{data.riskProfileLabel}</Badge>
                <p style={{ margin: 0, color: '#64748B' }}>
                  Risk profile governs position sizing hints and operator-facing aggressiveness labels.
                  Internal scoring uses confidence and risk breakdowns independently.
                </p>
              </div>
            </Card>

            {data.profileNotes && (
              <Card title="Deployment Notes">
                <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748B' }}>{data.profileNotes}</p>
              </Card>
            )}

            {data.conditions && data.conditions.length > 0 && (
              <Card title="Strategy Conditions">
                <ul className={styles.checkList}>
                  {data.conditions.map((c) => (
                    <li key={c.condition_key} className={styles.checkItem}>
                      <CheckCircle2 size={14} color="#1E40AF" />
                      <span style={{ fontSize: '0.85rem' }}>
                        <strong>{c.condition_label}</strong>
                        {c.value_text && ` — ${c.value_text}`}
                        {c.value_numeric != null && !c.value_text && ` — ${c.operator ?? ''} ${c.value_numeric}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            <Link href={`/strategies/performance`} className="btn btn--outline btn--block">
              View Full Performance Dashboard →
            </Link>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
