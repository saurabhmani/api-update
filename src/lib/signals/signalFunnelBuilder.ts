// ════════════════════════════════════════════════════════════════
//  signalFunnelBuilder — build the operator-facing funnel envelope
//  + the developing / deferred / rejected pools for /api/signals.
//
//  Spec INSTITUTIONAL §M (transparency):
//  the institutional `signals[]` array stays exactly as the strict
//  gate produced it — the new pools below are PARALLEL, additive
//  arrays so the UI's DEVELOPING / DEFERRED / REJECTED tabs can render
//  the rest of the engine output without bypassing any quality gate.
//
//  All reads come from the existing tables — no new schema, no new
//  writes. Pure async helper.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  toDisplayRow,
  type DisplayShape,
} from '@/lib/signals/signalDisplayShaper';

/** Spec INSTITUTIONAL §UX-SIMPLIFY (2026-05) — funnel envelope
 *  collapsed to the binary-bucket model: APPROVED vs REJECTED at the
 *  top, with the dominant rejection causes broken out for the operator
 *  funnel. DEVELOPING_SETUP and DEFERRED_WAIT_TRIGGER counts roll up
 *  into `rejected` (and surface as `rejected_other` when no specific
 *  cause matches). The detailed per-row `rejection_code` still carries
 *  the granular reason for the badge inside the REJECTED tab. */
export interface SignalFunnel {
  scanned:                  number;
  matched:                  number;
  approved:                 number;
  rejected:                 number;
  rejected_low_confidence:  number;
  rejected_rr:              number;
  rejected_market_regime:   number;
  rejected_stale:           number;
  rejected_stability:       number;
  rejected_other:           number;
  /** Window applied to `q365_signals.generated_at`. */
  window_minutes:           number;
}

interface BuildFunnelOpts {
  windowMinutes?: number;
  /** Cap for the developing/deferred/rejected pools. Each capped
   *  separately so a flood of one bucket doesn't starve the others. */
  poolLimit?:     number;
}

export interface SignalFunnelBundle {
  funnel:   SignalFunnel;
  /** Spec INSTITUTIONAL §UX-SIMPLIFY — single REJECTED pool. The union
   *  of (developing + deferred + rejected) ordered by recency. The
   *  per-row `rejection_code` distinguishes DEVELOPING_SETUP /
   *  DEFERRED_WAIT_TRIGGER / REJECTED_LOW_CONFIDENCE / etc as a
   *  sub-badge. */
  rejected: DisplayShape[];
}

interface CountRow {
  signal_status:        string | null;
  classification:       string | null;
  invalidation_reason:  string | null;
  cnt:                  number;
}

interface PoolRow {
  symbol:                  string;
  direction:               string | null;
  signal_status:           string | null;
  classification:          string | null;
  invalidation_reason:     string | null;
  confidence_score:        number | null;
  final_score:             number | string | null;
  risk_reward:             number | string | null;
  rr_ratio:                number | string | null;
  risk_score:              number | null;
  stress_survival_score:   number | string | null;
  market_regime:           string | null;
  scenario_tag:            string | null;
  status:                  string | null;
  generated_at:            Date | string | null;
  expires_at:              Date | string | null;
  live_valid:              number | null;
  rejection_codes_json:    unknown;
  rejection_reasons_json:  unknown;
}

function parseStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }
  return [];
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function poolRowToDisplay(r: PoolRow): DisplayShape {
  const rejectionReasons = parseStringArray(r.rejection_reasons_json);
  const rejectionCodes   = parseStringArray(r.rejection_codes_json);
  return toDisplayRow({
    symbol:                r.symbol,
    direction:             r.direction,
    classification:        r.classification,
    raw_classification:    r.classification,
    signal_status:         r.signal_status,
    status:                r.status,
    invalidation_reason:   r.invalidation_reason,
    live_valid:            r.live_valid,
    execution_allowed:
      String(r.signal_status ?? '').toUpperCase() === 'APPROVED_SIGNAL'
      && !r.invalidation_reason
      && (r.expires_at == null || new Date(r.expires_at).getTime() > Date.now()),
    rejection_reason:      rejectionReasons[0] ?? rejectionCodes[0] ?? null,
    rejection_codes:       rejectionCodes,
    scenario_tag:          r.scenario_tag,
    confidence_score:      r.confidence_score,
    confidence:            r.confidence_score,
    final_score:           num(r.final_score),
    rr_ratio:              num(r.rr_ratio ?? r.risk_reward),
    risk_reward:           num(r.risk_reward ?? r.rr_ratio),
    risk_score:            r.risk_score,
    stress_survival_score: num(r.stress_survival_score),
    market_regime:         r.market_regime,
    generated_at:          r.generated_at,
  });
}

