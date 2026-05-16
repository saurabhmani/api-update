// ════════════════════════════════════════════════════════════════
//  Manipulation Signal Risk — utility shared by Signal Engine,
//  Due Diligence, Daily Report, Backtesting, and Engine Health.
//
//  This module is the canonical place for:
//    (a) the policy that maps (band, freshness) → recommendedAction
//        and canAffectApproval flag;
//    (b) the dynamic-from-DB risk computation per symbol, derived from
//        q365_manipulation_snapshots + q365_manipulation_events;
//    (c) the wire shape that ships on every signal as `manipulationRisk`.
//
//  Hard policy guarantees (callers can rely on these unconditionally):
//    - canAffectApproval is true ONLY when freshnessStatus === 'FRESH'
//      AND band ∈ {ELEVATED, HIGH, SEVERE}.
//    - Stale, no-data, partial, or unknown freshness can never produce
//      a recommendedAction stronger than 'WARNING_ONLY'.
//    - The utility never invents events, scores, or scan dates. When
//      data is missing the envelope reports band='UNKNOWN' and
//      freshnessStatus='NO_DATA', and callers degrade to warning-only.
//
//  Why this lives under manipulation-engine/ and not under signals/:
//    the policy is owned by the surveillance team. Signal Engine
//    consumes the envelope and the action — it does not decide the
//    risk model itself.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

// ── Type surface ───────────────────────────────────────────────────

export type FreshnessStatus  = 'FRESH' | 'STALE' | 'NO_DATA' | 'PARTIAL' | 'UNKNOWN';
export type RiskBand         = 'LOW' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'SEVERE' | 'UNKNOWN';
export type RecommendedAction =
  | 'NO_IMPACT'
  | 'WARNING_ONLY'
  | 'PENALIZE'
  | 'RISK_RESTRICT'
  | 'BLOCK_APPROVAL';

export interface FreshnessEnvelope {
  latestEventDate:   string | null;
  latestCandleDate:  string | null;
  latestScanAt:      string | null;
  latestTradingDate: string | null;
  isStale:           boolean;
  daysLag:           number | null;
  status:            FreshnessStatus;
  reason:            string;
}

/**
 * Per-signal manipulation risk envelope. Attached to every approved /
 * high-potential / watchlist / rejected / nearest signal so wire
 * consumers can render the badge and DD pane uniformly.
 */
export interface ManipulationRisk {
  score:             number | null;
  band:              RiskBand;
  freshnessStatus:   FreshnessStatus;
  latestEventDate:   string | null;
  latestScanAt:      string | null;
  dominantPatterns:  string[];
  alertCount:        number;
  criticalCount:     number;
  recommendedAction: RecommendedAction;
  canAffectApproval: boolean;
  explanation:       string;
  evidence:          string[];
}

// ── Constants ──────────────────────────────────────────────────────

/** 3 trading-days of lag against the latest EOD candle = STALE. */
export const FRESH_DAYS_THRESHOLD = 3;

const UNKNOWN_RISK: ManipulationRisk = {
  score:             null,
  band:              'UNKNOWN',
  freshnessStatus:   'NO_DATA',
  latestEventDate:   null,
  latestScanAt:      null,
  dominantPatterns:  [],
  alertCount:        0,
  criticalCount:     0,
  recommendedAction: 'NO_IMPACT',
  canAffectApproval: false,
  explanation:       'No manipulation snapshot exists for this symbol.',
  evidence:          [],
};

// ── Policy ─────────────────────────────────────────────────────────

export function scoreToRiskBand(score: number | null | undefined): RiskBand {
  if (score == null || !Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 85) return 'SEVERE';
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'ELEVATED';
  if (score >= 25) return 'WATCH';
  return 'LOW';
}

/**
 * Single source of truth for the action-policy decision. Stale,
 * no-data, partial, or unknown freshness collapse every elevated band
 * to WARNING_ONLY — this is the hard rule that prevents stale data
 * from hard-rejecting signals.
 */
export function recommendedActionFor(
  band: RiskBand,
  freshness: FreshnessStatus,
): RecommendedAction {
  if (freshness !== 'FRESH') {
    if (band === 'LOW' || band === 'UNKNOWN') return 'NO_IMPACT';
    // ELEVATED / HIGH / SEVERE / WATCH all degrade to WARNING_ONLY
    // when freshness is anything other than FRESH.
    return 'WARNING_ONLY';
  }
  switch (band) {
    case 'SEVERE':   return 'BLOCK_APPROVAL';
    case 'HIGH':     return 'RISK_RESTRICT';
    case 'ELEVATED': return 'PENALIZE';
    case 'WATCH':    return 'WARNING_ONLY';
    case 'LOW':
    case 'UNKNOWN':
    default:         return 'NO_IMPACT';
  }
}

