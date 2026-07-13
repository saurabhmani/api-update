/**
 * Approved-signal opportunity leaderboard — ranks Phase-3 approved and
 * confirmed trading opportunities for the /rankings page.
 *
 * Data sources (priority order):
 *   1. ACTIVE confirmed snapshots (maturity-promoted, tradable now)
 *   2. q365_signals with signal_status = 'APPROVED_SIGNAL' (Phase-3
 *      gateway pass, not yet promoted to confirmed snapshots)
 */

import { db } from '@/lib/db';
import { computeOpportunityRank } from '@/services/rankingsService';
import type { RankedEntry } from '@/services/rankingsService';
import {
  getActiveConfirmedSnapshots,
  type ConfirmedSnapshotRow,
} from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import {
  strictApproved,
} from '@/lib/signals/confirmedSignalPolicy';
import { enrichWithLiveLtp } from '@/lib/signals/confirmedSignalsService';
import { resolveClosedSignalsMaxAgeHours } from '@/lib/signals/closedMarketSignals';

// ── Types ─────────────────────────────────────────────────────────

export type OpportunitySource = 'confirmed' | 'phase3_approved';

export interface OpportunityRankingRow {
  id:                    number;
  symbol:                string;
  name:                  string | null;
  exchange:              string;
  sector:                string | null;
  direction:             'BUY' | 'SELL';
  strategy:              string | null;
  timeframe:             string | null;
  classification:        string | null;
  conviction_band:       string | null;
  conviction_level:      string | null;

  opportunity_rank:      number;
  score:                 number | null;
  final_score:           number | null;
  confidence_score:      number | null;
  risk_score:            number | null;
  risk_reward:           number | null;
  portfolio_fit_score:   number | null;
  stress_survival_score: number | null;
  expected_edge_percent: number | null;
  maturity_score:        number | null;

  entry_price:           number | null;
  stop_loss:             number | null;
  target1:               number | null;
  market_stance:         string | null;
  regime:                string | null;

  ltp:                   number | null;
  pct_change:            number | null;
  livePrice:             number | null;
  livePChange:             number | null;
  liveSource:            string | null;

  signal_type:           'BUY' | 'SELL';
  signal_status:         string;
  source:                OpportunitySource;
  approved:              boolean;
  execution_allowed:     boolean;
  rank_position:         number;
  rank_explanation:      string;
  rank_factors:          string[];

  confirmed_at:          string | null;
  generated_at:          string | null;
  signal_age_min:        number | null;
  validation_cycles:     number | null;
  stability_passed:      boolean | null;
}

export interface OpportunityLeaderboardFilters {
  sector?:      string;
  exchange?:    string;
  direction?:   'BUY' | 'SELL';
  strategy?:    string;
  timeframe?:   string;
  conviction?:  string;
  risk?:        'low' | 'medium' | 'high';
  market?:      string;
  search?:      string;
  sort?:        'opportunity_rank' | 'confidence' | 'final_score' | 'risk' | 'freshness';
  sortDir?:     'asc' | 'desc';
}

export interface OpportunityLeaderboardResult {
  data:           OpportunityRankingRow[];
  total:          number;
  count:          number;
  page:           number;
  limit:          number;
  has_more:       boolean;
  confirmed_count: number;
  phase3_count:    number;
  filter_options: {
    sectors:     string[];
    strategies:  string[];
    timeframes:  string[];
    convictions: string[];
    exchanges:   string[];
  };
  sorted_by:      string;
  as_of:          string;
}

// ── Helpers ───────────────────────────────────────────────────────

const CONVICTION_RANK: Record<string, number> = {
  high_conviction: 4,
  institutional:   4,
  actionable:      3,
  medium:          3,
  watchlist:       2,
  low:             2,
  reject:          0,
};

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normSym(v: unknown): string {
  return String(v ?? '').toUpperCase().trim();
}