const SELECT_COLS = `
  s.symbol, s.direction, s.signal_status, s.classification,
  s.invalidation_reason, s.confidence_score, s.final_score,
  s.risk_reward, s.risk_reward AS rr_ratio,
  s.risk_score, s.stress_survival_score,
  s.market_regime, s.scenario_tag, s.status,
  s.generated_at, s.expires_at, s.live_valid,
  s.rejection_codes_json, s.rejection_reasons_json`;

/**
 * Build the canonical funnel + the three additive pools in a single
 * call. Reads from q365_signals (all status values) within the lookback
 * window. Each pool is capped at `poolLimit` (default 50) and ordered
 * by recency so the UI sees the freshest rejections first.
 *
 * BUG-FIX (2026-05) — adaptive window: when the requested time-window
 * comes back empty BUT q365_signals has rows from an older batch
 * (e.g. auto-recovery batch from 6h ago), expand the window to cover
 * the latest batch so the funnel + REJECTED tab always reflect what
 * the scanner has actually produced. Without this, a healthy DB with
 * a stale-but-real latest batch would render funnel=zeros + REJECTED=
 * empty, which the user (correctly) read as "data are not showing".
 */
export async function buildSignalFunnel(
  opts: BuildFunnelOpts = {},
): Promise<SignalFunnelBundle> {
  const requestedWindowMin = Math.max(1, Math.min(1440, opts.windowMinutes ?? 60));
  const poolLimit = Math.max(5,  Math.min(500,  opts.poolLimit    ?? 50));

  // Adaptive window: if the requested window has no rows, expand to
  // cover the latest batch in q365_signals. Hard ceiling: 7 days
  // (any batch older than that is operationally dead).
  let windowMin = requestedWindowMin;
  let effectiveWindowSource: 'requested' | 'latest_batch' = 'requested';
  try {
    const { rows: probeRows } = await db.query<{ ts: Date | string | null; cnt: number }>(
      `SELECT MAX(generated_at) AS ts, COUNT(*) AS cnt
         FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [requestedWindowMin],
    );
    const probe = (probeRows[0] as any) ?? {};
    const cnt = Number(probe.cnt ?? 0);
    if (cnt === 0) {
      const { rows: latestRows } = await db.query<{ ts: Date | string | null }>(
        `SELECT MAX(generated_at) AS ts FROM q365_signals
          WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      );
      const latestTs = (latestRows[0] as any)?.ts;
      if (latestTs) {
        const ms = latestTs instanceof Date
          ? latestTs.getTime()
          : Date.parse(String(latestTs).replace(' ', 'T'));
        if (Number.isFinite(ms)) {
          // Set window to (now − latestBatchTs) + 5min slop, capped to 7d.
          const ageMin = Math.max(1, Math.ceil((Date.now() - ms) / 60_000) + 5);
          windowMin = Math.min(7 * 24 * 60, ageMin);
          effectiveWindowSource = 'latest_batch';
        }
      }
    }
  } catch (err: any) {
    console.warn('[FUNNEL] adaptive window probe failed:', err?.message);
  }

  const empty = (): SignalFunnel => ({
    scanned: 0, matched: 0, approved: 0, rejected: 0,
    rejected_low_confidence: 0, rejected_rr: 0,
    rejected_market_regime: 0, rejected_stale: 0,
    rejected_stability: 0, rejected_other: 0,
    window_minutes: windowMin,
  });

  // ── Aggregate counts ────────────────────────────────────────────
  let countRows: CountRow[] = [];
  try {
    const { rows } = await db.query<CountRow>(
      `SELECT signal_status, classification, invalidation_reason, COUNT(*) AS cnt
         FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
        GROUP BY signal_status, classification, invalidation_reason`,
      [windowMin],
    );
    countRows = rows as CountRow[];
  } catch {
    return { funnel: empty(), rejected: [] };
  }
  if (effectiveWindowSource === 'latest_batch') {
    console.log(`[FUNNEL] adaptive window expanded ${requestedWindowMin}min → ${windowMin}min (covering latest batch)`);
  }

  // Spec INSTITUTIONAL §UX-SIMPLIFY — binary count loop. Approved is
  // tradable institutional rows; everything else (NO_TRADE,
  // DEVELOPING_SETUP, WATCHLIST_ONLY, invalidated) rolls up into
  // `rejected`, broken out by the dominant cause for the funnel.
  const funnel = empty();
  for (const r of countRows) {
    const cnt = Number(r.cnt ?? 0);
    if (!Number.isFinite(cnt) || cnt === 0) continue;
    funnel.scanned += cnt;
    funnel.matched += cnt;
    const ss        = String(r.signal_status ?? '').toUpperCase();
    const cls       = String(r.classification ?? '').toUpperCase();
    const invReason = String(r.invalidation_reason ?? '').toLowerCase();

    // APPROVED — institutional whitelist + no invalidation.
    if (
      ss === 'APPROVED_SIGNAL' && !invReason
      && cls !== 'NO_TRADE' && cls !== 'WATCHLIST_ONLY' && cls !== 'DEVELOPING_SETUP'
    ) {
      funnel.approved += cnt;
      continue;
    }

    // Everything else = REJECTED. Bucket by dominant cause.
    funnel.rejected += cnt;
    if (invReason) {
      if (/stop_loss|target_reached|expired|stale/.test(invReason))           funnel.rejected_stale += cnt;
      else if (/regime|counter[- ]regime|capital[_ ]?preservation/.test(invReason)) funnel.rejected_market_regime += cnt;
      else if (/stability|unstable/.test(invReason))                          funnel.rejected_stability += cnt;
      else if (/reward[- ]?risk|\brr\b|risk[_ ]?reward/.test(invReason))      funnel.rejected_rr += cnt;
      else if (/confidence/.test(invReason))                                  funnel.rejected_low_confidence += cnt;
      else                                                                    funnel.rejected_other += cnt;
      continue;
    }
    // No invalidation — sub-bucket by classification / signal_status.
    // DEVELOPING_SETUP and WATCHLIST_ONLY are non-tradable engine
    // verdicts; surface them as 'other' so the funnel honestly reflects
    // "engine didn't reject for a specific score reason — it just
    // hasn't promoted this row yet".
    if (ss === 'DEVELOPING_SETUP' || cls === 'DEVELOPING_SETUP') {
      funnel.rejected_other += cnt;
      continue;
    }
    if (cls === 'WATCHLIST_ONLY') {
      funnel.rejected_other += cnt;
      continue;
    }
    if (cls === 'NO_TRADE') {
      // Without a specific reason on the row, NO_TRADE is most often
      // the engine's "score below floor" verdict — dominant cause is
      // low_confidence in production.
      funnel.rejected_low_confidence += cnt;
      continue;
    }
    funnel.rejected_other += cnt;
  }

  // Spec INSTITUTIONAL §UX-SIMPLIFY — single REJECTED pool.
  // Returns every row that did NOT pass the institutional whitelist
  // (NO_TRADE / DEVELOPING_SETUP / WATCHLIST_ONLY / invalidated)
  // ordered by recency. Per-row `rejection_code` distinguishes the
  // sub-cause for the badge inside the REJECTED tab.
  let rejected: DisplayShape[] = [];
  try {
    const { rows } = await db.query<PoolRow>(
      `SELECT ${SELECT_COLS} FROM q365_signals s
        WHERE s.generated_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          AND (
                UPPER(COALESCE(s.classification,  '')) IN ('NO_TRADE','WATCHLIST_ONLY','DEVELOPING_SETUP')
             OR UPPER(COALESCE(s.signal_status,   '')) IN ('NO_TRADE','DEVELOPING_SETUP')
             OR COALESCE(s.invalidation_reason, '') <> ''
          )
        ORDER BY s.generated_at DESC LIMIT ?`,
      [windowMin, poolLimit],
    );
    rejected = (rows as PoolRow[]).map(poolRowToDisplay);
  } catch {
    rejected = [];
  }

  return { funnel, rejected };
}
