/**
 * Scenario Engine — Quantorus365
 *
 * Determines the current market scenario from live inputs
 * and controls which strategies are allowed, discouraged, or blocked.
 *
 * Scenario is NOT a label. It is a gatekeeper.
 *
 * Inputs consumed:
 *   - Live index trend and structure (Kite + Yahoo)
 *   - Market breadth (advancing/declining ratio)
 *   - Volatility regime (VIX + ATR spread)
 *   - Sector leadership concentration
 *   - FII/DII directional flow
 *   - Options PCR and OI skew
 *   - Intraday range expansion state
 */

import { cacheGet, cacheSet }           from '@/lib/redis';
import { db }                            from '@/lib/db';
import { fetchIndices }                  from './marketQuote';

// ════════════════════════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════════════════════════

export type ScenarioTag =
  | 'trend_continuation'
  | 'breakout_expansion'
  | 'choppy_mean_reverting'
  | 'defensive_risk_off'
  | 'short_covering_rally'
  | 'event_driven_volatility'
  | 'no_trade_uncertain';

export type VolatilityMode  = 'low' | 'normal' | 'elevated' | 'extreme';
export type BreadthState    = 'strong_positive' | 'positive' | 'neutral' | 'negative' | 'strong_negative';
export type DirectionBias   = 'bullish' | 'bearish' | 'neutral';

export interface ScenarioResult {
  scenario_tag:        ScenarioTag;
  scenario_confidence: number;        // 0–100
  market_stance_hint:  string;        // human-readable context
  allowed_strategies:  string[];
  blocked_strategies:  string[];
  volatility_mode:     VolatilityMode;
  breadth_state:       BreadthState;
  direction_bias:      DirectionBias;
  regime_alignment:    number;        // 0–100 how well current data aligns with regime
  computed_at:         string;
}

// ── Strategy families referenced by scenario ──────────────────────
const STRATEGY_FAMILIES = {
  BREAKOUT:          'breakout_continuation',
  PULLBACK:          'pullback_in_trend',
  MOMENTUM:          'momentum_expansion',
  MEAN_REVERSION:    'mean_reversion',
  TREND:             'trend_continuation',
  REL_STRENGTH:      'relative_strength_leader',
  VOL_COMPRESSION:   'volatility_compression',
  DEFENSIVE:         'defensive_quality',
  EVENT:             'event_driven',
} as const;

// ════════════════════════════════════════════════════════════════
//  INPUT NORMALIZATION
// ════════════════════════════════════════════════════════════════

interface ScenarioInputs {
  nifty_change_pct:    number;
  nifty_chg_5d:        number;    // multi-timeframe trend
  bank_nifty_pct:      number;
  midcap_pct:          number;
  vix:                 number | null;
  advancing:           number;
  declining:           number;
  fii_net_crore:       number;
  pcr:                 number | null;
  avg_range_pct:       number;
  sectors_positive:    number;
  sectors_total:       number;
  leader_dispersion:   number;    // fraction of sectors leading (0–1)
  avg_top_confidence:  number;
  regime:              string;
}

