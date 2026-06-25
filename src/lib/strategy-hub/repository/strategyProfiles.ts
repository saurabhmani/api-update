import { db } from '@/lib/db';
import type { StrategyProfileRow } from '../types';

export async function loadAllStrategyProfiles(): Promise<Map<string, StrategyProfileRow>> {
  const map = new Map<string, StrategyProfileRow>();
  try {
    const { rows } = await db.query(
      `SELECT strategy_id, deployment_status, paper_trading_enabled,
              risk_profile, metadata_json, version, notes
         FROM strategy_hub_profiles`,
    );
    for (const row of rows as StrategyProfileRow[]) {
      map.set(row.strategy_id, row);
    }
  } catch {
    // Table may not exist before migration
  }
  return map;
}

export async function loadStrategyProfile(strategyId: string): Promise<StrategyProfileRow | null> {
  try {
    const { rows } = await db.query(
      `SELECT strategy_id, deployment_status, paper_trading_enabled,
              risk_profile, metadata_json, version, notes
         FROM strategy_hub_profiles
        WHERE strategy_id = ?
        LIMIT 1`,
      [strategyId],
    );
    return rows.length ? (rows[0] as StrategyProfileRow) : null;
  } catch {
    return null;
  }
}
