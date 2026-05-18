'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt } from '@/lib/utils';
import { Zap, ChevronDown, ChevronUp } from 'lucide-react';
import '@/styles/components/_intelligence.scss';

function SignalChip({ dir }: { dir: string }) {
  return <span className={`signal-chip signal-chip--${dir}`}>{dir}</span>;
}

export default function SignalDetailPage() {
  const { key }            = useParams<{ key: string }>();
  const symbol             = decodeURIComponent(key).toUpperCase();
  const [signal, setSignal] = useState<any>(null);
  const [loading, setLoad]  = useState(true);

  useEffect(() => {
    fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(symbol)}`)
      .then(r => r.json())
      .then(d => setSignal(d.signal))
      .finally(() => setLoad(false));
  }, [symbol]);

  return (
    <AppShell title={`Signal: ${symbol}`}>
      <div className="page">
        <div className="page__header">
          <div>
            <h1>{symbol}</h1>
            <p>Live signal analysis</p>
          </div>
        </div>

        {loading ? <Loading /> : !signal ? (
          <Empty icon={Zap} title="Signal unavailable" description="Could not fetch data for this symbol. Check the symbol or try again." />
        ) : (
          <div style={{ display: 'grid', gap: 20 }}>

            {/* Hero */}
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#1E3A5F' }}>{signal.tradingsymbol}</div>
                  <div style={{ fontSize: 13, color: '#64748B' }}>{signal.exchange} · {signal.timeframe}</div>
                </div>
                <SignalChip dir={signal.direction} />
                <Badge variant={signal.risk === 'High' ? 'red' : signal.risk === 'Low' ? 'green' : 'orange'}>
                  {signal.risk} Risk
                </Badge>
                <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <div style={{ fontSize: 13, color: '#94A3B8' }}>Confidence</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: signal.confidence >= 70 ? '#16A34A' : signal.confidence >= 50 ? '#D97706' : '#DC2626' }}>
                    {signal.confidence}%
                  </div>
                </div>
              </div>

              {/* Confidence bar */}
              <div style={{ marginBottom: 20 }}>
                <div className="confidence-bar__track" style={{ height: 10 }}>
                  <div
                    className={`confidence-bar__fill confidence-bar__fill--${signal.confidence >= 70 ? 'high' : signal.confidence >= 50 ? 'medium' : 'low'}`}
                    style={{ width: `${signal.confidence}%` }}
                  />
                </div>
              </div>

              {/* Levels */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                {[
                  { label: 'Entry', value: signal.entry_price, color: '#1E3A5F' },
                  { label: 'Stop Loss', value: signal.stop_loss, color: '#DC2626' },
                  { label: 'Target 1', value: signal.target1, color: '#16A34A' },
                  { label: 'Target 2', value: signal.target2, color: '#059669' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: '#F8FAFC', borderRadius: 10, padding: '14px 16px', textAlign: 'center', border: '1px solid #E2E8F0' }}>
                    <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color }}>{fmt.currency(value)}</div>
                  </div>
                ))}
              </div>

              {signal.risk_reward && (
                <div style={{ marginTop: 14, fontSize: 13, color: '#64748B', textAlign: 'center' }}>
                  Risk / Reward Ratio: <strong style={{ color: '#0F172A' }}>1:{signal.risk_reward}</strong>
                </div>
              )}
            </Card>

            {/* Institutional decision panel — only renders when the
                final-decision gate adjusted the row (Phase 3 + 5 + 6).
                Demotion-only, so when shown it always communicates a
                stricter status than the raw classification. */}
            {signal.decisionChanged === true && (
              <Card title="Institutional decision">
                <div style={{ display: 'grid', gap: 10, fontSize: 13, color: '#334155' }}>
                  <div>
                    <strong style={{ color: '#0F172A' }}>Decision adjusted by institutional risk gate.</strong>
                    {signal.demotionReason ? (
                      <div style={{ marginTop: 4, color: '#64748B' }}>{signal.demotionReason}</div>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>Raw status</div>
                      <div style={{ fontWeight: 700, color: '#475569' }}>{signal.rawApprovalStatus ?? '—'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>Effective status</div>
                      <div style={{ fontWeight: 700, color: '#92400E' }}>{signal.effectiveApprovalStatus ?? '—'}</div>
                    </div>
                  </div>
                  {Array.isArray(signal.institutionalBlockers) && signal.institutionalBlockers.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 4 }}>Blockers</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {signal.institutionalBlockers.map((b: string, i: number) => (
                          <li key={i} style={{ color: '#475569' }}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(signal.institutionalWarnings) && signal.institutionalWarnings.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 4 }}>Warnings</div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {signal.institutionalWarnings.map((w: string, i: number) => (
                          <li key={i} style={{ color: '#64748B' }}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(signal.decisionTrace) && signal.decisionTrace.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12, color: '#64748B' }}>Decision trace ({signal.decisionTrace.length})</summary>
                      <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: '#475569' }}>
                        {signal.decisionTrace.map((t: any, i: number) => (
                          <li key={i}>
                            <span style={{ color: '#94A3B8', fontWeight: 600 }}>{t.layer}</span>
                            {' — '}
                            <span>{t.reason}</span>
                            {t.severity ? <span style={{ marginLeft: 6, color: t.severity === 'blocker' ? '#DC2626' : t.severity === 'warning' ? '#D97706' : '#94A3B8', fontSize: 11 }}>({t.severity})</span> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </Card>
            )}

            {/* Reasons */}
            <Card title="Why this signal?">
              {signal.reasons?.length ? signal.reasons.map((r: any) => (
                <div key={r.key} className="reason-item">
                  <div className={`reason-item__dot reason-item__dot--${r.score > 0 ? 'positive' : r.score < 0 ? 'negative' : 'neutral'}`} />
                  <div style={{ flex: 1 }}>
                    <div className="reason-item__label">{r.label}</div>
                    <div className="reason-item__desc">{r.description}</div>
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: r.score > 0 ? '#16A34A' : r.score < 0 ? '#DC2626' : '#94A3B8' }}>
                    {r.score > 0 ? '+' : ''}{(r.score * 100).toFixed(0)}
                  </div>
                </div>
              )) : <p style={{ color: '#94A3B8', fontSize: 14 }}>No detailed reasons available.</p>}
            </Card>

            {/* Disclaimer */}
            <div style={{ background: '#FEF9E7', border: '1px solid #FDE68A', borderRadius: 10, padding: '12px 16px', fontSize: 12, color: '#92400E' }}>
              ⚠️ Signals are generated by rule-based algorithms using public market data. They are for informational purposes only and do not constitute financial advice. Always do your own research and manage risk carefully.
            </div>

          </div>
        )}
      </div>
    </AppShell>
  );
}
