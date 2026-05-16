/**
 * Stock Detail Service
 *
 * Returns a complete stock detail payload for a given NSE symbol.
 * Read priority for every field:
 *
 *   LTP / Day High / Low / 52W data
 *     1. Redis  key: stock:{SYMBOL}         (MarketSnapshot, TTL 60s)
 *     2. Redis  key: nse:/quote-equity?symbol={SYMBOL}  (raw NSE cache)
 *     3. MySQL  candles — latest close + MAX/MIN over 365 days
 *
 *   Candles (OHLCV history)
 *     1. Redis  key: stock:candles:{SYMBOL}:{interval}  (TTL 120s)
 *     2. MySQL  candles table — keyed by instrument_key
 *
 *   Score (Quantorus365 ranking score)
 *     1. Redis  key: stock:{SYMBOL}         (snapshot has no score — skip)
 *     2. MySQL  rankings.score for tradingsymbol
 *
 *   Signal type + reasons
 *     1. Redis  key: signal:{instrument_key}  (full Signal object, TTL 300s)
 *     2. MySQL  signals JOIN signal_reasons   (most recent signal)
 *
 * IMPORTANT:
 *   - instrument_key is resolved once from instruments table and cached.
 *   - candles table is keyed by instrument_key, NOT tradingsymbol.
 *   - signal_reasons.reason_text — plain text per row, joined to signals.id
 *   - 52W high/low: from NSE quote cache if available, else MAX/MIN candles
 */

import { cacheGet, cacheSet } from '@/lib/redis';
import { db }                 from '@/lib/db';
import { getLatestActiveSnapshotBySymbol } from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import {
  toDisplayRow,
  type DisplayStatus,
  type RejectionCode,
  type ApprovalStage,
} from '@/lib/signals/signalDisplayShaper';

// ── Output types ─────────────────────────────────────────────────

export interface CandleBar {
  ts:     string;   // ISO datetime
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  oi:     number;
}

export interface SignalReason {
  rank:       number;
  factor_key: string | null;
  text:       string;
}

export interface StockDetail {
  symbol:         string;
  instrument_key: string;
  name:           string | null;

  // Price
  ltp:            number;
  open:           number;
  day_high:       number;
  day_low:        number;
  prev_close:     number;
  change_abs:     number;
  change_percent: number;
  volume:         number;
  vwap:           number | null;

  // 52-week
  week52_high:    number;
  week52_low:     number;

  // Candles
  candles:        CandleBar[];
  candle_interval:string;

  // Quantorus365 score
  score:          number | null;
  rank_position:  number | null;

  // Signal
  signal_type:    string | null;   // BUY | SELL | HOLD
  confidence:     number | null;
  signal_strength:string | null;   // Strong | Moderate | Weak
  entry_price:    number | null;
  stop_loss:      number | null;
  target1:        number | null;
  target2:        number | null;
  risk_reward:    number | null;
  reasons:        SignalReason[];
  signal_age_min: number | null;

  // Signal intelligence (full payload from Phase 3/4 engine)
  risk_score:        number | null;
  portfolio_fit:     number | null;
  conviction_band:   string | null;   // high_conviction | actionable | watchlist | reject
  scenario_tag:      string | null;   // TREND_CONTINUATION | ... | NO_STRATEGY
  market_stance:     string | null;   // aggressive | selective | defensive | capital_preservation
  rejection_reasons: string[];
  rejection_codes:   string[];
  signal_status:     SignalStatus | null;

  // ── Execution contract (mirrors /api/signals row shape) ──────────
  // Single source of truth for "is this tradable right now". The main
  // signals table and the detail page MUST agree on this value — the
  // dashboard never renders BUY while the detail page says REJECTED.
  classification:    string | null;          // explicit; never silently "No Trade"
  execution_allowed: boolean;
  rejection_reason:  string | null;          // first specific reason when blocked
  signal_note:       string | null;          // banner copy for REVALIDATED case
  signal_source:     'stored' | 'live' | 'none'; // which path produced the displayed signal

  // ── Live-revalidation drift fields (2026-05) ────────────────────
  // Spec PART 7 — live validation may downgrade but not silently
  // replace. When the stored row was APPROVED and the live re-scan
  // disagrees, every one of these MUST be populated so the UI can
  // render a "Signal changed after live revalidation" banner with
  // the before/after states and the specific reason.
  //
  //   signal_state_changed=false  → live agrees with stored (steady)
  //   signal_state_changed=true   → live disagreed; the row was
  //                                 demoted/invalidated and the user
  //                                 needs to see the explanation.
  //
  // No silent drift: a true value here is always paired with the
  // populated previous_status / current_status / downgrade_reason.
  signal_state_changed: boolean;
  previous_status:      SignalStatus | 'APPROVED' | null;   // what the stored row claimed
  current_status:       SignalStatus | 'APPROVED' | null;   // what live revalidation produced
  downgrade_reason:     string | null;                       // human reason; null when no drift

  // Spec INSTITUTIONAL §UX-SIMPLIFY (2026-05) — explainability
  // fields. The detail page surfaces ONLY the binary
  // APPROVED / REJECTED state to match the main-table tabs.
  // The detailed `rejection_code` (REJECTED_LOW_RR /
  // DEVELOPING_SETUP / DEFERRED_WAIT_TRIGGER / etc) is the sub-badge
  // that explains WHY each row failed, but the top-level state is
  // strictly APPROVED | REJECTED — never the legacy
  // DEVELOPING / DEFERRED / NO_TRADE strings.
  approval_state:    DisplayStatus;          // 'APPROVED' | 'REJECTED'
  rejection_code:    RejectionCode;          // specific code (REJECTED_LOW_RR / DEVELOPING_SETUP / etc)
  display_reason:    string;                 // human-readable single sentence
  approval_stage:    ApprovalStage;          // scanned | matched | scored | gated | approved | promoted
  promotion_stage:   'none' | 'tracker' | 'mature' | 'promoted'; // maturity-tracker progression
  maturity_state:    string | null;          // null | 'candidate' | 'developing' | 'mature' | 'promoted' | 'terminated'
  freshness_state:   'fresh' | 'aging' | 'stale' | 'unknown';

  // Meta
  data_source:    'redis' | 'mysql' | 'mixed';
  as_of:          string;
}

export type SignalStatus = 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE';

// ── Helpers ───────────────────────────────────────────────────────

const n = (v: unknown, fb = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
};

const STRENGTH_CONFIDENCE: Record<string, number> = {
  Strong: 85, Moderate: 65, Weak: 40,
};

const DETAIL_TTL    = 30;   // seconds — full detail cache
const CANDLE_TTL    = 120;  // seconds — candle array cache
const IKEY_TTL      = 3600; // seconds — instrument_key resolution cache
const DEFAULT_CANDLE_LIMIT = 100;

// ── Step 1: Resolve instrument_key from tradingsymbol ─────────────
// Candles are keyed by instrument_key, not tradingsymbol.
// Cache this resolution so we don't query instruments table per request.