export function canAffectApprovalFor(
  band: RiskBand,
  freshness: FreshnessStatus,
): boolean {
  return freshness === 'FRESH' &&
    (band === 'ELEVATED' || band === 'HIGH' || band === 'SEVERE');
}

export function applyManipulationPolicy(risk: ManipulationRisk): ManipulationRisk {
  const recommendedAction = recommendedActionFor(risk.band, risk.freshnessStatus);
  const canAffectApproval = canAffectApprovalFor(risk.band, risk.freshnessStatus);
  return { ...risk, recommendedAction, canAffectApproval };
}

// ── Internal helpers ───────────────────────────────────────────────

function toIsoDate(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.split('T')[0];
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return null;
}

function toIsoDateTime(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.includes('T') ? v : new Date(v).toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

function dayDiff(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null;
  return Math.round((db - da) / 86_400_000);
}

// ── Freshness probe ────────────────────────────────────────────────

/**
 * Cached global freshness envelope. The Phase-A /api/manipulation route
 * computes the same shape — we duplicate the small helper here so that
 * signal-engine code can import a pure lib module without reaching into
 * an API route. The cache is per-process and TTL-bounded so a polling
 * caller (signals API runs every few seconds) doesn't hit the DB on
 * every request.
 */
let _freshnessCache: { value: FreshnessEnvelope; expiresAt: number } | null = null;
const FRESHNESS_TTL_MS = 30_000;

export async function computeManipulationFreshness(): Promise<FreshnessEnvelope> {
  if (_freshnessCache && Date.now() < _freshnessCache.expiresAt) {
    return _freshnessCache.value;
  }

  let latestEventDate:  string | null = null;
  let latestCandleDate: string | null = null;
  let latestScanAt:     string | null = null;
  let snapshotCount30d = 0;

  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(event_date) AS d FROM q365_manipulation_events`,
    );
    latestEventDate = toIsoDate(rows?.[0]?.d ?? null);
  } catch {/* table may not exist on fresh DB — treat as no data */}

  try {
    const { rows } = await db.query<{ d: string | Date | null; n: number }>(
      `SELECT MAX(created_at) AS d, COUNT(*) AS n
         FROM q365_manipulation_snapshots
        WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    );
    latestScanAt = toIsoDateTime(rows?.[0]?.d ?? null);
    snapshotCount30d = Number(rows?.[0]?.n ?? 0);
  } catch {/* table may not exist */}

  try {
    const { rows } = await db.query<{ d: string | Date | null }>(
      `SELECT MAX(ts) AS d FROM candles
        WHERE candle_type = 'eod' AND interval_unit = '1day'`,
    );
    latestCandleDate = toIsoDate(rows?.[0]?.d ?? null);
  } catch {/* candles table missing — extremely unusual */}

  const refDate = latestCandleDate ?? toIsoDate(new Date());
  const daysLag = dayDiff(latestEventDate, refDate);

  let status: FreshnessStatus;
  let reason: string;
  if (!latestEventDate) {
    status = 'NO_DATA';
    reason = 'No manipulation events have been recorded. Run a scan to populate the surveillance surface.';
  } else if (daysLag != null && daysLag > FRESH_DAYS_THRESHOLD) {
    status = 'STALE';
    reason = `No fresh manipulation scan or candle data after ${latestEventDate}. ` +
             `Latest events are ${daysLag} day(s) behind latest candle date.`;
  } else if (snapshotCount30d === 0) {
    status = 'PARTIAL';
    reason = 'Manipulation events exist but no snapshot persisted in the last 30 days. ' +
             'Symbol-level risk view may be incomplete.';
  } else {
    status = 'FRESH';
    reason = `Latest event ${latestEventDate}, lag ${daysLag ?? 0} day(s) — within ${FRESH_DAYS_THRESHOLD}-day freshness window.`;
  }

  const envelope: FreshnessEnvelope = {
    latestEventDate,
    latestCandleDate,
    latestScanAt,
    latestTradingDate: latestCandleDate,
    isStale: status === 'STALE',
    daysLag,
    status,
    reason,
  };

  _freshnessCache = { value: envelope, expiresAt: Date.now() + FRESHNESS_TTL_MS };
  return envelope;
}