async function gatherInputs(): Promise<ScenarioInputs> {
  // Read from Redis caches written by scheduler.
  // NOTE: market:intelligence is written by computeMarketIntelligence().
  // To avoid a race condition the caller must ensure intelligence is computed
  // before scenario (see /api/market-intelligence route).
  const [intel, regime, indicesCache, optChainNifty] = await Promise.all([
    cacheGet<any>('market:intelligence'),
    cacheGet<any>('market:regime'),
    cacheGet<any>('nse:/allIndices'),   // raw index array (key: nse:/allIndices)
    cacheGet<any>('options:NIFTY'),     // NIFTY option chain for PCR
  ]);

  // ── Sector / index data ──────────────────────────────────────────
  // Primary: Redis cache (key nse:/allIndices, written upstream).
  // Fallback: fetch live indices directly — works even when Redis is disabled.
  let indicesData: any[] = (indicesCache as any)?.data ?? [];

  if (!indicesData.length) {
    try {
      const live = await fetchIndices();
      indicesData = live.map(i => ({ index: i.name, name: i.name, percentChange: i.percentChange, variation: i.variation }));
    } catch { /* live feed unavailable — all index changes stay 0 */ }
  }

  // Resolve key index percent-changes directly from indicesData.
  // NOTE: the old code used intel?.trendScore (wrong — field is trend_score, snake_case)
  // and intel?.index_changes (field does not exist in MarketIntelligenceResult).
  // Use live indices as the authoritative source; fall back to intel.trend_score.
  function idxPct(name: string): number {
    const d = indicesData.find((d: any) => d.index === name || d.name === name);
    return d ? Number(d.percentChange ?? d.variation ?? 0) : 0;
  }

  const niftyChg   = idxPct('NIFTY 50')        || (intel?.trend_score != null ? intel.trend_score / 20 : 0);
  const bankChg    = idxPct('NIFTY BANK');
  const midcapChg  = idxPct('NIFTY MIDCAP 100');

  // Sector leadership dispersion: fraction of key sectors that are positive.
  const SECTOR_NAMES = ['NIFTY BANK','NIFTY IT','NIFTY PHARMA','NIFTY AUTO','NIFTY FMCG','NIFTY METAL','NIFTY ENERGY','NIFTY REALTY'];
  const sectorChanges = SECTOR_NAMES
    .map(name => indicesData.find((d: any) => d.index === name || d.name === name))
    .filter(Boolean)
    .map((d: any) => Number(d.percentChange ?? d.variation ?? 0));
  const leadingCount     = sectorChanges.filter(v => v > 0.3).length;
  const leaderDispersion = sectorChanges.length > 0
    ? leadingCount / sectorChanges.length
    : 0.5;

  // ── PCR from NIFTY option chain cache ──────────────────────────
  let pcr: number | null = null;
  if ((optChainNifty as any)?.records?.length) {
    const recs     = (optChainNifty as any).records as any[];
    const totalCe  = recs.reduce((s: number, r: any) => s + (r.ce_oi || 0), 0);
    const totalPe  = recs.reduce((s: number, r: any) => s + (r.pe_oi || 0), 0);
    if (totalCe > 0) pcr = parseFloat((totalPe / totalCe).toFixed(2));
  }

  // ── Multi-timeframe Nifty trend from DB candles ─────────────────
  let niftyChgMTF = 0;
  try {
    const { rows } = await db.query(
      `SELECT close FROM candles WHERE instrument_key='NSE_INDEX|NIFTY 50' AND interval_unit='1day' ORDER BY ts DESC LIMIT 5`
    );
    if ((rows as any[]).length >= 2) {
      const closes = (rows as any[]).map((r: any) => Number(r.close));
      niftyChgMTF = closes[0] > 0 ? ((closes[0] - closes[closes.length - 1]) / closes[closes.length - 1]) * 100 : 0;
    }
  } catch {}

  // ── Breadth and vol from intel cache (MarketIntelligenceResult — snake_case fields) ──
  const vix       = intel?.volatility?.nifty_vix     ?? null;
  const advancing = intel?.advancing                  ?? 200;
  const declining = intel?.declining                  ?? 200;
  const fiiNet    = intel?.fii_dii?.[0]?.fii_net      ?? 0;
  const avgRange  = intel?.volatility?.avg_range_pct  ?? 2;
  const sectorsPos  = (intel?.sector_strength ?? []).filter((s: any) => s.change_percent > 0).length;
  const sectorsTotal= (intel?.sector_strength ?? []).length || 8;

  // ── Average confidence of recent top signals ────────────────────
  let avgTopConf = 60;
  try {
    const { rows } = await db.query(`
      SELECT AVG(confidence) AS avg_conf
      FROM signals
      WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
        AND signal_type IN ('BUY','SELL')
      LIMIT 1
    `);
    if ((rows[0] as any)?.avg_conf) avgTopConf = Number((rows[0] as any).avg_conf);
  } catch {}

  return {
    nifty_change_pct:   niftyChg,
    nifty_chg_5d:       niftyChgMTF,
    bank_nifty_pct:     bankChg,
    midcap_pct:         midcapChg,
    vix,
    advancing,
    declining,
    fii_net_crore:      fiiNet,
    pcr,
    avg_range_pct:      avgRange,
    sectors_positive:   sectorChanges.filter(v => v > 0).length,
    sectors_total:      sectorsTotal,
    leader_dispersion:  leaderDispersion,
    avg_top_confidence: avgTopConf,
    regime:             regime?.regime ?? 'NEUTRAL',
  };
}

