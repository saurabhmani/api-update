// ════════════════════════════════════════════════════════════════
//  Scheduler monitoring for Strategy Hub ops (Phase 6)
// ════════════════════════════════════════════════════════════════

import { CRON_REGISTRY } from '@/lib/reliability/constants/cronRegistry';
import { fetchLearningJobRuns, fetchSyncLogs, fetchSchedulerRuns } from '@/lib/reliability/repository/reliabilityRepository';
import type { JobRunStatus, SchedulerJobStatus, SchedulerMonitorSummary } from './types';

const HUB_AUTOMATION_JOBS = [
  { id: 'hub-daily-validation', name: 'Hub Daily Validation', schedule: '06:00 IST daily', matchKeys: ['hub-daily-validation'] },
  { id: 'hub-health-check', name: 'Hub Health Check', schedule: 'Every 15m (market hours)', matchKeys: ['hub-health-check'] },
  { id: 'hub-cache-refresh', name: 'Hub Cache Refresh', schedule: 'Hourly', matchKeys: ['hub-cache-refresh'] },
  { id: 'hub-performance-recalc', name: 'Hub Performance Recalc', schedule: 'Daily 05:00 IST', matchKeys: ['hub-performance-recalc'] },
  { id: 'hub-ranking-refresh', name: 'Hub Ranking Refresh', schedule: 'Daily 05:30 IST', matchKeys: ['hub-ranking-refresh'] },
  { id: 'hub-learning-refresh', name: 'Hub Learning Refresh', schedule: 'Daily 20:30 IST', matchKeys: ['hub-learning-refresh'] },
];

function matchJobRun(
  job: { matchKeys: string[] },
  runs: Array<{ job_name: string; status: string; duration_ms: number | null; run_at: string }>,
) {
  return runs.find((r) =>
    job.matchKeys.some((k) => r.job_name.toLowerCase().includes(k.toLowerCase())),
  );
}

function toStatus(raw: string | undefined): JobRunStatus {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'success' || v === 'ok' || v === 'completed') return 'success';
  if (v === 'failed' || v === 'error' || v === 'fail') return 'failed';
  if (v === 'running' || v === 'in_progress') return 'running';
  if (v === 'paused') return 'paused';
  return 'unknown';
}

export async function loadSchedulerMonitor(pausedJobs: Set<string> = new Set()): Promise<SchedulerMonitorSummary> {
  const [learningRuns, syncRuns, pgRuns] = await Promise.all([
    fetchLearningJobRuns(14),
    fetchSyncLogs(14),
    fetchSchedulerRuns(30),
  ]);

  const normalizedLearning = learningRuns.map((r) => ({
    job_name: r.job_name,
    status: r.status,
    duration_ms: r.duration_ms,
    run_at: typeof r.run_at === 'string' ? r.run_at : new Date(r.run_at).toISOString(),
  }));
  const normalizedSync = syncRuns.map((r) => ({
    job_name: r.job_name,
    status: r.status,
    duration_ms: r.duration_ms,
    run_at: typeof r.run_at === 'string' ? r.run_at : new Date(r.run_at).toISOString(),
  }));
  const allRuns = [...normalizedLearning, ...normalizedSync];

  const jobs: SchedulerJobStatus[] = [];

  for (const def of CRON_REGISTRY) {
    const run = matchJobRun(def, allRuns);
    const pg = pgRuns.find((r) =>
      def.matchKeys.some((k) => r.label.toLowerCase().includes(k.toLowerCase())),
    );
    jobs.push({
      id: def.id,
      name: def.label,
      schedule: def.schedule,
      lastRun: run?.run_at ?? pg?.started_at ?? null,
      nextRun: null,
      durationMs: run?.duration_ms ?? pg?.elapsed_ms ?? null,
      status: pausedJobs.has(def.id) ? 'paused' : toStatus(run?.status ?? (pg && pg.failed_count > 0 ? 'failed' : 'success')),
      retryCount: pg?.failed_count ?? 0,
      source: def.source,
      paused: pausedJobs.has(def.id),
    });
  }

  for (const def of HUB_AUTOMATION_JOBS) {
    const run = matchJobRun(def, allRuns);
    jobs.push({
      id: def.id,
      name: def.name,
      schedule: def.schedule,
      lastRun: run?.run_at ?? null,
      nextRun: null,
      durationMs: run?.duration_ms ?? null,
      status: pausedJobs.has(def.id) ? 'paused' : toStatus(run?.status),
      retryCount: 0,
      source: 'hub-automation',
      paused: pausedJobs.has(def.id),
    });
  }

  return { jobs, lastUpdated: new Date().toISOString() };
}
