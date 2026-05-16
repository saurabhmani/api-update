'use client';
// ════════════════════════════════════════════════════════════════
//  Emerging Opportunities Section
//
//  Renders DEVELOPING_SETUP / WATCHLIST_ONLY / NO_TRADE rows in
//  their own visually-distinct panel below the main BUY/SELL table.
//  These rows are intentionally NOT actionable — the segmented
//  framing tells the operator at a glance what state each setup is
//  in:
//
//    Watchlist  — classification ∈ { WATCHLIST_ONLY, WATCHLIST }.
//                 Quality is OK but conviction has not built; keep
//                 an eye on it for confluence.
//    Developing — classification = DEVELOPING_SETUP, plus any
//                 conflicting / drift-downgraded rows. The setup
//                 is forming and may resolve into a trade; wait
//                 for breakout / confirmation.
//    No Trade   — classification = NO_TRADE. Surfaced so the
//                 operator can see WHY the row was vetoed
//                 (Liquidity Blocked / Risk Veto / Portfolio
//                 Conflict / Wait for Trigger) instead of having
//                 it silently dropped.
//
//  The Phase-12 partition (lib/signal-engine/pipeline/phase12Routing.ts)
//  is the source of truth for which rows land here. This component
//  only renders + segments.
// ════════════════════════════════════════════════════════════════

import { Sparkles } from 'lucide-react';
import {
  ClassificationBadge,
  FinalScorePill,
  RiskScorePill,
  PortfolioFitPill,
  StressSurvivalPill,
  RiskRewardCell,
  ExplanationSummary,
} from './Phase12SignalRow';
import type {
  Phase11ApiSignalResponse,
  SignalExplanation,
} from '@/types/phase11Signal';

/**
 * Loose row shape: accepts any object that has the Phase-12 display
 * fields. Keeps the component usable against the API's
 * `emerging_opportunities` payload without forcing every legacy
 * caller to migrate to Phase11ApiSignalResponse first.
 */
export interface EmergingRow {
  id?:                    number | null;
  symbol?:                string | null;
  tradingsymbol?:         string | null;
  direction?:             string | null;
  classification?:        string | null;
  signal_status?:         string | null;
  final_score?:           number | null;
  risk_score?:            number | null;
  portfolio_fit_score?:   number | null;
  stress_survival_score?: number | null;
  risk_reward?:           number | null;
  expected_edge_percent?: number | null;
  rejection_codes?:       string[] | null;
  rejection_reasons?:     string[] | null;
  explanation?:           SignalExplanation | null;
}

type Bucket = 'watchlist' | 'developing' | 'no_trade';

interface BucketMeta {
  key:    Bucket;
  label:  string;
  color:  string;
  bg:     string;
  border: string;
  blurb:  string;
}

// Spec INSTITUTIONAL §UX-SIMPLIFY §4 (2026-05) — labels updated to
// the canonical RejectionCode strings. The component itself is dead
// code (page.tsx no longer imports it), but enforcing the rule at
// source means re-enabling it can never reintroduce a "No Trade" /
// "Watchlist" string into the UI. New code should render the
// REJECTED tab via RejectedSignalsPanel in src/app/signals/page.tsx.
const BUCKETS: BucketMeta[] = [
  {
    key:    'watchlist',
    label:  'DEFERRED_WAIT_TRIGGER',
    color:  '#854D0E',
    bg:     '#FEF9C3',
    border: '#FDE68A',
    blurb:  'Awaiting confirmation trigger — monitor for entry.',
  },
  {
    key:    'developing',
    label:  'DEVELOPING_SETUP',
    color:  '#92400E',
    bg:     '#FEF3C7',
    border: '#FCD34D',
    blurb:  'Setup is forming — not yet tradable.',
  },
  {
    key:    'no_trade',
    label:  'REJECTED',
    color:  '#991B1B',
    bg:     '#FEE2E2',
    border: '#FCA5A5',
    blurb:  'Failed institutional approval — see per-row rejection_code for cause.',
  },
];

/**
 * Hard cap on rendered rows across ALL three buckets. The API now
 * returns ~12, but a cap here is defence-in-depth in case a future
 * caller passes more. A single segmented panel with >15 rows starts
 * to bury the actionable signals above it.
 */
const TOTAL_ROW_CAP = 15;

function rowSymbol(r: EmergingRow): string {
  return String(r.symbol ?? r.tradingsymbol ?? '—');
}

function bucketOf(r: EmergingRow): Bucket {
  const cls = String(r.classification ?? '').toUpperCase();
  if (cls === 'NO_TRADE')                                return 'no_trade';
  if (cls === 'WATCHLIST_ONLY' || cls === 'WATCHLIST')   return 'watchlist';
  // DEVELOPING_SETUP, conflicting setups, drift-downgraded rows, and
  // any unrecognised classification land here. Developing is the
  // fall-through bucket — the operator still sees the row, just under
  // the most-honest label.
  return 'developing';
}

function rankRow(r: EmergingRow): number {
  // Simple ranking: higher final_score first, ties broken by edge%.
  // Nulls sort last (treated as 0). Used to pick the top N inside
  // each bucket and to order rows within a bucket.
  const fs   = Number(r.final_score ?? 0);
  const edge = Number(r.expected_edge_percent ?? 0);
  return fs * 100 + edge;
}

