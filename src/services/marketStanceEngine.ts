/**
 * Market Stance Engine — Quantorus365
 *
 * Stance configs here define RELATIVE adjustments.
 * Absolute thresholds are loaded from systemConfigService.getConfig().
 * applyStanceOverrides(cfg, stance) merges both for the final effective threshold.
 *
 * Determines the global behavior posture for the current session.
 * Market stance controls how aggressively or defensively the entire
 * platform behaves: signal thresholds, alert volume, risk multipliers,
 * ranking weights, and dashboard messaging.
 *
 * States: aggressive | selective | defensive | capital_preservation
 */

import { cacheGet, cacheSet }   from '@/lib/redis';
import { db }                    from '@/lib/db';
import type { ScenarioResult }   from './scenarioEngine';
import { getConfig, applyStanceOverrides } from './systemConfigService';

// ════════════════════════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════════════════════════

export type MarketStance =
  | 'aggressive'
  | 'selective'
  | 'defensive'
  | 'capital_preservation';

export interface StanceConfig {
  // Threshold overrides applied platform-wide
  min_confidence:         number;   // override MIN_CONFIDENCE
  min_rr:                 number;   // override MIN_RR_SWING
  max_sector_exposure:    number;   // % cap per sector
  max_positions:          number;   // max concurrent open positions
  risk_multiplier:        number;   // applied to stop distances (1.0 = normal)
  alert_frequency:        number;   // 0–1 multiplier on alert generation
  // Strategy behavior
  allowed_strategy_types: string[]; // empty = no restriction
  boosted_strategy_types: string[]; // get score bonus
  suppressed_strategy_types: string[]; // get score penalty
}

export interface StanceResult {
  market_stance:       MarketStance;
  stance_confidence:   number;        // 0–100
  stance_config:       StanceConfig;
  rationale:           string;
  scenario_tag:        string;
  breadth_score:       number;
  volatility_score:    number;
  rejection_rate:      number;       // recent signal rejection %
  avg_top_confidence:  number;
  guidance_message:    string;
  computed_at:         string;
}

// ════════════════════════════════════════════════════════════════
//  STANCE CONFIGS
// ════════════════════════════════════════════════════════════════

const STANCE_CONFIGS: Record<MarketStance, StanceConfig> = {
  aggressive: {
    min_confidence:           55,   // below DB default — stance relaxes requirements
    min_rr:                   1.5,
    max_sector_exposure:      40,
    max_positions:            15,
    risk_multiplier:          1.0,
    alert_frequency:          1.0,
    allowed_strategy_types:   [],
    boosted_strategy_types:   ['breakout_continuation', 'momentum_expansion', 'trend_continuation'],
    suppressed_strategy_types:[],
  },
  selective: {
    min_confidence:           70,
    min_rr:                   1.8,
    max_sector_exposure:      30,
    max_positions:            10,
    risk_multiplier:          1.1,
    alert_frequency:          0.6,
    allowed_strategy_types:   [],
    boosted_strategy_types:   ['trend_continuation', 'relative_strength_leader', 'pullback_in_trend'],
    suppressed_strategy_types:['breakout_continuation'],
  },
  defensive: {
    min_confidence:           75,   // above DB default — stance tightens requirements
    min_rr:                   2.0,
    max_sector_exposure:      20,
    max_positions:            6,
    risk_multiplier:          1.3,
    alert_frequency:          0.3,
    allowed_strategy_types:   ['defensive_quality', 'mean_reversion', 'pullback_in_trend'],
    boosted_strategy_types:   ['defensive_quality'],
    suppressed_strategy_types:['breakout_continuation', 'momentum_expansion', 'event_driven'],
  },
  capital_preservation: {
    min_confidence:           85,   // far above DB default — near-block mode
    min_rr:                   2.5,
    max_sector_exposure:      15,
    max_positions:            3,
    risk_multiplier:          1.5,
    alert_frequency:          0.1,
    allowed_strategy_types:   [],  // effectively blocks everything via confidence
    boosted_strategy_types:   [],
    suppressed_strategy_types: Object.values({
      b:'breakout_continuation', m:'momentum_expansion', t:'trend_continuation',
      e:'event_driven', r:'relative_strength_leader',
    }),
  },
};