function convictionFromRow(
  convictionLevel: string | null | undefined,
  classification: string | null | undefined,
  confidence: number | null,
): string {
  const lvl = String(convictionLevel ?? '').toUpperCase();
  if (lvl === 'INSTITUTIONAL' || lvl === 'HIGH') return 'high_conviction';
  if (lvl === 'MEDIUM') return 'actionable';

  const cls = String(classification ?? '').toUpperCase();
  if (cls.includes('INSTITUTIONAL') || cls === 'HIGH_CONVICTION' || cls === 'HIGH_CONVICTION_BUY') {
    return 'high_conviction';
  }
  if (cls === 'VALID_SIGNAL' || cls === 'VALID_BUY' || cls === 'MEDIUM_CONVICTION') {
    return 'actionable';
  }
  if (confidence != null) {
    if (confidence >= 80) return 'high_conviction';
    if (confidence >= 65) return 'actionable';
    if (confidence >= 50) return 'watchlist';
  }
  return 'watchlist';
}

function mapSnapshotToRow(s: ConfirmedSnapshotRow, sector: string | null): OpportunityRankingRow {
  const conf = num(s.confidence_score);
  const final = num(s.final_score);
  const conviction = convictionFromRow(s.conviction_level, s.classification, conf);
  const factorScores = s.factor_scores ?? {};
  const portfolioFit = num(
    (factorScores as Record<string, unknown>).portfolio_fit
    ?? (factorScores as Record<string, unknown>).portfolio_fit_score,
  );
  const marketStance = String(
    (factorScores as Record<string, unknown>).market_stance
    ?? (s.explanation as Record<string, unknown> | null)?.market_stance
    ?? '',
  ) || null;

  const base: Partial<RankedEntry> = {
    score:               final ?? conf ?? 50,
    confidence_score:    conf,
    confidence:          conf,
    risk_score:          null,
    portfolio_fit_score: portfolioFit,
    conviction_band:     conviction,
    signal_type:         s.direction,
    market_stance:       marketStance ?? undefined,
  };
  const opportunityRank = computeOpportunityRank(base);

  return {
    id:                    s.id,
    symbol:                s.symbol,
    name:                  null,
    exchange:              s.exchange || 'NSE',
    sector,
    direction:             s.direction,
    strategy:              s.strategy,
    timeframe:             'intraday',
    classification:        s.classification,
    conviction_band:       conviction,
    conviction_level:      s.conviction_level,
    opportunity_rank:      opportunityRank,
    score:                 final,
    final_score:           final,
    confidence_score:      conf,
    risk_score:            null,
    risk_reward:           num(s.rr_ratio),
    portfolio_fit_score:   portfolioFit,
    stress_survival_score: num(s.stress_survival_score),
    expected_edge_percent: num(s.expected_edge_percent),
    maturity_score:        num(s.maturity_score),
    entry_price:           num(s.entry_price),
    stop_loss:             num(s.stop_loss),
    target1:               num(s.target1),
    market_stance:         marketStance,
    regime:                null,
    ltp:                   num(s.entry_price),
    pct_change:            null,
    livePrice:             s.livePrice ?? null,
    livePChange:           s.livePChange ?? null,
    liveSource:            s.liveSource ?? null,
    signal_type:           s.direction,
    signal_status:         'APPROVED_SIGNAL',
    source:                'confirmed',
    approved:              true,
    execution_allowed:     s.execution_allowed,
    rank_position:         0,
    rank_explanation:      '',
    rank_factors:          [],
    confirmed_at:          s.confirmed_at,
    generated_at:          s.confirmed_at,
    signal_age_min:        s.signal_age_minutes_at_promotion,
    validation_cycles:     num(s.validation_cycles_passed),
    stability_passed:      s.stability_passed,
  };
}

interface RawPhase3Row {
  id:                    number;
  symbol:                string;
  exchange:              string;
  direction:             string;
  signal_type:           string | null;
  classification:        string | null;
  confidence_score:      number;
  confidence_band:       string | null;
  risk_score:            number | null;
  final_score:           number | null;
  composite_final_score: number | null;
  risk_reward:           number | null;
  portfolio_fit_score:   number | null;
  stress_survival_score: number | null;
  opportunity_score:     number | null;
  market_stance:         string | null;
  market_regime:         string | null;
  timeframe:             string | null;
  entry_price:           number | null;
  stop_loss:             number | null;
  target1:               number | null;
  ltp:                   number | null;
  pct_change:            number | null;
  generated_at:          Date | string;
  mt_conviction_level:   string | null;
  mt_maturity_score:     number | null;
  mt_validation_cycles:  number | null;
  mt_stability_passed:   number | null;
  sector:                string | null;
}

