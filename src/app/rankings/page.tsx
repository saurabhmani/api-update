'use client';
/**
 * Rankings page — Quantorus365.
 *
 * Audit fixes (2026-05):
 *   • Header used to read "Top stocks by Quantorus365 score" while the
 *     backend actually sorted by `opportunity_rank`, so a row with a
 *     higher visible score could appear far below a row with a lower
 *     one (ASHOKLEY 75.3 at rank 38 below ADANIGREEN 73.7 at rank 2).
 *     The header now matches the comparator and surfaces the
 *     `sorted_by` field returned by /api/rankings.
 *   • Page reads /api/market-status (single source of truth) and
 *     refuses to show a LIVE badge when the wall clock says closed.
 *     Refresh cadence drops from 10 s → 5 min when off-hours.
 *   • Rows are bucketed into High Conviction / Actionable Watchlist /
 *     Momentum Leaders / Filtered Out so a momentum mover never gets
 *     mistaken for a high-quality institutional opportunity.
 *   • Numeric formatters never emit NaN; missing fields render as "—".
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { RefreshCw, TrendingUp, AlertTriangle, ShieldAlert } from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Button } from '@/components/ui';
import { rankingsApi } from '@/lib/apiClient';
import { fmt, changeClass } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────

type MarketMode = 'live' | 'pre_open' | 'post_close' | 'holiday' | 'weekend' | 'market_closed';
type DataSource = 'live_feed' | 'cached_rankings' | 'last_rankings_db' | 'eod_snapshot';

interface RankingRow {
  symbol?:              string;
  tradingsymbol?:       string;
  name?:                string;
  exchange?:            string;
  sector?:              string | null;
  score?:               number | null;
  rank_position?:       number | null;
  opportunity_rank?:    number | null;
  ltp?:                 number | null;
  pct_change?:          number | null;
  volume?:              number | null;
  signal_type?:         'BUY' | 'SELL' | 'HOLD' | null;
  confidence?:          number | null;
  confidence_score?:    number | null;
  conviction_band?:     string | null;
  risk_score?:          number | null;
  data_source?:         string | null;
  signal_age_min?:      number | null;
}

interface RankingsApiResponse {
  data?:           RankingRow[];
  count?:          number;
  total?:          number;
  mode?:           MarketMode;
  market_state?:   string;
  market_label?:   string;
  market_reason?:  string | null;
  is_holiday?:     boolean;
  now_ist?:        string;
  bypass_active?:  boolean;
  bypass_reason?:  string | null;
  data_source?:    DataSource;
  sorted_by?:      string;
  as_of?:          string;
  error?:          string;
}

// ─── Helpers ──────────────────────────────────────────────────────

const safeNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const symbolOf = (r: RankingRow): string =>
  String(r.symbol || r.tradingsymbol || '').toUpperCase();

const opportunityOf = (r: RankingRow): number | null =>
  safeNum(r.opportunity_rank) ?? safeNum(r.score);

const isMomentumMover = (r: RankingRow): boolean => {
  const pct = safeNum(r.pct_change);
  return pct != null && Math.abs(pct) >= 4;
};

const isFilteredOut = (r: RankingRow): boolean => {
  const conv = (r.conviction_band ?? '').toLowerCase();
  if (conv === 'reject') return true;
  const risk = safeNum(r.risk_score);
  if (risk != null && risk >= 70) return true;
  const conf = safeNum(r.confidence_score ?? r.confidence);
  if (conf != null && conf < 50) return true;
  return false;
};

const isHighConviction = (r: RankingRow): boolean => {
  const opp  = safeNum(opportunityOf(r));
  const conf = safeNum(r.confidence_score ?? r.confidence);
  const risk = safeNum(r.risk_score);
  if (opp == null || opp < 75) return false;
  if (conf != null && conf < 80) return false;
  if (risk != null && risk > 35) return false;
  return true;
};

const isActionable = (r: RankingRow): boolean => {
  const opp  = safeNum(opportunityOf(r));
  const conf = safeNum(r.confidence_score ?? r.confidence);
  if (opp == null) return false;
  if (opp < 65 || opp >= 75) return false;
  if (conf != null && (conf < 65 || conf >= 80)) return false;
  return true;
};

interface Bucketed {
  highConviction: RankingRow[];
  actionable:     RankingRow[];
  momentum:       RankingRow[];
  filtered:       RankingRow[];
  remaining:      RankingRow[];
}

const bucket = (rows: RankingRow[]): Bucketed => {
  const out: Bucketed = {
    highConviction: [], actionable: [], momentum: [], filtered: [], remaining: [],
  };
  const claimed = new Set<string>();
  const claim = (r: RankingRow, list: RankingRow[]) => {
    list.push(r);
    claimed.add(symbolOf(r));
  };
  for (const r of rows) {
    if (isFilteredOut(r))   { claim(r, out.filtered);       continue; }
    if (isHighConviction(r)){ claim(r, out.highConviction); continue; }
    if (isActionable(r))    { claim(r, out.actionable);     continue; }
  }
  for (const r of rows) {
    if (claimed.has(symbolOf(r))) continue;
    if (isMomentumMover(r))  { claim(r, out.momentum);   continue; }
    out.remaining.push(r);
  }
  return out;
};

// Refresh cadence — open market polls fast (live LTP overlay is meaningful);
// closed market polls slowly (rows are last-close, no point hammering).
const refreshIntervalMs = (mode: MarketMode | undefined): number => {
  if (mode === 'live') return 15_000;
  return 5 * 60_000;
};

const modeBadge = (mode: MarketMode | undefined): { label: string; bg: string; fg: string; live: boolean } => {
  switch (mode) {
    case 'live':         return { label: 'LIVE',          bg: '#DCFCE7', fg: '#15803D', live: true  };
    case 'pre_open':     return { label: 'PRE-OPEN',      bg: '#FEF3C7', fg: '#92400E', live: false };
    case 'post_close':   return { label: 'MARKET CLOSED', bg: '#FEF3C7', fg: '#92400E', live: false };
    case 'weekend':      return { label: 'WEEKEND',       bg: '#FEF3C7', fg: '#92400E', live: false };
    case 'holiday':      return { label: 'HOLIDAY',       bg: '#FEF3C7', fg: '#92400E', live: false };
    case 'market_closed':return { label: 'MARKET CLOSED', bg: '#FEF3C7', fg: '#92400E', live: false };
    default:             return { label: '—',             bg: '#E2E8F0', fg: '#475569', live: false };
  }
};

const dataSourceLabel = (s: DataSource | undefined): string => {
  switch (s) {
    case 'live_feed':        return 'Live feed';
    case 'cached_rankings':  return 'Cached rankings';
    case 'last_rankings_db': return 'Last rankings (DB)';
    case 'eod_snapshot':     return 'EOD snapshot';
    default:                 return '—';
  }
};

const signalBadge = (sig: string | null | undefined) => {
  const s = (sig ?? 'HOLD').toUpperCase();
  if (s === 'BUY')  return <Badge variant="green">BUY</Badge>;
  if (s === 'SELL') return <Badge variant="red">SELL</Badge>;
  if (s === 'HOLD') return <Badge variant="gray">HOLD</Badge>;
  return <Badge>{s}</Badge>;
};

// Conviction band vocabulary varies by source:
//   - rankingsService.interpretRankingSignal → 'high_conviction' / 'actionable' / 'watchlist' / 'reject'
//   - q365_signals.confidence_band            → 'HIGH' / 'MEDIUM' / 'LOW' / 'INSTITUTIONAL'
//   - bootstrapped legacy rows                → 'high' / 'medium' / 'low'
// Normalising on the way in so the Conviction column never falls
// through to "—" when the DB carries a perfectly valid value in
// a different casing/synonym.
const convictionBadge = (band: string | null | undefined) => {
  const raw = (band ?? '').trim().toLowerCase();
  if (!raw) return <Badge variant="gray">—</Badge>;

  // High conviction tier
  if (raw === 'high_conviction' || raw === 'high' || raw === 'institutional') {
    return <Badge variant="dark">High</Badge>;
  }
  // Actionable / Medium tier
  if (raw === 'actionable' || raw === 'medium' || raw === 'med') {
    return <Badge variant="green">Actionable</Badge>;
  }
  // Watchlist / Low tier
  if (raw === 'watchlist' || raw === 'low' || raw === 'developing') {
    return <Badge variant="orange">Watchlist</Badge>;
  }
  // Rejected / NO_TRADE tier
  if (raw === 'reject' || raw === 'rejected' || raw === 'no_trade') {
    return <Badge variant="red">Rejected</Badge>;
  }
  // Unknown vocabulary — surface the raw value so operators see the
  // band rather than a silent "—" that hides a data-quality issue.
  return <Badge variant="gray">{(band ?? '').toString().slice(0, 12) || '—'}</Badge>;
};

const riskBadge = (risk: number | null) => {
  if (risk == null) return <span style={{ color: '#94A3B8' }}>—</span>;
  if (risk >= 70) return <Badge variant="red">{risk.toFixed(0)} High</Badge>;
  if (risk >= 40) return <Badge variant="orange">{risk.toFixed(0)} Med</Badge>;
  return <Badge variant="green">{risk.toFixed(0)} Low</Badge>;
};

// ─── Page ─────────────────────────────────────────────────────────

export default function RankingsPage() {
  const [resp,    setResp]    = useState<RankingsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  // View mode — default 'flat' so the page matches the dashboard's
  // Top Rankings panel byte-for-byte: a single ordered table sorted
  // strictly by opportunity_rank DESC. The 'grouped' view buckets
  // rows into High Conviction / Actionable / Momentum / Other /
  // Filtered tiers; useful for review but breaks global ordering
  // (an Actionable row at opp=72 can sit above a Momentum row at
  // opp=85 because Momentum is a later section). Operators who
  // want the categorical breakdown can opt in.
  const [view, setView] = useState<'flat' | 'grouped'>('flat');

  const load = useCallback(async () => {
    try {
      const d = await rankingsApi.get(100) as RankingsApiResponse;
      setResp(d);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Failed to load rankings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Market-aware refresh: 15 s when open, 5 min when closed.
  useEffect(() => {
    const ms = refreshIntervalMs(resp?.mode);
    const id = setInterval(() => { if (!document.hidden) load(); }, ms);
    return () => clearInterval(id);
  }, [load, resp?.mode]);

  // Defensive client-side sort. Mirrors compareRanked in
  // rankingsService.ts so a stale 60s redis cache (or a future
  // backend regression) can never make the visible RANK column
  // disagree with the row order. Sort keys, in priority order:
  //   1. opportunity_rank DESC (falls back to score)
  //   2. conviction band rank DESC
  //   3. confidence_score DESC
  //   4. risk_score ASC (lower wins ties)
  //   5. volume DESC
  //   6. symbol ASC
  const CONVICTION_RANK_LOCAL: Record<string, number> = {
    high_conviction: 4, actionable: 3, watchlist: 2, reject: 0,
  };
  const rawRows = resp?.data ?? [];
  const rows    = useMemo(() => {
    return [...rawRows].sort((a, b) => {
      const aOpp = Number(opportunityOf(a) ?? 0);
      const bOpp = Number(opportunityOf(b) ?? 0);
      if (aOpp !== bOpp) return bOpp - aOpp;
      const cb = (CONVICTION_RANK_LOCAL[(b.conviction_band ?? '').toLowerCase()] ?? 1)
               - (CONVICTION_RANK_LOCAL[(a.conviction_band ?? '').toLowerCase()] ?? 1);
      if (cb !== 0) return cb;
      const aConf = safeNum(a.confidence_score ?? a.confidence) ?? -1;
      const bConf = safeNum(b.confidence_score ?? b.confidence) ?? -1;
      if (aConf !== bConf) return bConf - aConf;
      const aRisk = safeNum(a.risk_score) ?? Number.POSITIVE_INFINITY;
      const bRisk = safeNum(b.risk_score) ?? Number.POSITIVE_INFINITY;
      if (aRisk !== bRisk) return aRisk - bRisk;
      const aVol = safeNum(a.volume) ?? 0;
      const bVol = safeNum(b.volume) ?? 0;
      if (aVol !== bVol) return bVol - aVol;
      return symbolOf(a).localeCompare(symbolOf(b));
    });
  }, [rawRows]);
  const buckets = useMemo(() => bucket(rows), [rows]);

  const mode      = resp?.mode;
  const badge     = modeBadge(mode);
  const isClosed  = mode != null && mode !== 'live';
  const ltpLabel  = isClosed ? 'Last Close LTP' : 'LTP';
  const pctLabel  = isClosed ? 'Last Close Change %' : 'Change %';
  const tableTitle = isClosed
    ? 'Last Close Rankings — sorted by Opportunity Rank'
    : 'Top stocks by Opportunity Rank';

  return (
    <AppShell title="Rankings">
      <div className="page">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="page__header">
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              Rankings
              <span
                title={resp?.market_label ?? 'Market status loading…'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '2px 10px', borderRadius: 99,
                  background: badge.bg, color: badge.fg,
                  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: badge.live ? '#15803D' : '#D97706',
                  animation: badge.live ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }} />
                {badge.label}
              </span>
              <Badge variant="gray">{dataSourceLabel(resp?.data_source)}</Badge>
            </h1>
            <p style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {tableTitle}
              {resp?.as_of && <span style={{ color: '#94A3B8', fontSize: 12 }}>· as of {fmt.datetime(resp.as_of)}</span>}
              {resp?.sorted_by && (
                <span title={resp.sorted_by} style={{ color: '#94A3B8', fontSize: 11 }}>
                  · order: {resp.sorted_by.split(',')[0]}…
                </span>
              )}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* View toggle — Flat (single sorted table, matches the
                dashboard's Top Rankings panel exactly) vs Grouped
                (bucketed by tier). Default is Flat so /rankings and
                the dashboard agree on row order. */}
            <div role="group" aria-label="View mode" style={{
              display: 'inline-flex', borderRadius: 6,
              border: '1px solid #E2E8F0', overflow: 'hidden', fontSize: 12,
            }}>
              {(['flat', 'grouped'] as const).map((m) => {
                const active = view === m;
                return (
                  <button
                    key={m}
                    onClick={() => setView(m)}
                    style={{
                      padding: '6px 12px', border: 'none',
                      background: active ? '#1E293B' : 'white',
                      color:      active ? 'white'   : '#475569',
                      fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    {m === 'flat' ? 'Flat' : 'Grouped'}
                  </button>
                );
              })}
            </div>
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <RefreshCw size={13} /> Refresh
            </Button>
          </div>
        </div>

        {/* ── Closed-market banner ───────────────────────────────── */}
        {isClosed && (
          <div style={{
            background: '#FEF3C7', borderRadius: 10, padding: '12px 18px',
            marginBottom: 18, border: '1px solid #FDE68A',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <AlertTriangle size={20} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#92400E', marginBottom: 4 }}>
                Market Closed — Showing last available rankings
              </div>
              <div style={{ fontSize: 12, color: '#92400E' }}>
                {resp?.market_label ?? 'Market is closed'}
                {resp?.market_reason ? ` · ${resp.market_reason}` : ''}.
                This is cached / EOD data and should not be treated as live intraday data.
                Auto-refresh is throttled to once every 5 minutes.
              </div>
              {resp?.bypass_active && (
                <div style={{
                  marginTop: 6, fontSize: 11, color: '#7C2D12',
                  background: '#FEE2E2', padding: '2px 8px', borderRadius: 6,
                  display: 'inline-block', fontWeight: 700,
                }} title={resp?.bypass_reason ?? ''}>
                  ⚠️ Market-hours bypass env detected ({resp?.bypass_reason})
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Body ───────────────────────────────────────────────── */}
        {loading && !resp ? (
          <Card flush><Loading /></Card>
        ) : error ? (
          <Card flush>
            <Empty
              icon={ShieldAlert}
              title="Couldn't load rankings"
              description={error}
            />
          </Card>
        ) : rows.length === 0 ? (
          <Card flush>
            <Empty
              icon={TrendingUp}
              title="No rankings data"
              description="Go to Admin → Data Management and trigger a rankings sync."
            />
          </Card>
        ) : view === 'flat' ? (
          // Flat view — same sort order as the dashboard's Top
          // Rankings panel: rows already arrived from the API in
          // strict opportunity_rank DESC order (compareRanked in
          // rankingsService.ts). No bucketing, no per-section
          // re-numbering. The Tier column makes the categorical
          // breakdown visible without breaking global ordering.
          <Section
            title={isClosed ? 'Last Close Rankings' : 'Top Stocks by Opportunity Rank'}
            subtitle="Sorted strictly by opportunity_rank DESC — global order matches every other ranking surface in the platform"
            variant="slate"
            rows={rows}
            ltpLabel={ltpLabel}
            pctLabel={pctLabel}
            startIndex={1}
            showTier
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Section
              title="High Conviction Opportunities"
              subtitle={`Opportunity Rank ≥ 75 · confidence ≥ 80 · risk ≤ 35`}
              variant="emerald"
              rows={buckets.highConviction}
              ltpLabel={ltpLabel}
              pctLabel={pctLabel}
              startIndex={1}
            />
            <Section
              title="Actionable Watchlist"
              subtitle={`Opportunity Rank 65–75 · confidence 65–80 · needs confirmation`}
              variant="amber"
              rows={buckets.actionable}
              ltpLabel={ltpLabel}
              pctLabel={pctLabel}
              startIndex={1 + buckets.highConviction.length}
            />
            <Section
              title="Momentum Leaders"
              subtitle="Strong intraday move (≥ 4% absolute) — momentum signal, not a buy/sell call"
              variant="blue"
              rows={buckets.momentum}
              ltpLabel={ltpLabel}
              pctLabel={pctLabel}
              startIndex={1 + buckets.highConviction.length + buckets.actionable.length}
            />
            {buckets.remaining.length > 0 && (
              <Section
                title="Other Ranked Stocks"
                subtitle="Did not match the High Conviction / Actionable / Momentum criteria"
                variant="slate"
                rows={buckets.remaining}
                ltpLabel={ltpLabel}
                pctLabel={pctLabel}
                startIndex={
                  1 + buckets.highConviction.length + buckets.actionable.length + buckets.momentum.length
                }
              />
            )}
            {buckets.filtered.length > 0 && (
              <Section
                title="Filtered Out / Risk Watch"
                subtitle="Rejected, high risk, or low confidence — surfaced for transparency, not as opportunities"
                variant="red"
                rows={buckets.filtered}
                ltpLabel={ltpLabel}
                pctLabel={pctLabel}
                startIndex={
                  1
                  + buckets.highConviction.length
                  + buckets.actionable.length
                  + buckets.momentum.length
                  + buckets.remaining.length
                }
              />
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ─── Section table ────────────────────────────────────────────────

interface SectionProps {
  title:      string;
  subtitle:   string;
  variant:    'emerald' | 'amber' | 'blue' | 'slate' | 'red';
  rows:       RankingRow[];
  ltpLabel:   string;
  pctLabel:   string;
  startIndex: number;
  /** When true, render an extra "Tier" column showing which bucket
   *  each row would belong to (High Conviction / Actionable /
   *  Momentum / Other / Filtered). Used by the flat view so the
   *  categorical breakdown is still visible without breaking the
   *  global opportunity_rank ordering. */
  showTier?:  boolean;
}

// Tier classification (mirrors the bucketing predicates above) so the
// flat view can label each row with its tier without re-running the
// bucketing logic and without any chance of disagreeing with it.
function tierOf(r: RankingRow): { label: string; bg: string; fg: string } {
  if (isFilteredOut(r))    return { label: 'Filtered',  bg: '#FEE2E2', fg: '#B91C1C' };
  if (isHighConviction(r)) return { label: 'High Conv', bg: '#D1FAE5', fg: '#065F46' };
  if (isActionable(r))     return { label: 'Actionable',bg: '#DBEAFE', fg: '#1D4ED8' };
  if (isMomentumMover(r))  return { label: 'Momentum',  bg: '#EDE9FE', fg: '#5B21B6' };
  return { label: 'Other', bg: '#F1F5F9', fg: '#475569' };
}

const SECTION_BG: Record<SectionProps['variant'], string> = {
  emerald: '#ECFDF5',
  amber:   '#FFFBEB',
  blue:    '#EFF6FF',
  slate:   '#F8FAFC',
  red:     '#FEF2F2',
};

const SECTION_BORDER: Record<SectionProps['variant'], string> = {
  emerald: '#A7F3D0',
  amber:   '#FDE68A',
  blue:    '#BFDBFE',
  slate:   '#E2E8F0',
  red:     '#FECACA',
};

function Section({ title, subtitle, variant, rows, ltpLabel, pctLabel, startIndex, showTier }: SectionProps) {
  if (!rows.length) return null;
  return (
    <Card flush>
      <div style={{
        background: SECTION_BG[variant],
        borderBottom: `1px solid ${SECTION_BORDER[variant]}`,
        padding: '12px 18px',
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{title}</h3>
          <span style={{ fontSize: 11, color: '#475569' }}>· {rows.length} stock{rows.length === 1 ? '' : 's'}</span>
        </div>
        <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>{subtitle}</div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Symbol</th>
              <th>Name</th>
              <th>Exchange</th>
              <th>Sector</th>
              {showTier && <th>Tier</th>}
              <th style={{ textAlign: 'right' }}>Opp. Rank</th>
              <th style={{ textAlign: 'right' }}>Q365 Score</th>
              <th>Signal</th>
              <th>Conviction</th>
              <th style={{ textAlign: 'right' }}>Confidence</th>
              <th>Risk</th>
              <th style={{ textAlign: 'right' }}>{ltpLabel}</th>
              <th style={{ textAlign: 'right' }}>{pctLabel}</th>
              <th style={{ textAlign: 'right' }}>Volume</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const sym  = symbolOf(r);
              const opp  = safeNum(opportunityOf(r));
              const sc   = safeNum(r.score);
              const conf = safeNum(r.confidence_score ?? r.confidence);
              const risk = safeNum(r.risk_score);
              const ltp  = safeNum(r.ltp);
              const pct  = safeNum(r.pct_change);
              const vol  = safeNum(r.volume);
              const age  = safeNum(r.signal_age_min);
              return (
                <tr key={`${sym}-${i}`}>
                  <td style={{ fontWeight: 700, color: '#94A3B8' }}>{startIndex + i}</td>
                  <td><strong style={{ color: '#1E3A5F' }}>{sym || '—'}</strong></td>
                  <td style={{ color: '#64748B', fontSize: 12 }}>{fmt.truncate(r.name, 24) || '—'}</td>
                  <td><Badge>{r.exchange || 'NSE'}</Badge></td>
                  <td style={{ color: '#64748B', fontSize: 12 }}>{r.sector || '—'}</td>
                  {showTier && (() => {
                    const t = tierOf(r);
                    return (
                      <td>
                        <span style={{
                          background: t.bg, color: t.fg,
                          fontSize: 10, fontWeight: 700, padding: '2px 8px',
                          borderRadius: 99, letterSpacing: 0.3,
                        }}>
                          {t.label}
                        </span>
                      </td>
                    );
                  })()}
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#0F172A' }}>
                    {opp != null ? opp.toFixed(0) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#475569' }}>
                    {sc != null ? sc.toFixed(1) : '—'}
                  </td>
                  <td>{signalBadge(r.signal_type)}</td>
                  <td>{convictionBadge(r.conviction_band)}</td>
                  <td style={{ textAlign: 'right' }}>{conf != null ? `${conf.toFixed(0)}%` : '—'}</td>
                  <td>{riskBadge(risk)}</td>
                  <td style={{ textAlign: 'right' }}>{ltp != null && ltp > 0 ? fmt.currency(ltp) : '—'}</td>
                  <td
                    style={{ textAlign: 'right' }}
                    className={pct != null ? changeClass(pct) : ''}
                  >
                    {pct != null ? fmt.percent(pct) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>{vol != null && vol > 0 ? fmt.volume(vol) : '—'}</td>
                  <td style={{ fontSize: 11, color: '#64748B' }}>{r.data_source || '—'}</td>
                  <td style={{ fontSize: 11, color: '#64748B' }}>
                    {age != null ? `${age}m ago` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