// ════════════════════════════════════════════════════════════════
//  SCENARIO CLASSIFICATION
// ════════════════════════════════════════════════════════════════

function classifyVolatility(vix: number | null, avgRange: number): VolatilityMode {
  if (vix && vix >= 25) return 'extreme';
  if (vix && vix >= 18) return 'elevated';
  if (avgRange >= 3.5)  return 'elevated';
  if (avgRange <= 1.2)  return 'low';
  return 'normal';
}

function classifyBreadth(advancing: number, declining: number): BreadthState {
  const total = advancing + declining;
  if (!total) return 'neutral';
  const ratio = advancing / total;
  if (ratio >= 0.72) return 'strong_positive';
  if (ratio >= 0.58) return 'positive';
  if (ratio <= 0.28) return 'strong_negative';
  if (ratio <= 0.42) return 'negative';
  return 'neutral';
}

function scoreScenario(tag: ScenarioTag, inputs: ScenarioInputs & { breadthState: BreadthState }): number {
  let score = 0;

  switch (tag) {
    case 'trend_continuation':
      if (inputs.nifty_change_pct > 0.5)             score += 20;
      if (inputs.nifty_chg_5d > 1.5)                score += 10;  // multi-TF confirmation
      if (inputs.breadthState === 'positive' || inputs.breadthState === 'strong_positive') score += 20;
      if (inputs.leader_dispersion >= 0.6)           score += 15;  // broad sector leadership
      if (['BULL','STRONG_BULL'].includes(inputs.regime))         score += 20;
      if (inputs.fii_net_crore > 200)                score += 5;   // institutional support
      break;

    case 'breakout_expansion':
      if (inputs.nifty_change_pct > 1.0)             score += 25;
      if (inputs.avg_range_pct > 2.5)                score += 20;
      if (inputs.fii_net_crore > 300)                score += 20;
      if (inputs.breadthState === 'strong_positive')  score += 20;
      if (inputs.leader_dispersion >= 0.75) score += 10;
      if (inputs.pcr && inputs.pcr < 0.8)            score += 10;
      break;

    case 'choppy_mean_reverting':
      if (Math.abs(inputs.nifty_change_pct) < 0.4)   score += 35;
      if (inputs.breadthState === 'neutral')          score += 25;
      if (inputs.avg_range_pct < 2.0 && inputs.avg_range_pct > 0.8) score += 20;
      if (!['BULL','BEAR','STRONG_BULL','STRONG_BEAR'].includes(inputs.regime)) score += 20;
      break;

    case 'defensive_risk_off':
      if (inputs.nifty_change_pct < -0.8)            score += 30;
      if (['BEAR','STRONG_BEAR'].includes(inputs.regime))          score += 30;
      if (inputs.breadthState === 'negative' || inputs.breadthState === 'strong_negative') score += 20;
      if (inputs.fii_net_crore < -400)               score += 20;
      break;

    case 'short_covering_rally':
      if (inputs.nifty_change_pct > 0.8)             score += 20;
      if (inputs.pcr && inputs.pcr > 1.2)            score += 30;
      if (inputs.fii_net_crore > 200 && inputs.regime === 'BEAR') score += 30;
      if (inputs.breadthState === 'positive')         score += 20;
      break;

    case 'event_driven_volatility':
      if (inputs.vix && inputs.vix > 20)             score += 35;
      if (inputs.avg_range_pct > 3.5)               score += 35;
      if (Math.abs(inputs.nifty_change_pct) > 1.5)  score += 30;
      break;

    case 'no_trade_uncertain':
      if (inputs.avg_top_confidence < 55)            score += 35;
      if (Math.abs(inputs.nifty_change_pct) < 0.2)  score += 20;
      if (inputs.breadthState === 'neutral' && inputs.vix && inputs.vix > 16) score += 25;
      if (inputs.regime === 'CHOPPY')                score += 20;
      break;
  }

  return Math.min(100, score);
}

