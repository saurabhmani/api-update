/**
 * In-process + Redis-backed last-scan health for morning/evening jobs.
 */
import { cacheService } from '@/lib/cache/cacheService';

export interface ScanRunStamp {
  startedAt: string | null;
  completedAt: string | null;
  persisted: number | null;
  generated: number | null;
  ok: boolean | null;
  jobName: string | null;
  error?: string | null;
}

export interface SchedulerScanHealth {
  lastMorningScanStartedAt: string | null;
  lastMorningScanCompletedAt: string | null;
  lastMorningScanPersisted: number | null;
  lastEveningScanStartedAt: string | null;
  lastEveningScanCompletedAt: string | null;
  lastEveningScanPersisted: number | null;
  schedulerProcessRole: string;
  lastMorningOk: boolean | null;
  lastEveningOk: boolean | null;
}

const MEMORY: {
  morning: ScanRunStamp;
  evening: ScanRunStamp;
  role: string;
} = {
  morning: emptyStamp(),
  evening: emptyStamp(),
  role: 'unknown',
};

function emptyStamp(): ScanRunStamp {
  return {
    startedAt: null,
    completedAt: null,
    persisted: null,
    generated: null,
    ok: null,
    jobName: null,
    error: null,
  };
}

function isMorningJob(jobName: string): boolean {
  return /morning|midday|late-rescore|first-morning|main-morning/i.test(jobName);
}

function isEveningJob(jobName: string): boolean {
  return /evening/i.test(jobName);
}

function redisKey(kind: 'morning' | 'evening'): string {
  return `scheduler:scanHealth:${kind}`;
}

export function setSchedulerProcessRole(role: string): void {
  MEMORY.role = role;
}

export async function markScanStarted(jobName: string): Promise<void> {
  const stamp: ScanRunStamp = {
    ...emptyStamp(),
    startedAt: new Date().toISOString(),
    jobName,
  };
  if (isMorningJob(jobName)) {
    MEMORY.morning = { ...MEMORY.morning, ...stamp, completedAt: null, ok: null };
    await cacheService.set(redisKey('morning'), MEMORY.morning, 86_400).catch(() => {});
  } else if (isEveningJob(jobName)) {
    MEMORY.evening = { ...MEMORY.evening, ...stamp, completedAt: null, ok: null };
    await cacheService.set(redisKey('evening'), MEMORY.evening, 86_400).catch(() => {});
  }
}

export async function markScanCompleted(opts: {
  jobName: string;
  persisted: number;
  generated: number;
  ok: boolean;
  error?: string | null;
}): Promise<void> {
  const stamp: ScanRunStamp = {
    startedAt: isMorningJob(opts.jobName)
      ? MEMORY.morning.startedAt
      : isEveningJob(opts.jobName)
        ? MEMORY.evening.startedAt
        : null,
    completedAt: new Date().toISOString(),
    persisted: opts.persisted,
    generated: opts.generated,
    ok: opts.ok,
    jobName: opts.jobName,
    error: opts.error ?? null,
  };
  if (isMorningJob(opts.jobName)) {
    MEMORY.morning = { ...MEMORY.morning, ...stamp };
    await cacheService.set(redisKey('morning'), MEMORY.morning, 86_400).catch(() => {});
  } else if (isEveningJob(opts.jobName)) {
    MEMORY.evening = { ...MEMORY.evening, ...stamp };
    await cacheService.set(redisKey('evening'), MEMORY.evening, 86_400).catch(() => {});
  }
}

export async function getSchedulerScanHealth(): Promise<SchedulerScanHealth> {
  const morningCached = await cacheService.get<ScanRunStamp>(redisKey('morning')).catch(() => null);
  const eveningCached = await cacheService.get<ScanRunStamp>(redisKey('evening')).catch(() => null);
  const morning = morningCached ?? MEMORY.morning;
  const evening = eveningCached ?? MEMORY.evening;
  return {
    lastMorningScanStartedAt: morning.startedAt,
    lastMorningScanCompletedAt: morning.completedAt,
    lastMorningScanPersisted: morning.persisted,
    lastEveningScanStartedAt: evening.startedAt,
    lastEveningScanCompletedAt: evening.completedAt,
    lastEveningScanPersisted: evening.persisted,
    schedulerProcessRole: MEMORY.role,
    lastMorningOk: morning.ok,
    lastEveningOk: evening.ok,
  };
}
