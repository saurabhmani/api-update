'use client';

import { useMemo, useState } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Card, Loading, Badge, StatCard } from '@/components/ui';
import {
  usePortfolioSummary,
  usePortfolioRisk,
  usePortfolioDiversification,
  useAllocationHistory,
  usePortfolioAlerts,
  useSaveAllocations,
  usePortfolioOptimization,
  usePortfolioSimulation,
  usePortfolioAlertActions,
} from '@/hooks/useStrategyPortfolio';
import type { AllocationMethod, OptimizationGoal, PortfolioWindow } from '@/lib/strategy-hub/portfolio/types';
import {
  Wallet, TrendingUp, Shield, PieChart as PieIcon, AlertTriangle,
  RefreshCw, Save, Play, Sparkles,
} from 'lucide-react';
import styles from '@/app/strategies/strategies.module.scss';

const WINDOWS: PortfolioWindow[] = ['TODAY', '7D', '30D', '90D', '1Y', 'ALL'];
const METHODS: { id: AllocationMethod; label: string }[] = [
  { id: 'manual', label: 'Manual' },
  { id: 'equal', label: 'Equal' },
  { id: 'risk_weighted', label: 'Risk-weighted' },
  { id: 'performance_weighted', label: 'Performance' },
  { id: 'confidence_weighted', label: 'Confidence' },
];
const GOALS: { id: OptimizationGoal; label: string }[] = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'maximize_return', label: 'Max Return' },
  { id: 'minimize_risk', label: 'Min Risk' },
  { id: 'conservative', label: 'Conservative' },
  { id: 'growth', label: 'Growth' },
  { id: 'income', label: 'Income' },
];
const CHART_COLORS = ['#1E40AF', '#16A34A', '#D97706', '#DC2626', '#7C3AED', '#0891B2', '#BE185D'];

function fmtCurrency(n: number): string {
  if (n >= 1_000_000) return `₹${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(0)}K`;
  return `₹${n.toFixed(0)}`;
}

interface Props {
  canManage?: boolean;
}

