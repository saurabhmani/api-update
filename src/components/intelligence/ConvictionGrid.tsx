'use client';
import { useMemo, useState } from 'react';
import { Target, TrendingUp, Eye, XCircle, ArrowUpRight, ArrowDownRight } from 'lucide-react';

/* ─── Band config ─────────────────────────────────────────────── */
const BANDS = [
  { key: 'high_conviction', label: 'High Conviction', short: 'HC', range: '85–100', color: '#059669', dark: '#065F46', light: '#D1FAE5', surface: '#F0FDF4', grad: 'linear-gradient(135deg, #059669, #34D399)', icon: Target, dots: 4 },
  { key: 'actionable',      label: 'Actionable',      short: 'ACT', range: '70–84',  color: '#2563EB', dark: '#1D4ED8', light: '#DBEAFE', surface: '#EFF6FF', grad: 'linear-gradient(135deg, #2563EB, #60A5FA)', icon: TrendingUp, dots: 3 },
  { key: 'watchlist',        label: 'Watchlist',        short: 'WL',  range: '55–69',  color: '#D97706', dark: '#92400E', light: '#FEF3C7', surface: '#FFFBEB', grad: 'linear-gradient(135deg, #D97706, #FBBF24)', icon: Eye,        dots: 2 },
  { key: 'reject',           label: 'Filtered',         short: 'FLT', range: '<55',    color: '#94A3B8', dark: '#64748B', light: '#F1F5F9', surface: '#F8FAFC', grad: 'linear-gradient(135deg, #94A3B8, #CBD5E1)', icon: XCircle,    dots: 1 },
] as const;

/* ─── Types ───────────────────────────────────────────────────── */
interface Signal {
  tradingsymbol?: string; symbol?: string; direction?: string;
  confidence_score?: number; confidence?: number;
  conviction_band?: string | null; risk_reward?: number | null;
}

interface Props {
  convictionDistribution: Record<string, number>;
  signals?: Signal[];
  total: number;
  loading?: boolean;
}

