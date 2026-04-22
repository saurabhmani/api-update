// ════════════════════════════════════════════════════════════════
//  triggerEngine — scores batch-snapshot + movers + news signals,
//  returns a short ranked list of symbols that warrant a deep fetch.
//
//  Inputs come from Tier A's cheap market-wide endpoints (already
//  fetched — triggering does NOT issue new API calls). Outputs are
//  consumed by the batchScheduler's Tier B phase.
// ════════════════════════════════════════════════════════════════

import type { MarketSnapshot, MoversResult } from '@/types/market';
import { cacheGet } from '@/lib/redis';
import { CONFIG, tierOf } from './schedulerConfig';
import { filterNotCoolingDown } from './cooldownStore';
import { snapshot as budgetSnapshot, maxDeepForLevel, triggerMultForLevel } from './apiBudgetGuard';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'triggerEngine' });

export type TriggerReason =
  | 'pctChange'
  | 'pctChangeStrong'
  | 'volumeSpike'
  | 'volumeSpikeStrong'
  | 'inTrending'
  | 'inShockers'
  | 'inMostActive'
  | 'freshNews'
  | 'near52wHigh'
  | 'near52wLow';

export interface TriggerCandidate {
  symbol: string;
  score: number;
  reasons: TriggerReason[];
  tier: 1 | 2 | 3;
  pctChange?: number;
  volumeRatio?: number;
}

export interface TriggerInputs {
  /** Per-symbol current snapshot, typically the batch write from
   *  Tier A. `volumeAvg20d` is optional; supply when available. */
  snapshots: Array<MarketSnapshot & {
    yearHigh?: number;
    yearLow?: number;
    volumeAvg20d?: number;
  }>;
  movers?: MoversResult;
  /** Symbols surfaced by price_shockers endpoint. */
  shockers?: string[];
  /** Symbols surfaced by most_active endpoint. */
  mostActive?: string[];
  /** Symbols with fresh news per Tier C. */
  freshNewsSymbols?: string[];
}

// ── Scoring ─────────────────────────────────────────────────────────

function scoreSnapshot(
  s: TriggerInputs['snapshots'][number],
  movers: Set<string>,
  shockers: Set<string>,
  mostActive: Set<string>,
  freshNews: Set<string>,
  thresholdMult: number,
): TriggerCandidate | null {
  const th = CONFIG.triggerThresholds;
  const reasons: TriggerReason[] = [];
  let score = 0;

  const pct = Math.abs(s.changePercent ?? 0);
  const pctMin    = th.pctChangeMin * thresholdMult;
  const pctStrong = th.pctChangeStrong * thresholdMult;

  if (pct >= pctStrong) { score += 40; reasons.push('pctChangeStrong'); }
  else if (pct >= pctMin) { score += 25; reasons.push('pctChange'); }

  const volRatio = s.volumeAvg20d && s.volumeAvg20d > 0
    ? s.volume / s.volumeAvg20d
    : 0;
  const volMin    = th.volumeRatioMin * thresholdMult;
  const volStrong = th.volumeRatioStrong * thresholdMult;

  if (volRatio >= volStrong) { score += 30; reasons.push('volumeSpikeStrong'); }
  else if (volRatio >= volMin) { score += 20; reasons.push('volumeSpike'); }

  if (movers.has(s.symbol))     { score += 25; reasons.push('inTrending'); }
  if (shockers.has(s.symbol))   { score += 25; reasons.push('inShockers'); }
  if (mostActive.has(s.symbol)) { score += 15; reasons.push('inMostActive'); }
  if (freshNews.has(s.symbol))  { score += 20; reasons.push('freshNews'); }

  // 52w proximity — requires yearHigh/yearLow (IndianAPI returns them
  // on /stock; batch endpoint may or may not — fall back to cached
  // CorporateIntel if your pipeline writes it).
  if (s.yearHigh && s.yearHigh > 0) {
    const distHigh = (s.yearHigh - s.price) / s.yearHigh;
    if (distHigh >= 0 && distHigh <= th.near52wPct) {
      score += 15; reasons.push('near52wHigh');
    }
  }
  if (s.yearLow && s.yearLow > 0) {
    const distLow = (s.price - s.yearLow) / s.yearLow;
    if (distLow >= 0 && distLow <= th.near52wPct) {
      score += 15; reasons.push('near52wLow');
    }
  }

  if (reasons.length === 0) return null;

  // Tier bonus — prefer Tier 1 when ties.
  const tier = tierOf(s.symbol);
  if (tier === 1) score += 10;
  else if (tier === 2) score += 5;

  return {
    symbol: s.symbol,
    score,
    reasons,
    tier,
    pctChange: s.changePercent,
    volumeRatio: volRatio || undefined,
  };
}

