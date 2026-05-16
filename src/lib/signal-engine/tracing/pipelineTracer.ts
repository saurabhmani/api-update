// ════════════════════════════════════════════════════════════════
//  pipelineTracer — correlation-id based tracing for the Q365
//  signal engine. Emits one console line per engine boundary with
//  a clear prefix, run id, elapsed ms and a JSON payload.
//
//  Goals
//  ─────
//    1. Make every engine's start / input / output / failure
//       visible in real time without changing business logic.
//    2. Correlate all lines from a single pipeline run via a
//       short runId so multi-phase flows can be grepped in one
//       shot: `grep "[run=r_k9xa1]" logs/pipeline.log`.
//    3. Zero overhead when tracing is disabled — the no-op tracer
//       is returned and every method short-circuits.
//
//  Enable with:  PIPELINE_TRACE=1
//  Verbose mode: PIPELINE_TRACE=2   (logs full payloads instead
//                                    of summarised row counts)
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
const log = logger.child({ component: 'pipelineTracer' });

type TraceValue = string | number | boolean | null | undefined | TraceValue[] | { [k: string]: TraceValue };

export interface EngineSpan {
  /** Record what an engine received. Called once, at entry. */
  input(payload?: Record<string, TraceValue>): void;
  /** Record what an engine produced. Called once, at exit. */
  output(payload?: Record<string, TraceValue>): void;
  /** Record an unexpected failure. The span is auto-closed. */
  fail(err: Error | string, payload?: Record<string, TraceValue>): void;
  /** Close the span. Prints ✓ line with elapsed ms. */
  end(payload?: Record<string, TraceValue>): void;
}

export interface PipelineTracer {
  readonly runId: string;
  /** Open a new engine span. Every engine should do this at entry. */
  engine(name: string): EngineSpan;
  /** Phase-level boundary log. Use for Phase 1/2/3/4 entry/exit. */
  phase(name: string, payload?: Record<string, TraceValue>): EngineSpan;
  /** Structured log outside an engine span (rare). */
  info(msg: string, payload?: Record<string, TraceValue>): void;
  /** Same, but at warn severity. */
  warn(msg: string, payload?: Record<string, TraceValue>): void;
}

// ── Formatting helpers ────────────────────────────────────────

function traceLevel(): 0 | 1 | 2 {
  const v = process.env.PIPELINE_TRACE;
  if (v === '2') return 2;
  if (v === '1' || v === 'true' || v === 'on') return 1;
  return 0;
}

function compact(payload: Record<string, TraceValue> | undefined): string {
  if (!payload) return '';
  try {
    const keys = Object.keys(payload);
    if (keys.length === 0) return '';
    if (traceLevel() >= 2) return ' ' + JSON.stringify(payload);
    // Summarised: arrays → length, objects → `{...}`, primitives inline.
    const out: string[] = [];
    for (const k of keys) {
      const v = payload[k];
      if (Array.isArray(v))                     out.push(`${k}=${v.length}`);
      else if (v && typeof v === 'object')      out.push(`${k}={…}`);
      else if (typeof v === 'string' && v.length > 40) out.push(`${k}="${v.slice(0, 37)}…"`);
      else                                       out.push(`${k}=${String(v)}`);
    }
    return ' ' + out.join(' ');
  } catch {
    return '';
  }
}

function makeRunId(): string {
  // Short, sortable, human-friendly: r_<base36 of epoch>_<rand>
  const ts = Date.now().toString(36);
  const r  = Math.random().toString(36).slice(2, 6);
  return `r_${ts}_${r}`;
}

// ── Real tracer ────────────────────────────────────────────────

class RealTracer implements PipelineTracer {
  readonly runId: string;
  private readonly startedAt: number;
  constructor(runId?: string) {
    this.runId = runId ?? makeRunId();
    this.startedAt = Date.now();
    log.info('pipeline open', { runId: this.runId, ts: new Date(this.startedAt).toISOString() });
  }

  engine(name: string): EngineSpan {
    return new RealSpan(this.runId, 'ENGINE', name);
  }

  phase(name: string, payload?: Record<string, TraceValue>): EngineSpan {
    const span = new RealSpan(this.runId, 'PHASE', name);
    if (payload) span.input(payload);
    else         span.input({});
    return span;
  }

