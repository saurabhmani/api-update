import { db } from '@/lib/db';
import type {
  DeploymentHistoryRow,
  DeployedStrategyRow,
  StrategyProfileRow,
} from '../types';
import type {
  DeploymentEnvironment,
  DeploymentEventType,
  DeploymentLifecycle,
} from '../deploymentLifecycle';
import { ensureStrategyHubTables } from './strategyHubSchema';

function parseJsonField(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mapProfile(row: Record<string, unknown>): StrategyProfileRow {
  return {
    strategy_id:           String(row.strategy_id),
    deployment_status:     String(row.deployment_status) as StrategyProfileRow['deployment_status'],
    paper_trading_enabled: Boolean(Number(row.paper_trading_enabled)),
    risk_profile:          row.risk_profile != null ? String(row.risk_profile) : null,
    metadata_json:         parseJsonField(row.metadata_json),
    version:               String(row.version ?? '1.0.0'),
    notes:                 row.notes != null ? String(row.notes) : null,
    updated_at:            row.updated_at != null ? String(row.updated_at) : undefined,
    created_at:            row.created_at != null ? String(row.created_at) : undefined,
  };
}

export async function loadAllStrategyProfiles(): Promise<Map<string, StrategyProfileRow>> {
  const map = new Map<string, StrategyProfileRow>();
  try {
    await ensureStrategyHubTables();
    const { rows } = await db.query(
      `SELECT strategy_id, deployment_status, paper_trading_enabled,
              risk_profile, metadata_json, version, notes,
              updated_at, created_at
         FROM strategy_hub_profiles`,
    );
    for (const row of rows as Record<string, unknown>[]) {
      const profile = mapProfile(row);
      map.set(profile.strategy_id, profile);
    }
  } catch {
    // Table may not exist before first ensure
  }
  return map;
}

export async function loadStrategyProfile(strategyId: string): Promise<StrategyProfileRow | null> {
  try {
    await ensureStrategyHubTables();
    const { rows } = await db.query(
      `SELECT strategy_id, deployment_status, paper_trading_enabled,
              risk_profile, metadata_json, version, notes,
              updated_at, created_at
         FROM strategy_hub_profiles
        WHERE strategy_id = ?
        LIMIT 1`,
      [strategyId],
    );
    return rows.length ? mapProfile(rows[0] as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function upsertStrategyProfile(
  strategyId: string,
  patch: Partial<Pick<StrategyProfileRow, 'deployment_status' | 'paper_trading_enabled' | 'risk_profile' | 'notes' | 'metadata_json'>>,
): Promise<StrategyProfileRow> {
  await ensureStrategyHubTables();
  const existing = await loadStrategyProfile(strategyId);

  if (!existing) {
    await db.query(
      `INSERT INTO strategy_hub_profiles
         (strategy_id, deployment_status, paper_trading_enabled, risk_profile, notes, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        strategyId,
        patch.deployment_status ?? 'draft',
        patch.paper_trading_enabled ? 1 : 0,
        patch.risk_profile ?? null,
        patch.notes ?? null,
        patch.metadata_json ? JSON.stringify(patch.metadata_json) : null,
      ],
    );
  } else {
    await db.query(
      `UPDATE strategy_hub_profiles
          SET deployment_status     = COALESCE(?, deployment_status),
              paper_trading_enabled = COALESCE(?, paper_trading_enabled),
              risk_profile          = COALESCE(?, risk_profile),
              notes                 = COALESCE(?, notes),
              metadata_json         = COALESCE(?, metadata_json),
              updated_at            = NOW()
        WHERE strategy_id = ?`,
      [
        patch.deployment_status ?? null,
        patch.paper_trading_enabled != null ? (patch.paper_trading_enabled ? 1 : 0) : null,
        patch.risk_profile ?? null,
        patch.notes ?? null,
        patch.metadata_json ? JSON.stringify(patch.metadata_json) : null,
        strategyId,
      ],
    );
  }

  const updated = await loadStrategyProfile(strategyId);
  if (!updated) throw new Error(`Failed to upsert strategy profile for ${strategyId}`);
  return updated;
}

export async function recordDeploymentHistory(entry: {
  strategyId: string;
  userId: number;
  fromStatus: string | null;
  toStatus: DeploymentLifecycle;
  environment: DeploymentEnvironment;
  eventType: DeploymentEventType;
  actor?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await ensureStrategyHubTables();
  await db.query(
    `INSERT INTO strategy_hub_deployment_history
       (strategy_id, user_id, from_status, to_status, environment, event_type, actor, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.strategyId,
      entry.userId,
      entry.fromStatus,
      entry.toStatus,
      entry.environment,
      entry.eventType,
      entry.actor ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}

export async function listDeploymentHistory(opts: {
  userId?: number;
  strategyId?: string;
  limit?: number;
}): Promise<DeploymentHistoryRow[]> {
  await ensureStrategyHubTables();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.userId != null) {
    clauses.push('user_id = ?');
    params.push(opts.userId);
  }
  if (opts.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(opts.strategyId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, strategy_id, user_id, from_status, to_status, environment,
            event_type, actor, details_json, created_at
       FROM strategy_hub_deployment_history
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );

  return (rows as Record<string, unknown>[]).map((r) => ({
    id:            Number(r.id),
    strategy_id:   String(r.strategy_id),
    user_id:       Number(r.user_id),
    from_status:   r.from_status != null ? String(r.from_status) : null,
    to_status:     String(r.to_status),
    environment:   String(r.environment) as DeploymentEnvironment,
    event_type:    String(r.event_type) as DeploymentEventType,
    actor:         r.actor != null ? String(r.actor) : null,
    details_json:  parseJsonField(r.details_json),
    created_at:    String(r.created_at),
  }));
}

/** Strategies with paper_deployed or live status for a user (from history + profile). */
export async function listDeployedStrategiesForUser(userId: number): Promise<DeployedStrategyRow[]> {
  await ensureStrategyHubTables();
  const { rows } = await db.query(
    `SELECT p.strategy_id, p.deployment_status, p.paper_trading_enabled, p.updated_at,
            h.last_deployed_at, h.last_deployed_by, h.last_environment
       FROM strategy_hub_profiles p
       INNER JOIN (
         SELECT strategy_id,
                MAX(created_at) AS last_deployed_at,
                SUBSTRING_INDEX(
                  GROUP_CONCAT(COALESCE(actor, '') ORDER BY created_at DESC SEPARATOR '||'),
                  '||', 1
                ) AS last_deployed_by,
                SUBSTRING_INDEX(
                  GROUP_CONCAT(environment ORDER BY created_at DESC SEPARATOR '||'),
                  '||', 1
                ) AS last_environment
           FROM strategy_hub_deployment_history
          WHERE user_id = ?
            AND event_type IN ('deploy', 'promote_live')
            AND to_status IN ('paper_deployed', 'live')
          GROUP BY strategy_id
       ) h ON h.strategy_id = p.strategy_id
      WHERE p.deployment_status IN ('paper_deployed', 'live')
      ORDER BY h.last_deployed_at DESC`,
    [userId],
  );

  return (rows as Record<string, unknown>[]).map((r) => ({
    strategy_id:           String(r.strategy_id),
    deployment_status:   String(r.deployment_status) as DeployedStrategyRow['deployment_status'],
    paper_trading_enabled: Boolean(Number(r.paper_trading_enabled)),
    updated_at:            String(r.updated_at),
    last_deployed_at:      r.last_deployed_at != null ? String(r.last_deployed_at) : null,
    last_deployed_by:      r.last_deployed_by ? String(r.last_deployed_by) : null,
    last_environment:    r.last_environment
      ? (String(r.last_environment) as DeploymentEnvironment)
      : null,
  }));
}