export default function EmergingOpportunitiesSection({
  rows,
  defaultExpanded = false,
}: {
  rows:             EmergingRow[] | Phase11ApiSignalResponse[];
  defaultExpanded?: boolean;
}) {
  if (!rows || rows.length === 0) return null;

  // ── Bucket + cap ────────────────────────────────────────────
  // Sort the full list by rank, take the top TOTAL_ROW_CAP, then
  // bucket. This way the segmentation is fed the highest-quality
  // emerging rows first and we never render more than the cap.
  const ranked = (rows as EmergingRow[])
    .slice()
    .sort((a, b) => rankRow(b) - rankRow(a))
    .slice(0, TOTAL_ROW_CAP);

  const buckets: Record<Bucket, EmergingRow[]> = {
    watchlist:  [],
    developing: [],
    no_trade:   [],
  };
  for (const r of ranked) buckets[bucketOf(r)].push(r);

  return (
    <section style={{
      marginTop:    24,
      background:   '#FFFBEB',
      border:       '1px solid #FDE68A',
      borderRadius: 10,
      padding:      '16px 20px',
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Sparkles size={16} color="#92400E" />
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#78350F' }}>
          Emerging Opportunities
        </h2>
        <span style={{ fontSize: 11, color: '#A16207', fontWeight: 600 }}>
          {ranked.length} setup{ranked.length === 1 ? '' : 's'} —{' '}
          {buckets.watchlist.length} deferred, {buckets.developing.length} developing,{' '}
          {buckets.no_trade.length} rejected
        </span>
      </header>
      <p style={{ margin: '0 0 12px 0', fontSize: 12, color: '#78350F' }}>
        Setups segmented by state — not yet tradable. DEFERRED_WAIT_TRIGGER
        holds quality; DEVELOPING_SETUP is forming; REJECTED rows carry a
        specific rejection_code (see per-row badge).
      </p>

      {BUCKETS.map((meta) => {
        const list = buckets[meta.key];
        if (list.length === 0) return null;
        return (
          <BucketBlock
            key={meta.key}
            meta={meta}
            rows={list}
            defaultExpanded={defaultExpanded}
          />
        );
      })}
    </section>
  );
}

// ── Bucket block (one per segment) ─────────────────────────────────
function BucketBlock({
  meta,
  rows,
  defaultExpanded,
}: {
  meta:            BucketMeta;
  rows:            EmergingRow[];
  defaultExpanded: boolean;
}) {
  return (
    <div style={{
      marginTop:    12,
      border:       `1px solid ${meta.border}`,
      borderRadius: 8,
      background:   '#FFFFFF',
      overflow:     'hidden',
    }}>
      <div style={{
        background: meta.bg,
        padding:    '6px 12px',
        display:    'flex',
        alignItems: 'center',
        gap:        10,
      }}>
        <span style={{
          fontSize:     10,
          fontWeight:   800,
          letterSpacing: 0.5,
          color:        meta.color,
          textTransform: 'uppercase',
        }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 11, color: meta.color, fontWeight: 600 }}>
          {rows.length} row{rows.length === 1 ? '' : 's'}
        </span>
        <span style={{ fontSize: 11, color: '#78350F', flex: 1 }}>
          {meta.blurb}
        </span>
      </div>

      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#FAFAF9' }}>
              {/* Edge % included for parity with the main grid; renders '—'
                  when the upstream payload doesn't carry it. */}
              {['Symbol', 'Direction', 'Classification', 'Final', 'Edge %',
                'Risk', 'Portfolio Fit', 'Stress', 'R:R'].map((h) => (
                <th key={h} style={{
                  padding:    '8px 10px',
                  textAlign:  'left',
                  fontSize:   10,
                  color:      '#78350F',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? `${rowSymbol(r)}-${i}`} style={{ borderTop: `1px solid ${meta.border}` }}>
                <td style={{ padding: '8px 10px', fontWeight: 700, color: '#78350F' }}>{rowSymbol(r)}</td>
                <td style={{ padding: '8px 10px', fontSize: 11, fontWeight: 700 }}>{r.direction ?? '—'}</td>
                <td style={{ padding: '8px 10px' }}>
                  <ClassificationBadge
                    value={r.classification ?? null}
                    rejectionCodes={r.rejection_codes ?? null}
                    rejectionReasons={r.rejection_reasons ?? null}
                  />
                </td>
                <td style={{ padding: '8px 10px' }}><FinalScorePill value={r.final_score} /></td>
                <td style={{
                  padding:    '8px 10px',
                  textAlign:  'right',
                  fontWeight: 700,
                  color:      (r.expected_edge_percent ?? 0) >= 1 ? '#065F46'
                            : (r.expected_edge_percent ?? 0) > 0  ? '#1D4ED8'
                            :                                       '#94A3B8',
                }}>
                  {r.expected_edge_percent != null
                    ? `${Number(r.expected_edge_percent) >= 0 ? '+' : ''}${Number(r.expected_edge_percent).toFixed(2)}%`
                    : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                </td>
                <td style={{ padding: '8px 10px' }}><RiskScorePill        value={r.risk_score} /></td>
                <td style={{ padding: '8px 10px' }}><PortfolioFitPill     value={r.portfolio_fit_score} /></td>
                <td style={{ padding: '8px 10px' }}><StressSurvivalPill   value={r.stress_survival_score} /></td>
                <td style={{ padding: '8px 10px' }}><RiskRewardCell       value={r.risk_reward} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {defaultExpanded && (
        <div style={{ padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.slice(0, 3).map((r, i) => (
            <ExplanationSummary
              key={r.id ?? i}
              explanation={r.explanation ?? null}
              fallback={`${rowSymbol(r)} — ${meta.label.toLowerCase()}.`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
