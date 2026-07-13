'use client';

import { useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Card, Loading, Badge, StatCard } from '@/components/ui';
import {
  useStrategyAiInsights,
  useHubAiRecommendations,
  useExecutiveAiSummary,
  useAiRecommendationHistory,
  useApplyAiRecommendation,
  useOptimizationSimulation,
  useTriggerAiAnalysis,
} from '@/hooks/useStrategyAi';
import type { AnalyticsWindow } from '@/lib/strategy-hub/analytics/types';
import type { AiRecommendation, SummaryPeriod } from '@/lib/strategy-hub/ai/types';
import {
  Brain, AlertTriangle, TrendingUp, TrendingDown, Minus, Shield,
  RefreshCw, Sparkles, Play, CheckCircle2, History,
} from 'lucide-react';
import styles from '@/app/strategies/strategies.module.scss';

const WINDOWS: AnalyticsWindow[] = ['7D', '30D', '90D', '180D'];
const PERIODS: SummaryPeriod[] = ['daily', 'weekly', 'monthly'];

const CONFIDENCE_TONE: Record<string, 'green' | 'orange' | 'gray'> = {
  high: 'green',
  medium: 'orange',
  low: 'gray',
};

const RISK_TONE: Record<string, 'green' | 'orange' | 'red' | 'gray'> = {
  low: 'green',
  moderate: 'orange',
  elevated: 'orange',
  high: 'red',
};

const TREND_ICON = {
  improving: TrendingUp,
  stable: Minus,
  declining: TrendingDown,
};