const GUIDANCE: Record<MarketStance, string> = {
  aggressive:
    'Multiple sectors in gear with healthy breadth. Full position sizing permitted. Execute setups with conviction.',
  selective:
    'Uneven participation. Only the highest-quality setups meet the bar today. Reduce size on marginal signals.',
  defensive:
    'Broad market under pressure or conditions are inconsistent. Tighten stops on existing positions. Be very selective with new entries.',
  capital_preservation:
    'Market conditions are hostile or highly uncertain. Raise cash. Protect existing capital. Avoid new entries.',
};

// ════════════════════════════════════════════════════════════════
//  STANCE COMPUTATION
// ════════════════════════════════════════════════════════════════

interface StanceInputs {
  scenario:          ScenarioResult;
  breadth_ratio:     number;     // advancing / total (0–1)
  vix:               number | null;
  avg_range_pct:     number;
  rejection_rate:    number;     // 0–1
  avg_top_confidence:number;
  regime:            string;
  fii_net:           number;
}

async function gatherStanceInputs(scenario: ScenarioResult): Promise<StanceInputs> {
  const intel    = await cacheGet<any>('market:intelligence');
  const regime   = await cacheGet<any>('market:regime');

  const advancing = intel?.advancing ?? 200;
  const declining = intel?.declining ?? 200;
  const total     = advancing + declining;
  const breadthRatio = total > 0 ? advancing / total : 0.5;

  const vix       = intel?.volatility?.nifty_vix    ?? null;
  const avgRange  = intel?.volatility?.avg_range_pct ?? 2;
  const fiiNet    = intel?.fii_dii?.[0]?.fii_net    ?? 0;

  // Recent rejection rate from DB
  let rejectionRate = 0.5;
  try {
    const { rows } = await db.query(`
      SELECT
        SUM(CASE WHEN approved=0 THEN 1 ELSE 0 END) AS rejected,
        COUNT(*) AS total
      FROM signal_rejections
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
      LIMIT 1
    `);
    const r   = rows[0] as any;
    const tot = Number(r?.total || 0);
    const rej = Number(r?.rejected || 0);
    if (tot > 5) rejectionRate = rej / tot;
  } catch {}

  // Average confidence of recent approved signals
  let avgTopConf = 60;
  try {
    const { rows } = await db.query(`
      SELECT AVG(confidence_score) AS avg_c
      FROM confidence_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 2 HOUR)
      LIMIT 1
    `);
    if ((rows[0] as any)?.avg_c) avgTopConf = Number((rows[0] as any).avg_c);
  } catch {}

  return {
    scenario,
    breadth_ratio:     breadthRatio,
    vix,
    avg_range_pct:     avgRange,
    rejection_rate:    rejectionRate,
    avg_top_confidence: avgTopConf,
    regime:            regime?.regime ?? 'NEUTRAL',
    fii_net:           fiiNet,
  };
}