function mapPhase3ToRow(r: RawPhase3Row): OpportunityRankingRow | null {
  const final = num(r.composite_final_score) ?? num(r.final_score) ?? num(r.confidence_score);
  const conf = num(r.confidence_score);
  const rr = num(r.risk_reward);
  if (conf == null || conf <= 0) return null;
  if (final == null || final <= 0) return null;

  const direction: 'BUY' | 'SELL' = String(r.direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const conviction = convictionFromRow(r.mt_conviction_level ?? r.confidence_band, r.classification, conf);
  const generatedMs = r.generated_at instanceof Date
    ? r.generated_at.getTime()
    : Date.parse(String(r.generated_at).replace(' ', 'T'));
  const ageMin = Number.isFinite(generatedMs)
    ? Math.max(0, Math.floor((Date.now() - generatedMs) / 60000))
    : null;

  const base: Partial<RankedEntry> = {
    score:               final,
    confidence_score:    conf,
    confidence:          conf,
    risk_score:          num(r.risk_score),
    portfolio_fit_score: num(r.portfolio_fit_score),
    conviction_band:     conviction,
    signal_type:         direction,
    market_stance:       r.market_stance ?? undefined,
    regime:              r.market_regime ?? undefined,
  };
  const opportunityRank = computeOpportunityRank(base);

  return {
    id:                    r.id,
    symbol:                r.symbol,
    name:                  null,
    exchange:              r.exchange || 'NSE',
    sector:                r.sector,
    direction,
    strategy:              r.signal_type,
    timeframe:             r.timeframe ?? 'intraday',
    classification:        r.classification,
    conviction_band:       conviction,
    conviction_level:      r.mt_conviction_level,
    opportunity_rank:      opportunityRank,
    score:                 final,
    final_score:           final,
    confidence_score:      conf,
    risk_score:            num(r.risk_score),
    risk_reward:           rr,
    portfolio_fit_score:   num(r.portfolio_fit_score),
    stress_survival_score: num(r.stress_survival_score),
    expected_edge_percent: null,
    maturity_score:        num(r.mt_maturity_score),
    entry_price:           num(r.entry_price),
    stop_loss:             num(r.stop_loss),
    target1:               num(r.target1),
    market_stance:         r.market_stance,
    regime:                r.market_regime,
    ltp:                   num(r.ltp) ?? num(r.entry_price),
    pct_change:            num(r.pct_change),
    livePrice:             null,
    livePChange:           null,
    liveSource:            null,
    signal_type:           direction,
    signal_status:         'APPROVED_SIGNAL',
    source:                'phase3_approved',
    approved:              true,
    execution_allowed:     true,
    rank_position:         0,
    rank_explanation:      '',
    rank_factors:          [],
    confirmed_at:          null,
    generated_at:          r.generated_at instanceof Date
      ? r.generated_at.toISOString()
      : String(r.generated_at),
    signal_age_min:        ageMin,
    validation_cycles:     num(r.mt_validation_cycles),
    stability_passed:      r.mt_stability_passed == null ? null : Number(r.mt_stability_passed) === 1,
  };
}

export function compareOpportunityRows(
  a: OpportunityRankingRow,
  b: OpportunityRankingRow,
): number {
  const orDiff = (b.opportunity_rank ?? 0) - (a.opportunity_rank ?? 0);
  if (orDiff !== 0) return orDiff;

  const cb = (CONVICTION_RANK[(b.conviction_band ?? '').toLowerCase()] ?? 1)
           - (CONVICTION_RANK[(a.conviction_band ?? '').toLowerCase()] ?? 1);
  if (cb !== 0) return cb;

  const cs = (b.confidence_score ?? -1) - (a.confidence_score ?? -1);
  if (cs !== 0) return cs;

  const pf = (b.portfolio_fit_score ?? -1) - (a.portfolio_fit_score ?? -1);
  if (pf !== 0) return pf;

  const ra = a.risk_score ?? Number.POSITIVE_INFINITY;
  const rb = b.risk_score ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;

  const fs = (b.final_score ?? -1) - (a.final_score ?? -1);
  if (fs !== 0) return fs;

  const at = a.confirmed_at ? Date.parse(a.confirmed_at) : (a.generated_at ? Date.parse(a.generated_at) : 0);
  const bt = b.confirmed_at ? Date.parse(b.confirmed_at) : (b.generated_at ? Date.parse(b.generated_at) : 0);
  if (bt !== at) return bt - at;

  return normSym(a.symbol).localeCompare(normSym(b.symbol));
}

function buildRankFactors(row: OpportunityRankingRow): string[] {
  const factors: string[] = [];
  if (row.source === 'confirmed') {
    factors.push('Maturity-confirmed snapshot (Phase 4 promoted)');
  } else {
    factors.push('Phase-3 approval gateway pass (awaiting promotion)');
  }
  if (row.final_score != null) factors.push(`Final score ${row.final_score.toFixed(0)}`);
  if (row.confidence_score != null) factors.push(`Confidence ${row.confidence_score.toFixed(0)}%`);
  if (row.conviction_band) factors.push(`Conviction: ${row.conviction_band.replace(/_/g, ' ')}`);
  if (row.risk_reward != null) factors.push(`R:R ${row.risk_reward.toFixed(1)}`);
  if (row.portfolio_fit_score != null) factors.push(`Portfolio fit ${row.portfolio_fit_score.toFixed(0)}`);
  if (row.risk_score != null) factors.push(`Risk ${row.risk_score.toFixed(0)}`);
  if (row.maturity_score != null) factors.push(`Maturity ${row.maturity_score.toFixed(0)}`);
  if (row.market_stance) factors.push(`Market stance: ${row.market_stance}`);
  if (row.stability_passed) factors.push('Stability validated');
  if (row.validation_cycles != null && row.validation_cycles >= 2) {
    factors.push(`${row.validation_cycles} validation cycles`);
  }
  return factors;
}

function buildRankExplanation(
  row: OpportunityRankingRow,
  position: number,
  above: OpportunityRankingRow | null,
): string {
  const factors = buildRankFactors(row);
  const headline = `Rank #${position} — Opportunity score ${row.opportunity_rank} from ${row.source === 'confirmed' ? 'confirmed' : 'Phase-3 approved'} ${row.direction} on ${row.symbol}.`;
  if (!above) {
    return `${headline} Top of leaderboard: ${factors.slice(0, 4).join('; ')}.`;
  }
  const gaps: string[] = [];
  const oppGap = above.opportunity_rank - row.opportunity_rank;
  if (oppGap > 0) gaps.push(`${oppGap} pts lower opportunity rank than #${position - 1}`);
  const confGap = (above.confidence_score ?? 0) - (row.confidence_score ?? 0);
  if (confGap >= 3) gaps.push(`confidence ${confGap.toFixed(0)} pts below leader`);
  const riskAbove = above.risk_score;
  const riskHere = row.risk_score;
  if (riskAbove != null && riskHere != null && riskHere - riskAbove >= 10) {
    gaps.push(`higher risk (+${(riskHere - riskAbove).toFixed(0)})`);
  }
  const whyBelow = gaps.length > 0 ? ` Behind #${position - 1}: ${gaps.join('; ')}.` : '';
  return `${headline} Key drivers: ${factors.slice(0, 3).join('; ')}.${whyBelow}`;
}

async function loadSectorMap(symbols: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!symbols.length) return map;
  const unique = [...new Set(symbols.map(normSym).filter(Boolean))];
  const ph = unique.map(() => '?').join(',');
  try {
    const { rows } = await db.query<{ tradingsymbol: string; sector: string | null }>(
      `SELECT tradingsymbol, sector FROM instruments WHERE tradingsymbol IN (${ph})`,
      unique,
    );
    for (const r of rows) {
      const sym = normSym(r.tradingsymbol);
      if (sym && r.sector) map.set(sym, r.sector);
    }
  } catch { /* non-fatal */ }
  return map;
}

