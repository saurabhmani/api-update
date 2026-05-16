// ════════════════════════════════════════════════════════════════
//  Prometheus Exposition — Spec PROMETHEUS-2026-05.
//
//  Renders the institutional-health snapshot in the Prometheus text
//  exposition format (v0.0.4). One scrape returns every counter the
//  engine bumps since process boot, labelled by provider/stage so a
//  Grafana dashboard can slice by instance / provider / market state
//  without parsing logs.
//
//  Pure module — no I/O. The caller wires the snapshot in.
//
//  Counter semantics (Prometheus convention):
//    *_total                — monotonic counter; resets on restart.
//                             Prometheus's rate() handles the reset.
//    *_state                — gauge; 0/1 boolean state.
//    *_seconds              — gauge; current age / latency snapshot.
//
//  Naming follows Prometheus best practices:
//    namespace_subsystem_name_unit
//    institutional_provider_invalid_payload_total
//    institutional_elite_approved_total
//    institutional_full_scan_starts_total
//    institutional_candle_age_seconds
// ════════════════════════════════════════════════════════════════

import type { InstitutionalHealthSnapshot } from './institutionalHealth';

interface PromContext {
  /** Snapshot from getInstitutionalHealthSnapshot(). */
  snapshot: InstitutionalHealthSnapshot;
  /** Optional candle freshness probe — when present, exposed as a
   *  separate metric family (institutional_candle_*). */
  candle?: {
    candle_age_seconds: number | null;
    freshness_quality:  string;
    feed_frozen:        boolean;
    market_open:        boolean;
  } | null;
  /** Optional provider breaker probe — exposed as institutional_provider_breaker_*. */
  breaker?: {
    state:        string;
    open:         boolean;
    remainingMs:  number;
    auth_failed:  boolean;
  } | null;
  /** Optional rate-limiter queue probe. */
  queue?: {
    depth:                  number;
    peak_depth:             number;
    throttle_wait_total_ms: number;
    served_total:           number;
  } | null;
  /** Process instance identifier. Defaults to HOSTNAME or "unknown".
   *  Surfaced as an `instance` label on every metric so Prometheus
   *  can aggregate across replicas without colliding. */
  instance?: string;
}

const NAMESPACE = 'institutional';

/** Escape a label value per Prometheus exposition format §LabelValue:
 *  backslash, double-quote, and newline are the only chars to escape. */