export function StrategyPortfolioPanel({ canManage = false }: Props) {
  const [window, setWindow] = useState<PortfolioWindow>('90D');
  const [section, setSection] = useState<'overview' | 'allocation' | 'risk' | 'optimize' | 'simulate'>('overview');
  const [method, setMethod] = useState<AllocationMethod>('manual');
  const [goal, setGoal] = useState<OptimizationGoal>('balanced');
  const [totalCapitalInput, setTotalCapitalInput] = useState('');
  const [editAmounts, setEditAmounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);

  const { data: summary, isLoading, error, refetch, isFetching } = usePortfolioSummary(window);
  const { data: risk } = usePortfolioRisk(window, section === 'overview' || section === 'risk');
  const { data: diversification } = usePortfolioDiversification(window, section === 'overview' || section === 'risk');
  const { data: history } = useAllocationHistory();
  const { data: alerts } = usePortfolioAlerts();
  const saveAlloc = useSaveAllocations();
  const optimize = usePortfolioOptimization();
  const simulate = usePortfolioSimulation();
  const alertActions = usePortfolioAlertActions();

  const sectorChart = useMemo(
    () => (diversification?.sector ?? []).slice(0, 8).map((s) => ({ name: s.label, value: s.weightPct })),
    [diversification],
  );

  const handleSave = async () => {
    setMsg(null);
    try {
      if (totalCapitalInput && canManage) {
        await saveAlloc.mutateAsync({
          method: 'manual',
          allocations: [],
          totalCapital: Number(totalCapitalInput),
        });
      }
      const allocations = (summary?.allocations ?? [])
        .filter((a) => a.eligible)
        .map((a) => ({
          strategyId: a.strategyId,
          amount: editAmounts[a.strategyId] != null
            ? Number(editAmounts[a.strategyId])
            : a.allocatedAmount,
        }));
      await saveAlloc.mutateAsync({ method, allocations });
      setMsg('Allocations saved.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Save failed.');
    }
  };

  const applyEqual = () => {
    if (!summary) return;
    const eligible = summary.allocations.filter((a) => a.eligible);
    const each = summary.settings.totalCapital / Math.max(eligible.length, 1);
    const next: Record<string, string> = {};
    for (const a of eligible) next[a.strategyId] = String(Math.round(each));
    setEditAmounts(next);
    setMethod('equal');
  };

  if (isLoading) return <Loading text="Loading portfolio…" />;
  if (error || !summary) {
    return (
      <Card>
        <p style={{ color: '#DC2626' }}>Failed to load portfolio.</p>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => refetch()}>Retry</button>
      </Card>
    );
  }

  const kpis = summary.kpis;

  return (
    <div className={styles.portfolioPanel}>
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
              {w === 'ALL' ? 'Lifetime' : w === 'TODAY' ? 'Today' : w}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className={styles.filters} style={{ marginBottom: 16 }}>
        {(['overview', 'allocation', 'risk', 'optimize', 'simulate'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={section === s ? styles.filterChipActive : styles.filterChip}
            onClick={() => setSection(s)}
          >
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {msg && <p className={styles.aiApplyMsg}>{msg}</p>}

      {/* KPI Dashboard */}
      {(section === 'overview' || section === 'allocation') && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
          <StatCard label="Total Capital" value={fmtCurrency(kpis.totalCapital)} icon={Wallet} iconVariant="blue" />
          <StatCard label="Allocated" value={fmtCurrency(kpis.allocatedCapital)} icon={PieIcon} iconVariant="green" />
          <StatCard label="Available" value={fmtCurrency(kpis.availableCapital)} icon={Wallet} iconVariant="orange" />
          <StatCard label="Portfolio Return" value={`${kpis.portfolioReturnPct}%`} icon={TrendingUp} iconVariant="blue" />
          <StatCard label="Sharpe" value={kpis.portfolioSharpe ?? '—'} icon={TrendingUp} iconVariant="green" />
          <StatCard label="Drawdown" value={`${kpis.portfolioDrawdownPct}%`} icon={Shield} iconVariant="orange" />
          <StatCard label="Win Rate" value={`${kpis.portfolioWinRate}%`} icon={TrendingUp} iconVariant="blue" />
          <StatCard label="Risk Score" value={kpis.portfolioRiskScore} icon={Shield} iconVariant="orange" />
        </div>
      )}

      {/* Alerts */}
      {alerts && alerts.length > 0 && section === 'overview' && (
        <section className={styles.aiSection}>
          <h3><AlertTriangle size={18} /> Portfolio Alerts ({alerts.length})</h3>
          <div className={styles.aiAnomalyList}>
            {alerts.slice(0, 5).map((a) => (
              <div key={a.id} className={styles.aiAnomalyItem}>
                <Badge variant={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'orange' : 'gray'}>
                  {a.severity}
                </Badge>
                <strong>{a.title}</strong>
                <p>{a.description}</p>
                {canManage && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn--sm btn--outline" onClick={() => alertActions.mutate({ id: a.id, action: 'acknowledge' })}>Acknowledge</button>
                    <button type="button" className="btn btn--sm btn--outline" onClick={() => alertActions.mutate({ id: a.id, action: 'resolve' })}>Resolve</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {canManage && (
            <button type="button" className="btn btn--outline btn--sm" style={{ marginTop: 8 }} onClick={() => alertActions.mutate({ id: 0, action: 'refresh' })}>
              Refresh Alerts
            </button>
          )}
        </section>
      )}

      {/* Allocation Table */}
      {(section === 'overview' || section === 'allocation') && (
        <section className={styles.aiSection}>
          <h3><Wallet size={18} /> Capital Allocation</h3>
          {canManage && (
            <div className={styles.portfolioToolbar}>
              <label>
                Total Capital
                <input
                  type="number"
                  className={styles.aiSimInput}
                  placeholder={String(summary.settings.totalCapital)}
                  value={totalCapitalInput}
                  onChange={(e) => setTotalCapitalInput(e.target.value)}
                />
              </label>
              <div className={styles.filters}>
                {METHODS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={method === m.id ? styles.filterChipActive : styles.filterChip}
                    onClick={() => setMethod(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn--outline btn--sm" onClick={applyEqual}>Equal Split</button>
              <button type="button" className="btn btn--primary btn--sm" disabled={saveAlloc.isPending} onClick={handleSave}>
                <Save size={14} /> Save
              </button>
            </div>
          )}
          <div className={styles.portfolioTableWrap}>
            <table className={styles.aiSimTable}>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Status</th>
                  <th>Current</th>
                  <th>%</th>
                  <th>Suggested</th>
                  {canManage && <th>Edit Amount</th>}
                </tr>
              </thead>
              <tbody>
                {summary.allocations.filter((a) => a.eligible || a.allocatedAmount > 0).map((a) => (
                  <tr key={a.strategyId}>
                    <td>{a.strategyName}</td>
                    <td><Badge variant={a.environment === 'live' ? 'orange' : a.environment === 'paper' ? 'green' : 'gray'}>{a.deploymentStatus}</Badge></td>
                    <td>{fmtCurrency(a.allocatedAmount)}</td>
                    <td>{a.allocatedPct.toFixed(1)}%</td>
                    <td>{a.suggestedAmount != null ? fmtCurrency(a.suggestedAmount) : '—'}</td>
                    {canManage && (
                      <td>
                        <input
                          type="number"
                          className={styles.aiSimInput}
                          style={{ width: 100 }}
                          placeholder={String(a.allocatedAmount)}
                          value={editAmounts[a.strategyId] ?? ''}
                          onChange={(e) => setEditAmounts((p) => ({ ...p, [a.strategyId]: e.target.value }))}
                          disabled={!a.eligible}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.aiMuted}>
            {kpis.liveStrategies} live · {kpis.paperStrategies} paper · {kpis.activeStrategies} active · Data: {kpis.dataStatus}
          </p>
        </section>
      )}

      {/* Risk & Diversification */}
      {(section === 'overview' || section === 'risk') && risk && diversification && (
        <div className={styles.aiTwoCol}>
          <Card>
            <h4>Risk Dashboard</h4>
            <div className={styles.aiRiskHeader}>
              <span className={styles.aiRiskScore}>{risk.riskScore}</span>
              <Badge variant={risk.riskCategory === 'high' ? 'red' : risk.riskCategory === 'elevated' ? 'orange' : 'green'}>
                {risk.riskCategory}
              </Badge>
            </div>
            <p>VaR (95%): {risk.portfolioVar95Pct != null ? `${risk.portfolioVar95Pct}%` : '—'}</p>
            <p>Max Drawdown: {risk.maxDrawdownPct}%</p>
            <p>Diversification: {risk.diversificationScore}/100</p>
            <ul className={styles.aiRiskFactors}>
              {risk.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </Card>
          <Card>
            <h4>Sector Exposure</h4>
            {sectorChart.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={sectorChart} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                    {sectorChart.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                </PieChart>
              </ResponsiveContainer>
            ) : <p className={styles.aiMuted}>No sector data for allocated strategies.</p>}
            <ul>{diversification.recommendations.map((r, i) => <li key={i} className={styles.aiMuted}>{r}</li>)}</ul>
          </Card>
        </div>
      )}

      {section === 'risk' && risk && (
        <Card>
          <h4>Strategy Concentration</h4>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={risk.strategyConcentration.slice(0, 10)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="strategyName" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="weightPct" fill="#1E40AF" name="Weight %" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Optimization */}
      {section === 'optimize' && (
        <section className={styles.aiSection}>
          <h3><Sparkles size={18} /> Portfolio Optimization</h3>
          <p className={styles.aiAdvisoryNote}>Advisory only — recommendations are not applied automatically.</p>
          <div className={styles.filters} style={{ marginBottom: 12 }}>
            {GOALS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={goal === g.id ? styles.filterChipActive : styles.filterChip}
                onClick={() => setGoal(g.id)}
              >
                {g.label}
              </button>
            ))}
            <button type="button" className="btn btn--primary btn--sm" disabled={optimize.isPending} onClick={() => optimize.mutate(goal)}>
              Generate
            </button>
          </div>
          {optimize.data && (
            <Card>
              <p>{optimize.data.expectedRiskImpact}</p>
              {optimize.data.expectedReturnImprovementPct != null && (
                <p>Expected return change: {optimize.data.expectedReturnImprovementPct > 0 ? '+' : ''}{optimize.data.expectedReturnImprovementPct} pts</p>
              )}
              <table className={styles.aiSimTable}>
                <thead>
                  <tr><th>Strategy</th><th>Current %</th><th>Recommended %</th><th>Delta</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {optimize.data.recommendedAllocations.map((r) => (
                    <tr key={r.strategyId}>
                      <td>{r.strategyName}</td>
                      <td>{r.currentPct}%</td>
                      <td>{r.recommendedPct}%</td>
                      <td>{r.deltaPct > 0 ? '+' : ''}{r.deltaPct}%</td>
                      <td className={styles.aiMuted}>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}

      {/* Simulation */}
      {section === 'simulate' && canManage && (
        <section className={styles.aiSection}>
          <h3><Play size={18} /> Portfolio Simulation</h3>
          <p className={styles.aiAdvisoryNote}>Simulations never modify production data.</p>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={simulate.isPending}
            onClick={() => simulate.mutate({ method: 'equal', totalCapital: summary.settings.totalCapital })}
          >
            Simulate Equal Allocation
          </button>
          {simulate.data && (
            <div className={styles.aiSimResults}>
              <table className={styles.aiSimTable}>
                <thead>
                  <tr><th>Metric</th><th>Baseline</th><th>Projected</th><th>Delta</th></tr>
                </thead>
                <tbody>
                  <tr><td>Return</td><td>{simulate.data.baseline.returnPct}%</td><td>{simulate.data.projected.returnPct}%</td><td>{simulate.data.delta.returnPct > 0 ? '+' : ''}{simulate.data.delta.returnPct}</td></tr>
                  <tr><td>Drawdown</td><td>{simulate.data.baseline.drawdownPct}%</td><td>{simulate.data.projected.drawdownPct}%</td><td>{simulate.data.delta.drawdownPct > 0 ? '+' : ''}{simulate.data.delta.drawdownPct}</td></tr>
                  <tr><td>Win Rate</td><td>{simulate.data.baseline.winRate}%</td><td>{simulate.data.projected.winRate}%</td><td>{simulate.data.delta.winRate > 0 ? '+' : ''}{simulate.data.delta.winRate}</td></tr>
                  <tr><td>Risk Score</td><td>{simulate.data.baseline.riskScore}</td><td>{simulate.data.projected.riskScore}</td><td>{simulate.data.delta.riskScore > 0 ? '+' : ''}{simulate.data.delta.riskScore}</td></tr>
                  <tr><td>Utilization</td><td>{simulate.data.baseline.capitalUtilizationPct}%</td><td>{simulate.data.projected.capitalUtilizationPct}%</td><td>—</td></tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Allocation History */}
      {section === 'allocation' && history && history.length > 0 && (
        <section className={styles.aiSection}>
          <h3>Allocation History</h3>
          <div className={styles.aiHistoryList}>
            {history.slice(0, 15).map((h: { id: number; strategyName: string; fromAmount: number; toAmount: number; method: string; createdAt: string }) => (
              <div key={h.id} className={styles.aiHistoryItem}>
                <span>{h.strategyName}</span>
                <span>{fmtCurrency(h.fromAmount)} → {fmtCurrency(h.toAmount)}</span>
                <Badge variant="gray">{h.method}</Badge>
                <span className={styles.aiMuted}>{new Date(h.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
