'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt } from '@/lib/utils';
import { Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { ProductASignalCard } from '@/components/signals/ProductASignalCard';
import { buildProductASignalCard } from '@/lib/signals/productASignalContract';
import '@/styles/components/_intelligence.scss';

function SignalChip({ dir }: { dir: string }) {
  return <span className={`signal-chip signal-chip--${dir}`}>{dir}</span>;
}

async function postManualAction(body: Record<string, unknown>) {
  const res = await fetch('/api/signals/manual-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

export default function SignalDetailPage() {
  const { key }            = useParams<{ key: string }>();
  const symbol             = decodeURIComponent(key).toUpperCase();
  const [signal, setSignal] = useState<any>(null);
  const [loading, setLoad]  = useState(true);
  const [showLegacy, setShowLegacy] = useState(false);

  useEffect(() => {
    fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(symbol)}`)
      .then(r => r.json())
      .then(d => setSignal(d.signal))
      .finally(() => setLoad(false));
  }, [symbol]);

  const productCard = useMemo(() => {
    if (!signal) return null;
    if (signal.product_a) return signal.product_a;
    return buildProductASignalCard({
      id: signal.id,
      symbol: signal.tradingsymbol ?? signal.symbol ?? symbol,
      direction: signal.direction,
      strategy: signal.strategy ?? signal.signal_type,
      confidence_score: signal.confidence_score ?? signal.confidence,
      final_score: signal.final_score,
      institutional_score: signal.institutional_score,
      maturity_score: signal.maturity_score,
      entry_price: signal.entry_price,
      stop_loss: signal.stop_loss,
      target1: signal.target1,
      target2: signal.target2,
      target3: signal.target3,
      risk_reward: signal.risk_reward,
      livePrice: signal.livePrice ?? signal.ltp,
      status: signal.status,
      signal_status: signal.signal_status,
      classification: signal.classification,
      execution_allowed: signal.execution_allowed,
      live_invalidated: signal.live_invalidated,
      invalidation_reason: signal.invalidation_reason,
      rejection_reason: signal.rejection_reason ?? signal.demotionReason,
      generated_at: signal.generated_at,
      confirmed_at: signal.confirmed_at,
      valid_until: signal.valid_until,
      regime: signal.regime ?? signal.market_regime,
      sector: signal.sector,
      explanation: signal.explanation,
      audit_snapshot_id: signal.id,
      is_elite: String(signal.classification ?? '').includes('INSTITUTIONAL')
        || String(signal.classification ?? '') === 'HIGH_CONVICTION',
    });
  }, [signal, symbol]);

  const onAddToWatchlist = useCallback(async (sym: string) => {
    await postManualAction({ action: 'add_to_watchlist', symbol: sym });
  }, []);

  const onCreateAlert = useCallback(async (payload: {
    symbol: string;
    kind: 'entry_valid' | 'expire_or_invalidate';
    targetPrice?: number | null;
  }) => {
    await postManualAction({
      action: payload.kind === 'entry_valid' ? 'alert_entry_valid' : 'alert_expire_or_invalidate',
      symbol: payload.symbol,
      target_price: payload.targetPrice,
    });
  }, []);

  const onJournal = useCallback(async (payload: { symbol: string; signalId: number | null; note: string }) => {
    if (!payload.note.trim()) return;
    await postManualAction({
      action: 'manual_trade_journal',
      symbol: payload.symbol,
      signalId: payload.signalId,
      note: payload.note,
    });
  }, []);

  return (
    <AppShell title={`Signal: ${symbol}`}>
      <div className="page">
        <div className="page__header">
          <div>
            <h1>{symbol}</h1>
            <p>Product A — manual signal experience</p>
          </div>
        </div>

        {loading ? <Loading /> : !signal ? (
          <Empty icon={Zap} title="Signal unavailable" description="Could not fetch data for this symbol. Check the symbol or try again." />
        ) : (
          <div style={{ display: 'grid', gap: 20 }}>
            {productCard && (
              <ProductASignalCard
                card={productCard}
                onAddToWatchlist={onAddToWatchlist}
                onCreateAlert={onCreateAlert}
                onJournal={onJournal}
              />
            )}

            <button
              type="button"
              onClick={() => setShowLegacy((v) => !v)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'transparent', border: 'none', color: '#64748B',
                fontSize: 12, cursor: 'pointer', padding: 0, width: 'fit-content',
              }}
            >
              {showLegacy ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {showLegacy ? 'Hide legacy detail' : 'Show legacy detail'}
            </button>

            {showLegacy && (
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

              <div style={{ marginBottom: 20 }}>
                <div className="confidence-bar__track" style={{ height: 10 }}>
                  <div
                    className={`confidence-bar__fill confidence-bar__fill--${signal.confidence >= 70 ? 'high' : signal.confidence >= 50 ? 'medium' : 'low'}`}
                    style={{ width: `${signal.confidence}%` }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                {[
                  { label: 'Entry', value: signal.entry_price, color: '#1E3A5F' },
                  { label: 'Stop Loss', value: signal.stop_loss, color: '#DC2626' },
                  { label: 'Target 1', value: signal.target1, color: '#16A34A' },
                  { label: 'Target 2', value: signal.target2, color: '#059669' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: '#F8FAFC', borderRadius: 10, padding: '14px 16px', textAlign: 'center', border: '1px solid #E2E8F0' }}>
                    <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 6 }}>{label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color }}>{fmt.number(value)}</div>
                  </div>
                ))}
              </div>
            </Card>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