  info(msg: string, payload?: Record<string, TraceValue>): void {
    log.info(msg, { runId: this.runId, ...(payload ?? {}) });
  }

  warn(msg: string, payload?: Record<string, TraceValue>): void {
    log.warn(msg, { runId: this.runId, ...(payload ?? {}) });
  }
}

class RealSpan implements EngineSpan {
  private readonly runId: string;
  private readonly kind: 'ENGINE' | 'PHASE';
  private readonly name: string;
  private readonly startedAt: number;
  private closed = false;

  constructor(runId: string, kind: 'ENGINE' | 'PHASE', name: string) {
    this.runId     = runId;
    this.kind      = kind;
    this.name      = name;
    this.startedAt = Date.now();
    log.info('span start', { runId, kind, name });
  }

  input(payload?: Record<string, TraceValue>): void {
    log.debug('span input', { runId: this.runId, name: this.name, ...(payload ?? {}) });
  }

  output(payload?: Record<string, TraceValue>): void {
    log.debug('span output', { runId: this.runId, name: this.name, ...(payload ?? {}) });
  }

  fail(err: Error | string, payload?: Record<string, TraceValue>): void {
    if (this.closed) return;
    const msg = err instanceof Error ? err.message : String(err);
    const ms  = Date.now() - this.startedAt;
    log.error('span failed', { runId: this.runId, kind: this.kind, name: this.name, ms, error_message: msg, ...(payload ?? {}) });
    this.closed = true;
  }

  end(payload?: Record<string, TraceValue>): void {
    if (this.closed) return;
    const ms = Date.now() - this.startedAt;
    log.info('span end', { runId: this.runId, kind: this.kind, name: this.name, ms, ...(payload ?? {}) });
    this.closed = true;
  }
}

// ── No-op tracer (tracing disabled) ───────────────────────────

const NOOP_SPAN: EngineSpan = {
  input:  () => { /* no-op */ },
  output: () => { /* no-op */ },
  fail:   () => { /* no-op */ },
  end:    () => { /* no-op */ },
};

class NoopTracer implements PipelineTracer {
  readonly runId = 'r_noop';
  engine(): EngineSpan { return NOOP_SPAN; }
  phase():  EngineSpan { return NOOP_SPAN; }
  info():   void { /* no-op */ }
  warn():   void { /* no-op */ }
}

const NOOP = new NoopTracer();

// ── Factory + ambient accessor ────────────────────────────────
//
// Callers that receive a tracer as an argument use it directly.
// Anything deep in the engine graph that can't plumb the tracer
// through its signature can read the current run's tracer via
// getAmbientTracer() — it's set once per pipeline invocation.

export function createPipelineTracer(runId?: string): PipelineTracer {
  return traceLevel() > 0 ? new RealTracer(runId) : NOOP;
}

let ambient: PipelineTracer = NOOP;

export function setAmbientTracer(t: PipelineTracer): void {
  ambient = t;
}

export function getAmbientTracer(): PipelineTracer {
  return ambient;
}

/**
 * Convenience wrapper — run an async function inside an engine
 * span, auto-capturing input/output and always closing the span
 * (even on throw). Reduces boilerplate at the call site from:
 *
 *   const span = tracer.engine('foo');
 *   span.input({ n: rows.length });
 *   try { const out = await foo(rows); span.output({ out: out.length }); span.end(); return out; }
 *   catch (e) { span.fail(e as Error); throw e; }
 *
 * to:
 *
 *   return await traceEngine(tracer, 'foo', { n: rows.length },
 *     async () => { const out = await foo(rows); return { value: out, output: { out: out.length } }; });
 */
export async function traceEngine<T>(
  tracer: PipelineTracer,
  name: string,
  input: Record<string, TraceValue>,
  fn: () => Promise<{ value: T; output?: Record<string, TraceValue> }>,
): Promise<T> {
  const span = tracer.engine(name);
  span.input(input);
  try {
    const { value, output } = await fn();
    span.end(output);
    return value;
  } catch (err) {
    span.fail(err as Error);
    throw err;
  }
}
