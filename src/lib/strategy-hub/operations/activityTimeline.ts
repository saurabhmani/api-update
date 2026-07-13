// ════════════════════════════════════════════════════════════════
//  Unified operational activity timeline (Phase 6)
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import { listDeploymentHistory } from '../repository/strategyProfiles';
import { listModeHistory } from '../repository/modeHistory';
import { listConfigHistory } from '../repository/configHistory';
import { listValidationHistory } from '../repository/validationHistory';
import { listAlerts } from '../repository/opsAlerts';
import { listOpsEvents } from '../repository/opsEvents';
import type { ActivityTimelineEntry } from './types';

function strategyName(id: string | null): string | null {
  if (!id) return null;
  return getStrategyMeta(id).strategyName;
}

export async function buildActivityTimeline(opts: {
  strategyId?: string;
  search?: string;
  category?: ActivityTimelineEntry['category'];
  limit?: number;
}): Promise<ActivityTimelineEntry[]> {
  const limit = Math.min(opts.limit ?? 100, 300);
  const [
    deployments,
    modes,
    configs,
    validations,
    alerts,
    opsEvents,
  ] = await Promise.all([
    listDeploymentHistory({ strategyId: opts.strategyId, limit: 50 }),
    listModeHistory({ strategyId: opts.strategyId, limit: 50 }),
    listConfigHistory({ strategyId: opts.strategyId, limit: 50 }),
    listValidationHistory({ strategyId: opts.strategyId, limit: 50 }),
    listAlerts({ strategyId: opts.strategyId, status: 'all', limit: 50 }),
    listOpsEvents({ strategyId: opts.strategyId, limit: 50 }),
  ]);

  const entries: ActivityTimelineEntry[] = [];

  for (const d of deployments) {
    entries.push({
      id: `deploy-${d.id}`,
      timestamp: d.created_at,
      category: 'deployment',
      strategyId: d.strategy_id,
      strategyName: strategyName(d.strategy_id),
      title: `Deployment ${d.event_type}`,
      description: `${d.from_status ?? '—'} → ${d.to_status} (${d.environment})`,
      actor: d.actor,
    });
  }

  for (const m of modes) {
    entries.push({
      id: `mode-${m.id}`,
      timestamp: m.created_at,
      category: 'mode',
      strategyId: m.strategy_id,
      strategyName: strategyName(m.strategy_id),
      title: 'Mode change',
      description: `${m.from_mode ?? '—'} → ${m.to_mode}`,
      actor: m.actor,
    });
  }

  for (const c of configs) {
    entries.push({
      id: `config-${c.id}`,
      timestamp: c.created_at,
      category: 'configuration',
      strategyId: c.strategy_id,
      strategyName: strategyName(c.strategy_id),
      title: `Configuration v${c.version_number}`,
      description: c.change_summary,
      actor: c.actor,
    });
  }

  for (const v of validations) {
    entries.push({
      id: `valid-${v.id}`,
      timestamp: v.created_at,
      category: 'validation',
      strategyId: v.strategy_id,
      strategyName: strategyName(v.strategy_id),
      title: `Validation ${v.overall_status}`,
      description: `Score ${v.validation_score} (${v.validation_target})`,
      actor: v.actor,
      severity: v.overall_status === 'failed' ? 'critical' : v.overall_status === 'warning' ? 'warning' : 'info',
    });
  }

  for (const a of alerts) {
    entries.push({
      id: `alert-${a.id}`,
      timestamp: a.createdAt,
      category: 'alert',
      strategyId: a.strategyId,
      strategyName: a.strategyName ?? strategyName(a.strategyId),
      title: a.title,
      description: `${a.description} [${a.status}]`,
      actor: a.acknowledgedBy ?? a.resolvedBy,
      severity: a.severity,
    });
  }

  for (const e of opsEvents) {
    entries.push({
      id: `ops-${e.id}`,
      timestamp: e.createdAt,
      category: e.eventType.includes('scheduler') ? 'scheduler' : e.eventType.includes('engine') ? 'engine' : 'health',
      strategyId: e.strategyId,
      strategyName: strategyName(e.strategyId),
      title: e.title,
      description: e.description ?? '',
      actor: e.actor,
      severity: e.severity as ActivityTimelineEntry['severity'],
    });
  }

  let filtered = entries;
  if (opts.category) filtered = filtered.filter((e) => e.category === opts.category);
  if (opts.search?.trim()) {
    const q = opts.search.trim().toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.title.toLowerCase().includes(q)
        || e.description.toLowerCase().includes(q)
        || (e.strategyName ?? '').toLowerCase().includes(q),
    );
  }

  return filtered
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}