/** Test/tooling-only — force a re-fetch on the next call. */
export function clearManipulationFreshnessCache(): void { _freshnessCache = null; }

// ── Risk envelope builders ─────────────────────────────────────────

/**
 * Build a single-symbol risk envelope from raw snapshot/event aggregates
 * + a precomputed freshness. Pure function — separated from DB I/O so
 * it can be unit-tested without a database.
 */
export function buildManipulationRiskEnvelope(args: {
  symbol:             string;
  manipulationScore:  number | null;
  latestEventDate:    string | null;
  latestScanAt:       string | null;
  dominantPatterns:   string[];
  alertCount:         number;
  criticalCount:      number;
  globalFreshness:    FreshnessEnvelope;
}): ManipulationRisk {
  const band = scoreToRiskBand(args.manipulationScore);

  // Per-symbol freshness — a symbol can be stale even when the global
  // surface is fresh, if its specific events are old.
  const lag = dayDiff(args.latestEventDate, args.globalFreshness.latestCandleDate);
  const freshness: FreshnessStatus =
    !args.latestEventDate ? 'NO_DATA'
    : lag != null && lag > FRESH_DAYS_THRESHOLD ? 'STALE'
    : args.globalFreshness.status === 'PARTIAL' ? 'PARTIAL'
    : args.globalFreshness.status === 'FRESH' ? 'FRESH'
    : args.globalFreshness.status;

  const recommendedAction = recommendedActionFor(band, freshness);
  const canAffectApproval = canAffectApprovalFor(band, freshness);

  // Safe wording — never claim manipulation is a proven fact.
  const evidence: string[] = [];
  if (args.alertCount > 0) {
    evidence.push(`${args.alertCount} historical alert${args.alertCount === 1 ? '' : 's'} detected on ${args.symbol}`);
  }
  if (args.criticalCount > 0) {
    evidence.push(`${args.criticalCount} critical-severity event${args.criticalCount === 1 ? '' : 's'} on record`);
  }
  if (args.dominantPatterns.length > 0) {
    evidence.push(`Dominant patterns: ${args.dominantPatterns.slice(0, 3).map((p) => p.replace(/_/g, ' ')).join(', ')}`);
  }
  if (args.latestEventDate) {
    evidence.push(`Latest event: ${args.latestEventDate}`);
  }
  if (freshness !== 'FRESH') {
    evidence.push(`Freshness: ${freshness} — recommended action capped at WARNING_ONLY`);
  }

  let explanation: string;
  if (band === 'UNKNOWN' || freshness === 'NO_DATA') {
    explanation = 'No manipulation snapshot available for this symbol.';
  } else if (freshness !== 'FRESH') {
    explanation = `Historical manipulation risk exists (band ${band}, score ${args.manipulationScore ?? '—'}). ` +
                  `Data is ${freshness.toLowerCase()}, so the manipulation gate is in warning-only mode.`;
  } else {
    switch (recommendedAction) {
      case 'BLOCK_APPROVAL':
        explanation = `Fresh severe manipulation risk detected on ${args.symbol} (score ${args.manipulationScore}). ` +
                      'Approval is blocked pending review.';
        break;
      case 'RISK_RESTRICT':
        explanation = `Fresh high manipulation risk detected on ${args.symbol} (score ${args.manipulationScore}). ` +
                      'Signal moved to risk-restricted; manual review required.';
        break;
      case 'PENALIZE':
        explanation = `Fresh elevated manipulation risk on ${args.symbol} (score ${args.manipulationScore}). ` +
                      'Warning attached; approval thresholds not modified.';
        break;
      case 'WARNING_ONLY':
        explanation = `Manipulation watch flag on ${args.symbol} (band ${band}). Warning only.`;
        break;
      case 'NO_IMPACT':
      default:
        explanation = `Manipulation surveillance shows ${band.toLowerCase()} risk for ${args.symbol}. No impact on approval.`;
    }
  }

  return {
    score: args.manipulationScore,
    band,
    freshnessStatus: freshness,
    latestEventDate: args.latestEventDate,
    latestScanAt:    args.latestScanAt,
    dominantPatterns: args.dominantPatterns,
    alertCount:      args.alertCount,
    criticalCount:   args.criticalCount,
    recommendedAction,
    canAffectApproval,
    explanation,
    evidence,
  };
}

// ── DB-backed lookups ──────────────────────────────────────────────

/**
 * Batch fetch manipulation risk for many symbols in two queries:
 * latest snapshot per symbol + event aggregates. Returns a Map keyed by
 * symbol (uppercased). Symbols with no data still appear in the map
 * with an UNKNOWN envelope so callers can rely on `map.get(sym)`
 * returning a value rather than undefined.
 */
