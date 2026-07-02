// ════════════════════════════════════════════════════════════════
//  NSE 1000 universe churn control — weekly rebuild selection
//
//  Rules (1-based rank, 1 = most liquid):
//    • Add new symbols only if rank <= addMaxRank (default 900)
//    • Keep existing if rank <= keepMaxRank (1100) AND data quality OK
//    • Remove if rank > removeMinRank (1200) OR data quality fails
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { UniverseRankInput } from './nseUniverseRanker';
import { NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT } from './nseUniverseRanker';

export type ChurnAction = 'add' | 'keep' | 'remove';

export interface UniverseChurnThresholds {
  addMaxRank: number;
  keepMaxRank: number;
  removeMinRank: number;
}

export interface ChurnSymbolDecision {
  symbol: string;
  rank: number | null;
  action: ChurnAction;
  dataQualityOk: boolean;
  reason: string;
  compositeScore: number;
}

export interface ChurnSelectionResult {
  selected: string[];
  decisions: ChurnSymbolDecision[];
  added: number;
  kept: number;
  removed: number;
  targetSize: number;
  thresholds: UniverseChurnThresholds;
}

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

export const UNIVERSE_CHURN_THRESHOLDS_DEFAULT = (): UniverseChurnThresholds => ({
  addMaxRank: envNum('UNIVERSE_CHURN_ADD_MAX_RANK', 100, 2000, 900),
  keepMaxRank: envNum('UNIVERSE_CHURN_KEEP_MAX_RANK', 100, 2500, 1100),
  removeMinRank: envNum('UNIVERSE_CHURN_REMOVE_MIN_RANK', 100, 3000, 1200),
});

export function isSymbolDataQualityOk(
  row: UniverseRankInput | undefined,
  totalDailyBars: number,
  minBars: number = NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT(),
): boolean {
  if (!row) return false;
  if (totalDailyBars < minBars) return false;
  if (row.candleCompleteness < 0.5) return false;
  if (row.tradedValue <= 0) return false;
  return true;
}

export async function loadActiveUniverseSymbolSet(): Promise<Set<string>> {
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol FROM q365_universe WHERE is_active = 1`,
  );
  return new Set(
    (rows as Array<{ symbol: string }>)
      .map((r) => String(r.symbol).trim().toUpperCase())
      .filter(Boolean),
  );
}

/** Pure churn selection — exported for tests. */
export function computeUniverseChurnSelection(input: {
  ranked: UniverseRankInput[];
  currentActive: Set<string>;
  totalDailyBars: Map<string, number>;
  targetSize: number;
  maxSize?: number;
  thresholds?: UniverseChurnThresholds;
  minBars?: number;
}): ChurnSelectionResult {
  const thresholds = input.thresholds ?? UNIVERSE_CHURN_THRESHOLDS_DEFAULT();
  const minBars = input.minBars ?? NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT();
  const maxSize = input.maxSize ?? input.targetSize + 50;
  const rankBySymbol = new Map<string, number>();
  const rowBySymbol = new Map<string, UniverseRankInput>();

  input.ranked.forEach((row, idx) => {
    const sym = row.symbol.toUpperCase();
    rankBySymbol.set(sym, idx + 1);
    rowBySymbol.set(sym, row);
  });

  const decisions: ChurnSymbolDecision[] = [];
  const selected = new Set<string>();

  const dq = (sym: string): boolean =>
    isSymbolDataQualityOk(
      rowBySymbol.get(sym),
      input.totalDailyBars.get(sym) ?? 0,
      minBars,
    );

  // Phase 1 — evaluate current active symbols
  for (const sym of [...input.currentActive].sort()) {
    const rank = rankBySymbol.get(sym) ?? null;
    const dataQualityOk = dq(sym);
    const compositeScore = rowBySymbol.get(sym)?.compositeScore ?? 0;

    let action: ChurnAction = 'remove';
    let reason = '';

    if (rank == null || !dataQualityOk) {
      action = 'remove';
      reason = rank == null
        ? 'unranked or ineligible — data quality failed'
        : 'data quality failed';
    } else if (rank > thresholds.removeMinRank) {
      action = 'remove';
      reason = `rank ${rank} > remove threshold ${thresholds.removeMinRank}`;
    } else if (rank <= thresholds.keepMaxRank && dataQualityOk) {
      action = 'keep';
      reason = `rank ${rank} <= keep threshold ${thresholds.keepMaxRank}`;
      selected.add(sym);
    } else {
      // rank in (keepMaxRank, removeMinRank] with good data — hold (no forced remove)
      action = 'keep';
      reason = `rank ${rank} in hold band (${thresholds.keepMaxRank}, ${thresholds.removeMinRank}]`;
      selected.add(sym);
    }

    decisions.push({
      symbol: sym,
      rank,
      action,
      dataQualityOk,
      reason,
      compositeScore,
    });
  }

  let kept = decisions.filter((d) => d.action === 'keep').length;
  let removed = decisions.filter((d) => d.action === 'remove').length;

  let added = 0;

  // Phase 2 — add new symbols (rank <= addMaxRank, good data)
  for (const row of input.ranked) {
    if (selected.size >= maxSize) break;
    const sym = row.symbol.toUpperCase();
    if (selected.has(sym) || input.currentActive.has(sym)) continue;
    const rank = rankBySymbol.get(sym)!;
    const dataQualityOk = dq(sym);
    if (rank <= thresholds.addMaxRank && dataQualityOk) {
      selected.add(sym);
      decisions.push({
        symbol: sym,
        rank,
        action: 'add',
        dataQualityOk,
        reason: `new add rank ${rank} <= ${thresholds.addMaxRank}`,
        compositeScore: row.compositeScore,
      });
      added++;
    }
  }

  // Phase 3 — top-up toward target from add band only (rank <= addMaxRank)
  if (selected.size < input.targetSize) {
    for (const row of input.ranked) {
      if (selected.size >= input.targetSize || selected.size >= maxSize) break;
      const sym = row.symbol.toUpperCase();
      if (selected.has(sym)) continue;
      const rank = rankBySymbol.get(sym)!;
      if (rank <= thresholds.addMaxRank && dq(sym)) {
        selected.add(sym);
        decisions.push({
          symbol: sym,
          rank,
          action: 'add',
          dataQualityOk: true,
          reason: `top-up rank ${rank} <= ${thresholds.addMaxRank}`,
          compositeScore: row.compositeScore,
        });
        added++;
      }
    }
  }

  if (selected.size > maxSize) {
    const trimCandidates = decisions
      .filter((d) => d.action === 'add')
      .sort((a, b) => (b.rank ?? 9999) - (a.rank ?? 9999));
    for (const d of trimCandidates) {
      if (selected.size <= maxSize) break;
      selected.delete(d.symbol);
      d.action = 'remove';
      d.reason = `${d.reason}; trimmed over maxSize=${maxSize}`;
      added = Math.max(0, added - 1);
      removed++;
    }
  }

  added = decisions.filter((d) => d.action === 'add').length;
  kept = decisions.filter((d) => d.action === 'keep').length;
  removed = decisions.filter((d) => d.action === 'remove').length;

  return {
    selected: [...selected].sort(),
    decisions,
    added,
    kept,
    removed,
    targetSize: input.targetSize,
    thresholds,
  };
}