async function resolveInstrumentKey(symbol: string): Promise<{
  instrument_key: string;
  name: string | null;
}> {
  const cacheKey = `ikey:${symbol}`;
  const cached   = await cacheGet<{ instrument_key: string; name: string | null }>(cacheKey);
  if (cached) return cached;

  try {
    const { rows } = await db.query(`
      SELECT instrument_key, name
      FROM instruments
      WHERE tradingsymbol = ?
        AND exchange      = 'NSE'
        AND is_active     = 1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    if ((rows as any[]).length) {
      const row = (rows as any[])[0];
      const result = {
        instrument_key: String(row.instrument_key),
        name:           row.name ? String(row.name) : null,
      };
      await cacheSet(cacheKey, result, IKEY_TTL);
      return result;
    }
  } catch { /* instruments table may be empty */ }

  // Fallback: construct standard NSE equity key
  return { instrument_key: `NSE_EQ|${symbol}`, name: null };
}

// ── Step 2a: Price data — Redis stock:{SYMBOL} ────────────────────

interface PriceData {
  ltp:            number;
  open:           number;
  day_high:       number;
  day_low:        number;
  prev_close:     number;
  change_abs:     number;
  change_percent: number;
  volume:         number;
  vwap:           number | null;
  week52_high:    number;
  week52_low:     number;
  source:         'redis_snapshot' | 'redis_nse' | 'mysql';
}

async function getPriceFromRedis(symbol: string): Promise<PriceData | null> {

  // ── Try 1: MarketSnapshot (stock:{SYMBOL}) written by scheduler ──
  const snap = await cacheGet<any>(`stock:${symbol}`);
  if (snap && snap.ltp) {
    return {
      ltp:            n(snap.ltp),
      open:           n(snap.open),
      day_high:       n(snap.high),
      day_low:        n(snap.low),
      prev_close:     n(snap.close),
      change_abs:     n(snap.change_abs),
      change_percent: n(snap.change_percent),
      volume:         n(snap.volume),
      vwap:           snap.vwap != null ? n(snap.vwap) : null,
      // MarketSnapshot doesn't store 52W — will be filled from NSE cache or candles
      week52_high:    0,
      week52_low:     0,
      source:         'redis_snapshot',
    };
  }

  // ── Try 2: Raw NSE quote cache (nse:/quote-equity?symbol=...) ────
  const nseKey = `nse:/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const nseRaw = await cacheGet<any>(nseKey);
  if (nseRaw?.priceInfo) {
    const p = nseRaw.priceInfo;
    const t = nseRaw.marketDeptOrderBook?.tradeInfo ?? {};
    return {
      ltp:            n(p.lastPrice),
      open:           n(p.open),
      day_high:       n(p.intraDayHighLow?.max ?? p.lastPrice),
      day_low:        n(p.intraDayHighLow?.min ?? p.lastPrice),
      prev_close:     n(p.previousClose),
      change_abs:     n(p.change),
      change_percent: n(p.pChange),
      volume:         n(t.totalTradedVolume),
      vwap:           p.vwap != null ? n(p.vwap) : null,
      week52_high:    n(p.weekHighLow?.max),
      week52_low:     n(p.weekHighLow?.min),
      source:         'redis_nse',
    };
  }

  return null;
}

// ── Step 2b: Price data — MySQL fallback ──────────────────────────

async function getPriceFromMySQL(
  instrumentKey: string,
  symbol:        string,
): Promise<PriceData | null> {
  // Cascade: candles.intraday → candles.eod → market_data_daily.
  //
  // The `candles` table is the legacy intraday/EOD store keyed by
  // instrument_key. The active scanner pipeline writes daily OHLC to
  // `market_data_daily` keyed by symbol. Symbols ingested only through
  // the new pipeline (every relaxed-pool symbol on a fresh local DB)
  // have NO row in `candles`, so the legacy lookup returned null and
  // the detail API 404'd — surfaced in the UI as "REJECTED · NO_STRATEGY"
  // even though the stored signal was a valid BUY/SELL.
  //
  // We try the legacy intraday table first (preserves existing behaviour
  // for large-caps with intraday rows), then EOD candles, then fall
  // back to market_data_daily by symbol. The `52W high/low` lookup
  // also cascades, so a symbol present only in market_data_daily
  // still gets its annual extremes.
  const annualFromCandles = async (): Promise<{ wHigh: number; wLow: number } | null> => {
    try {
      const { rows } = await db.query(`
        SELECT MAX(high) AS week52_high, MIN(low) AS week52_low
        FROM candles
        WHERE instrument_key = ?
          AND candle_type    = 'eod'
          AND ts             >= DATE_SUB(NOW(), INTERVAL 365 DAY)
      `, [instrumentKey]);
      const a = (rows as any[])[0] ?? {};
      const wHigh = n(a.week52_high), wLow = n(a.week52_low);
      if (wHigh > 0 || wLow > 0) return { wHigh, wLow };
      return null;
    } catch { return null; }
  };
  const annualFromDaily = async (): Promise<{ wHigh: number; wLow: number }> => {
    try {
      const { rows } = await db.query(`
        SELECT MAX(high) AS week52_high, MIN(low) AS week52_low
        FROM market_data_daily
        WHERE symbol = ?
          AND ts     >= DATE_SUB(NOW(), INTERVAL 365 DAY)
      `, [symbol]);
      const a = (rows as any[])[0] ?? {};
      return { wHigh: n(a.week52_high), wLow: n(a.week52_low) };
    } catch { return { wHigh: 0, wLow: 0 }; }
  };

  try {
    // Tier 1 — legacy intraday candle.
    const { rows: latest } = await db.query(`
      SELECT open, high, low, close, volume, oi, ts
      FROM candles
      WHERE instrument_key = ?
        AND candle_type    = 'intraday'
      ORDER BY ts DESC
      LIMIT 1
    `, [instrumentKey]);

    if ((latest as any[]).length) {
      const row = (latest as any[])[0];
      const ann = await annualFromCandles() ?? await annualFromDaily();
      return {
        ltp:            n(row.close),
        open:           n(row.open),
        day_high:       n(row.high),
        day_low:        n(row.low),
        prev_close:     n(row.close),  // best proxy from intraday
        change_abs:     0,
        change_percent: 0,
        volume:         n(row.volume),
        vwap:           null,
        week52_high:    ann.wHigh,
        week52_low:     ann.wLow,
        source:         'mysql',
      };
    }
  } catch { /* tier 1 unavailable — continue */ }

  // Tier 2 — legacy EOD candle. Same instrument_key key.
  try {
    const { rows: latestEod } = await db.query(`
      SELECT open, high, low, close, volume, oi, ts
      FROM candles
      WHERE instrument_key = ?
        AND candle_type    = 'eod'
      ORDER BY ts DESC
      LIMIT 2
    `, [instrumentKey]);

    if ((latestEod as any[]).length) {
      const row  = (latestEod as any[])[0];
      const prev = (latestEod as any[])[1];
      const close = n(row.close);
      const prevClose = prev ? n(prev.close) : close;
      const ann  = await annualFromCandles() ?? await annualFromDaily();
      return {
        ltp:            close,
        open:           n(row.open),
        day_high:       n(row.high),
        day_low:        n(row.low),
        prev_close:     prevClose,
        change_abs:     prevClose ? close - prevClose : 0,
        change_percent: prevClose ? ((close - prevClose) / prevClose) * 100 : 0,
        volume:         n(row.volume),
        vwap:           null,
        week52_high:    ann.wHigh,
        week52_low:     ann.wLow,
        source:         'mysql',
      };
    }
  } catch { /* tier 2 unavailable — continue */ }

  // Tier 3 — current scanner pipeline's daily OHLC store.
  try {
    const { rows: latestDaily } = await db.query(`
      SELECT open, high, low, close, volume, ts
      FROM market_data_daily
      WHERE symbol = ?
      ORDER BY ts DESC
      LIMIT 2
    `, [symbol]);

    if (!(latestDaily as any[]).length) return null;

    const row  = (latestDaily as any[])[0];
    const prev = (latestDaily as any[])[1];
    const close = n(row.close);
    const prevClose = prev ? n(prev.close) : close;
    const ann = await annualFromDaily();
    return {
      ltp:            close,
      open:           n(row.open),
      day_high:       n(row.high),
      day_low:        n(row.low),
      prev_close:     prevClose,
      change_abs:     prevClose ? close - prevClose : 0,
      change_percent: prevClose ? ((close - prevClose) / prevClose) * 100 : 0,
      volume:         n(row.volume),
      vwap:           null,
      week52_high:    ann.wHigh,
      week52_low:     ann.wLow,
      source:         'mysql',
    };
  } catch {
    return null;
  }
}

// ── Step 3: Candles — Redis → MySQL ──────────────────────────────

async function getCandles(
  instrumentKey: string,
  symbol:        string,
  interval:      string,
  limit:         number
): Promise<CandleBar[]> {

  // ── Redis cache for candle array ─────────────────────────────
  const cKey   = `stock:candles:${symbol}:${interval}`;
  const cached = await cacheGet<CandleBar[]>(cKey);
  if (cached?.length) return cached;

  // ── MySQL ────────────────────────────────────────────────────
  // Candles are stored by instrument_key with candle_type + interval_unit
  const candleType   = interval === '1day' ? 'eod' : 'intraday';
  const intervalUnit = interval;

  try {
    const { rows } = await db.query(`
      SELECT ts, open, high, low, close, volume, oi
      FROM candles
      WHERE instrument_key = ?
        AND candle_type    = ?
        AND interval_unit  = ?
      ORDER BY ts DESC
      LIMIT ?
    `, [instrumentKey, candleType, intervalUnit, limit]);

    const bars: CandleBar[] = (rows as any[]).map(r => ({
      ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      open:   n(r.open),
      high:   n(r.high),
      low:    n(r.low),
      close:  n(r.close),
      volume: n(r.volume),
      oi:     n(r.oi),
    })).reverse(); // oldest-first for charting

    if (bars.length) {
      await cacheSet(cKey, bars, CANDLE_TTL);
      return bars;
    }
  } catch { /* fall through to market_data_daily fallback */ }

  // ── Daily fallback — market_data_daily (current scanner store) ──
  // The legacy `candles` table is empty for symbols ingested only
  // through the scanner pipeline (which writes to market_data_daily).
  // Without this fallback the chart on the detail page renders an
  // empty array even though the scanner has 200+ daily bars per
  // symbol persisted. Only meaningful for `1day` — intraday interval
  // requests have no equivalent in market_data_daily.
  if (interval === '1day') {
    try {
      const { rows } = await db.query(`
        SELECT ts, open, high, low, close, volume
        FROM market_data_daily
        WHERE symbol = ?
        ORDER BY ts DESC
        LIMIT ?
      `, [symbol, limit]);

      const bars: CandleBar[] = (rows as any[]).map(r => ({
        ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
        open:   n(r.open),
        high:   n(r.high),
        low:    n(r.low),
        close:  n(r.close),
        volume: n(r.volume),
        oi:     0,  // market_data_daily doesn't carry OI
      })).reverse();

      if (bars.length) {
        await cacheSet(cKey, bars, CANDLE_TTL);
      }
      return bars;
    } catch {
      return [];
    }
  }

  return [];
}

// ── Step 4: Score — MySQL rankings ───────────────────────────────

async function getScore(symbol: string): Promise<{
  score: number | null;
  rank_position: number | null;
}> {
  try {
    const { rows } = await db.query(`
      SELECT score, rank_position
      FROM rankings
      WHERE tradingsymbol = ?
      ORDER BY score DESC
      LIMIT 1
    `, [symbol]);

    if (!(rows as any[]).length) return { score: null, rank_position: null };
    const row = (rows as any[])[0];
    return {
      score:         n(row.score, 0),
      rank_position: row.rank_position != null ? n(row.rank_position) : null,
    };
  } catch {
    return { score: null, rank_position: null };
  }
}

// ── Step 5a: Signal — Redis signal:{instrument_key} ───────────────

interface SignalData {
  signal_type:    string | null;
  confidence:     number | null;
  signal_strength:string | null;
  entry_price:    number | null;
  stop_loss:      number | null;
  target1:        number | null;
  target2:        number | null;
  risk_reward:    number | null;
  reasons:        SignalReason[];
  signal_age_min: number | null;

  risk_score:        number | null;
  portfolio_fit:     number | null;
  conviction_band:   string | null;
  scenario_tag:      string | null;
  market_stance:     string | null;
  rejection_reasons: string[];
  rejection_codes:   string[];
  signal_status:     SignalStatus | null;

  classification:    string | null;
  execution_allowed: boolean;
  rejection_reason:  string | null;
  signal_note:       string | null;
  signal_source:     'stored' | 'live' | 'none';

  // Live-revalidation drift state — see StockDetail interface for
  // semantics. Always populated (never undefined): the steady-state
  // case is { signal_state_changed: false, previous_status: null,
  // current_status: null, downgrade_reason: null }.
  signal_state_changed: boolean;
  previous_status:      SignalStatus | 'APPROVED' | null;
  current_status:       SignalStatus | 'APPROVED' | null;
  downgrade_reason:     string | null;

  source:         'redis' | 'mysql';
}

/**
 * Spec INSTITUTIONAL §M.5 — derive the per-row explainability shape
 * from any signal-source row. Re-uses signalDisplayShaper so the
 * detail page tags match what /api/signals' funnel/pools emit.
 *
 * `maturity_state` and `promotion_stage` come from the maturity
 * tracker query (see `loadMaturitySnapshot` below).
 */
function buildExplainabilityFields(row: {
  signal_status:    string | null;
  classification:   string | null;
  rejection_reason: string | null;
  rejection_codes:  string[] | null;
  scenario_tag:     string | null;
  conviction_band:  string | null;
  confidence:       number | null;
  risk_reward:      number | null;
  market_regime:    string | null;
  execution_allowed: boolean;
}): {
  approval_state:  DisplayStatus;
  rejection_code:  RejectionCode;
  display_reason:  string;
  approval_stage:  ApprovalStage;
} {
  const display = toDisplayRow({
    signal_status:    row.signal_status,
    classification:   row.classification,
    raw_classification: row.classification,
    rejection_reason: row.rejection_reason,
    rejection_codes:  row.rejection_codes,
    scenario_tag:     row.scenario_tag,
    conviction_band:  row.conviction_band,
    confidence_score: row.confidence,
    confidence:       row.confidence,
    risk_reward:      row.risk_reward,
    rr_ratio:         row.risk_reward,
    market_regime:    row.market_regime,
    execution_allowed: row.execution_allowed,
  });
  return {
    approval_state:  display.display_status,
    rejection_code:  display.rejection_code,
    display_reason:  display.display_reason,
    approval_stage:  display.approval_stage,
  };
}

/** Spec INSTITUTIONAL §M.5 — read the maturity-tracker row for a
 *  symbol so the detail page surfaces the live promotion path
 *  (candidate → developing → mature → promoted). Returns sane
 *  defaults when no tracker row exists. */
async function loadMaturitySnapshot(symbol: string): Promise<{
  promotion_stage: 'none' | 'tracker' | 'mature' | 'promoted';
  maturity_state:  string | null;
}> {
  try {
    const { rows } = await db.query<{ stage: string | null; promoted_signal_id: number | null }>(
      `SELECT stage, promoted_signal_id
         FROM q365_signal_maturity_tracker
        WHERE symbol = ?
        ORDER BY last_seen_at DESC LIMIT 1`,
      [symbol.toUpperCase()],
    );
    const row = (rows as any[])[0];
    if (!row) return { promotion_stage: 'none', maturity_state: null };
    const stage = String(row.stage ?? '').toLowerCase();
    if (row.promoted_signal_id != null) {
      return { promotion_stage: 'promoted', maturity_state: stage || 'promoted' };
    }
    if (stage === 'mature')      return { promotion_stage: 'mature', maturity_state: stage };
    if (stage === 'developing')  return { promotion_stage: 'tracker', maturity_state: stage };
    if (stage === 'candidate')   return { promotion_stage: 'tracker', maturity_state: stage };
    if (stage === 'terminated')  return { promotion_stage: 'none', maturity_state: stage };
    return { promotion_stage: 'tracker', maturity_state: stage || null };
  } catch {
    return { promotion_stage: 'none', maturity_state: null };
  }
}

/** Spec INSTITUTIONAL §M.5 — derive freshness_state from the most
 *  recent candle in market_data_daily. <30min=fresh, <2h=aging,
 *  >2h=stale. Pure DB lookup; no upstream calls. */
async function loadFreshnessState(symbol: string): Promise<'fresh' | 'aging' | 'stale' | 'unknown'> {
  try {
    const { rows } = await db.query<{ latest: Date | string | null }>(
      `SELECT MAX(ts) AS latest FROM market_data_daily WHERE symbol = ?`,
      [symbol.toUpperCase()],
    );
    const latest = rows[0]?.latest;
    if (!latest) return 'unknown';
    const ts = latest instanceof Date ? latest.getTime() : Date.parse(String(latest));
    if (!Number.isFinite(ts)) return 'unknown';
    const ageMin = (Date.now() - ts) / 60_000;
    if (ageMin <= 30)      return 'fresh';
    if (ageMin <= 120)     return 'aging';
    return 'stale';
  } catch {
    return 'unknown';
  }
}

// Classify the trade-ability of a raw signal payload into the tri-state
// used by the UI. Confidence/conviction drive the primary split; the
// presence of rejection codes demotes everything to NO_TRADE; an
// actionable band with developing-but-not-approved metrics yields
// DEVELOPING_SETUP so the UI can show "setup is developing" rather than
// a flat rejection.
function classifySignalStatus(args: {
  confidence:        number | null;
  conviction_band:   string | null;
  scenario_tag:      string | null;
  rejection_codes:   string[];
  market_stance:     string | null;
  status?:           string | null;   // q365_signals.status when available
}): SignalStatus {
  const conf  = args.confidence ?? 0;
  const band  = (args.conviction_band ?? '').toLowerCase();
  const scen  = (args.scenario_tag ?? '').toUpperCase();
  const codes = args.rejection_codes ?? [];
  const stance = (args.market_stance ?? '').toLowerCase();
  const status = (args.status ?? '').toLowerCase();

  const hardRejected =
    codes.length > 0 ||
    band === 'reject' ||
    scen === 'NO_STRATEGY' ||
    status === 'rejected';

  if (hardRejected) {
    // A watchlist band with NO_STRATEGY/low conviction is not tradeable
    // but the setup may still develop — keep DEVELOPING_SETUP when the
    // confidence is at least mid-range so the UI can guide the user.
    if (conf >= 55 && band !== 'reject' && stance !== 'capital_preservation') {
      return 'DEVELOPING_SETUP';
    }
    return 'NO_TRADE';
  }

  if (band === 'high_conviction' || (band === 'actionable' && conf >= 70)) {
    return 'APPROVED_SIGNAL';
  }
  if (band === 'actionable' || band === 'watchlist' || conf >= 55) {
    return 'DEVELOPING_SETUP';
  }
  return 'NO_TRADE';
}

async function getSignalFromRedis(instrumentKey: string): Promise<SignalData | null> {
  const cached = await cacheGet<any>(`signal:${instrumentKey}`);
  if (!cached) return null;

  // Full Signal object is stored in Redis by signalEngine.ts
  const reasons: SignalReason[] = (cached.reasons ?? []).map((r: any, i: number) => ({
    rank:       i + 1,
    factor_key: r.key   ?? null,
    text:       r.description ?? r.label ?? '',
  }));

  const genAt = cached.generated_at
    ? Math.round((Date.now() - new Date(cached.generated_at).getTime()) / 60000)
    : null;

  const strength = cached.confidence > 75 ? 'Strong'
                 : cached.confidence > 55 ? 'Moderate' : 'Weak';

  const rejection_reasons: string[] = Array.isArray(cached.rejection_reasons)
    ? cached.rejection_reasons.map((v: unknown) => String(v))
    : [];
  const rejection_codes: string[] = Array.isArray(cached.rejection_codes)
    ? cached.rejection_codes.map((v: unknown) => String(v))
    : [];

  const conviction_band = typeof cached.conviction_band === 'string' ? cached.conviction_band : null;
  const scenario_tag    = typeof cached.scenario_tag    === 'string' ? cached.scenario_tag    : null;
  const market_stance   = typeof cached.market_stance   === 'string' ? cached.market_stance   : null;
  const risk_score      = typeof cached.risk_score      === 'number' ? cached.risk_score      : null;
  const portfolio_fit   = typeof cached.portfolio_fit   === 'number' ? cached.portfolio_fit   :
                          typeof cached.portfolio_fit_score === 'number' ? cached.portfolio_fit_score : null;

  const confidence = typeof cached.confidence === 'number' ? cached.confidence : null;

  // Prefer engine-persisted tri-state when the Redis payload
  // carries it (post-migration writes); otherwise derive.
  const cachedStatus = typeof cached.signal_status === 'string' ? cached.signal_status : null;
  const signal_status: SignalStatus =
    cachedStatus === 'APPROVED_SIGNAL'  ? 'APPROVED_SIGNAL'
    : cachedStatus === 'DEVELOPING_SETUP' ? 'DEVELOPING_SETUP'
    : cachedStatus === 'NO_TRADE'         ? 'NO_TRADE'
    : classifySignalStatus({
        confidence,
        conviction_band,
        scenario_tag,
        rejection_codes,
        market_stance,
      });

  // Classification: prefer the cached column. NEVER silently coerce a
  // missing value to NO_TRADE — fall back to UNDEFINED and log so the
  // operator can see when an upstream writer is omitting it.
  const classification: string | null = typeof cached.classification === 'string' && cached.classification
    ? cached.classification
    : null;
  if (classification === null) {
    console.error('[stockDetailService] Redis signal missing classification', {
      instrument_key: cached.instrument_key ?? null,
      direction:      cached.direction ?? null,
      confidence,
      signal_status,
    });
  }

  // Execution contract — for Redis-cached signals the engine has already
  // approved the row at write time, so execution_allowed mirrors the
  // tri-state. Specific veto reason comes from the first rejection row.
  const execution_allowed = signal_status === 'APPROVED_SIGNAL'
    && rejection_reasons.length === 0;
  const rejection_reason  = rejection_reasons[0] ?? rejection_codes[0] ?? null;

  return {
    signal_type:    cached.direction ?? null,
    confidence,
    signal_strength:strength,
    entry_price:    cached.entry_price != null ? n(cached.entry_price) : null,
    stop_loss:      cached.stop_loss   != null ? n(cached.stop_loss)   : null,
    target1:        cached.target1     != null ? n(cached.target1)     : null,
    target2:        cached.target2     != null ? n(cached.target2)     : null,
    risk_reward:    cached.risk_reward != null ? n(cached.risk_reward) : null,
    reasons,
    signal_age_min: genAt,

    risk_score,
    portfolio_fit,
    conviction_band,
    scenario_tag,
    market_stance,
    rejection_reasons,
    rejection_codes,
    signal_status,

    classification:    classification ?? 'UNDEFINED',
    execution_allowed,
    rejection_reason,
    signal_note:       null,
    signal_source:     'live',

    // Redis-cached signals are produced by the live analyzer in a
    // single pass — no stored-vs-live reconciliation happens here, so
    // drift is structurally impossible. Steady-state defaults.
    signal_state_changed: false,
    previous_status:      null,
    current_status:       null,
    downgrade_reason:     null,

    source:         'redis',
  };
}

// ── Step 5b: Signal — MySQL signals JOIN signal_reasons ───────────

async function getSignalFromMySQL(
  instrumentKey: string,
  symbol:        string
): Promise<SignalData | null> {
  // ── Primary read: q365_signals (canonical Phase 3/4 table) ─────
  // Contains full signal-intelligence payload — confidence_score,
  // risk_score, scenario_tag, market_regime, market_stance,
  // confidence_band (→ conviction_band), portfolio_fit_score,
  // entry/stop/targets. Fall through to the legacy `signals`
  // reader only when this query fails (fresh DB, missing table).
  try {
    // signal_status is the canonical tri-state persisted by the
    // rejection engine at write time (APPROVED_SIGNAL /
    // DEVELOPING_SETUP / NO_TRADE). Prefer it over the service-side
    // derivation below; fall back to classifySignalStatus only when
    // the column is NULL (historical rows pre-migration).
    // CONSISTENCY: must select the SAME row the main /signals table
    // would surface, otherwise the stock-detail page can show a
    // signal the table has already invalidated. The lifecycle gate
    // here mirrors getActiveSignals (status active/watchlist/flagged
    // ∧ invalidation_reason IS NULL ∧ not expired ∧ decay <> expired).
    // Without these clauses a row that the live revalidation path
    // (revalidateInstrument) just marked invalidation_reason='Live
    // revalidation: NO_TRADE' would still come back here as the
    // displayed signal — re-introducing the exact RATEGAIN bug we
    // just fixed.
    const { rows: q365Rows } = await db.query(`
      SELECT
        id, direction, signal_type,
        confidence_score, confidence_band,
        risk_score, risk_band, opportunity_score,
        portfolio_fit_score, regime_alignment,
        entry_price, stop_loss, target1, target2, risk_reward,
        market_regime, market_stance, scenario_tag,
        status, signal_status, classification, invalidation_reason,
        generated_at
      FROM q365_signals
      WHERE (instrument_key = ? OR symbol = ?)
        AND status IN ('active','watchlist','flagged')
        AND invalidation_reason IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (decay_state IS NULL OR decay_state <> 'expired')
      -- Spec STORED-SIGNAL-PRIORITY (consistency contract) —
      -- "stock detail page should prefer latest APPROVED q365_signals
      -- row for the selected symbol". Symbols routinely have multiple
      -- active rows (the scanner writes a new row per batch + multi-
      -- direction strategies emit BUY and SELL for the same name),
      -- so a plain "generated_at DESC" could pick a low-confidence
      -- DEVELOPING_SETUP row while the signals-table view picked a
      -- higher-confidence APPROVED_SIGNAL row from an earlier batch.
      -- The two surfaces then disagreed on direction/status.
      -- Aligned ordering: APPROVED first, then confidence/final_score
      -- (matches the signals route's relaxed/best-available pool
      -- ordering), then recency, then id as a deterministic tiebreaker.
      ORDER BY
        CASE
          WHEN UPPER(COALESCE(signal_status, '')) = 'APPROVED_SIGNAL'  THEN 0
          WHEN UPPER(COALESCE(signal_status, '')) = 'DEVELOPING_SETUP' THEN 1
          ELSE 2
        END ASC,
        COALESCE(confidence_score, 0) DESC,
        COALESCE(final_score, 0)      DESC,
        generated_at DESC,
        id DESC
      LIMIT 1
    `, [instrumentKey, symbol]);

    if ((q365Rows as any[]).length) {
      const sig = (q365Rows as any[])[0];

      // Reasons + rejections come from q365_signal_reasons (typed rows).
      // reason_type='reason' / 'warning' / 'rejection' — split them
      // into the SignalReason[] and rejection_* arrays accordingly.
      const reasons: SignalReason[] = [];
      const rejection_reasons: string[] = [];
      const rejection_codes: string[]   = [];
      try {
        const { rows: reasonRows } = await db.query(`
          SELECT reason_type, message, factor_key, contribution
          FROM q365_signal_reasons
          WHERE signal_id = ?
          ORDER BY id ASC
        `, [sig.id]);

        let rank = 1;
        for (const r of (reasonRows as any[])) {
          const type = String(r.reason_type ?? '').toLowerCase();
          const msg  = String(r.message ?? '');
          if (!msg) continue;
          if (type === 'rejection') {
            rejection_reasons.push(msg);
            if (r.factor_key) rejection_codes.push(String(r.factor_key));
          } else if (type === 'warning') {
            // carry warnings into the visible reasons list so the UI
            // can render them alongside approval rationale
            reasons.push({ rank: rank++, factor_key: r.factor_key ? String(r.factor_key) : null, text: msg });
          } else {
            reasons.push({ rank: rank++, factor_key: r.factor_key ? String(r.factor_key) : null, text: msg });
          }
        }
      } catch { /* reasons table optional — keep going */ }

      const confidence    = sig.confidence_score != null ? n(sig.confidence_score) : null;
      const strength      = confidence == null ? null
                          : confidence > 75 ? 'Strong'
                          : confidence > 55 ? 'Moderate' : 'Weak';

      const scenario_tag  = sig.scenario_tag   ? String(sig.scenario_tag)   : null;
      const market_stance = sig.market_stance  ? String(sig.market_stance)  : null;
      const conviction_band = sig.confidence_band ? String(sig.confidence_band) : null;

      // NO_STRATEGY is a meaningful rejection signal in itself — add
      // it to the codes so the UI can render the humanized label even
      // when q365_signal_reasons has no explicit rejection row.
      if (scenario_tag === 'NO_STRATEGY' && !rejection_codes.includes('NO_STRATEGY')) {
        rejection_codes.push('NO_STRATEGY');
      }
      if (market_stance === 'capital_preservation' && !rejection_codes.includes('capital_preservation')) {
        rejection_codes.push('capital_preservation');
      }

      // Prefer the persisted column from the rejection engine;
      // fall back to the service-side classifier for historic rows
      // whose column is still NULL (pre-migration writes).
      const persisted = sig.signal_status ? String(sig.signal_status) : null;
      const signal_status: SignalStatus =
        persisted === 'APPROVED_SIGNAL'  ? 'APPROVED_SIGNAL'
        : persisted === 'DEVELOPING_SETUP' ? 'DEVELOPING_SETUP'
        : persisted === 'NO_TRADE'         ? 'NO_TRADE'
        : classifySignalStatus({
            confidence,
            conviction_band,
            scenario_tag,
            rejection_codes,
            market_stance,
            status: sig.status ? String(sig.status) : null,
          });

      const genAt = sig.generated_at
        ? Math.round((Date.now() - new Date(sig.generated_at).getTime()) / 60000)
        : null;

      // Classification — explicit column wins. Use ?? "UNDEFINED" instead of
      // "|| 'No Trade'" so a missing column is loud rather than silent. The
      // rejection-engine writer always sets this field; a NULL means an
      // upstream bug and the operator should see the error.
      const classification: string = sig.classification
        ? String(sig.classification)
        : 'UNDEFINED';
      if (classification === 'UNDEFINED') {
        console.error('[stockDetailService] q365 signal missing classification', {
          id:             sig.id,
          symbol,
          instrument_key: instrumentKey,
          direction:      sig.direction,
          confidence,
          final_score:    null,
          signal_status:  persisted,
        });
      }

      // Execution contract.
      // - APPROVED_SIGNAL with no invalidation ⇒ tradable.
      // - Hard invalidation (stop_loss_broken, target_reached, engine_disagree,
      //   live_rejected, NO_TRADE classification) ⇒ vetoed; surface the
      //   specific reason rather than the generic "No Trade".
      const invalidationReason: string | null = sig.invalidation_reason
        ? String(sig.invalidation_reason)
        : null;
      const execution_allowed = signal_status === 'APPROVED_SIGNAL'
        && classification !== 'NO_TRADE'
        && !invalidationReason;
      const rejection_reason: string | null = invalidationReason
        ?? rejection_reasons[0]
        ?? rejection_codes[0]
        ?? null;

      return {
        signal_type:    sig.direction ?? sig.signal_type ?? null,
        confidence,
        signal_strength: strength,
        entry_price:    sig.entry_price != null ? n(sig.entry_price) : null,
        stop_loss:      sig.stop_loss   != null ? n(sig.stop_loss)   : null,
        target1:        sig.target1     != null ? n(sig.target1)     : null,
        target2:        sig.target2     != null ? n(sig.target2)     : null,
        risk_reward:    sig.risk_reward != null ? n(sig.risk_reward) : null,
        reasons,
        signal_age_min: genAt,

        risk_score:        sig.risk_score          != null ? n(sig.risk_score)          : null,
        portfolio_fit:     sig.portfolio_fit_score != null ? n(sig.portfolio_fit_score) : null,
        conviction_band,
        scenario_tag,
        market_stance,
        rejection_reasons,
        rejection_codes,
        signal_status,

        classification,
        execution_allowed,
        rejection_reason,
        signal_note:       null,
        signal_source:     'stored',

        // Stored row read directly from q365_signals — the
        // reconcileWithLiveRevalidation step downstream owns drift
        // detection and will overwrite these four fields if live
        // disagrees. Defaults here represent "no drift seen yet".
        signal_state_changed: false,
        previous_status:      null,
        current_status:       null,
        downgrade_reason:     null,

        source:         'mysql',
      };
    }
  } catch (err: any) {
    // Table may not exist yet on a fresh DB — fall through to legacy.
    console.warn('[stockDetailService] q365_signals query failed, falling back to legacy signals table:', err?.message);
  }

  // ── Legacy fallback: old `signals` + `signal_reasons` tables ───
  try {
    const { rows: sigRows } = await db.query(`
      SELECT id, signal_type, strength, description, generated_at
      FROM signals
      WHERE instrument_key = ?
         OR tradingsymbol  = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `, [instrumentKey, symbol]);

    if (!(sigRows as any[]).length) return null;
    const sig = (sigRows as any[])[0];

    const { rows: reasonRows } = await db.query(`
      SELECT rank, reason_text, factor_key
      FROM signal_reasons
      WHERE signal_id = ?
      ORDER BY rank ASC
    `, [sig.id]);

    const reasons: SignalReason[] = (reasonRows as any[]).map(r => ({
      rank:       n(r.rank, 0),
      factor_key: r.factor_key ? String(r.factor_key) : null,
      text:       String(r.reason_text ?? ''),
    }));

    if (!reasons.length && sig.description) {
      sig.description.split(';').forEach((part: string, i: number) => {
        const clean = part.trim();
        if (clean) reasons.push({ rank: i + 1, factor_key: null, text: clean });
      });
    }

    const strength: string = sig.strength ?? 'Weak';
    const confidence        = STRENGTH_CONFIDENCE[strength] ?? 40;

    const genAt = sig.generated_at
      ? Math.round((Date.now() - new Date(sig.generated_at).getTime()) / 60000)
      : null;

    const legacyStatus = classifySignalStatus({
      confidence,
      conviction_band: null,
      scenario_tag:    null,
      rejection_codes: [],
      market_stance:   null,
    });

    return {
      signal_type:    sig.signal_type ?? null,
      confidence,
      signal_strength:strength,
      entry_price:    null,
      stop_loss:      null,
      target1:        null,
      target2:        null,
      risk_reward:    null,
      reasons,
      signal_age_min: genAt,

      risk_score:        null,
      portfolio_fit:     null,
      conviction_band:   null,
      scenario_tag:      null,
      market_stance:     null,
      rejection_reasons: [],
      rejection_codes:   [],
      signal_status:     legacyStatus,

      // Legacy table predates the classification column — there is no
      // engine-emitted value to read, so the API surfaces UNDEFINED. The
      // route handlers translate this to a soft "—" pill rather than the
      // generic "No Trade" label.
      classification:    'UNDEFINED',
      execution_allowed: legacyStatus === 'APPROVED_SIGNAL',
      rejection_reason:  null,
      signal_note:       null,
      signal_source:     'stored',

      // Legacy path — no live revalidation hook attached. Steady-state.
      signal_state_changed: false,
      previous_status:      null,
      current_status:       null,
      downgrade_reason:     null,

      source:         'mysql',
    };
  } catch {
    return null;
  }
}

// ── Step 5a: Signal — confirmed snapshot (institutional canonical) ─
//
// Spec INSTITUTIONAL §F — the main /api/signals table reads from
// q365_confirmed_signal_snapshots (the institutional layer). For the
// stock-detail page to render the SAME direction/status the table is
// shipping, the detail must also read the confirmed snapshot first.
//
// Without this, the detail page falls through to q365_signals, which
// can still carry a DEVELOPING_SETUP / NO_TRADE row for a symbol that
// the maturity worker has since promoted into a confirmed BUY — exactly
// the "table=BUY, detail=REJECTED" mismatch the spec calls out.
async function getSignalFromConfirmedSnapshot(
  symbol: string,
): Promise<SignalData | null> {
  try {
    const snap = await getLatestActiveSnapshotBySymbol(symbol);
    if (!snap) return null;
    // The reader normalizes win_probability to 0..1 and emits the
    // execution contract; surface its canonical view directly so the
    // detail page mirrors what /api/signals just shipped. We deliberately
    // do NOT recompute conviction / classification / rejection — the
    // promotion gate already validated this row.
    const conf = snap.confidence_score;
    const strength: string =
      conf == null ? 'Weak' : conf > 75 ? 'Strong' : conf > 55 ? 'Moderate' : 'Weak';
    const genAt = snap.confirmed_at
      ? Math.round((Date.now() - new Date(snap.confirmed_at).getTime()) / 60000)
      : null;
    // Spec PART 7 (2026-05) — live-revalidation drift detection.
    // The confirmed snapshot was written as APPROVED_SIGNAL by the
    // promotion gate, but the snapshot reader's live overlay
    // (`getActiveConfirmedSnapshots` → `revalidateInstrument`) sets
    // `execution_allowed=false` + populates `rejection_reason` /
    // `invalidation_reason` whenever live tape has invalidated the
    // entry/stop/target. THAT is the drift signal: stored=APPROVED
    // but live=REJECTED. Surface it transparently — never silently
    // replace the stored row, never hide the disagreement.
    const storedWasApproved = snap.signal_status === 'APPROVED_SIGNAL';
    const liveVetoed =
      snap.execution_allowed === false
      || (snap.invalidation_reason != null && String(snap.invalidation_reason).trim() !== '');
    const drift = storedWasApproved && liveVetoed;
    const driftReason = drift
      ? (snap.rejection_reason
         ?? snap.invalidation_reason
         ?? 'live tape disagrees with stored approval')
      : null;

    return {
      signal_type:    snap.direction,
      confidence:     conf,
      signal_strength: strength,
      entry_price:    snap.entry_price,
      stop_loss:      snap.stop_loss,
      target1:        snap.target1,
      target2:        snap.target2,
      risk_reward:    snap.rr_ratio,
      reasons:        [],
      signal_age_min: genAt,

      risk_score:        null,
      portfolio_fit:     null,
      conviction_band:   snap.conviction_level,
      scenario_tag:      snap.strategy,
      market_stance:     null,
      rejection_reasons: [],
      rejection_codes:   snap.rejection_codes ?? [],
      // A confirmed-snapshot row is APPROVED_SIGNAL by construction
      // (the writer's classification gate enforces it), so mirror that
      // tri-state here. execution_allowed reflects the reader's live
      // gate (status=ACTIVE ∧ valid_until>NOW ∧ no invalidation).
      signal_status:     snap.signal_status,

      classification:    snap.classification ?? 'UNDEFINED',
      execution_allowed: snap.execution_allowed,
      rejection_reason:  snap.rejection_reason,
      // Drift banner copy — surfaced verbatim by the detail page so
      // the operator immediately sees why the stored APPROVED row is
      // not currently tradable.
      signal_note:       drift
        ? `Signal changed after live revalidation: ${driftReason}`
        : null,
      signal_source:     'stored',

      // Drift fields — populated only when the stored row was
      // APPROVED but the live overlay vetoed it.
      signal_state_changed: drift,
      previous_status:      drift ? 'APPROVED' : null,
      current_status:       drift ? 'NO_TRADE' : null,
      downgrade_reason:     driftReason,

      source:         'mysql',
    };
  } catch (err: any) {
    console.warn('[stockDetailService] confirmed-snapshot read failed:', err?.message);
    return null;
  }
}

// ── Step 5: Signal — confirmed snapshot → q365_signals → Redis ────
//
// Order matters. The previous "Redis first" path violated the
// stored-row-is-truth contract that /api/signals enforces:
//   1. Main /signals reads q365_confirmed_signal_snapshots; the
//      stock-detail page MUST read the same row first or the two views
//      drift apart whenever the maturity worker promotes a row.
//   2. q365_signals is the pre-promotion / scanner layer — used only
//      when no confirmed snapshot exists for the symbol.
//   3. Redis is the live-engine cache — consulted last so it can never
//      override a stored APPROVED row with a transient NO_TRADE.
//
// This ordering is the spec INSTITUTIONAL §F fix for "table=BUY,
// detail=REJECTED" mismatches.
async function getSignal(
  instrumentKey: string,
  symbol:        string
): Promise<SignalData> {
  const fromConfirmed = await getSignalFromConfirmedSnapshot(symbol);
  if (fromConfirmed) return fromConfirmed;

  const fromMySQL = await getSignalFromMySQL(instrumentKey, symbol);
  if (fromMySQL) return fromMySQL;

  const fromRedis = await getSignalFromRedis(instrumentKey);
  if (fromRedis) return fromRedis;

  return {
    signal_type:    null,
    confidence:     null,
    signal_strength:null,
    entry_price:    null,
    stop_loss:      null,
    target1:        null,
    target2:        null,
    risk_reward:    null,
    reasons:        [],
    signal_age_min: null,

    risk_score:        null,
    portfolio_fit:     null,
    conviction_band:   null,
    scenario_tag:      null,
    market_stance:     null,
    rejection_reasons: [],
    rejection_codes:   [],
    signal_status:     null,

    classification:    null,
    execution_allowed: false,
    rejection_reason:  null,
    signal_note:       null,
    signal_source:     'none',

    // No signal at all — drift fields default to "no drift seen".
    signal_state_changed: false,
    previous_status:      null,
    current_status:       null,
    downgrade_reason:     null,

    source:         'mysql',
  };
}

// ── Public API ────────────────────────────────────────────────────

export async function getStockDetail(
  symbol:   string,
  interval: string = '1minute',
  candleLimit: number = DEFAULT_CANDLE_LIMIT
): Promise<StockDetail | null> {

  const sym = symbol.toUpperCase().trim();
  if (!sym) return null;

  // ── Full detail cache (avoids re-running all steps on repeated hits) ──
  const detailKey    = `stock:detail:${sym}:${interval}`;
  const cachedDetail = await cacheGet<StockDetail>(detailKey);
  if (cachedDetail) return cachedDetail;

  // ── Step 1: Resolve instrument_key ───────────────────────────────
  const { instrument_key, name } = await resolveInstrumentKey(sym);

  // ── Steps 2–5 run concurrently ───────────────────────────────────
  const [priceRedis, candleData, scoreData, signalData, maturity, freshness] = await Promise.all([
    getPriceFromRedis(sym),
    getCandles(instrument_key, sym, interval, Math.min(candleLimit, 500)),
    getScore(sym),
    getSignal(instrument_key, sym),
    // Spec INSTITUTIONAL §M.5 — maturity-tracker + candle-freshness
    // probes for the explainability fields. Both are pure DB lookups
    // and run in parallel with the existing reads, so latency cost
    // is bounded by the slowest leg (candles, typically).
    loadMaturitySnapshot(sym),
    loadFreshnessState(sym),
  ]);

  // ── Price resolution: Redis → MySQL ──────────────────────────────
  let price = priceRedis;
  let dataSource: StockDetail['data_source'] = 'redis';

  if (!price || price.ltp === 0) {
    price      = await getPriceFromMySQL(instrument_key, sym);
    dataSource = 'mysql';
  } else if (price.source === 'redis_snapshot' && price.week52_high === 0) {
    // Snapshot has no 52W data — try NSE raw cache for 52W only
    const nseKey = `nse:/quote-equity?symbol=${encodeURIComponent(sym)}`;
    const nseRaw = await cacheGet<any>(nseKey);
    if (nseRaw?.priceInfo) {
      price.week52_high = n(nseRaw.priceInfo.weekHighLow?.max) || price.week52_high;
      price.week52_low  = n(nseRaw.priceInfo.weekHighLow?.min) || price.week52_low;
    }
    // Still 0 after Redis? Compute from MySQL candles
    if (price.week52_high === 0) {
      try {
        const { rows } = await db.query(`
          SELECT MAX(high) AS week52_high, MIN(low) AS week52_low
          FROM candles
          WHERE instrument_key = ?
            AND candle_type    = 'eod'
            AND ts             >= DATE_SUB(NOW(), INTERVAL 365 DAY)
        `, [instrument_key]);
        const a = (rows as any[])[0] ?? {};
        if (a.week52_high) { price.week52_high = n(a.week52_high); price.week52_low = n(a.week52_low); }
      } catch {}
    }
    dataSource = 'mixed';
  }

  if (!price) return null; // No data at all

  // Mix flag when some parts came from MySQL
  if (signalData.source === 'mysql' || scoreData.score === null) {
    dataSource = dataSource === 'mysql' ? 'mysql' : 'mixed';
  }

  // ── Assemble final result ─────────────────────────────────────────
  const result: StockDetail = {
    symbol:          sym,
    instrument_key,
    name,

    ltp:             price.ltp,
    open:            price.open,
    day_high:        price.day_high,
    day_low:         price.day_low,
    prev_close:      price.prev_close,
    change_abs:      price.change_abs,
    change_percent:  price.change_percent,
    volume:          price.volume,
    vwap:            price.vwap,

    week52_high:     price.week52_high,
    week52_low:      price.week52_low,

    candles:         candleData,
    candle_interval: interval,

    score:           scoreData.score,
    rank_position:   scoreData.rank_position,

    signal_type:     signalData.signal_type,
    confidence:      signalData.confidence,
    signal_strength: signalData.signal_strength,
    entry_price:     signalData.entry_price,
    stop_loss:       signalData.stop_loss,
    target1:         signalData.target1,
    target2:         signalData.target2,
    risk_reward:     signalData.risk_reward,
    reasons:         signalData.reasons,
    signal_age_min:  signalData.signal_age_min,

    risk_score:        signalData.risk_score,
    portfolio_fit:     signalData.portfolio_fit,
    conviction_band:   signalData.conviction_band,
    scenario_tag:      signalData.scenario_tag,
    market_stance:     signalData.market_stance,
    rejection_reasons: signalData.rejection_reasons,
    rejection_codes:   signalData.rejection_codes,
    signal_status:     signalData.signal_status,

    classification:    signalData.classification,
    execution_allowed: signalData.execution_allowed,
    rejection_reason:  signalData.rejection_reason,
    signal_note:       signalData.signal_note,
    signal_source:     signalData.signal_source,

    // Spec PART 7 — live-revalidation drift visibility. These four
    // fields are populated by getSignalFromConfirmedSnapshot (and
    // default to no-drift in every other path) so the UI/API can
    // render "Signal changed after live revalidation" with the exact
    // before/after states whenever the live overlay disagrees with
    // the stored APPROVED row.
    signal_state_changed: signalData.signal_state_changed,
    previous_status:      signalData.previous_status,
    current_status:       signalData.current_status,
    downgrade_reason:     signalData.downgrade_reason,

    // Spec INSTITUTIONAL §M.5 — explainability fields. Synthesised
    // from the same shaper /api/signals' funnel/pools use, so the
    // detail page badge always matches the table badge.
    ...(() => {
      if (signalData.signal_source === 'none') {
        // No signal at all — operator-facing "monitor only" state.
        return {
          approval_state:  'REJECTED' as DisplayStatus,
          rejection_code:  'REJECTED_NO_STRATEGY' as RejectionCode,
          display_reason:  'no signal generated for this symbol in the current scan window',
          approval_stage:  'scanned' as ApprovalStage,
        };
      }
      const exp = buildExplainabilityFields({
        signal_status:    signalData.signal_status,
        classification:   signalData.classification,
        rejection_reason: signalData.rejection_reason,
        rejection_codes:  signalData.rejection_codes,
        scenario_tag:     signalData.scenario_tag,
        conviction_band:  signalData.conviction_band,
        confidence:       signalData.confidence,
        risk_reward:      signalData.risk_reward,
        market_regime:    null,            // not available at this layer; market_regime lives on q365_signals
        execution_allowed: signalData.execution_allowed,
      });
      return exp;
    })(),
    promotion_stage: maturity.promotion_stage,
    maturity_state:  maturity.maturity_state,
    freshness_state: freshness,

    data_source:     dataSource,
    as_of:           new Date().toISOString(),
  };

  // Spec §8 — single-line debug log per stock-detail load. Operators can
  // grep `[STOCK-DETAIL]` to confirm the displayed signal matches the row
  // /api/signals just shipped (the two paths now share the same execution
  // contract — direction, classification, execution_allowed, rejection_reason).
  console.log('[STOCK-DETAIL]', {
    symbol:            sym,
    direction:         signalData.signal_type,
    confidence:        signalData.confidence,
    final_score:       null,
    classification:    signalData.classification,
    execution_allowed: signalData.execution_allowed,
    rejection_reason:  signalData.rejection_reason,
    signal_source:     signalData.signal_source,
    // Drift fields — included so a single grep of [STOCK-DETAIL] tells
    // the operator immediately whether the displayed row was demoted
    // by live revalidation, with both states + reason on the same line.
    signal_state_changed: signalData.signal_state_changed,
    previous_status:      signalData.previous_status,
    current_status:       signalData.current_status,
    downgrade_reason:     signalData.downgrade_reason,
  });
  if (signalData.signal_state_changed) {
    // Spec PART 7 — explicit governance log when live revalidation
    // demotes a stored APPROVED row. Routes to the same channel as
    // [GOVERNANCE] so SRE dashboards can count drift events without
    // having to parse [STOCK-DETAIL].
    console.warn('[GOVERNANCE] live revalidation drift', {
      symbol:           sym,
      previous_status:  signalData.previous_status,
      current_status:   signalData.current_status,
      downgrade_reason: signalData.downgrade_reason,
    });
  }

  // Cache the assembled result for DETAIL_TTL seconds
  await cacheSet(detailKey, result, DETAIL_TTL);

  return result;
}