export async function getManipulationRiskForSymbols(
  rawSymbols: ReadonlyArray<string>,
): Promise<Map<string, ManipulationRisk>> {
  const symbols = Array.from(new Set(rawSymbols.map((s) => String(s ?? '').toUpperCase()))).filter(Boolean);
  const result = new Map<string, ManipulationRisk>();
  if (symbols.length === 0) return result;

  const freshness = await computeManipulationFreshness().catch(() => ({
    latestEventDate: null, latestCandleDate: null, latestScanAt: null, latestTradingDate: null,
    isStale: false, daysLag: null, status: 'NO_DATA' as FreshnessStatus,
    reason: 'Freshness probe failed.',
  }));

  // Snapshot per symbol — latest snapshot_date carries the band/score.
  const snapshotBySymbol = new Map<string, { score: number | null; scanAt: string | null }>();
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const { rows } = await db.query<any>(
      `SELECT s.symbol, s.manipulation_score, s.created_at
         FROM q365_manipulation_snapshots s
         JOIN (
                SELECT symbol, MAX(snapshot_date) AS d
                  FROM q365_manipulation_snapshots
                 WHERE symbol IN (${placeholders})
                 GROUP BY symbol
              ) latest
           ON latest.symbol = s.symbol AND latest.d = s.snapshot_date`,
      symbols,
    );
    for (const r of (rows ?? []) as any[]) {
      snapshotBySymbol.set(String(r.symbol).toUpperCase(), {
        score:  Number(r.manipulation_score ?? 0),
        scanAt: toIsoDateTime(r.created_at),
      });
    }
  } catch {/* table missing → leave map empty */}

  // Event aggregates per symbol.
  const eventBySymbol = new Map<string, {
    alertCount: number; criticalCount: number; latestEventDate: string | null; patterns: string[];
  }>();
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const { rows } = await db.query<any>(
      `SELECT symbol,
              COUNT(*) AS alert_count,
              SUM(CASE WHEN severity IN ('severe','high','critical') THEN 1 ELSE 0 END) AS critical_count,
              MAX(event_date) AS latest_event_date,
              GROUP_CONCAT(DISTINCT event_type ORDER BY event_type) AS patterns
         FROM q365_manipulation_events
        WHERE symbol IN (${placeholders})
        GROUP BY symbol`,
      symbols,
    );
    for (const r of (rows ?? []) as any[]) {
      eventBySymbol.set(String(r.symbol).toUpperCase(), {
        alertCount:      Number(r.alert_count ?? 0),
        criticalCount:   Number(r.critical_count ?? 0),
        latestEventDate: toIsoDate(r.latest_event_date),
        patterns:        String(r.patterns ?? '').split(',').filter(Boolean).slice(0, 5),
      });
    }
  } catch {/* table missing */}

  for (const symbol of symbols) {
    const snap = snapshotBySymbol.get(symbol);
    const ev   = eventBySymbol.get(symbol);

    if (!snap && !ev) {
      result.set(symbol, { ...UNKNOWN_RISK });
      continue;
    }

    result.set(symbol, buildManipulationRiskEnvelope({
      symbol,
      manipulationScore: snap?.score ?? null,
      latestEventDate:   ev?.latestEventDate ?? null,
      latestScanAt:      snap?.scanAt ?? null,
      dominantPatterns:  ev?.patterns ?? [],
      alertCount:        ev?.alertCount ?? 0,
      criticalCount:     ev?.criticalCount ?? 0,
      globalFreshness:   freshness,
    }));
  }

  return result;
}

/** Convenience single-symbol wrapper. */
export async function getManipulationRiskForSymbol(symbol: string): Promise<ManipulationRisk> {
  const map = await getManipulationRiskForSymbols([symbol]);
  return map.get(String(symbol ?? '').toUpperCase()) ?? { ...UNKNOWN_RISK };
}

/**
 * Attach a manipulation risk envelope to any object that has a
 * `symbol` / `tradingsymbol` field. Mutation is by spread so the caller
 * doesn't change in place — keeps row identity-checks safe.
 */
export function attachManipulationRiskToSignal<T extends { symbol?: string | null; tradingsymbol?: string | null }>(
  signal: T,
  riskMap: ReadonlyMap<string, ManipulationRisk>,
): T & { manipulationRisk: ManipulationRisk } {
  const sym = String(signal.symbol ?? signal.tradingsymbol ?? '').toUpperCase();
  const risk = riskMap.get(sym) ?? { ...UNKNOWN_RISK };
  return { ...signal, manipulationRisk: risk };
}

