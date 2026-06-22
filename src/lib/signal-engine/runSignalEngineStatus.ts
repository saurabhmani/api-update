// ════════════════════════════════════════════════════════════════
//  Signal-engine run status — process-local + disk persistence
//
//  Survives lock release and scanner progress clears so
//  GET /api/run-signal-engine?status=true still reports the last
//  completed run after a fast async job finishes.
// ════════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

const KEY_ACTIVE = '__signalEngineActiveRun';
const KEY_LAST_COMPLETED = '__signalEngineLastCompletedRun';

const LAST_RUN_DISK_PATH = path.join(
  process.cwd(),
  '.next',
  'signal-engine-last-run.json',
);

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;

export interface SignalEngineFailedSymbol {
  symbol: string;
  reason: string;
}

export interface SignalEngineCompletedRun {
  jobId: string;
  mode: string;
  success: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSymbols: number;
  scannedSymbols: number;
  rejectedInsufficientCandles: number;
  rejectedProviderError: number;
  signalsGenerated: number;
  signalsSaved: number;
  indianApiRequestsUsed: number;
  dataSource: string;
  lastError: string | null;
  failedSymbolsSample: SignalEngineFailedSymbol[];
}

interface ActiveRunState {
  jobId: string;
  mode: string;
  startedAt: string;
  totalSymbols: number;
}

export interface SignalEngineStatusSnapshot {
  running: boolean;
  jobId: string | null;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  totalSymbols: number | null;
  scannedSymbols: number | null;
  rejectedInsufficientCandles: number | null;
  rejectedProviderError: number | null;
  signalsGenerated: number | null;
  signalsSaved: number | null;
  indianApiRequestsUsed: number | null;
  dataSource: string | null;
  lastError: string | null;
  failedSymbolsSample: SignalEngineFailedSymbol[];
  lastCompletedRun: SignalEngineCompletedRun | null;
}

