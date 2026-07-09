'use client';
/**
 * Rankings page — approved trading opportunities leaderboard.
 *
 * Shows only signals that passed the Phase-3 approval gateway and
 * confirmed snapshots (maturity-promoted). Ranked by opportunity score
 * with conviction, confidence, portfolio fit, and risk tie-breakers.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  RefreshCw, TrendingUp, AlertTriangle, ShieldAlert,
  Search, ChevronLeft, ChevronRight, Info,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Button } from '@/components/ui';
import { rankingsApi } from '@/lib/apiClient';
import { fmt, changeClass } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────

type MarketMode = 'live' | 'pre_open' | 'post_close' | 'holiday' | 'weekend' | 'market_closed';
type DataSource = 'live_feed' | 'cached_rankings' | 'last_rankings_db' | 'last_close_cache' | 'unavailable';

interface OpportunityRow {
  id:                    number;
  symbol:                string;
  exchange:              string;
  sector:                string | null;
  direction:             'BUY' | 'SELL';
  strategy:              string | null;
  timeframe:             string | null;
  classification:        string | null;
  conviction_band:       string | null;
  opportunity_rank:      number;
  final_score:           number | null;
  confidence_score:      number | null;
  risk_score:            number | null;
  risk_reward:           number | null;
  portfolio_fit_score:   number | null;
  market_stance:         string | null;
  entry_price:           number | null;
  ltp:                   number | null;
  pct_change:            number | null;
  source:                'confirmed' | 'phase3_approved';
  rank_position:         number;
  rank_explanation:      string;
  rank_factors:          string[];
  signal_age_min:        number | null;
  confirmed_at:          string | null;
  generated_at:          string | null;
}

interface FilterOptions {
  sectors:     string[];
  strategies:  string[];
  timeframes:  string[];
  convictions: string[];
  exchanges:   string[];
}

interface OpportunitiesApiResponse {
  data?:            OpportunityRow[];
  total?:           number;
  count?:           number;
  page?:            number;
  limit?:           number;
  has_more?:        boolean;
  confirmed_count?: number;
  phase3_count?:    number;
  filter_options?:  FilterOptions;
  mode?:            MarketMode;
  market_label?:    string;
  market_reason?:   string | null;
  data_source?:     DataSource;
  sorted_by?:       string;
  as_of?:           string;
  message?:         string | null;
  error?:           string;
}

interface Filters {
  search:     string;
  sector:     string;
  exchange:   string;
  direction:  string;
  strategy:   string;
  timeframe:  string;
  conviction: string;
  risk:       string;
  market:     string;
  sort:       string;
  sortDir:    'asc' | 'desc';
}

const PAGE_SIZE = 25;

const DEFAULT_FILTERS: Filters = {
  search: '', sector: '', exchange: '', direction: '',
  strategy: '', timeframe: '', conviction: '', risk: '',
  market: '', sort: 'opportunity_rank', sortDir: 'desc',
};

// ─── Helpers ──────────────────────────────────────────────────────

const safeNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const refreshIntervalMs = (mode: MarketMode | undefined): number =>
  mode === 'live' ? 15_000 : 5 * 60_000;

const modeBadge = (mode: MarketMode | undefined) => {
  switch (mode) {
    case 'live':          return { label: 'LIVE',           bg: '#DCFCE7', fg: '#15803D', live: true };
    case 'pre_open':      return { label: 'PRE-OPEN',       bg: '#FEF3C7', fg: '#92400E', live: false };
    case 'post_close':
    case 'weekend':
    case 'holiday':
    case 'market_closed': return { label: 'MARKET CLOSED',  bg: '#FEF3C7', fg: '#92400E', live: false };
    default:              return { label: '—',              bg: '#E2E8F0', fg: '#475569', live: false };
  }
};

const convictionBadge = (band: string | null | undefined) => {
  const raw = (band ?? '').trim().toLowerCase();
  if (!raw) return <Badge variant="gray">—</Badge>;
  if (raw === 'high_conviction' || raw === 'institutional') return <Badge variant="dark">High</Badge>;
  if (raw === 'actionable' || raw === 'medium') return <Badge variant="green">Actionable</Badge>;
  if (raw === 'watchlist' || raw === 'low') return <Badge variant="orange">Watchlist</Badge>;
  return <Badge variant="gray">{band}</Badge>;
};

const sourceBadge = (source: OpportunityRow['source']) => {
  if (source === 'confirmed') {
    return (
      <span title="Maturity-promoted confirmed snapshot">
        <Badge variant="green">Confirmed</Badge>
      </span>
    );
  }
  return (
    <span title="Phase-3 approved, awaiting promotion">
      <Badge variant="orange">Phase 3</Badge>
    </span>
  );
};

const riskBadge = (risk: number | null) => {
  if (risk == null) return <span style={{ color: '#94A3B8' }}>—</span>;
  if (risk >= 70) return <Badge variant="red">{risk.toFixed(0)} High</Badge>;
  if (risk >= 40) return <Badge variant="orange">{risk.toFixed(0)} Med</Badge>;
  return <Badge variant="green">{risk.toFixed(0)} Low</Badge>;
};

const dirBadge = (dir: string) => {
  if (dir === 'BUY')  return <Badge variant="green">BUY</Badge>;
  if (dir === 'SELL') return <Badge variant="red">SELL</Badge>;
  return <Badge>{dir}</Badge>;
};

// ─── Page ─────────────────────────────────────────────────────────

export default function RankingsPage() {
  const [resp, setResp]       = useState<OpportunitiesApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [page, setPage]       = useState(1);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draftSearch, setDraftSearch] = useState('');

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const d = await rankingsApi.opportunities({
        limit: PAGE_SIZE,
        page,
        search:     filters.search || undefined,
        sector:     filters.sector || undefined,
        exchange:   filters.exchange || undefined,
        direction:  filters.direction || undefined,
        strategy:   filters.strategy || undefined,
        timeframe:  filters.timeframe || undefined,
        conviction: filters.conviction || undefined,
        risk:       filters.risk || undefined,
        market:     filters.market || undefined,
        sort:       filters.sort || undefined,
        sortDir:    filters.sortDir,
      }) as OpportunitiesApiResponse;
      setResp(d);
      setError(null);
    } catch (e: unknown) {
      setError((e as Error)?.message || 'Failed to load rankings');
    } finally {
      setLoading(false);
      if (manual) setRefreshing(false);
    }
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const ms = refreshIntervalMs(resp?.mode);
    const id = setInterval(() => { if (!document.hidden) load(); }, ms);
    return () => clearInterval(id);
  }, [load, resp?.mode]);

  const rows = resp?.data ?? [];
  const total = resp?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const opts = resp?.filter_options;
  const mode = resp?.mode;
  const badge = modeBadge(mode);
  const isClosed = mode != null && mode !== 'live';

  const applySearch = () => {
    setPage(1);
    setFilters((f) => ({ ...f, search: draftSearch.trim() }));
  };

  const setFilter = (key: keyof Filters, value: string) => {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const clearFilters = () => {
    setPage(1);
    setDraftSearch('');
    setFilters(DEFAULT_FILTERS);
  };

  const hasActiveFilters = useMemo(
    () => Object.entries(filters).some(([k, v]) => k !== 'sort' && k !== 'sortDir' && v !== ''),
    [filters],
  );

  return (
    <AppShell title="Rankings">
      <div className="page">
        {/* Header */}
        <div className="page__header">
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              Opportunity Rankings
              <span
                title={resp?.market_label ?? 'Market status'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '2px 10px', borderRadius: 99,
                  background: badge.bg, color: badge.fg,
                  fontSize: 11, fontWeight: 700,
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: badge.live ? '#15803D' : '#D97706',
                  animation: badge.live ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }} />
                {badge.label}
              </span>
            </h1>
            <p style={{ color: '#64748B', fontSize: 13, marginTop: 4 }}>
              Best approved trading opportunities — Phase-3 gateway pass and confirmed snapshots only.
              {resp?.confirmed_count != null && (
                <span> · {resp.confirmed_count} confirmed, {resp.phase3_count ?? 0} Phase-3 approved</span>
              )}
              {resp?.as_of && <span> · as of {fmt.datetime(resp.as_of)}</span>}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => load(true)} disabled={loading || refreshing}>
            <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {isClosed && (
          <div style={{
            background: '#FEF3C7', borderRadius: 10, padding: '12px 18px',
            marginBottom: 16, border: '1px solid #FDE68A',
            display: 'flex', gap: 12, alignItems: 'flex-start',
          }}>
            <AlertTriangle size={18} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: 12, color: '#92400E' }}>
              Market closed — showing last approved opportunities. Auto-refresh every 5 minutes.
            </div>
          </div>
        )}

        {/* Filters */}
        <Card style={{ marginBottom: 16, padding: '14px 18px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 6, flex: '1 1 200px', minWidth: 200 }}>
              <input
                type="text"
                placeholder="Search symbol, sector, strategy…"
                value={draftSearch}
                onChange={(e) => setDraftSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applySearch()}
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 6,
                  border: '1px solid #E2E8F0', fontSize: 13,
                }}
              />
              <Button variant="secondary" size="sm" onClick={applySearch}>
                <Search size={14} />
              </Button>
            </div>

            <FilterSelect label="Sector" value={filters.sector} options={opts?.sectors ?? []}
              onChange={(v) => setFilter('sector', v)} />
            <FilterSelect label="Exchange" value={filters.exchange} options={opts?.exchanges ?? []}
              onChange={(v) => setFilter('exchange', v)} />
            <FilterSelect label="Direction" value={filters.direction}
              options={['BUY', 'SELL']} onChange={(v) => setFilter('direction', v)} />
            <FilterSelect label="Strategy" value={filters.strategy} options={opts?.strategies ?? []}
              onChange={(v) => setFilter('strategy', v)} />
            <FilterSelect label="Timeframe" value={filters.timeframe} options={opts?.timeframes ?? []}
              onChange={(v) => setFilter('timeframe', v)} />
            <FilterSelect label="Conviction" value={filters.conviction} options={opts?.convictions ?? []}
              onChange={(v) => setFilter('conviction', v)} />
            <FilterSelect label="Risk" value={filters.risk}
              options={[{ v: 'low', l: 'Low' }, { v: 'medium', l: 'Medium' }, { v: 'high', l: 'High' }]}
              onChange={(v) => setFilter('risk', v)} />
            <FilterSelect label="Sort" value={filters.sort}
              options={[
                { v: 'opportunity_rank', l: 'Opportunity Rank' },
                { v: 'confidence', l: 'Confidence' },
                { v: 'final_score', l: 'Final Score' },
                { v: 'risk', l: 'Risk' },
                { v: 'freshness', l: 'Freshness' },
              ]}
              onChange={(v) => setFilter('sort', v)} />

            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                style={{
                  padding: '6px 12px', fontSize: 12, border: '1px solid #E2E8F0',
                  borderRadius: 6, background: 'white', cursor: 'pointer', color: '#64748B',
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </Card>

        {/* Body */}
        {loading && !resp ? (
          <Card flush><Loading /></Card>
        ) : error ? (
          <Card flush>
            <Empty icon={ShieldAlert} title="Couldn't load rankings" description={error} />
          </Card>
        ) : rows.length === 0 ? (
          <Card flush>
            <Empty
              icon={TrendingUp}
              title="No approved opportunities"
              description={resp?.message ?? 'No signals have passed the Phase-3 approval gateway yet.'}
            />
          </Card>
        ) : (
          <Card flush>
            <div style={{
              padding: '12px 18px', borderBottom: '1px solid #E2E8F0',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              flexWrap: 'wrap', gap: 8,
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Approved Opportunities Leaderboard</div>
                <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                  Sorted by {resp?.sorted_by?.split(',')[0] ?? 'opportunity rank'} · {total} total
                </div>
              </div>
              <Pagination
                page={page}
                totalPages={totalPages}
                onPage={(p) => setPage(p)}
              />
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Symbol</th>
                    <th>Dir</th>
                    <th>Source</th>
                    <th>Sector</th>
                    <th>Strategy</th>
                    <th style={{ textAlign: 'right' }}>Opp. Rank</th>
                    <th style={{ textAlign: 'right' }}>Final</th>
                    <th>Conviction</th>
                    <th style={{ textAlign: 'right' }}>Conf.</th>
                    <th style={{ textAlign: 'right' }}>R:R</th>
                    <th style={{ textAlign: 'right' }}>Port. Fit</th>
                    <th>Risk</th>
                    <th>Stance</th>
                    <th style={{ textAlign: 'right' }}>{isClosed ? 'Entry' : 'LTP'}</th>
                    <th style={{ textAlign: 'right' }}>Chg %</th>
                    <th>Age</th>
                    <th>Why ranked here</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ltp = safeNum(r.ltp) ?? safeNum(r.entry_price);
                    const pct = safeNum(r.pct_change);
                    const conf = safeNum(r.confidence_score);
                    const final = safeNum(r.final_score);
                    const rr = safeNum(r.risk_reward);
                    const fit = safeNum(r.portfolio_fit_score);
                    const risk = safeNum(r.risk_score);
                    const age = safeNum(r.signal_age_min);
                    return (
                      <tr key={`${r.symbol}-${r.id}-${r.rank_position}`}>
                        <td style={{ fontWeight: 700, color: '#94A3B8' }}>{r.rank_position}</td>
                        <td><strong style={{ color: '#1E3A5F' }}>{r.symbol}</strong></td>
                        <td>{dirBadge(r.direction)}</td>
                        <td>{sourceBadge(r.source)}</td>
                        <td style={{ fontSize: 12, color: '#64748B' }}>{r.sector || '—'}</td>
                        <td style={{ fontSize: 11, color: '#64748B' }}>{fmt.truncate(r.strategy, 16) || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{r.opportunity_rank}</td>
                        <td style={{ textAlign: 'right' }}>{final != null ? final.toFixed(0) : '—'}</td>
                        <td>{convictionBadge(r.conviction_band)}</td>
                        <td style={{ textAlign: 'right' }}>{conf != null ? `${conf.toFixed(0)}%` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{rr != null ? rr.toFixed(1) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{fit != null ? fit.toFixed(0) : '—'}</td>
                        <td>{riskBadge(risk)}</td>
                        <td style={{ fontSize: 11, color: '#64748B' }}>{r.market_stance || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{ltp != null && ltp > 0 ? fmt.currency(ltp) : '—'}</td>
                        <td
                          style={{ textAlign: 'right' }}
                          className={pct != null ? changeClass(pct) : ''}
                        >
                          {pct != null ? fmt.percent(pct) : '—'}
                        </td>
                        <td style={{ fontSize: 11, color: '#64748B' }}>
                          {age != null ? `${age}m` : '—'}
                        </td>
                        <td style={{ fontSize: 11, color: '#475569', maxWidth: 280 }}>
                          <span title={r.rank_explanation} style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                            <Info size={12} style={{ flexShrink: 0, marginTop: 2, color: '#94A3B8' }} />
                            <span>{fmt.truncate(r.rank_explanation, 90)}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{
              padding: '12px 18px', borderTop: '1px solid #E2E8F0',
              display: 'flex', justifyContent: 'flex-end',
            }}>
              <Pagination page={page} totalPages={totalPages} onPage={(p) => setPage(p)} />
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

// ─── Sub-components ───────────────────────────────────────────────

function FilterSelect({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: string[] | Array<{ v: string; l: string }>;
  onChange: (v: string) => void;
}) {
  const normalized = options.map((o) =>
    typeof o === 'string' ? { v: o, l: o } : o,
  );
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      title={label}
      style={{
        padding: '6px 10px', fontSize: 12, borderRadius: 6,
        border: '1px solid #E2E8F0', background: 'white', color: '#334155',
        maxWidth: 140,
      }}
    >
      <option value="">{label}</option>
      {normalized.map((o) => (
        <option key={o.v} value={o.v}>{o.l}</option>
      ))}
    </select>
  );
}

function Pagination({
  page, totalPages, onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        style={{
          padding: '4px 8px', border: '1px solid #E2E8F0', borderRadius: 6,
          background: 'white', cursor: page <= 1 ? 'not-allowed' : 'pointer',
          opacity: page <= 1 ? 0.5 : 1,
        }}
      >
        <ChevronLeft size={14} />
      </button>
      <span style={{ color: '#64748B' }}>Page {page} of {totalPages}</span>
      <button
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        style={{
          padding: '4px 8px', border: '1px solid #E2E8F0', borderRadius: 6,
          background: 'white', cursor: page >= totalPages ? 'not-allowed' : 'pointer',
          opacity: page >= totalPages ? 0.5 : 1,
        }}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}