// ── Aggregate summary for daily report / dashboards ────────────────

export interface ManipulationImpactSummary {
  totalSymbolsChecked:      number;
  cleanSymbols:             number;
  watchSymbols:             number;
  elevatedRiskSymbols:      number;
  highRiskSymbols:          number;
  severeRiskSymbols:        number;
  staleRiskSymbols:         number;
  unknownSymbols:           number;
  candidatesWarned:         number;
  candidatesPenalized:      number;
  candidatesRiskRestricted: number;
  candidatesBlocked:        number;
  warningOnlyCount:         number;
  topManipulationPatterns:  Array<{ pattern: string; count: number; avgScore: number | null }>;
  filterEffectivenessNote:  string;
  dataStatus:               FreshnessStatus;
}

/**
 * Build the manipulationFilterImpact block used by the daily report
 * and surveillance dashboards. Pure aggregation — does not touch the DB.
 */
export function summarizeManipulationImpact(
  signals: ReadonlyArray<{ manipulationRisk?: ManipulationRisk }>,
  globalFreshness: FreshnessEnvelope,
): ManipulationImpactSummary {
  let cleanSymbols           = 0;
  let watchSymbols           = 0;
  let elevatedRiskSymbols    = 0;
  let highRiskSymbols        = 0;
  let severeRiskSymbols      = 0;
  let staleRiskSymbols       = 0;
  let unknownSymbols         = 0;
  let candidatesWarned       = 0;
  let candidatesPenalized    = 0;
  let candidatesRiskRestricted = 0;
  let candidatesBlocked      = 0;
  let warningOnlyCount       = 0;

  const patternCounts: Record<string, { count: number; scoreSum: number; scoreN: number }> = {};

  for (const s of signals) {
    const r = s.manipulationRisk;
    if (!r) { unknownSymbols++; continue; }

    switch (r.band) {
      case 'LOW':      cleanSymbols++;        break;
      case 'WATCH':    watchSymbols++;        break;
      case 'ELEVATED': elevatedRiskSymbols++; break;
      case 'HIGH':     highRiskSymbols++;     break;
      case 'SEVERE':   severeRiskSymbols++;   break;
      case 'UNKNOWN':  unknownSymbols++;      break;
    }

    if (r.freshnessStatus === 'STALE' && r.band !== 'LOW' && r.band !== 'UNKNOWN') {
      staleRiskSymbols++;
    }

    switch (r.recommendedAction) {
      case 'BLOCK_APPROVAL': candidatesBlocked++;      break;
      case 'RISK_RESTRICT':  candidatesRiskRestricted++; break;
      case 'PENALIZE':       candidatesPenalized++;     break;
      case 'WARNING_ONLY':   warningOnlyCount++; candidatesWarned++; break;
      case 'NO_IMPACT':
      default: break;
    }

    for (const p of r.dominantPatterns ?? []) {
      const key = String(p);
      if (!patternCounts[key]) patternCounts[key] = { count: 0, scoreSum: 0, scoreN: 0 };
      patternCounts[key].count++;
      if (r.score != null) {
        patternCounts[key].scoreSum += r.score;
        patternCounts[key].scoreN++;
      }
    }
  }

  const topManipulationPatterns = Object.entries(patternCounts)
    .map(([pattern, v]) => ({
      pattern,
      count:    v.count,
      avgScore: v.scoreN > 0 ? Math.round((v.scoreSum / v.scoreN) * 100) / 100 : null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  let filterEffectivenessNote: string;
  if (globalFreshness.status !== 'FRESH') {
    filterEffectivenessNote =
      'Manipulation filter is warning-only because latest manipulation data is stale.';
  } else if (signals.length === 0) {
    filterEffectivenessNote =
      'No signals were evaluated against the manipulation filter this cycle.';
  } else {
    filterEffectivenessNote =
      'Effectiveness cannot be calculated yet because outcome/history data is insufficient.';
  }

  return {
    totalSymbolsChecked: signals.length,
    cleanSymbols, watchSymbols, elevatedRiskSymbols, highRiskSymbols,
    severeRiskSymbols, staleRiskSymbols, unknownSymbols,
    candidatesWarned, candidatesPenalized, candidatesRiskRestricted,
    candidatesBlocked, warningOnlyCount,
    topManipulationPatterns,
    filterEffectivenessNote,
    dataStatus: globalFreshness.status,
  };
}