// Attach breadth state to inputs for scenario scoring
function enrichInputs(inputs: ScenarioInputs): ScenarioInputs & { breadthState: BreadthState } {
  return {
    ...inputs,
    breadthState: classifyBreadth(inputs.advancing, inputs.declining),
  };
}

// ════════════════════════════════════════════════════════════════
//  STRATEGY PERMISSIONS PER SCENARIO
// ════════════════════════════════════════════════════════════════

const SCENARIO_PERMISSIONS: Record<ScenarioTag, { allowed: string[]; blocked: string[] }> = {
  trend_continuation: {
    allowed: [STRATEGY_FAMILIES.TREND, STRATEGY_FAMILIES.PULLBACK, STRATEGY_FAMILIES.REL_STRENGTH, STRATEGY_FAMILIES.MOMENTUM],
    blocked: [STRATEGY_FAMILIES.MEAN_REVERSION],
  },
  breakout_expansion: {
    allowed: [STRATEGY_FAMILIES.BREAKOUT, STRATEGY_FAMILIES.MOMENTUM, STRATEGY_FAMILIES.REL_STRENGTH],
    blocked: [STRATEGY_FAMILIES.MEAN_REVERSION, STRATEGY_FAMILIES.DEFENSIVE],
  },
  choppy_mean_reverting: {
    allowed: [STRATEGY_FAMILIES.MEAN_REVERSION, STRATEGY_FAMILIES.VOL_COMPRESSION],
    blocked: [STRATEGY_FAMILIES.BREAKOUT, STRATEGY_FAMILIES.MOMENTUM],
  },
  defensive_risk_off: {
    allowed: [STRATEGY_FAMILIES.DEFENSIVE],
    blocked: [STRATEGY_FAMILIES.BREAKOUT, STRATEGY_FAMILIES.MOMENTUM, STRATEGY_FAMILIES.TREND],
  },
  short_covering_rally: {
    allowed: [STRATEGY_FAMILIES.MOMENTUM, STRATEGY_FAMILIES.REL_STRENGTH],
    blocked: [STRATEGY_FAMILIES.MEAN_REVERSION, STRATEGY_FAMILIES.DEFENSIVE],
  },
  event_driven_volatility: {
    allowed: [STRATEGY_FAMILIES.EVENT],
    blocked: [STRATEGY_FAMILIES.BREAKOUT, STRATEGY_FAMILIES.TREND, STRATEGY_FAMILIES.MOMENTUM, STRATEGY_FAMILIES.PULLBACK],
  },
  no_trade_uncertain: {
    allowed: [],
    blocked: Object.values(STRATEGY_FAMILIES),
  },
};

const SCENARIO_STANCE: Record<ScenarioTag, string> = {
  trend_continuation:     'Market trending — favor trend-following setups with momentum confirmation',
  breakout_expansion:     'Breakout environment — quality breakouts with volume have highest success rate',
  choppy_mean_reverting:  'Range-bound market — avoid breakouts, favor mean reversion near extremes',
  defensive_risk_off:     'Risk-off conditions — capital preservation priority, only highest conviction setups',
  short_covering_rally:   'Short squeeze dynamics — positions moving fast; size carefully and use tight stops',
  event_driven_volatility:'Event volatility — standard signals unreliable; wait for volatility to normalize',
  no_trade_uncertain:     'No clear edge — best action is no action; raise cash or hold existing winners only',
};

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

const CACHE_KEY = 'scenario:current';
const CACHE_TTL = 300; // 5 min

// In-process memory cache — keeps scenario available when Redis is disabled
let _scenarioMem: ScenarioResult | null = null;
let _scenarioMemAt = 0;
const SCENARIO_MEM_TTL_MS = 300_000; // 5 min