async function loadPhase3Approved(
  excludeKeys: Set<string>,
  limit: number,
): Promise<OpportunityRankingRow[]> {
  const maxAgeH = resolveClosedSignalsMaxAgeHours();
  const sql = `
    SELECT
      s.id, s.symbol, s.exchange, s.direction, s.signal_type, s.classification,
      s.confidence_score, s.confidence_band, s.risk_score,
      s.final_score, s.composite_final_score, s.risk_reward,
      s.portfolio_fit_score, s.stress_survival_score, s.opportunity_score,
      s.market_stance, s.market_regime, s.timeframe,
      s.entry_price, s.stop_loss, s.target1, s.ltp, s.pct_change, s.generated_at,
      mt.conviction_level AS mt_conviction_level,
      mt.maturity_score   AS mt_maturity_score,
      mt.validation_cycles_passed AS mt_validation_cycles,
      mt.stable           AS mt_stability_passed
    FROM q365_signals s
    LEFT JOIN q365_signal_maturity_tracker mt
      ON mt.symbol = s.symbol AND mt.direction = s.direction
    WHERE s.direction IN ('BUY','SELL')
      AND UPPER(COALESCE(s.signal_status, '')) = 'APPROVED_SIGNAL'
      AND COALESCE(s.invalidation_reason, '') = ''
      AND UPPER(COALESCE(s.status, 'ACTIVE')) IN ('ACTIVE','')
      AND UPPER(COALESCE(s.classification, '')) NOT IN ('NO_TRADE', 'WATCHLIST_ONLY')
      AND s.generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
      AND COALESCE(s.signal_type, '') <> 'force_seed'
      AND COALESCE(s.batch_id, '') NOT LIKE 'force_seed%'
    ORDER BY COALESCE(s.composite_final_score, s.confidence_score, s.final_score, 0) DESC,
             s.confidence_score DESC, s.generated_at DESC
    LIMIT ?`;
  try {
    const { rows } = await db.query<RawPhase3Row>(sql, [
      maxAgeH,
      Math.min(limit, 500),
    ]);
    const sectorMap = await loadSectorMap(rows.map((r) => r.symbol));
    const out: OpportunityRankingRow[] = [];
    for (const r of rows) {
      const key = `${normSym(r.symbol)}|${String(r.direction).toUpperCase()}`;
      if (excludeKeys.has(key)) continue;
      r.sector = sectorMap.get(normSym(r.symbol)) ?? null;
      const mapped = mapPhase3ToRow(r);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch (err: unknown) {
    console.warn('[opportunityLeaderboard] phase3 load failed:', (err as Error)?.message);
    return [];
  }
}

function applyFilters(
  rows: OpportunityRankingRow[],
  filters: OpportunityLeaderboardFilters,
): OpportunityRankingRow[] {
  const search = (filters.search ?? '').trim().toUpperCase();
  return rows.filter((r) => {
    if (filters.exchange && normSym(r.exchange) !== normSym(filters.exchange)) return false;
    if (filters.direction && r.direction !== filters.direction) return false;
    if (filters.sector && (r.sector ?? '').toLowerCase() !== filters.sector.toLowerCase()) return false;
    if (filters.strategy && !(r.strategy ?? '').toLowerCase().includes(filters.strategy.toLowerCase())) return false;
    if (filters.timeframe && (r.timeframe ?? '').toLowerCase() !== filters.timeframe.toLowerCase()) return false;
    if (filters.conviction && (r.conviction_band ?? '').toLowerCase() !== filters.conviction.toLowerCase()) return false;
    if (filters.market && !(r.market_stance ?? '').toLowerCase().includes(filters.market.toLowerCase())) return false;
    if (filters.risk) {
      const risk = r.risk_score ?? 50;
      if (filters.risk === 'low' && risk >= 40) return false;
      if (filters.risk === 'medium' && (risk < 40 || risk >= 70)) return false;
      if (filters.risk === 'high' && risk < 70) return false;
    }
    if (search) {
      const hay = `${r.symbol} ${r.sector ?? ''} ${r.strategy ?? ''} ${r.classification ?? ''}`.toUpperCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function applySort(
  rows: OpportunityRankingRow[],
  sort: OpportunityLeaderboardFilters['sort'],
  sortDir: 'asc' | 'desc',
): OpportunityRankingRow[] {
  if (!sort || sort === 'opportunity_rank') {
    const sorted = [...rows].sort(compareOpportunityRows);
    return sortDir === 'asc' ? sorted.reverse() : sorted;
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av = 0;
    let bv = 0;
    switch (sort) {
      case 'confidence':    av = a.confidence_score ?? 0; bv = b.confidence_score ?? 0; break;
      case 'final_score':   av = a.final_score ?? 0; bv = b.final_score ?? 0; break;
      case 'risk':          av = a.risk_score ?? 999; bv = b.risk_score ?? 999; break;
      case 'freshness': {
        const at = a.confirmed_at ? Date.parse(a.confirmed_at) : (a.generated_at ? Date.parse(a.generated_at) : 0);
        const bt = b.confirmed_at ? Date.parse(b.confirmed_at) : (b.generated_at ? Date.parse(b.generated_at) : 0);
        av = at; bv = bt; break;
      }
      default: return compareOpportunityRows(a, b);
    }
    if (av !== bv) return sort === 'risk' ? (av - bv) * dir : (bv - av) * dir;
    return compareOpportunityRows(a, b);
  });
}

function collectFilterOptions(rows: OpportunityRankingRow[]) {
  const sectors = new Set<string>();
  const strategies = new Set<string>();
  const timeframes = new Set<string>();
  const convictions = new Set<string>();
  const exchanges = new Set<string>();
  for (const r of rows) {
    if (r.sector) sectors.add(r.sector);
    if (r.strategy) strategies.add(r.strategy);
    if (r.timeframe) timeframes.add(r.timeframe);
    if (r.conviction_band) convictions.add(r.conviction_band);
    if (r.exchange) exchanges.add(r.exchange);
  }
  const sortAlpha = (a: string, b: string) => a.localeCompare(b);
  return {
    sectors:     [...sectors].sort(sortAlpha),
    strategies:  [...strategies].sort(sortAlpha),
    timeframes:  [...timeframes].sort(sortAlpha),
    convictions: [...convictions].sort(sortAlpha),
    exchanges:   [...exchanges].sort(sortAlpha),
  };
}

const SORTED_BY_LABEL =
  'opportunity_rank DESC, conviction, confidence DESC, portfolio_fit DESC, risk ASC, final_score DESC';

export async function loadOpportunityLeaderboard(opts: {
  limit?:   number;
  page?:    number;
  filters?: OpportunityLeaderboardFilters;
  enrichLive?: boolean;
}): Promise<OpportunityLeaderboardResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const page  = Math.max(opts.page ?? 1, 1);
  const filters = opts.filters ?? {};

  const snapshots = await getActiveConfirmedSnapshots({ limit: 500 });
  const sectorMap = await loadSectorMap(snapshots.map((s) => s.symbol));

  const confirmedRows: OpportunityRankingRow[] = [];
  const shippedKeys = new Set<string>();

  for (const snap of snapshots) {
    if (!strictApproved(snap)) continue;
    const sector = sectorMap.get(normSym(snap.symbol)) ?? null;
    const row = mapSnapshotToRow(snap, sector);
    confirmedRows.push(row);
    shippedKeys.add(`${normSym(snap.symbol)}|${snap.direction}`);
  }

  const phase3Rows = await loadPhase3Approved(shippedKeys, 300);
  let allRows = [...confirmedRows, ...phase3Rows];

  if (opts.enrichLive !== false && allRows.length > 0) {
    await enrichWithLiveLtp(allRows);
    for (const r of allRows) {
      if (r.livePrice != null && r.livePrice > 0) {
        r.ltp = r.livePrice;
        if (r.livePChange != null) r.pct_change = r.livePChange;
      }
    }
  }

  const filterOptions = collectFilterOptions(allRows);
  const filtered = applyFilters(allRows, filters);
  const sorted = applySort(filtered, filters.sort, filters.sortDir ?? 'desc');

  const total = sorted.length;
  const offset = (page - 1) * limit;
  const pageRows = sorted.slice(offset, offset + limit);

  let prev: OpportunityRankingRow | null = offset > 0 ? sorted[offset - 1] : null;
  for (let i = 0; i < pageRows.length; i++) {
    const globalPos = offset + i + 1;
    const row = pageRows[i];
    row.rank_position = globalPos;
    row.rank_factors = buildRankFactors(row);
    row.rank_explanation = buildRankExplanation(row, globalPos, prev);
    prev = row;
  }

  return {
    data:            pageRows,
    total,
    count:           pageRows.length,
    page,
    limit,
    has_more:        offset + pageRows.length < total,
    confirmed_count: confirmedRows.length,
    phase3_count:    phase3Rows.length,
    filter_options:  filterOptions,
    sorted_by:       SORTED_BY_LABEL,
    as_of:           new Date().toISOString(),
  };
}
