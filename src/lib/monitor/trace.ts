// ════════════════════════════════════════════════════════════════
//  Workflow tracer — per-request hop chain.
//
//  startTrace() opens a trace for one inbound request. Each call to
//  addTraceStep() records the next hop (resolver / provider / DB /
//  cache) with its own latency. finishTrace() emits one
//  `[TRACE]` log line summarising the whole chain and stores the
//  trace in a bounded ring buffer that the /api/debug/system-health
//  route surfaces alongside the live counters.
//
//  Designed to be cheap and lock-free: a Map<string, TraceState>
//  holds open traces keyed by traceId; finishTrace() deletes the
//  entry once the line is emitted. The recent-trace buffer is a
//  small LRU (default 25) so the dashboard always has fresh
//  examples without paying memory cost over time.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const log = logger.child({ component: 'monitor.trace' });

const RECENT_TRACE_MAX = 25;

let _traceCounter = 0;
function newTraceId(): string {
  _traceCounter = (_traceCounter + 1) % 1_000_000;
  return `t-${Date.now().toString(36)}-${_traceCounter.toString(36)}`;
}

export interface TraceStep {
  /** Layer name (e.g. 'route', 'resolver', 'IndianAPI', 'NSE', 'cache', 'DB'). */
  label:    string;
  /** Optional sub-detail (e.g. 'fallback', symbol count, error code). */
  detail?:  string;
  /** Per-step duration in ms. */
  durationMs?: number;
}

interface TraceState {
  id:        string;
  route:     string;
  startedAt: number;
  steps:     TraceStep[];
}

export interface CompletedTrace {
  id:         string;
  route:      string;
  startedAt:  string;
  totalMs:    number;
  steps:      TraceStep[];
  /** Pretty single-line rendering used by the [TRACE] log line. */
  summary:    string;
}

const open = new Map<string, TraceState>();
const recent: CompletedTrace[] = [];

export function startTrace(route: string): string {
  const id = newTraceId();
  open.set(id, {
    id, route,
    startedAt: Date.now(),
    steps: [{ label: 'Request', detail: route }],
  });
  return id;
}

export function addTraceStep(traceId: string | undefined, step: TraceStep): void {
  if (!traceId) return;
  const t = open.get(traceId);
  if (!t) return;
  t.steps.push(step);
}

/**
 * Close a trace, emit the `[TRACE]` log line, and store the result
 * in the recent-trace ring buffer. Safe to call with an unknown id
 * (no-op).
 */
export function finishTrace(traceId: string | undefined): CompletedTrace | null {
  if (!traceId) return null;
  const t = open.get(traceId);
  if (!t) return null;
  open.delete(traceId);
  const totalMs = Date.now() - t.startedAt;
  const summary = renderSummary(t.route, t.steps, totalMs);
  const completed: CompletedTrace = {
    id: t.id,
    route: t.route,
    startedAt: new Date(t.startedAt).toISOString(),
    totalMs,
    steps: t.steps,
    summary,
  };
  // [TRACE] line — printed via console so it shows up alongside the
  // existing [PROVIDER] / [API CALL] markers operators grep on. The
  // structured logger captures the same data via log.info below for
  // JSON-line consumers.
  // eslint-disable-next-line no-console
  console.log(`[TRACE] ${summary}`);
  log.info('TRACE', { traceId: t.id, route: t.route, totalMs, steps: t.steps });
  recent.unshift(completed);
  if (recent.length > RECENT_TRACE_MAX) recent.length = RECENT_TRACE_MAX;
  return completed;
}

function renderSummary(route: string, steps: TraceStep[], totalMs: number): string {
  const parts = steps.map((s) => {
    const det = s.detail ? ` ${s.detail}` : '';
    const dur = typeof s.durationMs === 'number' ? ` (${s.durationMs}ms)` : '';
    return `${s.label}${det}${dur}`;
  });
  return `${route} → ${parts.slice(1).join(' → ')} → response (${totalMs}ms total)`;
}

export function getRecentTraces(): CompletedTrace[] {
  return recent.slice();
}

export function _resetTracesForTests(): void {
  open.clear();
  recent.length = 0;
}
