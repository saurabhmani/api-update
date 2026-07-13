// ════════════════════════════════════════════════════════════════
//  Phase 7 — Experiment Registry (no anonymous experiments)
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { ExperimentRecord, ExperimentStatus, ExperimentResult } from './types';
import { RESEARCH_SCHEMA_VERSION } from './types';

function stableJson(v: unknown): string {
  return JSON.stringify(v, Object.keys(v as object).sort());
}

export function hashExperiment(record: Omit<ExperimentRecord, 'experimentId'>): string {
  return createHash('sha256').update(stableJson(record)).digest('hex').slice(0, 16);
}

let counter = 0;

export function createExperimentId(createdAt: string, author: string): string {
  counter += 1;
  const stamp = createdAt.slice(0, 10).replaceAll('-', '');
  const authorSlug = author.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'anon';
  return `exp_${stamp}_${authorSlug}_${counter}`;
}

const registry = new Map<string, ExperimentRecord>();

export function registerExperiment(input: {
  author: string;
  description: string;
  datasetId: string;
  features: string[];
  parameters: Record<string, unknown>;
  createdAt: string;
  gitCommit?: string | null;
  configurationVersion: string;
  randomSeed: number;
  status?: ExperimentStatus;
}): ExperimentRecord {
  if (!input.author?.trim()) {
    throw new Error('Experiments must have a named author — anonymous experiments are not allowed');
  }
  const payload = {
    author: input.author.trim(),
    description: input.description,
    datasetId: input.datasetId,
    features: [...input.features].sort(),
    parameters: input.parameters,
    createdAt: input.createdAt,
    gitCommit: input.gitCommit ?? null,
    configurationVersion: input.configurationVersion,
    randomSeed: input.randomSeed,
    result: null as ExperimentResult | null,
    status: input.status ?? 'draft',
  };
  const experimentId = createExperimentId(input.createdAt, input.author);
  const record: ExperimentRecord = { experimentId, ...payload };
  registry.set(experimentId, Object.freeze({ ...record }));
  return record;
}

export function getExperiment(experimentId: string): ExperimentRecord | null {
  return registry.get(experimentId) ?? null;
}

export function listExperiments(filter?: { author?: string; status?: ExperimentStatus }): ExperimentRecord[] {
  let rows = [...registry.values()];
  if (filter?.author) rows = rows.filter((r) => r.author === filter.author);
  if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function updateExperiment(
  experimentId: string,
  patch: Partial<Pick<ExperimentRecord, 'status' | 'result'>>,
): ExperimentRecord {
  const existing = registry.get(experimentId);
  if (!existing) throw new Error(`Experiment not found: ${experimentId}`);
  const merged = { ...existing, ...patch };
  registry.set(experimentId, Object.freeze(merged));
  return merged;
}

export function clearExperimentRegistry(): void {
  registry.clear();
  counter = 0;
}

export function getExperimentRegistryVersion(): string {
  return RESEARCH_SCHEMA_VERSION;
}
