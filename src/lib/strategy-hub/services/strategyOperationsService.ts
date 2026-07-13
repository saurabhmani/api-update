// ════════════════════════════════════════════════════════════════
//  Strategy Hub — Operations service orchestrator (Phase 6)
// ════════════════════════════════════════════════════════════════

import { countOpenAlerts } from '../repository/opsAlerts';
import { loadAutomationSettings, saveAutomationSettings } from '../repository/automationSettings';
import { getOpsCache, setOpsCache, opsCacheKey, isIndianMarketHours } from '../operations/opsCache';
import { loadStrategyHealthSnapshots, summarizeHealth } from '../operations/healthMonitor';
import { generateAlertsFromHealth, loadAlertsWithNames } from '../operations/alertEngine';
import { buildActivityTimeline } from '../operations/activityTimeline';
import { loadSchedulerMonitor } from '../operations/schedulerMonitor';
import { loadSignalEngineMonitor } from '../operations/signalEngineMonitor';
import { runAutomationJob } from '../operations/automationRunner';
import type {
  AutomationJobType,
  AutomationSettings,
  OperationsDashboard,
  StrategyHealthSnapshot,
} from '../operations/types';

const pausedJobs = new Set<string>();

export async function loadOperationsDashboard(opts?: { skipCache?: boolean }): Promise<OperationsDashboard> {
  const cacheKey = opsCacheKey({ ns: 'ops-dashboard' });
  if (!opts?.skipCache) {
    const cached = getOpsCache<OperationsDashboard>(cacheKey);
    if (cached) return { ...cached.value, cached: true, cacheAgeMs: cached.ageMs };
  }

  const started = Date.now();
  const [snapshots, signalEngine, scheduler, openAlerts] = await Promise.all([
    loadStrategyHealthSnapshots(),
    loadSignalEngineMonitor(),
    loadSchedulerMonitor(pausedJobs),
    countOpenAlerts(),
  ]);

  await generateAlertsFromHealth(snapshots);
  const summary = summarizeHealth(snapshots);
  const lastValidation = snapshots
    .map((s) => s.lastValidationAt)
    .filter(Boolean)
    .sort()
    .pop() ?? null;

  const dashboard: OperationsDashboard = {
    generatedAt: new Date().toISOString(),
    summary: { ...summary, openAlerts },
    signalEngine,
    scheduler,
    lastValidationTime: lastValidation,
    lastScanTime: signalEngine.lastScanAt,
    nextScheduledScan: estimateNextScan(),
    marketHoursActive: isIndianMarketHours(),
    cached: false,
    cacheAgeMs: Date.now() - started,
  };

  setOpsCache(cacheKey, dashboard, isIndianMarketHours() ? 30_000 : 60_000);
  return dashboard;
}

function estimateNextScan(): string | null {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const targets = [8 * 60 + 30, 9 * 60 + 45, 12 * 60 + 30, 14 * 60 + 45, 16 * 60 + 30];
  const next = targets.find((t) => t > mins);
  if (!next) return null;
  const d = new Date(ist);
  d.setHours(Math.floor(next / 60), next % 60, 0, 0);
  return d.toISOString();
}

export async function loadHealthStatus(): Promise<StrategyHealthSnapshot[]> {
  const cacheKey = opsCacheKey({ ns: 'ops-health' });
  const cached = getOpsCache<StrategyHealthSnapshot[]>(cacheKey);
  if (cached) return cached.value;
  const snapshots = await loadStrategyHealthSnapshots();
  await generateAlertsFromHealth(snapshots);
  setOpsCache(cacheKey, snapshots, 45_000);
  return snapshots;
}

export {
  loadAlertsWithNames,
  buildActivityTimeline,
  loadSchedulerMonitor,
  loadSignalEngineMonitor,
  loadAutomationSettings,
  saveAutomationSettings,
  runAutomationJob,
};

export async function setSchedulerJobPaused(jobId: string, paused: boolean): Promise<void> {
  if (paused) pausedJobs.add(jobId);
  else pausedJobs.delete(jobId);
}

export type { AutomationJobType, AutomationSettings, OperationsDashboard, StrategyHealthSnapshot };