function esc(v: string | number | boolean | null | undefined): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function fmtLabels(labels: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    if (v == null) continue;
    parts.push(`${k}="${esc(v)}"`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

interface MetricEmitter {
  /** Emit one HELP+TYPE preamble + zero or more samples. */
  metric(name: string, help: string, type: 'counter' | 'gauge', samples: Array<{
    labels?: Record<string, string | number | boolean | null | undefined>;
    value:   number;
  }>): void;
}

function makeEmitter(out: string[]): MetricEmitter {
  const seenName = new Set<string>();
  return {
    metric(name, help, type, samples) {
      if (samples.length === 0) return;
      // Prometheus requires HELP+TYPE only ONCE per metric name across
      // a single scrape. Guard against accidental duplicate emission.
      if (!seenName.has(name)) {
        seenName.add(name);
        out.push(`# HELP ${name} ${esc(help)}`);
        out.push(`# TYPE ${name} ${type}`);
      }
      for (const s of samples) {
        out.push(`${name}${fmtLabels(s.labels ?? {})} ${formatNumber(s.value)}`);
      }
    },
  };
}

/** Prometheus accepts integers as-is and floats with a decimal point.
 *  NaN/±Inf must be emitted literally as `NaN` / `+Inf` / `-Inf`. */
function formatNumber(n: number): string {
  if (Number.isNaN(n))      return 'NaN';
  if (n === Infinity)       return '+Inf';
  if (n === -Infinity)      return '-Inf';
  if (Number.isInteger(n))  return String(n);
  return String(n);
}

/**
 * Render the institutional-health snapshot in Prometheus exposition
 * format. Returns the full text body (newline-terminated). The caller
 * sends this with `Content-Type: text/plain; version=0.0.4`.
 */
export function renderPrometheusMetrics(ctx: PromContext): string {
  const out: string[] = [];
  const e = makeEmitter(out);
  const instance = ctx.instance ?? process.env.HOSTNAME ?? 'unknown';
  const baseLabels = { instance };

  // ── Process info ───────────────────────────────────────────────
  e.metric(`${NAMESPACE}_process_uptime_seconds`,
    'Seconds since this process booted.',
    'gauge',
    [{ labels: baseLabels, value: ctx.snapshot.uptime_s }],
  );

  // ── Provider counters ──────────────────────────────────────────
  const invalidPayload = ctx.snapshot.providers.map((p) => ({
    labels: { ...baseLabels, provider: p.name },
    value:  p.invalid_payload,
  }));
  e.metric(`${NAMESPACE}_provider_invalid_payload_total`,
    'Per-provider count of payloads rejected by the validator (price<=0, volume=0 in market hours, NaN, etc).',
    'counter', invalidPayload);

  const rejectedSymbol = ctx.snapshot.providers.map((p) => ({
    labels: { ...baseLabels, provider: p.name },
    value:  p.rejected_symbol,
  }));
  e.metric(`${NAMESPACE}_provider_rejected_symbol_total`,
    'Per-provider count of symbols dropped at the adapter boundary.',
    'counter', rejectedSymbol);

  const fbTriggered = ctx.snapshot.providers.map((p) => ({
    labels: { ...baseLabels, provider: p.name },
    value:  p.fallback_triggered,
  }));
  e.metric(`${NAMESPACE}_provider_fallback_triggered_total`,
    'Cascade escalations that started FROM this provider.',
    'counter', fbTriggered);

  const fbSuccess = ctx.snapshot.providers.map((p) => ({
    labels: { ...baseLabels, provider: p.name },
    value:  p.fallback_success,
  }));
  e.metric(`${NAMESPACE}_provider_fallback_success_total`,
    'Successful fallback resolutions where THIS provider served data.',
    'counter', fbSuccess);

  const fbFailed = ctx.snapshot.providers.map((p) => ({
    labels: { ...baseLabels, provider: p.name },
    value:  p.fallback_failed,
  }));
  e.metric(`${NAMESPACE}_provider_fallback_failed_total`,
    'Fallback attempts that returned no usable data.',
    'counter', fbFailed);

  // ── Elite gate ─────────────────────────────────────────────────
  e.metric(`${NAMESPACE}_elite_approved_total`,
    'Rows that passed the elite institutional gate since process start.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.elite.approved_total }],
  );
  e.metric(`${NAMESPACE}_elite_rejected_total`,
    'Rows the elite gate dropped.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.elite.rejected_total }],
  );
  e.metric(`${NAMESPACE}_elite_stale_blocked_total`,
    'Rows dropped because freshness/decay flagged them stale or expired.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.elite.stale_blocked_total }],
  );
  e.metric(`${NAMESPACE}_elite_decay_applied_total`,
    'Rows that had market-closed decay applied (aging|stale|expired band).',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.elite.decay_applied_total }],
  );
  if (ctx.snapshot.approved_ratio != null) {
    e.metric(`${NAMESPACE}_elite_approved_ratio`,
      'approved_total / (approved_total + rejected_total) since process start.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.approved_ratio }],
    );
  }
  if (ctx.snapshot.elite.last_market_open != null) {
    e.metric(`${NAMESPACE}_elite_last_market_open`,
      '1 when the most recent elite-gate run saw the market open, 0 otherwise.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.elite.last_market_open ? 1 : 0 }],
    );
  }

  // ── Full scan ──────────────────────────────────────────────────
  e.metric(`${NAMESPACE}_full_scan_starts_total`,
    'Full institutional scans started.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.full_scan.starts }],
  );
  e.metric(`${NAMESPACE}_full_scan_completes_total`,
    'Full scans that completed successfully.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.full_scan.completes }],
  );
  e.metric(`${NAMESPACE}_full_scan_failures_total`,
    'Full scans that threw before completing.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.full_scan.failures }],
  );
  if (ctx.snapshot.full_scan.last_universe != null) {
    e.metric(`${NAMESPACE}_full_scan_last_universe`,
      'Universe size of the most recent full scan.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.full_scan.last_universe }],
    );
  }
  if (ctx.snapshot.full_scan.last_scanned != null) {
    e.metric(`${NAMESPACE}_full_scan_last_scanned`,
      'Symbols scanned in the most recent full scan.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.full_scan.last_scanned }],
    );
  }
  if (ctx.snapshot.full_scan.last_provider_coverage_pct != null) {
    e.metric(`${NAMESPACE}_full_scan_last_coverage_pct`,
      'Provider coverage % of the most recent full scan.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.full_scan.last_provider_coverage_pct }],
    );
  }
  if (ctx.snapshot.full_scan.last_elapsed_ms != null) {
    e.metric(`${NAMESPACE}_full_scan_last_elapsed_ms`,
      'Wall-clock duration of the most recent full scan.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.full_scan.last_elapsed_ms }],
    );
  }

  // ── Heartbeat ──────────────────────────────────────────────────
  e.metric(`${NAMESPACE}_heartbeat_ticks_total`,
    'Heartbeat tier ticks since process start.',
    'counter',
    [{ labels: baseLabels, value: ctx.snapshot.heartbeat.ticks }],
  );
  if (ctx.snapshot.heartbeat.last_universe != null) {
    e.metric(`${NAMESPACE}_heartbeat_last_universe`,
      'Last heartbeat tick universe size.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.heartbeat.last_universe }],
    );
  }
  if (ctx.snapshot.heartbeat.last_cache_hits != null) {
    e.metric(`${NAMESPACE}_heartbeat_last_cache_hits`,
      'Cache hits in the last heartbeat tick.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.heartbeat.last_cache_hits }],
    );
  }
  if (ctx.snapshot.heartbeat.last_cache_misses != null) {
    e.metric(`${NAMESPACE}_heartbeat_last_cache_misses`,
      'Cache misses in the last heartbeat tick.',
      'gauge',
      [{ labels: baseLabels, value: ctx.snapshot.heartbeat.last_cache_misses }],
    );
  }

  // ── Candle freshness ───────────────────────────────────────────
  if (ctx.candle) {
    if (ctx.candle.candle_age_seconds != null) {
      e.metric(`${NAMESPACE}_candle_age_seconds`,
        'Age of the latest candle in seconds at scrape time.',
        'gauge',
        [{ labels: baseLabels, value: ctx.candle.candle_age_seconds }],
      );
    }
    e.metric(`${NAMESPACE}_candle_feed_frozen`,
      '1 when the candle feed is frozen (no updates within the market-aware window), 0 otherwise.',
      'gauge',
      [{ labels: baseLabels, value: ctx.candle.feed_frozen ? 1 : 0 }],
    );
    e.metric(`${NAMESPACE}_candle_market_open`,
      '1 when market is open at scrape time.',
      'gauge',
      [{ labels: baseLabels, value: ctx.candle.market_open ? 1 : 0 }],
    );
    // freshness_quality as a label-only gauge (always 1) — Prometheus
    // pattern for categorical values.
    e.metric(`${NAMESPACE}_candle_freshness_quality_info`,
      'Categorical freshness band (label "quality" = fresh|aging|stale|frozen|unknown).',
      'gauge',
      [{
        labels: { ...baseLabels, quality: ctx.candle.freshness_quality },
        value:  1,
      }],
    );
  }

  // ── Provider breaker / queue ───────────────────────────────────
  if (ctx.breaker) {
    e.metric(`${NAMESPACE}_provider_breaker_open`,
      '1 when the IndianAPI breaker is open or half-open.',
      'gauge',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.breaker.open ? 1 : 0 }],
    );
    e.metric(`${NAMESPACE}_provider_auth_failed`,
      '1 when the IndianAPI auth-failed latch is set.',
      'gauge',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.breaker.auth_failed ? 1 : 0 }],
    );
    e.metric(`${NAMESPACE}_provider_breaker_remaining_ms`,
      'Milliseconds remaining on the IndianAPI breaker cooldown (0 when closed).',
      'gauge',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.breaker.remainingMs }],
    );
  }
  if (ctx.queue) {
    e.metric(`${NAMESPACE}_provider_queue_depth`,
      'In-flight rate-limiter queue depth.',
      'gauge',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.queue.depth }],
    );
    e.metric(`${NAMESPACE}_provider_queue_peak_depth`,
      'High-water-mark queue depth since process start.',
      'gauge',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.queue.peak_depth }],
    );
    e.metric(`${NAMESPACE}_provider_queue_throttle_wait_ms_total`,
      'Cumulative ms callers spent blocked behind the rate-limiter gap.',
      'counter',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.queue.throttle_wait_total_ms }],
    );
    e.metric(`${NAMESPACE}_provider_queue_served_total`,
      'Calls served through the rate limiter since process start.',
      'counter',
      [{ labels: { ...baseLabels, provider: 'indianapi' }, value: ctx.queue.served_total }],
    );
  }

  // Newline-terminated body per Prometheus exposition format spec.
  out.push('');
  return out.join('\n');
}
