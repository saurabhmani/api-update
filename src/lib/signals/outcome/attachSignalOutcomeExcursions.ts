// Batch-load persisted outcome excursions and attach to signal rows
// before due-diligence / daily-report builders run.

import { db } from '@/lib/db';

export const INTRADAY_TAPE_GAP_REASON =
  'per-signal price history not persisted yet (intraday MFE/MAE and time-to-target unavailable)';

export function isExpectedPlatformGapWarning(message: string): boolean {
  return /per-signal price history|intraday MFE\/MAE|time-to-target unavailable/i.test(message);
}

export interface OutcomeExcursionAttach {
  max_fav_excursion_pct: number | null;
  max_adv_excursion_pct: number | null;
  max_gain_pct: number | null;
  outcome_at: string | null;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickMfe(row: Record<string, unknown>): number | null {
  return num(row.mfe_pct)
    ?? num(row.max_fav_excursion_pct)
    ?? num(row.max_gain_pct);
}

function pickMae(row: Record<string, unknown>): number | null {
  return num(row.mae_pct) ?? num(row.max_adv_excursion_pct);
}

function pickOutcomeAt(row: Record<string, unknown>): string | null {
  const raw = row.outcome_at ?? row.evaluated_at ?? row.resolved_at;
  if (!raw) return null;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

export async function fetchOutcomeExcursionsBySignalId(
  signalIds: number[],
): Promise<Map<number, OutcomeExcursionAttach>> {
  const map = new Map<number, OutcomeExcursionAttach>();
  const ids = [...new Set(signalIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return map;

  try {
    const placeholders = ids.map(() => '?').join(', ');
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM q365_signal_outcomes WHERE signal_id IN (${placeholders})`,
      ids,
    );
    for (const row of rows) {
      const signalId = num(row.signal_id);
      if (signalId == null) continue;
      map.set(signalId, {
        max_fav_excursion_pct: pickMfe(row),
        max_adv_excursion_pct: pickMae(row),
        max_gain_pct:          num(row.max_gain_pct),
        outcome_at:            pickOutcomeAt(row),
      });
    }
  } catch {
    // Table missing or legacy shape — leave map empty.
  }
  return map;
}

export function attachOutcomeExcursionsToRows<T extends { id?: number | null }>(
  rows: readonly T[],
  excursions: Map<number, OutcomeExcursionAttach>,
): T[] {
  if (excursions.size === 0) return [...rows];
  return rows.map((row) => {
    const id = num(row.id);
    if (id == null) return row;
    const o = excursions.get(id);
    if (!o) return row;
    const mfe = o.max_fav_excursion_pct ?? o.max_gain_pct;
    return {
      ...row,
      max_fav_excursion_pct: o.max_fav_excursion_pct,
      max_adv_excursion_pct: o.max_adv_excursion_pct,
      max_gain_pct:          o.max_gain_pct,
      maxFavorableMovePercent: mfe,
      maxAdverseMovePercent:   o.max_adv_excursion_pct,
      outcome_at:              o.outcome_at,
    };
  });
}

export async function attachOutcomeExcursionsToMany<T extends { id?: number | null }>(
  rowGroups: readonly (readonly T[])[],
): Promise<T[][]> {
  const ids: number[] = [];
  for (const group of rowGroups) {
    for (const row of group) {
      const id = num(row.id);
      if (id != null) ids.push(id);
    }
  }
  const excursions = await fetchOutcomeExcursionsBySignalId(ids);
  return rowGroups.map((group) => attachOutcomeExcursionsToRows(group, excursions));
}