function RecommendationCard({
  rec,
  canManage,
  onApply,
  applying,
}: {
  rec: AiRecommendation;
  canManage: boolean;
  onApply?: (key: string) => void;
  applying?: boolean;
}) {
  const isExecutable = rec.applyMode === 'mode_change' && rec.targetMode;
  return (
    <div className={styles.aiRecCard}>
      <div className={styles.aiRecHeader}>
        <div>
          <Badge variant="gray">{rec.category}</Badge>
          <Badge variant={CONFIDENCE_TONE[rec.confidenceLevel] ?? 'gray'}>
            {rec.confidenceLevel} confidence
          </Badge>
          {rec.applyMode !== 'advisory' && (
            <Badge variant="dark">{rec.applyMode.replace('_', ' ')}</Badge>
          )}
        </div>
        {!rec.strategyId.startsWith('_') && (
          <span className={styles.aiRecStrategy}>{rec.strategyName}</span>
        )}
      </div>
      <h4 className={styles.aiRecAction}>{rec.action}</h4>
      <p className={styles.aiRecReason}>{rec.reason}</p>
      <div className={styles.aiRecEvidence}>
        <strong>Evidence</strong>
        <ul>
          {rec.evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      </div>
      <p className={styles.aiRecImpact}>
        <strong>Expected impact:</strong> {rec.expectedImpact}
      </p>
      <p className={styles.aiRecBasis}>
        <strong>Historical basis:</strong> {rec.historicalBasis}
      </p>
      {canManage && onApply && (
        <div className={styles.aiRecActions}>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={applying}
            onClick={() => onApply(rec.key)}
          >
            {isExecutable ? 'Apply Recommendation' : 'Acknowledge'}
          </button>
          {rec.applyMode === 'manual_config' && (
            <span className={styles.aiAdvisoryNote}>
              Config changes must be applied manually via the Configuration tab.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  strategyId?: string;
  canManage?: boolean;
}

export function StrategyAiInsightsPanel({ strategyId, canManage = false }: Props) {
  const [window, setWindow] = useState<AnalyticsWindow>('90D');
  const [period, setPeriod] = useState<SummaryPeriod>('weekly');
  const [simMinConf, setSimMinConf] = useState<string>('60');
  const [simRegime, setSimRegime] = useState<string>('');
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  const isDetail = Boolean(strategyId);

  const { data: insights, isLoading, error, refetch, isFetching } = useStrategyAiInsights(
    strategyId ?? '',
    { window, enabled: isDetail },
  );
  const { data: hubRecs, isLoading: hubLoading } = useHubAiRecommendations(window);
  const { data: summary, isLoading: summaryLoading } = useExecutiveAiSummary(period);
  const { data: history } = useAiRecommendationHistory(strategyId ?? '');
  const applyMutation = useApplyAiRecommendation(strategyId ?? '');
  const simMutation = useOptimizationSimulation(strategyId ?? '');
  const triggerAnalysis = useTriggerAiAnalysis();

  const handleApply = async (recKey: string) => {
    if (!strategyId) return;
    setApplyMsg(null);
    try {
      const result = await applyMutation.mutateAsync(recKey);
      setApplyMsg(result.message ?? 'Applied.');
    } catch (e) {
      setApplyMsg(e instanceof Error ? e.message : 'Apply failed.');
    }
  };

  const runSimulation = async () => {
    if (!strategyId) return;
    await simMutation.mutateAsync({
      window,
      minConfidence: simMinConf ? Number(simMinConf) : null,
      excludedRegimes: simRegime ? [simRegime] : undefined,
    });
  };

  if (isDetail && isLoading) return <Loading text="Loading AI insights…" />;
  if (isDetail && error) {
    return (
      <Card>
        <p style={{ color: '#DC2626' }}>Failed to load AI insights.</p>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => refetch()}>Retry</button>
      </Card>
    );
  }

  const predictionChart = insights?.prediction
    ? [
        { label: 'Win Rate', value: insights.prediction.expectedWinRate ?? 0 },
        { label: 'Drawdown', value: insights.prediction.expectedDrawdownPct ?? 0 },
        { label: 'Profit Factor', value: (insights.prediction.expectedProfitFactor ?? 0) * 10 },
        { label: 'Confidence', value: insights.prediction.expectedConfidence ?? 0 },
      ]
    : [];

  const TrendIcon = insights?.prediction
    ? TREND_ICON[insights.prediction.trend]
    : Minus;

  return (
    <div className={styles.aiPanel}>
      <div className={styles.analyticsToolbar}>
        <div className={styles.filters}>
          {isDetail ? (
            <>
              <span className={styles.filterLabel}>Period</span>
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={window === w ? styles.filterChipActive : styles.filterChip}
                  onClick={() => setWindow(w)}
                >
                  {w}
                </button>
              ))}
            </>
          ) : (
            <>
              <span className={styles.filterLabel}>Summary</span>
              {PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={period === p ? styles.filterChipActive : styles.filterChip}
                  onClick={() => setPeriod(p)}
                >
                  {p[0].toUpperCase()}{p.slice(1)}
                </button>
              ))}
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isDetail && (
            <button type="button" className="btn btn--outline btn--sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw size={14} /> Refresh
            </button>
          )}
          {canManage && (
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={triggerAnalysis.isPending}
              onClick={() => triggerAnalysis.mutate('recommendation_refresh')}
            >
              <Sparkles size={14} /> Run Analysis
            </button>
          )}
        </div>
      </div>

      {/* Hub-level executive summary */}
      {!isDetail && (
        <section className={styles.aiSection}>
          <h3><Brain size={18} /> Executive Summary</h3>
          {summaryLoading ? <Loading text="Generating summary…" /> : summary && (
            <Card>
              <p className={styles.aiHeadline}>{summary.headline}</p>
              <div className={styles.aiSummaryGrid}>
                <div>
                  <h4>Best Performers</h4>
                  <ul>{summary.bestPerformers.map((s) => (
                    <li key={s.strategyId}><strong>{s.strategyName}</strong> — {s.note}</li>
                  ))}</ul>
                  {!summary.bestPerformers.length && <p className={styles.aiMuted}>None identified yet.</p>}
                </div>
                <div>
                  <h4>Needs Attention</h4>
                  <ul>{summary.needsAttention.map((s) => (
                    <li key={s.strategyId}><strong>{s.strategyName}</strong> — {s.note}</li>
                  ))}</ul>
                  {!summary.needsAttention.length && <p className={styles.aiMuted}>No strategies flagged.</p>}
                </div>
                <div>
                  <h4>Risk Summary</h4>
                  <ul>{summary.riskSummary.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
                <div>
                  <h4>Optimization Opportunities</h4>
                  <ul>{summary.optimizationOpportunities.map((o, i) => <li key={i}>{o}</li>)}</ul>
                </div>
              </div>
              <div className={styles.aiTotals}>
                {summary.totals.strategiesAnalyzed} strategies · {summary.totals.evaluatedTrades} trades · {summary.totals.openAlerts} open alerts
              </div>
            </Card>
          )}
        </section>
      )}

      {/* Per-strategy predictive + risk */}
      {isDetail && insights && (
        <>
          <div className={styles.aiStatusRow}>
            <Badge variant={insights.dataStatus === 'SUFFICIENT' ? 'green' : insights.dataStatus === 'LIMITED' ? 'orange' : 'gray'}>
              Data: {insights.dataStatus}
            </Badge>
            {insights.cached && <Badge variant="gray">Cached</Badge>}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            <StatCard label="Expected Win Rate" value={insights.prediction.expectedWinRate != null ? `${insights.prediction.expectedWinRate}%` : '—'} icon={TrendingUp} iconVariant="blue" />
            <StatCard label="Expected Drawdown" value={insights.prediction.expectedDrawdownPct != null ? `${insights.prediction.expectedDrawdownPct}%` : '—'} icon={Shield} iconVariant="orange" />
            <StatCard label="Expected PF" value={insights.prediction.expectedProfitFactor ?? '—'} icon={Brain} iconVariant="green" />
            <StatCard label="Trend" value={insights.prediction.trend} icon={TrendIcon} iconVariant={insights.prediction.trend === 'declining' ? 'orange' : 'blue'} />
          </div>

          <div className={styles.aiTwoCol}>
            <Card>
              <h4>Predictive Performance</h4>
              <p className={styles.aiMuted}>{insights.prediction.basis}</p>
              {predictionChart.length > 0 && (
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={predictionChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="value" stroke="#1E40AF" strokeWidth={2} dot />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card>
              <h4>AI Risk Assessment</h4>
              <div className={styles.aiRiskHeader}>
                <span className={styles.aiRiskScore}>{insights.risk.riskScore}</span>
                <Badge variant={RISK_TONE[insights.risk.riskCategory] ?? 'gray'}>
                  {insights.risk.riskCategory} risk
                </Badge>
              </div>
              <ul className={styles.aiRiskFactors}>
                {insights.risk.factors.map((f) => (
                  <li key={f.id}>
                    <strong>{f.label}</strong> — {f.detail}
                    <div className={styles.aiMitigation}>Mitigation: {f.mitigation}</div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* Anomalies */}
          {insights.anomalies.length > 0 && (
            <section className={styles.aiSection}>
              <h3><AlertTriangle size={18} /> Anomaly Feed</h3>
              <div className={styles.aiAnomalyList}>
                {insights.anomalies.map((a) => (
                  <div key={a.id} className={styles.aiAnomalyItem}>
                    <Badge variant={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'orange' : 'gray'}>
                      {a.severity}
                    </Badge>
                    <strong>{a.title}</strong>
                    <p>{a.rootCause}</p>
                    <p className={styles.aiMitigation}>Action: {a.suggestedAction}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Simulator */}
          {canManage && (
            <section className={styles.aiSection}>
              <h3><Play size={18} /> Optimization Simulator</h3>
              <Card>
                <p className={styles.aiAdvisoryNote}>
                  Simulations replay real historical outcomes — production configuration is never modified.
                </p>
                <div className={styles.aiSimForm}>
                  <label>
                    Min confidence
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={simMinConf}
                      onChange={(e) => setSimMinConf(e.target.value)}
                      className={styles.aiSimInput}
                    />
                  </label>
                  <label>
                    Exclude regime
                    <input
                      type="text"
                      placeholder="e.g. Bearish"
                      value={simRegime}
                      onChange={(e) => setSimRegime(e.target.value)}
                      className={styles.aiSimInput}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={simMutation.isPending}
                    onClick={runSimulation}
                  >
                    Run Simulation
                  </button>
                </div>
                {simMutation.data && (
                  <div className={styles.aiSimResults}>
                    <table className={styles.aiSimTable}>
                      <thead>
                        <tr><th>Metric</th><th>Baseline</th><th>Simulated</th><th>Delta</th></tr>
                      </thead>
                      <tbody>
                        <tr><td>Win Rate</td><td>{simMutation.data.baseline.winRate}%</td><td>{simMutation.data.simulated.winRate}%</td><td>{simMutation.data.delta.winRate > 0 ? '+' : ''}{simMutation.data.delta.winRate}</td></tr>
                        <tr><td>Profit Factor</td><td>{simMutation.data.baseline.profitFactor}</td><td>{simMutation.data.simulated.profitFactor}</td><td>{simMutation.data.delta.profitFactor > 0 ? '+' : ''}{simMutation.data.delta.profitFactor}</td></tr>
                        <tr><td>Max Drawdown</td><td>{simMutation.data.baseline.maxDrawdownPct}%</td><td>{simMutation.data.simulated.maxDrawdownPct}%</td><td>{simMutation.data.delta.maxDrawdownPct > 0 ? '+' : ''}{simMutation.data.delta.maxDrawdownPct}</td></tr>
                        <tr><td>Trades</td><td>{simMutation.data.baseline.trades}</td><td>{simMutation.data.simulated.trades}</td><td>{simMutation.data.delta.trades > 0 ? '+' : ''}{simMutation.data.delta.trades}</td></tr>
                      </tbody>
                    </table>
                    <p>Ranking impact: <strong>{simMutation.data.rankingImpact.replace('_', ' ')}</strong></p>
                    <ul>{simMutation.data.notes.map((n, i) => <li key={i} className={styles.aiMuted}>{n}</li>)}</ul>
                  </div>
                )}
              </Card>
            </section>
          )}
        </>
      )}

      {/* Recommendations */}
      <section className={styles.aiSection}>
        <h3><Sparkles size={18} /> AI Recommendations</h3>
        {applyMsg && <p className={styles.aiApplyMsg}><CheckCircle2 size={14} /> {applyMsg}</p>}
        <div className={styles.aiRecList}>
          {(isDetail ? insights?.recommendations : hubRecs?.recommendations)?.length ? (
            (isDetail ? insights?.recommendations : hubRecs?.recommendations)?.map((rec) => (
              <RecommendationCard
                key={rec.key}
                rec={rec}
                canManage={canManage && isDetail}
                onApply={isDetail ? handleApply : undefined}
                applying={applyMutation.isPending}
              />
            ))
          ) : (
            <Card><p className={styles.aiMuted}>{hubLoading || isLoading ? 'Loading…' : 'No recommendations for this window — more evaluated trades are needed.'}</p></Card>
          )}
        </div>
      </section>

      {/* History */}
      {isDetail && history && history.length > 0 && (
        <section className={styles.aiSection}>
          <h3><History size={18} /> Recommendation History</h3>
          <div className={styles.aiHistoryList}>
            {history.slice(0, 20).map((row) => (
              <div key={row.id} className={styles.aiHistoryItem}>
                <Badge variant={row.status === 'applied' ? 'green' : row.status === 'dismissed' ? 'gray' : 'orange'}>
                  {row.status}
                </Badge>
                <span>{row.action}</span>
                <span className={styles.aiMuted}>{new Date(row.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
