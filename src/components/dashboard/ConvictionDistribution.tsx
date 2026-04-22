'use client';
import { useMemo } from 'react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip,
} from 'recharts';
import { Target, TrendingUp, Eye, XCircle } from 'lucide-react';

// ── Conviction band configuration ────────────────────────────
const BANDS = [
  {
    key: 'high_conviction',
    label: 'High Conviction',
    color: '#059669',
    lightBg: '#D1FAE5',
    textColor: '#065F46',
    gradient: 'linear-gradient(135deg, #059669, #10B981)',
    icon: Target,
    dots: '\u25CF\u25CF\u25CF\u25CF',
    description: 'Strongest setups — full-size position eligible',
  },
  {
    key: 'actionable',
    label: 'Actionable',
    color: '#2563EB',
    lightBg: '#DBEAFE',
    textColor: '#1D4ED8',
    gradient: 'linear-gradient(135deg, #2563EB, #3B82F6)',
    icon: TrendingUp,
    dots: '\u25CF\u25CF\u25CF\u25CB',
    description: 'Solid setups — standard sizing with confirmation',
  },
  {
    key: 'watchlist',
    label: 'Watchlist',
    color: '#D97706',
    lightBg: '#FEF3C7',
    textColor: '#92400E',
    gradient: 'linear-gradient(135deg, #D97706, #F59E0B)',
    icon: Eye,
    dots: '\u25CF\u25CF\u25CB\u25CB',
    description: 'Monitor only — not yet ready for deployment',
  },
  {
    key: 'reject',
    label: 'Below Threshold',
    color: '#94A3B8',
    lightBg: '#F1F5F9',
    textColor: '#64748B',
    gradient: 'linear-gradient(135deg, #94A3B8, #CBD5E1)',
    icon: XCircle,
    dots: '\u25CF\u25CB\u25CB\u25CB',
    description: 'Filtered out — insufficient quality',
  },
] as const;

// ── Types ────────────────────────────────────────────────────
interface ConvictionDistributionProps {
  signals: Array<{
    conviction_band?: string | null;
    confidence_score?: number | null;
    confidence?: number | null;
  }>;
  loading?: boolean;
  totalScanned?: number;
}

// ── Custom tooltip ───────────────────────────────────────────
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #E2E8F0',
      borderRadius: 10,
      padding: '10px 14px',
      boxShadow: '0 4px 16px rgba(11,31,58,0.12)',
      minWidth: 140,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ width: 10, height: 10, borderRadius: 3, background: d.color }} />
        <span style={{ fontWeight: 700, fontSize: 13, color: '#0B1120' }}>{d.label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: d.color }}>{d.count}</div>
      <div style={{ fontSize: 11, color: '#64748B' }}>{d.pct}% of signals</div>
    </div>
  );
}