export async function computeScenario(): Promise<ScenarioResult> {
  // 1. In-process memory (survives Redis being disabled)
  if (_scenarioMem && Date.now() - _scenarioMemAt < SCENARIO_MEM_TTL_MS) return _scenarioMem;
  // 2. Redis cache
  const cached = await cacheGet<ScenarioResult>(CACHE_KEY);
  if (cached) { _scenarioMem = cached; _scenarioMemAt = Date.now(); return cached; }

  const rawInputs   = await gatherInputs();
  const inputs      = enrichInputs(rawInputs);
  const volMode     = classifyVolatility(inputs.vix, inputs.avg_range_pct);
  const breadthState = inputs.breadthState;

  // Score all scenarios
  const ALL_TAGS: ScenarioTag[] = [
    'trend_continuation', 'breakout_expansion', 'choppy_mean_reverting',
    'defensive_risk_off', 'short_covering_rally', 'event_driven_volatility',
    'no_trade_uncertain',
  ];

  const scores = ALL_TAGS.map(tag => ({ tag, score: scoreScenario(tag, inputs) }));
  scores.sort((a, b) => b.score - a.score);

  const winner    = scores[0];
  const scenarioTag: ScenarioTag = winner.score >= 40 ? winner.tag : 'no_trade_uncertain';
  const confidence = Math.min(95, winner.score + (winner.score - (scores[1]?.score ?? 0)) * 0.3);

  const permissions = SCENARIO_PERMISSIONS[scenarioTag];

  const dirBias: DirectionBias =
    inputs.nifty_change_pct > 0.3 ? 'bullish' :
    inputs.nifty_change_pct < -0.3 ? 'bearish' : 'neutral';

  const regimeAlignment = (() => {
    const regime = inputs.regime;
    if (scenarioTag === 'trend_continuation' && ['BULL','STRONG_BULL'].includes(regime)) return 90;
    if (scenarioTag === 'defensive_risk_off' && ['BEAR','STRONG_BEAR'].includes(regime))  return 90;
    if (scenarioTag === 'choppy_mean_reverting' && regime === 'CHOPPY')                    return 90;
    if (regime === 'NEUTRAL')                                                               return 60;
    return 50;
  })();

  const result: ScenarioResult = {
    scenario_tag:        scenarioTag,
    scenario_confidence: Math.round(confidence),
    market_stance_hint:  SCENARIO_STANCE[scenarioTag],
    allowed_strategies:  permissions.allowed,
    blocked_strategies:  permissions.blocked,
    volatility_mode:     volMode,
    breadth_state:       breadthState,
    direction_bias:      dirBias,
    regime_alignment:    regimeAlignment,
    computed_at:         new Date().toISOString(),
  };

  await cacheSet(CACHE_KEY, result, CACHE_TTL);
  _scenarioMem   = result;
  _scenarioMemAt = Date.now();

  // Persist to DB (non-blocking)
  db.query(`
    INSERT INTO market_scenarios
      (scenario_tag, scenario_confidence, breadth_state, volatility_state,
       sector_rotation_json, index_state_json, notes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    scenarioTag,
    result.scenario_confidence,
    breadthState,
    volMode,
    JSON.stringify({ sectors_positive: inputs.sectors_positive, total: inputs.sectors_total }),
    JSON.stringify({ nifty: inputs.nifty_change_pct, bank: inputs.bank_nifty_pct, midcap: inputs.midcap_pct }),
    JSON.stringify({ fii_net: inputs.fii_net_crore, pcr: inputs.pcr }),
  ]).catch(() => {});

  return result;
}

export function isStrategyAllowed(
  strategyKey:  string,
  scenario:     ScenarioResult
): { allowed: boolean; reason: string } {
  if (scenario.blocked_strategies.includes(strategyKey)) {
    return {
      allowed: false,
      reason:  `Strategy "${strategyKey}" is blocked in ${scenario.scenario_tag} scenario`,
    };
  }
  if (scenario.scenario_tag === 'no_trade_uncertain') {
    return { allowed: false, reason: 'No-trade scenario: all strategies blocked' };
  }
  return { allowed: true, reason: '' };
}