/* ─── Component ───────────────────────────────────────────────── */
export default function ConvictionGrid({ convictionDistribution: dist, signals = [], total, loading }: Props) {
  const [active, setActive] = useState<string | null>(null);

  const bandData = useMemo(() => {
    const grouped: Record<string, Signal[]> = { high_conviction: [], actionable: [], watchlist: [], reject: [] };
    for (const s of signals) {
      const k = (s.conviction_band ?? 'reject').toLowerCase().replace(/\s+/g, '_');
      (grouped[k] ?? grouped.reject).push(s);
    }
    return BANDS.map(b => {
      const count = dist[b.key] ?? 0;
      const sigs = grouped[b.key] ?? [];
      const avgConf = sigs.length > 0 ? Math.round(sigs.reduce((s, v) => s + (v.confidence_score ?? v.confidence ?? 0), 0) / sigs.length) : 0;
      const buys = sigs.filter(s => s.direction === 'BUY').length;
      const sells = sigs.filter(s => s.direction === 'SELL').length;
      return { ...b, count, pct: total > 0 ? (count / total) * 100 : 0, avgConf, sigs, buys, sells };
    });
  }, [dist, signals, total]);

  const actionable = bandData[0].count + bandData[1].count;

  if (loading) {
    return (
      <div style={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(11,31,58,0.06)' }}>
        <div style={{ height: 14, width: 200, background: '#F1F5F9', borderRadius: 6, marginBottom: 16 }} />
        <div style={{ height: 40, background: '#F8FAFC', borderRadius: 10, marginBottom: 12 }} />
        <div style={{ display: 'flex', gap: 10 }}>
          {[1,2,3,4].map(i => <div key={i} style={{ flex: 1, height: 60, background: '#F8FAFC', borderRadius: 8 }} />)}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 12,
      boxShadow: '0 1px 3px rgba(11,31,58,0.06)', overflow: 'hidden',
    }}>
      {/* ══ TOP: Proportional distribution slider ══════════════ */}
      <div style={{ padding: '16px 18px 0' }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: 'linear-gradient(135deg, #0B1F3A, #1A3A6B)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Target size={12} color="#00C9FF" />
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, background: 'linear-gradient(135deg, #2563EB, #06B6D4)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Conviction Distribution
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 11, color: '#94A3B8' }}>{total} signals</span>
            <div style={{ background: '#D1FAE5', color: '#065F46', fontSize: 10, fontWeight: 700, padding: '3px 9px', borderRadius: 99 }}>
              {actionable} actionable
            </div>
          </div>
        </div>

        {/* ── THE SLIDER: Proportional stacked bar ─────────── */}
        <div style={{
          display: 'flex', height: 38, borderRadius: 10, overflow: 'hidden',
          background: '#F1F5F9', border: '1px solid #E2E8F0',
          cursor: 'pointer',
        }}>
          {bandData.map(b => {
            if (b.pct <= 0) return null;
            const isActive = active === b.key;
            return (
              <div
                key={b.key}
                onMouseEnter={() => setActive(b.key)}
                onMouseLeave={() => setActive(null)}
                style={{
                  width: `${Math.max(b.pct, 4)}%`,
                  background: isActive ? b.grad : b.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.25s ease',
                  position: 'relative',
                  transform: isActive ? 'scaleY(1.08)' : 'scaleY(1)',
                  zIndex: isActive ? 2 : 1,
                  borderRadius: isActive ? 4 : 0,
                  gap: 4,
                  overflow: 'hidden',
                  minWidth: 28,
                }}
              >
                <span style={{
                  fontSize: b.pct > 15 ? 13 : 10, fontWeight: 800, color: '#FFFFFF',
                  textShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  whiteSpace: 'nowrap',
                }}>
                  {b.count}
                </span>
                {b.pct > 20 && (
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.75)', fontWeight: 600 }}>
                    {Math.round(b.pct)}%
                  </span>
                )}
              </div>
            );
          })}
          {total === 0 && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#94A3B8' }}>
              No data
            </div>
          )}
        </div>

        {/* ── Legend dots under slider ─────────────────────── */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 8, marginBottom: 4 }}>
          {bandData.map(b => (
            <div
              key={b.key}
              onMouseEnter={() => setActive(b.key)}
              onMouseLeave={() => setActive(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                opacity: active && active !== b.key ? 0.4 : 1, transition: 'opacity 0.2s',
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: 2, background: b.color }} />
              <span style={{ fontSize: 10, fontWeight: 600, color: b.dark }}>{b.short}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ══ BOTTOM: Flex data strip ═══════════════════════════ */}
      <div style={{
        display: 'flex', borderTop: '1px solid #F1F5F9',
      }}>
        {bandData.map((b, i) => {
          const isActive = active === b.key;
          const Icon = b.icon;
          return (
            <div
              key={b.key}
              onMouseEnter={() => setActive(b.key)}
              onMouseLeave={() => setActive(null)}
              style={{
                flex: 1,
                padding: '14px 12px 14px',
                borderRight: i < 3 ? '1px solid #F1F5F9' : 'none',
                background: isActive ? b.surface : '#FFFFFF',
                transition: 'all 0.2s ease',
                cursor: 'default',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {/* Active indicator line */}
              {isActive && (
                <div style={{
                  position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                  background: b.grad,
                }} />
              )}

              {/* Row 1: Icon + Label */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <div style={{
                  width: 26, height: 26, borderRadius: 7,
                  background: isActive ? b.grad : b.light,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.2s',
                }}>
                  <Icon size={12} color={isActive ? '#FFF' : b.color} />
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: b.dark, lineHeight: 1.1 }}>{b.label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    {[1,2,3,4].map(d => (
                      <div key={d} style={{ width: 5, height: 5, borderRadius: '50%', background: d <= b.dots ? b.color : `${b.color}20` }} />
                    ))}
                    <span style={{ fontSize: 8, color: '#94A3B8', marginLeft: 2 }}>{b.range}</span>
                  </div>
                </div>
              </div>

              {/* Row 2: Big count + percentage */}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 6 }}>
                <span style={{
                  fontSize: 24, fontWeight: 800, color: b.count > 0 ? b.dark : '#CBD5E1',
                  lineHeight: 1, fontVariantNumeric: 'tabular-nums',
                }}>
                  {b.count}
                </span>
                <span style={{ fontSize: 11, color: b.count > 0 ? b.color : '#CBD5E1', fontWeight: 600 }}>
                  {Math.round(b.pct)}%
                </span>
              </div>

              {/* Row 3: Mini progress bar */}
              <div style={{
                height: 4, borderRadius: 99, background: `${b.color}12`, overflow: 'hidden', marginBottom: 8,
              }}>
                <div style={{
                  height: '100%', width: `${b.pct}%`, borderRadius: 99,
                  background: b.grad, transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1)',
                }} />
              </div>

              {/* Row 4: Stats */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {b.avgConf > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: b.dark,
                    background: b.light, padding: '2px 6px', borderRadius: 4,
                  }}>
                    avg {b.avgConf}%
                  </span>
                )}
                {b.buys > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: '#15803D',
                    background: '#DCFCE7', padding: '2px 6px', borderRadius: 4,
                    display: 'inline-flex', alignItems: 'center', gap: 2,
                  }}>
                    <ArrowUpRight size={8} /> {b.buys}
                  </span>
                )}
                {b.sells > 0 && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, color: '#DC2626',
                    background: '#FEE2E2', padding: '2px 6px', borderRadius: 4,
                    display: 'inline-flex', alignItems: 'center', gap: 2,
                  }}>
                    <ArrowDownRight size={8} /> {b.sells}
                  </span>
                )}
                {b.count === 0 && (
                  <span style={{ fontSize: 9, color: '#CBD5E1', fontStyle: 'italic' }}>none</span>
                )}
              </div>

              {/* Row 5: Top symbols preview (only when hovered) */}
              {isActive && b.sigs.length > 0 && (
                <div style={{
                  marginTop: 8, paddingTop: 8,
                  borderTop: `1px solid ${b.color}15`,
                  display: 'flex', flexDirection: 'column', gap: 3,
                }}>
                  {b.sigs.slice(0, 3).map((s, j) => {
                    const sym = s.tradingsymbol || s.symbol || '—';
                    const conf = s.confidence_score ?? s.confidence ?? 0;
                    return (
                      <div key={j} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        fontSize: 10, padding: '2px 0',
                      }}>
                        <span style={{ fontWeight: 700, color: '#0F172A' }}>{sym}</span>
                        <span style={{ fontWeight: 700, color: b.color, fontVariantNumeric: 'tabular-nums' }}>{conf}%</span>
                      </div>
                    );
                  })}
                  {b.sigs.length > 3 && (
                    <span style={{ fontSize: 9, color: '#94A3B8', textAlign: 'center' }}>+{b.sigs.length - 3} more</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
