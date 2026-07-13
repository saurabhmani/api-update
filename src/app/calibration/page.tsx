'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { BarChart3, RefreshCw, Target, Activity, Newspaper, Zap, Clock, TrendingUp, Shield, Brain, AlertTriangle } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, ReferenceLine, Legend,
} from 'recharts';
import s from './calibration.module.scss';

interface CalibData {
  strategyPerformance: any[];
  confidenceCalibration: any[];
  adaptiveRecommendations: any[];
  newsCalibration: any[];
  newsRecommendations: any[];
  outcomeDistribution: any[];
  returnDistribution: any[];
  learningJobRuns: any[];
  kpiMetrics: { activeSignals: number; strategyWinRate: number; avgReturnPct: number; riskLevel: string };
  kpiSource?: {
    activeSignals: 'lifecycle' | 'recent_window';
    performance:   'snapshot' | 'live_outcomes' | 'proxy_from_signals' | 'none';
  };
  marketRegime: { label: string; confidence: number; volatilityState: string };
  strategyParameters?: any[];
  confidenceWeights?: any[];
  optimizationSummary?: any[];
  suggestedImprovements?: any[];
  dataQuality?: {
    source: 'normalized_outcomes' | 'learning_snapshots' | 'insufficient_data';
    lookbackDays: number;
    performanceWindow: string;
    normalizedRows: number;
    evaluatedRows: number;
    directRows: number;
    observedRows: number;
    backtestRows: number;
    truncated?: boolean;
  };
}

const EMPTY_KPI = { activeSignals: 0, strategyWinRate: 0, avgReturnPct: 0, riskLevel: 'Low' };
const EMPTY_REGIME = { label: 'Sideways', confidence: 0, volatilityState: 'Normal' };

function calibClass(state: string): string {
  if (state?.includes('well')) return s.well;
  if (state?.includes('over')) return s.over;
  if (state?.includes('under')) return s.under;
  return s.insuf;
}

function envClass(fit: string): string {
  if (fit === 'excellent') return s.excellent;
  if (fit === 'good') return s.good;
  if (fit === 'moderate') return s.moderate;
  if (fit === 'poor') return s.poor;
  return s.insufficient_data;
}

function wrColor(wr: number): string {
  if (wr >= 0.6) return '#059669';
  if (wr >= 0.45) return '#D97706';
  return '#DC2626';
}

function pct(v: number): string { return (v * 100).toFixed(1) + '%'; }
function pctPoints(v: number): string { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; }