function persistLastCompletedRun(run: SignalEngineCompletedRun): void {
  g[KEY_LAST_COMPLETED] = run;
  try {
    const dir = path.dirname(LAST_RUN_DISK_PATH);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = `${LAST_RUN_DISK_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(run), 'utf8');
    renameSync(tmp, LAST_RUN_DISK_PATH);
  } catch {
    /* disk failure must not break the pipeline */
  }
}

export function getLastCompletedSignalEngineRun(): SignalEngineCompletedRun | null {
  const cached = g[KEY_LAST_COMPLETED];
  if (cached && typeof cached === 'object' && (cached as SignalEngineCompletedRun).jobId) {
    return cached as SignalEngineCompletedRun;
  }
  try {
    if (existsSync(LAST_RUN_DISK_PATH)) {
      const parsed = JSON.parse(readFileSync(LAST_RUN_DISK_PATH, 'utf8')) as SignalEngineCompletedRun;
      if (parsed && typeof parsed === 'object' && parsed.jobId) {
        g[KEY_LAST_COMPLETED] = parsed;
        return parsed;
      }
    }
  } catch { /* corrupt or missing */ }
  return null;
}

export function getActiveSignalEngineRun(): ActiveRunState | null {
  const active = g[KEY_ACTIVE];
  if (active && typeof active === 'object' && (active as ActiveRunState).jobId) {
    return active as ActiveRunState;
  }
  return null;
}

export function beginSignalEngineRun(opts: {
  jobId: string;
  mode: string;
  startedAt: string;
  totalSymbols: number;
}): void {
  g[KEY_ACTIVE] = {
    jobId: opts.jobId,
    mode: opts.mode,
    startedAt: opts.startedAt,
    totalSymbols: opts.totalSymbols,
  } satisfies ActiveRunState;
}

export function completeSignalEngineRun(run: SignalEngineCompletedRun): void {
  persistLastCompletedRun(run);
  g[KEY_ACTIVE] = null;
}

export function failSignalEngineRun(opts: {
  jobId: string;
  mode: string;
  startedAt: string;
  error: string;
  durationMs: number;
  totalSymbols: number;
  scannedSymbols?: number;
  rejectedInsufficientCandles?: number;
  rejectedProviderError?: number;
  signalsGenerated?: number;
  signalsSaved?: number;
  indianApiRequestsUsed?: number;
  dataSource?: string;
  failedSymbolsSample?: SignalEngineFailedSymbol[];
}): void {
  const active = getActiveSignalEngineRun();
  if (active && active.jobId !== opts.jobId) return;

  const finishedAt = new Date().toISOString();
  completeSignalEngineRun({
    jobId: opts.jobId,
    mode: opts.mode,
    success: false,
    startedAt: opts.startedAt,
    finishedAt,
    durationMs: opts.durationMs,
    totalSymbols: opts.totalSymbols,
    scannedSymbols: opts.scannedSymbols ?? 0,
    rejectedInsufficientCandles: opts.rejectedInsufficientCandles ?? 0,
    rejectedProviderError: opts.rejectedProviderError ?? 0,
    signalsGenerated: opts.signalsGenerated ?? 0,
    signalsSaved: opts.signalsSaved ?? 0,
    indianApiRequestsUsed: opts.indianApiRequestsUsed ?? 0,
    dataSource: opts.dataSource ?? 'unknown',
    lastError: opts.error,
    failedSymbolsSample: opts.failedSymbolsSample ?? [],
  });
}

function idleFieldsFromLast(last: SignalEngineCompletedRun | null): SignalEngineStatusSnapshot {
  if (!last) {
    return {
      running: false,
      jobId: null,
      mode: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      totalSymbols: null,
      scannedSymbols: null,
      rejectedInsufficientCandles: null,
      rejectedProviderError: null,
      signalsGenerated: null,
      signalsSaved: null,
      indianApiRequestsUsed: null,
      dataSource: null,
      lastError: null,
      failedSymbolsSample: [],
      lastCompletedRun: null,
    };
  }
  return {
    running: false,
    jobId: last.jobId,
    mode: last.mode,
    startedAt: last.startedAt,
    finishedAt: last.finishedAt,
    durationMs: last.durationMs,
    totalSymbols: last.totalSymbols,
    scannedSymbols: last.scannedSymbols,
    rejectedInsufficientCandles: last.rejectedInsufficientCandles,
    rejectedProviderError: last.rejectedProviderError,
    signalsGenerated: last.signalsGenerated,
    signalsSaved: last.signalsSaved,
    indianApiRequestsUsed: last.indianApiRequestsUsed,
    dataSource: last.dataSource,
    lastError: last.lastError,
    failedSymbolsSample: last.failedSymbolsSample,
    lastCompletedRun: last,
  };
}

export function buildSignalEngineStatus(opts: {
  running: boolean;
  jobId: string | null;
  mode: string | null;
  startedAtMs: number | null;
  progressScanned: number | null;
  progressTotal: number | null;
}): SignalEngineStatusSnapshot {
  const last = getLastCompletedSignalEngineRun();
  if (!opts.running) {
    return idleFieldsFromLast(last);
  }

  const active = getActiveSignalEngineRun();
  const startedAt = opts.startedAtMs != null
    ? new Date(opts.startedAtMs).toISOString()
    : (active?.startedAt ?? null);
  const now = Date.now();
  const durationMs = opts.startedAtMs != null
    ? Math.max(0, now - opts.startedAtMs)
    : null;
  const totalSymbols = opts.progressTotal ?? active?.totalSymbols ?? null;
  const scannedSymbols = opts.progressScanned ?? 0;

  return {
    running: true,
    jobId: opts.jobId ?? active?.jobId ?? null,
    mode: opts.mode ?? active?.mode ?? null,
    startedAt,
    finishedAt: null,
    durationMs,
    totalSymbols,
    scannedSymbols,
    rejectedInsufficientCandles: null,
    rejectedProviderError: null,
    signalsGenerated: null,
    signalsSaved: null,
    indianApiRequestsUsed: null,
    dataSource: null,
    lastError: null,
    failedSymbolsSample: [],
    lastCompletedRun: last,
  };
}
