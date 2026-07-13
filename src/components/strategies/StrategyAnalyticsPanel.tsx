'use client';

import { useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from 'recharts';
import { Card, Loading, Badge, StatCard } from '@/components/ui';
import { useStrategyAnalytics } from '@/hooks/useStrategyAnalytics';
import type { AnalyticsWindow, SectorAnalytics } from '@/lib/strategy-hub/analytics/types';
import {
  Activity, BarChart3, Brain, RefreshCw, TrendingUp, Target, Shield, Award,
} from 'lucide-react';
import styles from '@/app/strategies/strategies.module.scss';

const WINDOWS: AnalyticsWindow[] = ['TODAY', '7D', '30D', '90D', '180D', '1Y', 'ALL'];

const MEDAL: Record<string, string> = { gold: '🥇', silver: '🥈', bronze: '🥉' };

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

interface Props {
  strategyId: string;
  compareIds?: string[];
}

export function StrategyAnalyticsPanel({ strategyId, compareIds = [] }: Props) {
  const [window, setWindow] = useState<AnalyticsWindow>('90D');
  const [comparePeer, setComparePeer] = useState('');
  const [compareData, setCompareData] = useState<{
    strategies: Array<{
      strategyId: string; strategyName: string; winRate: number;
      profitFactor: number; maxDrawdownPct: number; overallScore: number;
    }>;
    highlights: string[];
    betterPerformer: string | null;
  } | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useStrategyAnalytics(strategyId, { window });

  const myRank = useMemo(
    () => data?.rankings?.find((r) => r.strategyId === strategyId) ?? null,
    [data?.rankings, strategyId],
  );

  const runCompare = async () => {
    const peer = comparePeer.trim();
    if (!peer || peer === strategyId) return;
    setCompareBusy(true);
    try {
      const res = await fetch(
        `/api/strategies/analytics/compare?ids=${strategyId},${peer}&window=${window}`,
        { credentials: 'include' },
      );
      const body = await res.json();
      if (body.ok) setCompareData(body.comparison);
    } finally {
      setCompareBusy(false);
    }
  };

  if (isLoading) return <Loading text="Loading performance analytics…" />;
  if (error) {
    return (
      <Card>
        <p style={{ color: '#DC2626' }}>Failed to load analytics.</p>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => refetch()}>Retry</button>
      </Card>
    );
  }

  const summary = data?.summary;
  const hasData = summary && summary.evaluatedSignals > 0;

  return (
    <div className={styles.analyticsPanel}>
      <div className={styles.analyticsToolbar}>
        <div className={styles.filters}>
          <span className={styles.filterLabel}>Period</span>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={window === w ? styles.filterChipActive : styles.filterChip}
              onClick={() => setWindow(w)}
            >
              {w === 'TODAY' ? 'Today' : w}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={() => refetch()}
          disabled={isFetching}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} className={isFetching ? styles.spin : undefined} />
          Refresh
        </button>
      </div>

      {data?.cached && (
        <p className={styles.analyticsCacheNote}>
          Served from cache ({Math.round((data.cacheAgeMs ?? 0) / 1000)}s old)
        </p>
      )}

      {!hasData && (
        <Card>
          <p style={{ color: '#64748B' }}>
            Insufficient evaluated signals for this window. Analytics require real outcome data from
            signal outcomes, confirmed snapshots, or completed backtests.
          </p>
          <p style={{ fontSize: '0.85rem', color: '#94A3B8', marginTop: 8 }}>
            Sources: {data?.sourceStatus.directOutcomeRows ?? 0} direct outcomes,{' '}
            {data?.sourceStatus.observedSnapshotRows ?? 0} snapshots,{' '}
            {data?.sourceStatus.backtestTradeRows ?? 0} backtest trades.
          </p>
        </Card>
      )}

      {summary && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, marginBottom: 20 }}>
            <StatCard label="Overall Score" value={myRank?.overallScore ?? summary.strategyHealthScore} icon={Award} iconVariant="orange" />
            <StatCard label="Win Rate" value={fmtPct(summary.winRate)} icon={TrendingUp} iconVariant="blue" />
            <StatCard label="Profit Factor" value={fmtNum(summary.profitFactor)} icon={BarChart3} iconVariant="green" />
            <StatCard label="Sharpe" value={fmtNum(summary.sharpeRatio)} icon={Activity} iconVariant="blue" />
            <StatCard label="Max Drawdown" value={fmtPct(summary.maxDrawdownPct)} icon={Shield} iconVariant="orange" />
            <StatCard label="Expectancy" value={`${fmtNum(summary.expectancy)}R`} icon={Target} iconVariant="green" />
          </div>

          <Card title="Signal Pipeline" style={{ marginBottom: 20 }}>
            <div className={styles.analyticsKpiGrid}>
              <div><span className={styles.configMetaLabel}>Generated</span><strong>{summary.totalSignalsGenerated}</strong></div>
              <div><span className={styles.configMetaLabel}>Approved</span><strong>{summary.approvedSignals}</strong></div>
              <div><span className={styles.configMetaLabel}>Confirmed</span><strong>{summary.confirmedSignals}</strong></div>
              <div><span className={styles.configMetaLabel}>Executed</span><strong>{summary.executedTrades}</strong></div>
              <div><span className={styles.configMetaLabel}>Avg Confidence</span><strong>{fmtPct(summary.averageConfidence, 0)}</strong></div>
              <div><span className={styles.configMetaLabel}>Sortino</span><strong>{fmtNum(summary.sortinoRatio)}</strong></div>
              <div><span className={styles.configMetaLabel}>CAGR</span><strong>{fmtPct(summary.cagrPct)}</strong></div>
              <div><span className={styles.configMetaLabel}>Holding Period</span><strong>{fmtNum(summary.averageHoldingPeriod, 1)} bars</strong></div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Badge variant="gray">{summary.performanceSource}</Badge>
              <Badge variant={summary.dataStatus === 'SUFFICIENT' ? 'green' : 'orange'}>{summary.dataStatus}</Badge>
              {myRank && (
                <Badge variant="dark">
                  Rank #{myRank.rank} {myRank.medal ? MEDAL[myRank.medal] : ''}
                  {myRank.trend === 'up' ? ' ↑' : myRank.trend === 'down' ? ' ↓' : ''}
                </Badge>
              )}
            </div>
          </Card>
        </>
      )}

      {data?.charts && data.charts.equityCurve.length > 1 && (
        <Card title="Equity & Drawdown" style={{ marginBottom: 20 }}>
          <div className={styles.analyticsChartRow}>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.charts.equityCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Line type="monotone" dataKey="equity" stroke="#1E40AF" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.charts.drawdown}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip />
                <Line type="monotone" dataKey="drawdown" stroke="#DC2626" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {data?.regime && (
        <Card title="Market Regime Analytics" style={{ marginBottom: 20 }}>
          {data.regime.dataStatus !== 'AVAILABLE' ? (
            <p style={{ color: '#64748B' }}>{data.regime.message}</p>
          ) : (
            <>
              <div className={styles.analyticsHighlights}>
                {data.regime.bestRegime && (
                  <span>Best: <strong>{data.regime.bestRegime.regime}</strong> ({fmtPct(data.regime.bestRegime.winRate)} WR)</span>
                )}
                {data.regime.worstRegime && (
                  <span>Worst: <strong>{data.regime.worstRegime.regime}</strong> ({fmtPct(data.regime.worstRegime.winRate)} WR)</span>
                )}
                {data.regime.recommendedRegimes.length > 0 && (
                  <span>Recommended: {data.regime.recommendedRegimes.join(', ')}</span>
                )}
              </div>
              <div className={styles.analyticsTableWrap}>
                <table className={styles.analyticsTable}>
                  <thead>
                    <tr>
                      <th>Regime</th><th>Trades</th><th>Win Rate</th><th>Avg Return</th>
                      <th>Confidence</th><th>Drawdown</th><th>PF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.regime.rows.map((r) => (
                      <tr key={r.regime}>
                        <td>{r.regime}</td>
                        <td>{r.trades}</td>
                        <td>{fmtPct(r.winRate)}</td>
                        <td>{fmtPct(r.averageReturnPct)}</td>
                        <td>{fmtPct(r.averageConfidence, 0)}</td>
                        <td>{fmtPct(r.drawdownPct)}</td>
                        <td>{fmtNum(r.profitFactor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {data?.sector && (
        <Card title="Sector & Industry Analytics" style={{ marginBottom: 20 }}>
          {data.sector.dataStatus === 'UNAVAILABLE' ? (
            <p style={{ color: '#64748B' }}>{data.sector.message}</p>
          ) : (
            <SectorTabs sector={data.sector} />
          )}
        </Card>
      )}

      {data?.confidence && data.confidence.histogram.some((h) => h.count > 0) && (
        <Card title="Confidence Distribution" style={{ marginBottom: 20 }}>
          <div className={styles.analyticsKpiGrid} style={{ marginBottom: 12 }}>
            <div><span className={styles.configMetaLabel}>Average</span><strong>{fmtPct(data.confidence.average, 0)}</strong></div>
            <div><span className={styles.configMetaLabel}>Median</span><strong>{fmtPct(data.confidence.median, 0)}</strong></div>
            <div><span className={styles.configMetaLabel}>P25</span><strong>{fmtPct(data.confidence.p25, 0)}</strong></div>
            <div><span className={styles.configMetaLabel}>P75</span><strong>{fmtPct(data.confidence.p75, 0)}</strong></div>
            <div><span className={styles.configMetaLabel}>P90</span><strong>{fmtPct(data.confidence.p90, 0)}</strong></div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.confidence.histogram}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#1E40AF" radius={[4, 4, 0, 0]}>
                {data.confidence.histogram.map((_, i) => (
                  <Cell key={i} fill={i >= 3 ? '#059669' : '#64748B'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {data?.trends && data.trends.points.length > 1 && (
        <Card title="Performance Trends" style={{ marginBottom: 20 }}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data.trends.points}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="period" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Line type="monotone" dataKey="winRate" name="Win Rate %" stroke="#1E40AF" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="returnPct" name="Return %" stroke="#059669" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="signalQuality" name="Signal Quality" stroke="#D97706" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {data?.learning && (
        <Card title="Learning & Optimization" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Brain size={18} color="#1E40AF" />
            <Badge variant={data.learning.status === 'SUFFICIENT' ? 'green' : 'orange'}>{data.learning.status}</Badge>
          </div>
          {data.learning.recommendations.length === 0 ? (
            <p style={{ color: '#64748B' }}>No optimization recommendations for this window yet.</p>
          ) : (
            <div className={styles.analyticsRecList}>
              {data.learning.recommendations.map((rec) => (
                <div key={rec.id} className={styles.analyticsRecCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong>{rec.action}</strong>
                    <Badge variant={rec.confidenceLevel === 'high' ? 'green' : rec.confidenceLevel === 'medium' ? 'orange' : 'gray'}>
                      {rec.confidenceLevel}
                    </Badge>
                  </div>
                  <p style={{ fontSize: '0.85rem', margin: '6px 0' }}>{rec.reason}</p>
                  <p style={{ fontSize: '0.8rem', color: '#059669' }}>Expected: {rec.expectedImpact}</p>
                  {rec.evidence.length > 0 && (
                    <ul style={{ fontSize: '0.78rem', color: '#64748B', margin: '6px 0 0', paddingLeft: 18 }}>
                      {rec.evidence.slice(0, 3).map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {data?.rankings && data.rankings.length > 0 && (
        <Card title="Strategy Leaderboard" style={{ marginBottom: 20 }}>
          <div className={styles.analyticsTableWrap}>
            <table className={styles.analyticsTable}>
              <thead>
                <tr>
                  <th>#</th><th>Strategy</th><th>Score</th><th>Win Rate</th>
                  <th>PF</th><th>Drawdown</th><th>Stability</th><th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {data.rankings.slice(0, 15).map((r) => (
                  <tr key={r.strategyId} className={r.strategyId === strategyId ? styles.analyticsRowHighlight : undefined}>
                    <td>{r.medal ? MEDAL[r.medal] : r.rank}</td>
                    <td>{r.strategyName}</td>
                    <td>{r.overallScore}</td>
                    <td>{fmtPct(r.winRate)}</td>
                    <td>{fmtNum(r.profitFactor)}</td>
                    <td>{fmtPct(r.maxDrawdownPct)}</td>
                    <td>{r.stabilityScore}</td>
                    <td>{r.trend === 'up' ? '↑' : r.trend === 'down' ? '↓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Compare Strategies">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Peer strategy id (snake_case)"
            value={comparePeer}
            onChange={(e) => setComparePeer(e.target.value)}
            className={styles.analyticsCompareInput}
          />
          <button type="button" className="btn btn--primary btn--sm" onClick={runCompare} disabled={compareBusy}>
            Compare
          </button>
        </div>
        {compareData && (
          <>
            {compareData.highlights.map((h, i) => (
              <p key={i} style={{ fontSize: '0.85rem', color: '#334155' }}>{h}</p>
            ))}
            <div className={styles.analyticsTableWrap}>
              <table className={styles.analyticsTable}>
                <thead>
                  <tr><th>Strategy</th><th>Score</th><th>Win Rate</th><th>PF</th><th>Drawdown</th></tr>
                </thead>
                <tbody>
                  {compareData.strategies.map((s) => (
                    <tr key={s.strategyId} className={s.strategyId === compareData.betterPerformer ? styles.analyticsRowHighlight : undefined}>
                      <td>{s.strategyName}</td>
                      <td>{s.overallScore}</td>
                      <td>{fmtPct(s.winRate)}</td>
                      <td>{fmtNum(s.profitFactor)}</td>
                      <td>{fmtPct(s.maxDrawdownPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function SectorTabs({ sector }: { sector: SectorAnalytics }) {
  const [tab, setTab] = useState<'sectors' | 'industries' | 'marketCaps' | 'exchanges'>('sectors');
  if (!sector) return null;
  const rows = tab === 'sectors' ? sector.sectors
    : tab === 'industries' ? sector.industries
    : tab === 'marketCaps' ? sector.marketCaps
    : sector.exchanges;

  return (
    <>
      <div className={styles.filters} style={{ marginBottom: 12 }}>
        {(['sectors', 'industries', 'marketCaps', 'exchanges'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t ? styles.filterChipActive : styles.filterChip}
            onClick={() => setTab(t)}
          >
            {t === 'marketCaps' ? 'Market Cap' : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.analyticsTableWrap}>
        <table className={styles.analyticsTable}>
          <thead>
            <tr>
              <th>Segment</th><th>Signals</th><th>Win Rate</th><th>Return</th>
              <th>Confidence</th><th>Approval</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>{r.signalCount}</td>
                <td>{fmtPct(r.winRate)}</td>
                <td>{fmtPct(r.averageReturnPct)}</td>
                <td>{fmtPct(r.averageConfidence, 0)}</td>
                <td>{fmtPct(r.approvalRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