export default function CalibrationPage() {
  const [data, setData] = useState<CalibData | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async (spinner = true) => {
    if (spinner) setLoading(true);
    try {
      const res = await fetch('/api/signal-engine/calibration?days=30', { cache: 'no-store' });
      if (res.status === 401) { window.location.href = `/login?from=${encodeURIComponent('/calibration')}`; return; }
      if (!res.ok) { setData(null); if (spinner) setLoading(false); return; }
      const json = await res.json().catch(() => null);
      setData(json && !json.error ? json : null);
    } catch { setData(null); }
    if (spinner) setLoading(false);
  }, []);

  const triggerRecalibration = async () => {
    setTriggering(true);
    try {
      await fetch('/api/signal-engine/calibration', { method: 'POST' }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      await load();
    } finally { setTriggering(false); }
  };

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 60 seconds (calibration data changes slowly)
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) load(false);
    }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) return <AppShell><Loading text="Loading calibration data..." /></AppShell>;

  const hasRealCalibrationData = (data?.dataQuality?.evaluatedRows ?? 0) > 0
    || (data?.strategyPerformance?.length ?? 0) > 0
    || (data?.confidenceCalibration?.length ?? 0) > 0;
  const kpi = data?.kpiMetrics ?? EMPTY_KPI;
  const kpiSource = data?.kpiSource;
  const regime = data?.marketRegime ?? EMPTY_REGIME;

  // Human-readable sublabels that reflect where each KPI came from,
  // so "Win Rate 42%" with no graded outcomes doesn't look identical
  // to "Win Rate 42%" computed from real outcomes.
  const activeSignalsSub =
    kpiSource?.activeSignals === 'recent_window' ? 'Generated in last 7 days'
    : 'Currently tracked';
  const performanceSub =
    kpiSource?.performance === 'snapshot'           ? 'Across all strategies'
    : kpiSource?.performance === 'live_outcomes'    ? 'Live from graded outcomes'
    : kpiSource?.performance === 'proxy_from_signals' ? 'Engine estimate (awaiting outcomes)'
    : 'Awaiting first graded outcome';
  const returnSub =
    kpiSource?.performance === 'snapshot'           ? 'Snapshot-derived average return'
    : kpiSource?.performance === 'live_outcomes'    ? 'Live realized return'
    : kpiSource?.performance === 'proxy_from_signals' ? 'Opportunity-score proxy'
    : 'Awaiting first graded outcome';
  const strategyPerformance = (data?.strategyPerformance ?? [])
    .slice().sort((a: any, b: any) => Number(b.win_rate) - Number(a.win_rate));
  const confidenceCalibration = data?.confidenceCalibration ?? [];
  const returnDistribution = data?.returnDistribution ?? [];
  const outcomeDistribution = data?.outcomeDistribution ?? [];
  const adaptiveRecommendations = data?.adaptiveRecommendations ?? [];
  const newsCalibration = data?.newsCalibration ?? [];
  const learningJobRuns = data?.learningJobRuns ?? [];
  const strategyParameters = data?.strategyParameters ?? [];
  const confidenceWeights = data?.confidenceWeights ?? [];
  const optimizationSummary = data?.optimizationSummary ?? [];
  const suggestedImprovements = data?.suggestedImprovements ?? [];
  const totalOutcomes = outcomeDistribution.reduce((s: number, o: any) => s + Number(o.count), 0);

  // Build calibration curve data
  const calibCurveData = confidenceCalibration.map((c: any) => {
    const bucketStr = String(c.bucket ?? '');
    const parts = bucketStr.split('_');
    const midpoint = parts.length === 2 ? (Number(parts[0]) + Number(parts[1])) / 2 : 50;
    return {
      confidence: midpoint,
      expectedHitRate: midpoint,
      actualHitRate: Math.round(Number(c.target1_hit_rate ?? 0) * 100),
      samples: Number(c.sample_size ?? 0),
    };
  }).sort((a: any, b: any) => a.confidence - b.confidence);

  // Strategy win rate chart data
  const strategyChartData = strategyPerformance.slice(0, 8).map((r: any) => ({
    name: String(r.strategy_name ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).slice(0, 16),
    winRate: Math.round(Number(r.win_rate ?? 0) * 100),
    trades: Number(r.sample_size ?? 0),
  }));

  // Histogram bar colors
  const distColors: Record<string, string> = {
    'Loss > -5%': '#DC2626', 'Loss -5% to -1%': '#F59E0B',
    'Flat -1% to +1%': '#6B7280', 'Gain +1% to +5%': '#10B981', 'Gain > +5%': '#059669',
  };

  return (
    <AppShell>
      <div className={s.pageHeader}>
        <span className={s.pageTitle}><BarChart3 size={24} style={{ display:'inline', verticalAlign:'middle', marginRight:8 }} />Calibration Dashboard</span>
        <div style={{ display:'flex', gap:8 }}>
          <button className={s.refreshBtn} onClick={triggerRecalibration} disabled={triggering} style={{ background: triggering ? '#94A3B8' : undefined }}>
            <Zap size={14} /> {triggering ? 'Recalibrating...' : 'Recalibrate'}
          </button>
          <button className={s.refreshBtn} onClick={() => load()}><RefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      {!hasRealCalibrationData && (
        <div style={{ padding:'8px 16px', background:'#FFFBEB', border:'1px solid #FDE68A', borderRadius:8, marginBottom:16, fontSize:12, color:'#92400E', display:'flex', alignItems:'center', gap:8 }}>
          <AlertTriangle size={14} /> No calibrated outcomes found yet. Generate signals and run recalibration to populate this dashboard.
        </div>
      )}

      {data?.dataQuality && (
        <div style={{ padding:'8px 16px', background:'#F8FAFC', border:'1px solid #E2E8F0', borderRadius:8, marginBottom:16, fontSize:12, color:'#475569', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap' }}>
          <span>
            Source: <b>{data.dataQuality.source.replace(/_/g, ' ')}</b> · Evaluated rows: <b>{data.dataQuality.evaluatedRows}</b> · Window: <b>{data.dataQuality.performanceWindow}</b>
            {data.dataQuality.truncated && (
              <span style={{ color: '#B45309', marginLeft: 8 }}>· Sample capped — metrics may undercount older outcomes</span>
            )}
          </span>
          <span>Direct {data.dataQuality.directRows} · Observed {data.dataQuality.observedRows} · Backtest {data.dataQuality.backtestRows}</span>
        </div>
      )}

      {/* ═══ 1. KPI Summary Cards ═══ */}
      <div className={s.grid4} style={{ marginBottom:24 }}>
        <div className={s.statBox}>
          <div className={s.statLabel}>Active Signals</div>
          <div className={s.statValue} style={{ color:'#1D4ED8' }}>{kpi.activeSignals}</div>
          <div style={{ fontSize:10, color:'#94A3B8', marginTop:4 }}>{activeSignalsSub}</div>
        </div>
        <div className={s.statBox}>
          <div className={s.statLabel}>Strategy Win Rate</div>
          <div className={s.statValue} style={{ color: wrColor(kpi.strategyWinRate) }}>{pct(kpi.strategyWinRate)}</div>
          <div style={{ fontSize:10, color:'#94A3B8', marginTop:4 }}>{performanceSub}</div>
        </div>
        <div className={s.statBox}>
          <div className={s.statLabel}>Avg Return / Signal</div>
          <div className={s.statValue} style={{ color: kpi.avgReturnPct >= 0 ? '#059669' : '#DC2626' }}>
            {pctPoints(kpi.avgReturnPct)}
          </div>
          <div style={{ fontSize:10, color:'#94A3B8', marginTop:4 }}>{returnSub}</div>
        </div>
        <div className={s.statBox}>
          <div className={s.statLabel}>Risk Score</div>
          <div className={s.statValue} style={{ color: kpi.riskLevel === 'High' ? '#DC2626' : kpi.riskLevel === 'Medium' ? '#D97706' : '#059669' }}>
            {kpi.riskLevel}
          </div>
          <div style={{ fontSize:10, color:'#94A3B8', marginTop:4 }}>AI market assessment</div>
        </div>
      </div>

      {/* ═══ 2. Market Regime Indicator ═══ */}
      <div className={s.section}>
        <div className={s.sectionHead}><Shield size={18} /><span>Market Regime</span></div>
        <div style={{ display:'flex', gap:16, alignItems:'center', padding:'16px 20px', borderRadius:8, background:'linear-gradient(135deg, #EFF6FF 0%, #F0FDF4 100%)', border:'1px solid #BFDBFE' }}>
          <div style={{ width:64, height:64, borderRadius:'50%', background: regime.label.includes('Bull') ? '#D1FAE5' : regime.label.includes('Bear') ? '#FEE2E2' : '#F0F4F8', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <TrendingUp size={28} style={{ color: regime.label.includes('Bull') ? '#059669' : regime.label.includes('Bear') ? '#DC2626' : '#64748B' }} />
          </div>
          <div>
            <div style={{ fontSize:18, fontWeight:800, color:'#1E293B' }}>{regime.label}</div>
            <div style={{ fontSize:12, color:'#64748B' }}>Confidence: <b>{regime.confidence}%</b></div>
          </div>
        </div>
      </div>

      {/* ═══ Strategy Parameters ═══ */}
      {strategyParameters.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Target size={18} /><span>Strategy Parameters</span></div>
          <Card>
            <div style={{ overflowX:'auto' }}>
              <table className={s.table}>
                <thead><tr>
                  <th>Strategy</th><th>EMA Period</th><th>RSI Threshold</th><th>ATR Multiplier</th>
                  <th>Volume Filter</th><th>Stop ATR</th><th>Target ATR</th><th>Samples</th><th>Current Win %</th>
                </tr></thead>
                <tbody>
                  {strategyParameters.slice(0, 16).map((p: any) => (
                    <tr key={p.strategyId}>
                      <td style={{ fontWeight:700 }}>{p.strategyName}</td>
                      <td>{p.emaPeriod}</td>
                      <td>{p.rsiThreshold}</td>
                      <td>{p.atrMultiplier}</td>
                      <td>
                        {p.volumeFilter}
                        {p.suggestedVolumeFilter !== p.volumeFilter && (
                          <span style={{ color:'#D97706', marginLeft:6 }}>→ {p.suggestedVolumeFilter}</span>
                        )}
                      </td>
                      <td>
                        {p.stopAtr}
                        {p.suggestedStopAtr !== p.stopAtr && (
                          <span style={{ color:'#D97706', marginLeft:6 }}>→ {p.suggestedStopAtr}</span>
                        )}
                      </td>
                      <td>{p.suggestedTargetAtr ?? p.targetAtr}</td>
                      <td>{p.samples}</td>
                      <td style={{ color: p.currentWinRate == null ? '#94A3B8' : wrColor(p.currentWinRate / 100), fontWeight:700 }}>
                        {p.currentWinRate == null ? '—' : `${Number(p.currentWinRate).toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ═══ Confidence Weights ═══ */}
      {confidenceWeights.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Brain size={18} /><span>Confidence Calibration Weights</span></div>
          <div className={s.grid3}>
            {confidenceWeights.map((w: any) => (
              <div key={w.dimension} className={s.recCard}>
                <div className={s.recHeader}>
                  <span className={s.recStrategy}>{w.dimension}</span>
                  <span className={s.recMod} style={{ background: w.impact > 0 ? '#D1FAE5' : w.impact < 0 ? '#FEE2E2' : '#F0F4F8', color: w.impact > 0 ? '#065F46' : w.impact < 0 ? '#991B1B' : '#5A6A7E' }}>
                    {w.currentWeight}% → {w.suggestedWeight}%
                  </span>
                </div>
                <div className={s.recReason}>{w.reason}</div>
                <div className={s.recEvidence}>{w.impact === 0 ? 'No change' : `${w.impact > 0 ? '+' : ''}${w.impact} point adjustment`}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ Before / After Optimization ═══ */}
      {optimizationSummary.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><TrendingUp size={18} /><span>Optimization — Before vs After Calibration</span></div>
          <div className={s.grid4}>
            {optimizationSummary.map((m: any) => (
              <div key={m.metric} className={s.statBox}>
                <div className={s.statLabel}>{m.metric}</div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:10 }}>
                  <span className={s.statValue}>{m.before}{m.unit === '%' ? '%' : m.unit}</span>
                  <span style={{ color:'#94A3B8', fontWeight:800 }}>↓</span>
                  <span className={s.statValue} style={{ color:'#059669' }}>{m.after}{m.unit === '%' ? '%' : m.unit}</span>
                </div>
                <div style={{ fontSize:10, color:'#94A3B8', marginTop:6 }}>{m.note}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ Suggested Improvements ═══ */}
      {suggestedImprovements.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Zap size={18} /><span>Suggested Improvements</span></div>
          <div className={s.grid3}>
            {suggestedImprovements.map((item: any, i: number) => (
              <div key={`${item.strategyId}-${i}`} className={s.recCard}>
                <div className={s.recHeader}>
                  <span className={s.recStrategy}>{item.strategyName}</span>
                  <span className={s.recMod} style={{ background: item.severity === 'high' ? '#FEE2E2' : item.severity === 'medium' ? '#FEF3C7' : '#D1FAE5', color: item.severity === 'high' ? '#991B1B' : item.severity === 'medium' ? '#92400E' : '#065F46' }}>
                    {item.severity}
                  </span>
                </div>
                <div style={{ fontWeight:700, fontSize:12, color:'#1E293B', marginBottom:4 }}>{item.recommendation}</div>
                <div className={s.recReason}>{item.rationale}</div>
                <div className={s.recEvidence}>{item.expectedImpact} · {item.sampleSize} samples</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 3. Visual Analytics — Charts Row ═══ */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:24 }}>
        {/* Return Distribution Histogram */}
        <Card title="Signal Return Distribution">
          <div style={{ height:240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={returnDistribution.map((d: any) => ({ ...d, fill: distColors[d.bucket] ?? '#6B7280' }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="bucket" tick={{ fontSize:10 }} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize:10 }} />
                <Tooltip contentStyle={{ fontSize:11 }} />
                <Bar dataKey="count" fill="#3B82F6" radius={[4,4,0,0]}>
                  {returnDistribution.map((d: any, i: number) => (
                    <Cell key={i} fill={distColors[d.bucket] ?? '#6B7280'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Strategy Win Rate Comparison */}
        <Card title="Strategy Win Rate Comparison">
          <div style={{ height:240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={strategyChartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize:10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize:10 }} width={120} />
                <Tooltip contentStyle={{ fontSize:11 }} formatter={(v: any) => `${v}%`} />
                <ReferenceLine x={50} stroke="#DC2626" strokeDasharray="3 3" label={{ value:'50%', position:'top', fontSize:9, fill:'#DC2626' }} />
                <Bar dataKey="winRate" fill="#3B82F6" radius={[0,4,4,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* ═══ 4. Confidence Calibration Curve ═══ */}
      {calibCurveData.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Brain size={18} /><span>Confidence Calibration Curve</span></div>
          <Card>
            <div style={{ fontSize:11, color:'#64748B', marginBottom:8 }}>
              Ideal: actual hit rate matches confidence score. Deviation = model miscalibration.
            </div>
            <div style={{ height:260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={calibCurveData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis dataKey="confidence" label={{ value: 'Model Confidence', position: 'insideBottom', offset: -5, fontSize:11 }} tick={{ fontSize:10 }} />
                  <YAxis label={{ value: 'Hit Rate %', angle: -90, position: 'insideLeft', fontSize:11 }} tick={{ fontSize:10 }} domain={[0, 100]} />
                  <Tooltip contentStyle={{ fontSize:11 }} />
                  <Legend wrapperStyle={{ fontSize:11 }} />
                  <Line type="monotone" dataKey="expectedHitRate" stroke="#94A3B8" strokeDasharray="5 5" name="Perfect Calibration" dot={false} />
                  <Line type="monotone" dataKey="actualHitRate" stroke="#3B82F6" strokeWidth={2} name="Actual Hit Rate" dot={{ r:4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}

      {/* ═══ 5. Outcome Distribution (existing, enhanced) ═══ */}
      {totalOutcomes > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Target size={18} /><span>Outcome Distribution ({totalOutcomes} signals)</span></div>
          <div className={s.grid4}>
            {outcomeDistribution.map((o: any) => (
              <div key={o.outcome_label} className={s.statBox}>
                <div className={s.statLabel}>{String(o.outcome_label).replace(/_/g, ' ')}</div>
                <div className={s.statValue}>{o.count}</div>
                <div style={{ fontSize:11, color:'#5A6A7E', marginTop:4 }}>
                  pnlR: {Number(o.avg_pnl_r).toFixed(2)} | MFE: {Number(o.avg_mfe).toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ 6. Strategy Performance Table (enhanced) ═══ */}
      <div className={s.section}>
        <div className={s.sectionHead}><Activity size={18} /><span>Strategy Performance</span></div>
        <Card>
          <div style={{ overflowX:'auto' }}>
            <table className={s.table}>
              <thead><tr>
                <th>Strategy</th><th>Regime</th><th>Samples</th>
                <th title="Percentage of signals that hit Target 1">Win Rate</th>
                <th title="Average realized return percentage">Avg Return</th>
                <th title="Profit factor based on normalized wins/losses">PF</th>
                <th title="Maximum Favorable Excursion — best unrealized gain">MFE</th>
                <th title="Maximum Adverse Excursion — worst unrealized loss">MAE</th>
                <th title="Strategy suitability for current market regime">Env Fit</th>
              </tr></thead>
              <tbody>
                {strategyPerformance.slice(0, 20).map((r: any, i: number) => {
                  const wr = Number(r.win_rate);
                  return (
                    <tr key={i}>
                      <td style={{ fontWeight:700 }}>{String(r.strategy_name).replace(/_/g, ' ')}</td>
                      <td>{r.regime}</td>
                      <td>{r.sample_size}</td>
                      <td style={{ color: wrColor(wr), fontWeight:700 }}>{pct(wr)}</td>
                      <td style={{ fontFamily:'monospace', color: Number(r.avg_return_pct ?? r.avg_pnl_r) > 0 ? '#059669' : '#DC2626' }}>{pctPoints(Number(r.avg_return_pct ?? r.avg_pnl_r ?? 0))}</td>
                      <td style={{ fontFamily:'monospace' }}>{Number(r.profit_factor ?? 0).toFixed(2)}</td>
                      <td>{Number(r.avg_mfe).toFixed(3)}</td>
                      <td>{Number(r.avg_mae).toFixed(3)}</td>
                      <td><span className={`${s.envBadge} ${envClass(r.environment_fit)}`}>{r.environment_fit}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {/* ═══ 7. Confidence Calibration Table ═══ */}
      <div className={s.section}>
        <div className={s.sectionHead}><Target size={18} /><span>Confidence Calibration</span></div>
        <Card>
          <table className={s.table}>
            <thead><tr><th>Bucket</th><th>Samples</th><th>T1 Hit Rate</th><th>Avg MFE</th><th>State</th></tr></thead>
            <tbody>
              {confidenceCalibration.map((c: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight:700 }}>{c.bucket}</td>
                  <td>{c.sample_size}</td>
                  <td>{pct(Number(c.target1_hit_rate))}</td>
                  <td>{Number(c.avg_mfe).toFixed(3)}</td>
                  <td><span className={`${s.calibBadge} ${calibClass(c.calibration_state)}`}>{String(c.calibration_state ?? '').replace(/_/g, ' ')}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* ═══ 8. Adaptive Recommendations ═══ */}
      {adaptiveRecommendations.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Zap size={18} /><span>Adaptive Recommendations</span></div>
          <div className={s.grid3}>
            {adaptiveRecommendations.slice(0, 12).map((r: any, i: number) => {
              const mod = Number(r.recommended_modifier);
              return (
                <div key={i} className={s.recCard}>
                  <div className={s.recHeader}>
                    <span className={s.recStrategy}>{r.strategy_name} / {r.regime}</span>
                    <span className={s.recMod} style={{ background: mod > 0 ? '#D1FAE5' : mod < 0 ? '#FEE2E2' : '#F0F4F8', color: mod > 0 ? '#065F46' : mod < 0 ? '#991B1B' : '#5A6A7E' }}>
                      {mod > 0 ? '+' : ''}{mod}
                    </span>
                  </div>
                  <div className={s.recReason}>{r.reason}</div>
                  <div className={s.recEvidence}>{r.evidence_strength} evidence ({r.sample_size} samples)</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ 9. News Calibration ═══ */}
      {newsCalibration.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionHead}><Newspaper size={18} /><span>News Calibration</span></div>
          <Card>
            <table className={s.table}>
              <thead><tr><th>Dimension</th><th>Value</th><th>Samples</th><th>Win Rate</th><th>Avg pnlR</th><th>State</th></tr></thead>
              <tbody>
                {newsCalibration.map((c: any, i: number) => (
                  <tr key={i}>
                    <td style={{ fontWeight:700 }}>{c.dimension}</td>
                    <td>{c.dimension_value}</td>
                    <td>{c.sample_size}</td>
                    <td style={{ color: wrColor(Number(c.win_rate)) }}>{pct(Number(c.win_rate))}</td>
                    <td style={{ fontFamily:'monospace' }}>{Number(c.avg_pnl_r).toFixed(3)}</td>
                    <td><span className={`${s.calibBadge} ${calibClass(c.calibration_state)}`}>{String(c.calibration_state ?? '').replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {/* ═══ 10. Learning Job Runs (enhanced) ═══ */}
      <div className={s.section}>
        <div className={s.sectionHead}><Clock size={18} /><span>Recent Learning Job Runs</span></div>
        <Card>
          <table className={s.table}>
            <thead><tr>
              <th>Job Name</th><th>Status</th><th>Execution Time</th><th>Last Run</th>
            </tr></thead>
            <tbody>
              {learningJobRuns.slice(0, 20).map((j: any, i: number) => (
                <tr key={i}>
                  <td style={{ fontWeight:700 }}>{j.job_name}</td>
                  <td>
                    <span style={{
                      display:'inline-block', padding:'2px 8px', borderRadius:12, fontSize:10, fontWeight:700, textTransform:'uppercase',
                      background: j.status === 'success' ? '#D1FAE5' : j.status === 'running' ? '#FFFBEB' : '#FEE2E2',
                      color: j.status === 'success' ? '#065F46' : j.status === 'running' ? '#92400E' : '#991B1B',
                    }}>
                      {j.status}
                    </span>
                  </td>
                  <td style={{ fontFamily:'monospace', fontSize:12 }}>{j.duration_ms}ms</td>
                  <td style={{ fontSize:12, color:'#64748B' }}>{new Date(j.run_at).toLocaleString()}</td>
                </tr>
              ))}
              {learningJobRuns.length === 0 && (
                <tr><td colSpan={4} style={{ padding:24, textAlign:'center', color:'#94A3B8', fontSize:12 }}>No job runs recorded yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
