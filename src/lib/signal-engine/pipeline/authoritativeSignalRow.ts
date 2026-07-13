// ════════════════════════════════════════════════════════════════
//  Authoritative signal row selection — shared by readSignals and
//  revalidateInstrument so the signals table and detail page resolve
//  the same q365_signals row for a symbol.
//
//  Root cause (Phase 1): loadLatestStored used generated_at DESC,
//  which picked a newer low-score SELL row while getActiveSignals
//  surfaced an older higher-score BUY row (LGEINDIA, PFC).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

/** Ranking used by getActiveSignals inner window — do not change without
 *  updating both paths and docs/product-a/data-integrity.md. */
export const AUTHORITATIVE_SIGNAL_ORDER_SQL =
  's.final_score DESC, s.opportunity_score DESC, s.generated_at DESC';

function signalRelaxMode(): boolean {
  return String(process.env.SIGNAL_RELAX_MODE ?? '').trim().toLowerCase() === 'true';
}

function signalStatusSql(alias = 's'): string {
  return signalRelaxMode()
    ? `AND (${alias}.signal_status IS NULL OR ${alias}.signal_status IN ('APPROVED_SIGNAL', 'DEVELOPING_SETUP'))`
    : `AND (${alias}.signal_status IS NULL OR ${alias}.signal_status = 'APPROVED_SIGNAL')`;
}

const HARD_INVALIDATION_EXCLUSIONS = [
  'stop_loss_broken',
  'stop_loss_broken_confirmed',
  'target_reached',
  'target_already_reached',
  'engine_disagree',
  'live_rejected',
] as const;

export interface AuthoritativeSignalRowOpts {
  /** When set, only rows with this direction are considered. */
  direction?: 'BUY' | 'SELL';
}

export interface AuthoritativeSignalRow {
  id:                  number;
  symbol:              string;
  instrument_key:      string;
  exchange:            string | null;
  direction:           string | null;
  signal_type:         string | null;
  confidence_score:    number | null;
  confidence_band:     string | null;
  risk_score:          number | null;
  risk_band:           string | null;
  opportunity_score:   number | null;
  portfolio_fit_score: number | null;
  regime_alignment:    number | null;
  entry_price:         number | null;
  stop_loss:           number | null;
  target1:             number | null;
  target2:             number | null;
  risk_reward:         number | null;
  market_regime:       string | null;
  market_stance:       string | null;
  scenario_tag:        string | null;
  status:              string | null;
  signal_status:       string | null;
  generated_at:        string | null;
  invalidation_reason: string | null;
}

/**
 * Load the single authoritative q365_signals row for a symbol using
 * the same filters and ranking as the /signals table read path.
 */
export async function getAuthoritativeSignalRow(
  symbol: string,
  instrumentKey: string,
  opts: AuthoritativeSignalRowOpts = {},
): Promise<AuthoritativeSignalRow | null> {
  const sym = String(symbol ?? '').trim().toUpperCase();
  const ikey = String(instrumentKey ?? '').trim();
  if (!sym) return null;

  const dirClause = opts.direction
    ? 'AND s.direction = ?'
    : '';
  const params: Array<string> = [ikey, sym, ...HARD_INVALIDATION_EXCLUSIONS];
  if (opts.direction) params.push(opts.direction);

  const invalidPlaceholders = HARD_INVALIDATION_EXCLUSIONS.map(() => '?').join(', ');

  const { rows } = await db.query<any>(
    `SELECT
       s.id, s.symbol, s.instrument_key, s.exchange,
       s.direction, s.signal_type,
       s.confidence_score, s.confidence_band,
       s.risk_score, s.risk_band, s.opportunity_score,
       s.portfolio_fit_score, s.regime_alignment,
       s.entry_price, s.stop_loss, s.target1, s.target2, s.risk_reward,
       s.market_regime, s.market_stance, s.scenario_tag,
       s.status, s.signal_status, s.generated_at, s.invalidation_reason
     FROM q365_signals s
     WHERE (s.instrument_key = ? OR s.symbol = ?)
       AND s.status IN ('active', 'watchlist', 'flagged', 'stale')
       AND (
         s.invalidation_reason IS NULL
         OR s.invalidation_reason NOT IN (${invalidPlaceholders})
       )
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND (s.decay_state IS NULL OR s.decay_state <> 'expired')
       ${signalStatusSql('s')}
       AND (s.final_score IS NULL OR s.final_score >= 30)
       ${dirClause}
     ORDER BY ${AUTHORITATIVE_SIGNAL_ORDER_SQL}
     LIMIT 1`,
    params,
  );

  if (!rows.length) return null;
  const r = rows[0];
  return {
    id:                  Number(r.id),
    symbol:              String(r.symbol ?? sym),
    instrument_key:      String(r.instrument_key ?? ikey),
    exchange:            r.exchange ? String(r.exchange) : null,
    direction:           r.direction ? String(r.direction) : null,
    signal_type:         r.signal_type ? String(r.signal_type) : null,
    confidence_score:    r.confidence_score != null ? Number(r.confidence_score) : null,
    confidence_band:     r.confidence_band ? String(r.confidence_band) : null,
    risk_score:          r.risk_score != null ? Number(r.risk_score) : null,
    risk_band:           r.risk_band ? String(r.risk_band) : null,
    opportunity_score:   r.opportunity_score != null ? Number(r.opportunity_score) : null,
    portfolio_fit_score: r.portfolio_fit_score != null ? Number(r.portfolio_fit_score) : null,
    regime_alignment:    r.regime_alignment != null ? Number(r.regime_alignment) : null,
    entry_price:         r.entry_price != null ? Number(r.entry_price) : null,
    stop_loss:           r.stop_loss != null ? Number(r.stop_loss) : null,
    target1:             r.target1 != null ? Number(r.target1) : null,
    target2:             r.target2 != null ? Number(r.target2) : null,
    risk_reward:         r.risk_reward != null ? Number(r.risk_reward) : null,
    market_regime:       r.market_regime ? String(r.market_regime) : null,
    market_stance:       r.market_stance ? String(r.market_stance) : null,
    scenario_tag:        r.scenario_tag ? String(r.scenario_tag) : null,
    status:              r.status ? String(r.status) : null,
    signal_status:       r.signal_status ? String(r.signal_status) : null,
    generated_at:        r.generated_at ? new Date(r.generated_at).toISOString() : null,
    invalidation_reason: r.invalidation_reason ? String(r.invalidation_reason) : null,
  };
}