// ── Main entry ──────────────────────────────────────────────────────

export interface EvaluateOpts {
  /** Max symbols to return; defaults to budget-aware CONFIG value. */
  maxSymbols?: number;
}

export async function evaluate(
  inputs: TriggerInputs,
  opts: EvaluateOpts = {},
): Promise<TriggerCandidate[]> {
  const budget = await budgetSnapshot();
  const max = opts.maxSymbols ?? maxDeepForLevel(budget.level);
  if (max <= 0) {
    log.info('trigger engine skipped — budget freeze', { level: budget.level });
    return [];
  }
  const thresholdMult = triggerMultForLevel(budget.level);

  const moversSet = new Set<string>([
    ...(inputs.movers?.gainers ?? []).map(m => m.symbol.toUpperCase()),
    ...(inputs.movers?.losers ?? []).map(m => m.symbol.toUpperCase()),
  ]);
  const shockersSet   = new Set((inputs.shockers   ?? []).map(s => s.toUpperCase()));
  const mostActiveSet = new Set((inputs.mostActive ?? []).map(s => s.toUpperCase()));
  const freshNewsSet  = new Set((inputs.freshNewsSymbols ?? []).map(s => s.toUpperCase()));

  // Score all candidates.
  const scored: TriggerCandidate[] = [];
  for (const snap of inputs.snapshots) {
    const c = scoreSnapshot(snap, moversSet, shockersSet, mostActiveSet, freshNewsSet, thresholdMult);
    if (c) scored.push(c);
  }

  // Movers/shockers/most-active symbols NOT present in snapshots (e.g.
  // Tier 3 discovery names we don't batch) — include at a baseline score.
  const knownSyms = new Set(scored.map(c => c.symbol));
  const discoveryUnion = new Set<string>([...moversSet, ...shockersSet, ...mostActiveSet, ...freshNewsSet]);
  for (const sym of discoveryUnion) {
    if (knownSyms.has(sym)) continue;
    const reasons: TriggerReason[] = [];
    let score = 0;
    if (moversSet.has(sym))     { reasons.push('inTrending');   score += 25; }
    if (shockersSet.has(sym))   { reasons.push('inShockers');   score += 25; }
    if (mostActiveSet.has(sym)) { reasons.push('inMostActive'); score += 15; }
    if (freshNewsSet.has(sym))  { reasons.push('freshNews');    score += 20; }
    if (reasons.length === 0) continue;

    const tier = tierOf(sym);
    if (tier === 1) score += 10; else if (tier === 2) score += 5;

    scored.push({ symbol: sym, score, reasons, tier });
  }

  // Rank.
  scored.sort((a, b) => b.score - a.score || a.tier - b.tier);

  // Filter cooldowns (deep-fetch reason only at this stage).
  const eligible = await filterNotCoolingDown(scored.map(c => c.symbol), 'deep');
  const eligibleSet = new Set(eligible);
  const withoutCooldown = scored.filter(c => eligibleSet.has(c.symbol));

  // Cap.
  const picked = withoutCooldown.slice(0, max);

  log.info('trigger evaluation complete', {
    scored: scored.length,
    eligible: withoutCooldown.length,
    picked: picked.length,
    max,
    level: budget.level,
    thresholdMult,
  });

  return picked;
}

// ── Helper: fetch fresh news symbols from cache ─────────────────────
// Tier C writes a list of recently-updated news symbols to this key.
// The trigger engine reads it so it can score `freshNews`.
const NEWS_INDEX_KEY = 'news:recent:symbols';

export async function readRecentNewsSymbols(): Promise<string[]> {
  const v = await cacheGet<string[]>(NEWS_INDEX_KEY);
  return v ?? [];
}
