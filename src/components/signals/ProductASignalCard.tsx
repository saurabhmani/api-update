'use client';
// ════════════════════════════════════════════════════════════════
//  Phase 9 — Product A Manual Signal Card
//
//  Subscriber-facing presentation of the canonical contract.
//  No broker order button. Manual actions only.
// ════════════════════════════════════════════════════════════════

import { useMemo, useState } from 'react';
import type { ProductASignalCard as CardModel } from '@/lib/signals/productASignalContract';
import {
  computeManualPositionSizing,
  formatTradePlanCopy,
} from '@/lib/signals/manualExecutionSupport';

const STATE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  elite:       { bg: '#ECFDF5', color: '#047857', label: 'Elite' },
  actionable:  { bg: '#EFF6FF', color: '#1D4ED8', label: 'Actionable' },
  watchlist:   { bg: '#FFFBEB', color: '#B45309', label: 'Watchlist' },
  expired:     { bg: '#F1F5F9', color: '#64748B', label: 'Expired' },
  invalidated: { bg: '#FEF2F2', color: '#B91C1C', label: 'Invalidated' },
};

function fmt(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export interface ProductASignalCardProps {
  card: CardModel;
  /** Optional live capital for illustrative sizing. */
  defaultCapital?: number;
  onAddToWatchlist?: (symbol: string) => void | Promise<void>;
  onCreateAlert?: (payload: {
    symbol: string;
    kind: 'entry_valid' | 'expire_or_invalidate';
    targetPrice?: number | null;
  }) => void | Promise<void>;
  onJournal?: (payload: { symbol: string; signalId: number | null; note: string }) => void | Promise<void>;
}

export function ProductASignalCard({
  card,
  defaultCapital = 100_000,
  onAddToWatchlist,
  onCreateAlert,
  onJournal,
}: ProductASignalCardProps) {
  const [capital, setCapital] = useState(defaultCapital);
  const [riskPct, setRiskPct] = useState(card.suggestedRiskPct || 1);
  const [journalNote, setJournalNote] = useState('');
  const [copied, setCopied] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const sizing = useMemo(() => {
    if (card.entryZone.reference == null || card.stopLoss == null) return null;
    return computeManualPositionSizing({
      capitalInr: capital,
      entry: card.entryZone.reference,
      stopLoss: card.stopLoss,
      riskPct,
    });
  }, [capital, riskPct, card.entryZone.reference, card.stopLoss]);

  const stateStyle = STATE_STYLE[card.signalState] ?? STATE_STYLE.watchlist;

  const copyPlan = async () => {
    const text = formatTradePlanCopy({
      symbol: card.symbol,
      direction: card.direction,
      entry: card.entryZone.reference,
      stop: card.stopLoss,
      target1: card.target1,
      target2: card.target2,
      target3: card.target3,
      rewardRisk: card.rewardRisk,
      validUntil: card.validUntil,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setStatusMsg('Clipboard unavailable — select and copy manually.');
    }
  };

  return (
    <article
      style={{
        border: '1px solid #E2E8F0',
        borderRadius: 12,
        background: '#fff',
        padding: 16,
        display: 'grid',
        gap: 14,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: '#0F172A' }}>{card.symbol}</span>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              background: card.direction === 'BUY' ? '#F0FDF4' : '#FEF2F2',
              color: card.direction === 'BUY' ? '#15803D' : '#B91C1C',
            }}>{card.direction}</span>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              background: stateStyle.bg, color: stateStyle.color,
            }}>{stateStyle.label}</span>
          </div>
          <div style={{ fontSize: 12, color: '#64748B', marginTop: 4 }}>
            {card.strategyName}
            {card.strategyVersion ? ` · v${card.strategyVersion}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: '#94A3B8' }}>Calibrated confidence</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#0F172A' }}>
            {card.calibratedConfidence != null ? Math.round(card.calibratedConfidence) : '—'}
          </div>
          <div style={{ fontSize: 11, color: '#64748B' }}>
            Evidence n={card.evidenceSampleSize ?? '—'}
          </div>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        <Metric label="Setup score" value={fmt(card.setupScore, 0)} />
        <Metric label="Decision score" value={fmt(card.compositeDecisionScore, 0)} hint="Composite institutional score" />
        <Metric label="R:R" value={fmt(card.rewardRisk)} />
        <Metric label="Distance to entry" value={
          card.distanceFromEntryR != null
            ? `${fmt(card.distanceFromEntryR)}R (${fmt(card.distanceFromEntryPct)}%)`
            : '—'
        } />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8, fontSize: 13 }}>
        <PlanCell label="Entry zone" value={
          card.entryZone.low != null && card.entryZone.high != null
            ? `${fmt(card.entryZone.low)} – ${fmt(card.entryZone.high)}`
            : fmt(card.entryZone.reference)
        } />
        <PlanCell label="Current" value={fmt(card.currentPrice)} />
        <PlanCell label="Stop" value={fmt(card.stopLoss)} />
        <PlanCell label="Target 1" value={fmt(card.target1)} />
        <PlanCell label="Target 2" value={fmt(card.target2)} />
        <PlanCell label="Target 3" value={fmt(card.target3)} />
      </div>

      {card.invalidationReason && (
        <div style={{ fontSize: 12, color: '#B91C1C', background: '#FEF2F2', padding: '8px 10px', borderRadius: 8 }}>
          Invalidation: {card.invalidationReason}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, fontSize: 12, color: '#475569' }}>
        <div>Generated: {card.generatedAt ?? '—'}</div>
        <div>Data: {card.dataTimestamp ?? '—'}</div>
        <div>Valid until: {card.validUntil ?? '—'}</div>
        <div>Regime: {card.marketRegime ?? '—'}</div>
        <div>Sector: {card.sectorStrength ?? '—'}</div>
        <div>MTF: {card.multiTimeframeAlignment ?? '—'}</div>
      </div>

      {(card.whyTrade || card.whyNotTrade.length > 0) && (
        <section style={{ display: 'grid', gap: 8 }}>
          {card.executionAllowed && card.whyTrade && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#047857', marginBottom: 4 }}>Why trade</div>
              <div style={{ fontSize: 13, color: '#334155' }}>{card.whyTrade}</div>
            </div>
          )}
          {!card.executionAllowed && card.whyNotTrade.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#B45309', marginBottom: 4 }}>Why not trade</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#334155' }}>
                {card.whyNotTrade.map((r) => (
                  <li key={r.code + r.message}>{r.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#15803D', marginBottom: 4 }}>Top positive factors</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#334155' }}>
            {(card.topPositiveFactors.length ? card.topPositiveFactors : [{ label: '—' }]).map((f, i) => (
              <li key={i}>{f.label}{f.detail ? ` — ${f.detail}` : ''}</li>
            ))}
          </ul>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#B91C1C', marginBottom: 4 }}>Risks / warnings</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#334155' }}>
            {(card.topRisks.length ? card.topRisks : [{ label: '—' }]).map((f, i) => (
              <li key={i}>{f.label}</li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', marginBottom: 4 }}>Why this signal may fail</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#475569' }}>
          {card.whyMayFail.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </div>

      {/* Capital / risk calculator — manual only */}
      <section style={{
        borderTop: '1px solid #E2E8F0', paddingTop: 12, display: 'grid', gap: 8,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#0F172A' }}>Personal capital / risk calculator</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ fontSize: 12, color: '#64748B' }}>
            Capital (₹)
            <input
              type="number"
              value={capital}
              min={1000}
              step={1000}
              onChange={(e) => setCapital(Number(e.target.value) || 0)}
              style={{ display: 'block', marginTop: 4, padding: '6px 8px', border: '1px solid #CBD5E1', borderRadius: 6, width: 140 }}
            />
          </label>
          <label style={{ fontSize: 12, color: '#64748B' }}>
            Risk %
            <input
              type="number"
              value={riskPct}
              min={0.1}
              max={5}
              step={0.1}
              onChange={(e) => setRiskPct(Number(e.target.value) || 1)}
              style={{ display: 'block', marginTop: 4, padding: '6px 8px', border: '1px solid #CBD5E1', borderRadius: 6, width: 80 }}
            />
          </label>
          <div style={{ fontSize: 13, color: '#334155' }}>
            Qty ≈ <strong>{sizing?.illustrativeQuantity ?? '—'}</strong>
            {' '}· Risk ₹{fmt(sizing?.riskAmountInr, 0)}
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#94A3B8' }}>{sizing?.note}</div>
      </section>

      {/* Manual actions — never broker */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <ActionBtn onClick={copyPlan}>{copied ? 'Copied' : 'Copy trade plan'}</ActionBtn>
        <ActionBtn onClick={() => onAddToWatchlist?.(card.symbol)}>Add to watchlist</ActionBtn>
        <ActionBtn onClick={() => onCreateAlert?.({
          symbol: card.symbol,
          kind: 'entry_valid',
          targetPrice: card.entryZone.reference,
        })}>
          Alert when entry valid
        </ActionBtn>
        <ActionBtn onClick={() => onCreateAlert?.({
          symbol: card.symbol,
          kind: 'expire_or_invalidate',
          targetPrice: null,
        })}>
          Alert on expire / invalidate
        </ActionBtn>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          placeholder="Manual journal note…"
          value={journalNote}
          onChange={(e) => setJournalNote(e.target.value)}
          style={{ flex: 1, minWidth: 180, padding: '6px 8px', border: '1px solid #CBD5E1', borderRadius: 6, fontSize: 13 }}
        />
        <ActionBtn
          onClick={() => {
            onJournal?.({ symbol: card.symbol, signalId: card.signalId, note: journalNote });
            setJournalNote('');
            setStatusMsg('Journal entry saved locally for this session.');
          }}
        >
          Journal entry
        </ActionBtn>
      </div>

      {statusMsg && <div style={{ fontSize: 11, color: '#64748B' }}>{statusMsg}</div>}

      <footer style={{ fontSize: 10, color: '#94A3B8' }}>
        Contract {card.contractVersion}
        {card.reproducible ? ` · Audit snapshot ${card.auditSnapshotId}` : ' · No audit snapshot'}
        {' · '}Product A — manual execution only (no place-order / auto-trade)
      </footer>
    </article>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ background: '#F8FAFC', borderRadius: 8, padding: '8px 10px' }} title={hint}>
      <div style={{ fontSize: 10, color: '#94A3B8', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{value}</div>
    </div>
  );
}

function PlanCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#94A3B8' }}>{label}</div>
      <div style={{ fontWeight: 600, color: '#0F172A' }}>{value}</div>
    </div>
  );
}

function ActionBtn({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: '6px 10px',
        borderRadius: 8,
        border: '1px solid #CBD5E1',
        background: '#fff',
        color: '#334155',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

export default ProductASignalCard;