function computeStanceScore(stance: MarketStance, inputs: StanceInputs): number {
  let score = 0;

  switch (stance) {
    case 'aggressive':
      if (inputs.breadth_ratio >= 0.62)                  score += 25;
      if (['BULL','STRONG_BULL'].includes(inputs.regime)) score += 25;
      if (inputs.rejection_rate < 0.35)                  score += 20;
      if (inputs.avg_top_confidence >= 70)               score += 20;
      if (inputs.fii_net > 300)                          score += 10;
      if (inputs.scenario.scenario_tag === 'trend_continuation' || inputs.scenario.scenario_tag === 'breakout_expansion') score += 15;
      break;

    case 'selective':
      if (inputs.breadth_ratio >= 0.50 && inputs.breadth_ratio < 0.65) score += 30;
      if (['NEUTRAL','BULL'].includes(inputs.regime))    score += 25;
      if (inputs.rejection_rate >= 0.35 && inputs.rejection_rate < 0.60) score += 20;
      if (inputs.avg_top_confidence >= 60 && inputs.avg_top_confidence < 72) score += 25;
      break;

    case 'defensive':
      if (inputs.breadth_ratio < 0.45)                   score += 25;
      if (['BEAR','CHOPPY'].includes(inputs.regime))     score += 25;
      if (inputs.rejection_rate >= 0.55)                 score += 20;
      if (inputs.vix && inputs.vix >= 17)                score += 20;
      if (inputs.scenario.scenario_tag === 'defensive_risk_off') score += 20;
      break;

    case 'capital_preservation':
      if (inputs.breadth_ratio < 0.30)                   score += 30;
      if (inputs.regime === 'STRONG_BEAR')               score += 30;
      if (inputs.rejection_rate >= 0.75)                 score += 20;
      if (inputs.vix && inputs.vix >= 25)                score += 20;
      if (inputs.scenario.scenario_tag === 'no_trade_uncertain' || inputs.scenario.scenario_tag === 'event_driven_volatility') score += 20;
      break;
  }

  return Math.min(100, score);
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

const CACHE_KEY = 'market:stance';
const CACHE_TTL = 300;

export async function computeMarketStance(scenario: ScenarioResult): Promise<StanceResult> {
  const cached = await cacheGet<StanceResult>(CACHE_KEY);
  if (cached && cached.scenario_tag === scenario.scenario_tag) return cached;

  const inputs = await gatherStanceInputs(scenario);

  const stances: MarketStance[] = ['aggressive', 'selective', 'defensive', 'capital_preservation'];
  const scored = stances.map(s => ({ stance: s, score: computeStanceScore(s, inputs) }));
  scored.sort((a, b) => b.score - a.score);

  const winner: MarketStance = scored[0].score >= 35 ? scored[0].stance : 'selective';
  const confidence = Math.min(92, scored[0].score + (scored[0].score - (scored[1]?.score ?? 0)) * 0.2);

  const rationale = [
    `Breadth: ${(inputs.breadth_ratio * 100).toFixed(0)}% advancing`,
    inputs.vix ? `VIX: ${inputs.vix.toFixed(1)}` : '',
    `Rejection rate: ${(inputs.rejection_rate * 100).toFixed(0)}%`,
    `Avg confidence: ${inputs.avg_top_confidence.toFixed(0)}`,
    `Regime: ${inputs.regime}`,
  ].filter(Boolean).join(' | ');

  const result: StanceResult = {
    market_stance:       winner,
    stance_confidence:   Math.round(confidence),
    stance_config:       STANCE_CONFIGS[winner],
    rationale,
    scenario_tag:        scenario.scenario_tag,
    breadth_score:       Math.round(inputs.breadth_ratio * 100),
    volatility_score:    inputs.vix ? Math.round(Math.min(100, inputs.vix * 4)) : 40,
    rejection_rate:      parseFloat(inputs.rejection_rate.toFixed(2)),
    avg_top_confidence:  Math.round(inputs.avg_top_confidence),
    guidance_message:    GUIDANCE[winner],
    computed_at:         new Date().toISOString(),
  };

  await cacheSet(CACHE_KEY, result, CACHE_TTL);

  db.query(`
    INSERT INTO market_stance_logs
      (market_stance, stance_confidence, scenario_tag, breadth_score,
       volatility_score, rejection_rate, avg_top_confidence, notes_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    winner, result.stance_confidence, scenario.scenario_tag,
    result.breadth_score, result.volatility_score,
    result.rejection_rate, result.avg_top_confidence,
    JSON.stringify({ regime: inputs.regime, rationale }),
  ]).catch(() => {});

  return result;
}

export function getStanceConfig(stance: MarketStance): StanceConfig {
  return STANCE_CONFIGS[stance];
}

export async function getCurrentStanceConfig(): Promise<StanceConfig> {
  const cached = await cacheGet<StanceResult>(CACHE_KEY);
  if (cached) return cached.stance_config;
  return STANCE_CONFIGS.selective; // safe default
}