// ── Center label for donut ───────────────────────────────────
function CenterLabel({ total, actionable }: { total: number; actionable: number }) {
  return (
    <div style={{
      position: 'absolute',
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      textAlign: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: '#0B1120', lineHeight: 1 }}>{total}</div>
      <div style={{ fontSize: 10, color: '#64748B', fontWeight: 600, marginTop: 2, letterSpacing: 0.5 }}>SIGNALS</div>
      <div style={{
        fontSize: 10, fontWeight: 700, marginTop: 6,
        color: '#059669', background: '#D1FAE5',
        padding: '2px 8px', borderRadius: 99,
      }}>
        {actionable} actionable
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────
export default function ConvictionDistribution({ signals, loading, totalScanned }: ConvictionDistributionProps) {
  const distribution = useMemo(() => {
    const counts: Record<string, number> = { high_conviction: 0, actionable: 0, watchlist: 0, reject: 0 };
    const confidences: Record<string, number[]> = { high_conviction: [], actionable: [], watchlist: [], reject: [] };

    for (const s of signals) {
      const band = s.conviction_band ?? 'reject';
      const key = band.toLowerCase().replace(/\s+/g, '_');
      const conf = s.confidence_score ?? s.confidence ?? 0;

      if (key in counts) {
        counts[key]++;
        confidences[key].push(conf);
      } else {
        counts.reject++;
        confidences.reject.push(conf);
      }
    }

    const total = signals.length;
    return BANDS.map((b) => ({
      ...b,
      count: counts[b.key] || 0,
      pct: total > 0 ? Math.round(((counts[b.key] || 0) / total) * 100) : 0,
      avgConf: confidences[b.key]?.length > 0
        ? Math.round(confidences[b.key].reduce((s, v) => s + v, 0) / confidences[b.key].length)
        : 0,
    }));
  }, [signals]);

  const total = signals.length;
  const actionableCount = distribution[0].count + distribution[1].count;
  const chartData = distribution.filter((d) => d.count > 0);

  // Skeleton loader
  if (loading) {
    return (
      <div style={{
        background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 12,
        padding: 24, boxShadow: '0 1px 3px rgba(11,31,58,0.08)',
      }}>
        <div style={{ height: 16, width: 180, background: '#E2E8F0', borderRadius: 6, marginBottom: 20 }} />
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <div style={{ width: 200, height: 200, borderRadius: '50%', background: '#F1F5F9' }} />
          <div style={{ flex: 1 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} style={{ height: 48, background: '#F8FAFC', borderRadius: 8, marginBottom: 8 }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #E2E8F0',
      borderRadius: 12,
      boxShadow: '0 1px 3px rgba(11,31,58,0.08)',
      overflow: 'hidden',
      transition: 'box-shadow 0.2s, border-color 0.2s',
    }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(0,201,255,0.18), 0 4px 16px rgba(0,201,255,0.12)';
        e.currentTarget.style.borderColor = '#06B6D4';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(11,31,58,0.08)';
        e.currentTarget.style.borderColor = '#E2E8F0';
      }}
    >
      {/* ── Header ──────────────────────────────────────────── */}
      <div style={{
        padding: '16px 20px 12px',
        borderBottom: '1px solid #F1F5F9',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 8,
            background: 'linear-gradient(135deg, #0B1F3A, #1A3A6B)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Target size={14} color="#00C9FF" />
          </div>
          <div>
            <h3 style={{
              margin: 0, fontSize: 14, fontWeight: 700,
              background: 'linear-gradient(135deg, #2563EB, #06B6D4)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>
              Conviction Distribution
            </h3>
            <p style={{ margin: 0, fontSize: 10, color: '#94A3B8', fontWeight: 500 }}>
              Signal quality breakdown
              {totalScanned ? ` \u00B7 ${totalScanned} scanned` : ''}
            </p>
          </div>
        </div>
        {actionableCount > 0 && (
          <div style={{
            background: '#D1FAE5', color: '#065F46',
            fontSize: 11, fontWeight: 700,
            padding: '4px 10px', borderRadius: 99,
          }}>
            {actionableCount} ready
          </div>
        )}
      </div>

      {/* ── Body ────────────────────────────────────────────── */}
      <div style={{ padding: '16px 20px 20px' }}>
        {total === 0 ? (
          <div style={{
            textAlign: 'center', padding: '32px 0',
            color: '#94A3B8', fontSize: 13,
          }}>
            No signals generated yet. Run the signal engine to see conviction distribution.
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: '200px 1fr',
            gap: 24,
            alignItems: 'center',
          }}>
            {/* ── Donut Chart ────────────────────────────────── */}
            <div style={{ position: 'relative', width: 200, height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={62}
                    outerRadius={88}
                    paddingAngle={3}
                    dataKey="count"
                    startAngle={90}
                    endAngle={-270}
                    stroke="none"
                  >
                    {chartData.map((d) => (
                      <Cell
                        key={d.key}
                        fill={d.color}
                        style={{
                          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.1))',
                          cursor: 'pointer',
                        }}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <CenterLabel total={total} actionable={actionableCount} />
            </div>

            {/* ── Breakdown Bars ─────────────────────────────── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {distribution.map((d) => {
                const Icon = d.icon;
                return (
                  <div
                    key={d.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: d.count > 0 ? d.lightBg : '#FAFBFC',
                      border: `1px solid ${d.count > 0 ? d.color + '20' : '#F1F5F9'}`,
                      transition: 'all 0.2s',
                      cursor: 'default',
                      opacity: d.count > 0 ? 1 : 0.5,
                    }}
                    onMouseEnter={(e) => {
                      if (d.count > 0) {
                        e.currentTarget.style.transform = 'translateX(2px)';
                        e.currentTarget.style.boxShadow = `0 2px 8px ${d.color}20`;
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'none';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Icon */}
                    <div style={{
                      width: 32, height: 32, borderRadius: 8,
                      background: d.count > 0 ? d.gradient : '#E2E8F0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Icon size={14} color="#FFFFFF" />
                    </div>

                    {/* Label + bar */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        alignItems: 'center', marginBottom: 4,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            fontSize: 12, fontWeight: 700,
                            color: d.count > 0 ? d.textColor : '#94A3B8',
                          }}>
                            {d.label}
                          </span>
                          <span style={{
                            fontSize: 9, fontWeight: 600,
                            color: d.count > 0 ? d.textColor : '#CBD5E1',
                            opacity: 0.7,
                          }}>
                            {d.dots}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                          <span style={{
                            fontSize: 16, fontWeight: 800,
                            color: d.count > 0 ? d.textColor : '#CBD5E1',
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {d.count}
                          </span>
                          <span style={{ fontSize: 10, color: '#94A3B8' }}>
                            ({d.pct}%)
                          </span>
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div style={{
                        height: 6, borderRadius: 99,
                        background: d.count > 0 ? `${d.color}15` : '#F1F5F9',
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          height: '100%',
                          width: `${d.pct}%`,
                          borderRadius: 99,
                          background: d.count > 0 ? d.gradient : '#E2E8F0',
                          transition: 'width 0.8s cubic-bezier(0.4, 0, 0.2, 1)',
                        }} />
                      </div>

                      {/* Description + avg confidence */}
                      <div style={{
                        display: 'flex', justifyContent: 'space-between',
                        marginTop: 3, fontSize: 10, color: '#94A3B8',
                      }}>
                        <span>{d.description}</span>
                        {d.count > 0 && d.avgConf > 0 && (
                          <span style={{ fontWeight: 600, color: d.textColor }}>
                            avg {d.avgConf}%
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Bottom Stats Row ─────────────────────────────── */}
        {total > 0 && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 10,
            marginTop: 16,
            paddingTop: 16,
            borderTop: '1px solid #F1F5F9',
          }}>
            {[
              { label: 'Hit Rate', value: actionableCount > 0 ? `${Math.round((actionableCount / total) * 100)}%` : '0%', color: '#059669', bg: '#F0FDF4' },
              { label: 'Avg Confidence', value: `${Math.round(signals.reduce((s, v) => s + (v.confidence_score ?? v.confidence ?? 0), 0) / total)}%`, color: '#2563EB', bg: '#EFF6FF' },
              { label: 'High Conviction', value: `${distribution[0].count}`, color: '#065F46', bg: '#D1FAE5' },
              { label: 'Filtered Out', value: `${distribution[3].count}`, color: '#64748B', bg: '#F8FAFC' },
            ].map((stat) => (
              <div key={stat.label} style={{
                background: stat.bg,
                borderRadius: 8,
                padding: '8px 10px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  {stat.label}
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: stat.color, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                  {stat.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
