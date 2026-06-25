// ════════════════════════════════════════════════════════════════
//  Strategy Lab Service — orchestration
// ════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { serializeToDsl, definitionToJson } from '../dsl';
import { parseNaturalLanguageStrategy, parseStructuredDefinition } from '../parser/ruleParser';
import { validateStrategyDefinition } from '../validator/strategyValidator';
import { previewStrategy } from '../preview/previewEngine';
import {
  insertAudit,
  loadAuditTrail,
  loadLabDefinition,
  listLabDefinitions,
  markPaperDeployed,
  saveLabDefinition,
  updateLabBacktest,
} from '../repository/strategyLabRepository';
import {
  logValidation,
  markUserStrategyDeployed,
  saveStrategyDraft,
  updateUserStrategyBacktest,
  upsertUserStrategy,
} from '../repository/strategyBuilderRepository';
import { CLIENT_DEFAULT_BACKTEST_CONFIG } from '@/lib/backtesting/config/clientDefaults';
import type { BacktestRunConfig } from '@/lib/backtesting/types';
import type {
  BacktestReadyConfig,
  StrategyDefinition,
  StrategyLabRecord,
  ValidationResult,
} from '../types';

function mapRow(row: Record<string, unknown>): StrategyLabRecord {
  const def = typeof row.definition_json === 'string'
    ? JSON.parse(row.definition_json)
    : row.definition_json;
  const validation = row.validation_json
    ? (typeof row.validation_json === 'string' ? JSON.parse(row.validation_json) : row.validation_json)
    : null;
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description != null ? String(row.description) : null,
    source: def.source ?? 'no_code',
    timeframe: def.timeframe ?? 'swing',
    direction: def.direction ?? 'long',
    definition: def as StrategyDefinition,
    dsl: String(row.dsl_text ?? ''),
    status: row.status as StrategyLabRecord['status'],
    validated: Number(row.validated) === 1,
    validation,
    lastBacktestId: row.last_backtest_id != null ? String(row.last_backtest_id) : null,
    backtestPassed: Number(row.backtest_passed) === 1,
    paperDeployed: Number(row.paper_deployed) === 1,
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function parseStrategy(input: { text?: string; definition?: unknown; name?: string }): StrategyDefinition {
  if (input.text?.trim()) {
    return parseNaturalLanguageStrategy(input.text, input.name ?? 'AI Strategy');
  }
  if (input.definition) {
    return parseStructuredDefinition(input.definition);
  }
  throw new Error('Provide text or definition');
}

export function validateLabStrategy(
  def: StrategyDefinition,
  backtestPassed = false,
  strategyId?: string,
  userId?: string | null,
): ValidationResult {
  const validation = validateStrategyDefinition(def, { forDeploy: false, backtestPassed });
  if (strategyId) {
    void logValidation(strategyId, userId ?? null, validation);
  }
  return validation;
}

export function previewLabStrategy(def: StrategyDefinition) {
  return previewStrategy(def);
}

export async function saveLabStrategy(
  def: StrategyDefinition,
  actor: string | null,
): Promise<{ id: string; validation: ValidationResult; dsl: string; json: string }> {
  const validation = validateStrategyDefinition(def);
  if (!validation.canSave) {
    throw new Error(validation.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; '));
  }

  const id = def.id ?? uuidv4();
  const dsl = serializeToDsl({ ...def, id });
  const json = definitionToJson({ ...def, id });

  await saveLabDefinition({
    id,
    name: def.name,
    description: def.description ?? null,
    source: def.source,
    timeframe: def.timeframe,
    direction: def.direction,
    definition: { ...def, id },
    dsl,
    status: validation.valid ? 'validated' : 'draft',
    validated: validation.valid,
    validation,
    createdBy: actor,
  });

  await upsertUserStrategy({
    id,
    userId: actor,
    name: def.name,
    description: def.description ?? null,
    source: def.source,
    timeframe: def.timeframe,
    direction: def.direction,
    definition: { ...def, id },
    dsl,
    status: validation.valid ? 'validated' : 'draft',
    validated: validation.valid,
  });

  await logValidation(id, actor, validation);
  await insertAudit(id, 'save', actor, { source: def.source, validation });

  return { id, validation, dsl, json };
}

export async function getLabStrategy(id: string): Promise<StrategyLabRecord | null> {
  const row = await loadLabDefinition(id);
  return row ? mapRow(row) : null;
}

export async function listLabStrategies(): Promise<StrategyLabRecord[]> {
  const rows = await listLabDefinitions();
  const results: StrategyLabRecord[] = [];
  for (const r of rows) {
    const full = await loadLabDefinition(String(r.id));
    if (full) results.push(mapRow(full));
  }
  return results;
}

export async function getLabAudit(id: string) {
  const rows = await loadAuditTrail(id);
  return rows.map((r) => ({
    id: Number(r.id),
    strategyId: id,
    action: String(r.action),
    actor: r.actor != null ? String(r.actor) : null,
    details: r.details_json
      ? (typeof r.details_json === 'string' ? JSON.parse(r.details_json) : r.details_json)
      : null,
    createdAt: String(r.created_at),
  }));
}

export function buildBacktestConfig(def: StrategyDefinition, labId: string): BacktestReadyConfig {
  const config: BacktestRunConfig = {
    ...CLIENT_DEFAULT_BACKTEST_CONFIG,
    name: `Lab Backtest — ${def.name}`,
    riskPerTradePct: def.risk.riskPerTradePct,
    maxOpenPositions: def.risk.maxOpenPositions,
    maxGrossExposurePct: def.risk.maxGrossExposurePct,
    minRewardRisk: def.risk.minRewardRisk ?? 1.2,
    maxStopWidthPct: def.stopLoss.type === 'percent' ? Math.max(def.stopLoss.value, 8) : 8,
    strategies: null,
    tags: [`lab:${labId}`, `source:${def.source}`],
  };
  return { name: `Lab: ${def.name}`, labStrategyId: labId, config };
}

export async function saveLabDraft(
  def: StrategyDefinition,
  actor: string | null,
): Promise<{ id: string }> {
  const id = def.id ?? uuidv4();
  await saveStrategyDraft(id, actor, def.name || 'Untitled Draft', def.source, { ...def, id });
  return { id };
}

export async function runLabBacktest(
  labId: string,
  actor: string | null,
  configOverride?: Record<string, unknown>,
): Promise<{ backtestId: string; status: string; backtestPassed: boolean; mode?: string }> {
  const record = await getLabStrategy(labId);
  if (!record) throw new Error('Strategy not found');
  if (!record.validated) throw new Error('Strategy must be validated before backtest');

  const btConfig = buildBacktestConfig(record.definition, labId);
  const mergedConfig = { ...btConfig.config, ...configOverride };

  const { handlePostBacktest } = await import('@/lib/backtesting/api/canonicalHandlers');
  const syntheticReq = new Request('http://localhost/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: mergedConfig }),
  });
  const btResponse = await handlePostBacktest(syntheticReq as import('next/server').NextRequest);
  const btData = await btResponse.json();

  if (!btData.ok) {
    throw new Error(btData.error ?? 'Backtest failed');
  }

  const backtestId = String(btData.backtestId ?? btData.runId);
  const passed = btData.status === 'completed';
  await recordLabBacktest(labId, backtestId, passed, actor);

  return { backtestId, status: btData.status, backtestPassed: passed, mode: btData.mode };
}

export async function recordLabBacktest(labId: string, backtestId: string, passed: boolean, actor: string | null) {
  await updateLabBacktest(labId, backtestId, passed);
  await updateUserStrategyBacktest(labId, backtestId, passed);
  await insertAudit(labId, 'backtest', actor, { backtestId, passed });
}

export async function requestPaperDeployment(labId: string, actor: string | null): Promise<{ approved: boolean; issues: string[] }> {
  const record = await getLabStrategy(labId);
  if (!record) throw new Error('Strategy not found');

  const validation = validateStrategyDefinition(record.definition, {
    forDeploy: true,
    backtestPassed: record.backtestPassed,
  });

  if (!validation.canDeploy) {
    await insertAudit(labId, 'deploy_rejected', actor, { issues: validation.issues });
    return {
      approved: false,
      issues: validation.issues.map((i) => i.message),
    };
  }

  await markPaperDeployed(labId);
  await markUserStrategyDeployed(labId);
  await insertAudit(labId, 'paper_deploy', actor, { deploymentType: 'paper' });
  return { approved: true, issues: [] };
}
