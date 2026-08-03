// ════════════════════════════════════════════════════════════════
//  Institutional Health Counters — Spec INSTITUTIONAL-HEALTH-2026-05.
//
//  Process-local monotonic counters that the resolver / validator /
//  elite gate / scheduler bump as they run. Read by
//  GET /api/system/institutional-health to produce the SRE
//  dashboard payload.
//
//  Pure module — no I/O, no DB. Counters are reset on process boot;
//  the endpoint surfaces "since process start" semantics so SRE can
//  pair the numbers with the boot timestamp.
//
//  All recorders are O(1). The counter object is intentionally tiny
//  so reading it from a hot path (e.g. validator on every snapshot)
//  is free.
// ════════════════════════════════════════════════════════════════

const bootedAt = Date.now();

interface ProviderCounter {
  name:                string;
  invalid_payload:     number;
  rejected_symbol:     number;
  fallback_triggered:  number;
  fallback_success:    number;
  fallback_failed:     number;
  last_invalid_at:     string | null;
  last_invalid_reason: string | null;
}

const providers = new Map<string, ProviderCounter>();

function ensureProvider(name: string): ProviderCounter {
  let c = providers.get(name);
  if (!c) {
    c = {
      name,
      invalid_payload:     0,
      rejected_symbol:     0,
      fallback_triggered:  0,
      fallback_success:    0,
      fallback_failed:     0,
      last_invalid_at:     null,
      last_invalid_reason: null,
    };
    providers.set(name, c);
  }
  return c;
}

export function recordInvalidPayload(provider: string, reason: string | null): void {
  const c = ensureProvider(provider);
  c.invalid_payload  += 1;
  c.rejected_symbol  += 1;
  c.last_invalid_at  = new Date().toISOString();
  c.last_invalid_reason = reason;
}

export function recordFallbackTriggered(fromProvider: string): void {
  ensureProvider(fromProvider).fallback_triggered += 1;
}

export function recordFallbackSuccess(provider: string): void {
  ensureProvider(provider).fallback_success += 1;
}

export function recordFallbackFailed(provider: string, _reason: string | null): void {
  ensureProvider(provider).fallback_failed += 1;
}

// ── Elite-gate counters ─────────────────────────────────────────────

interface EliteCounter {
  approved_total:      number;
  rejected_total:      number;
  stale_blocked_total: number;  // dropped because freshness/decay flagged stale
  decay_applied_total: number;
  last_run_at:         string | null;
  last_approved:       number;
  last_rejected:       number;
  last_market_open:    boolean | null;
}
const elite: EliteCounter = {
  approved_total:      0,
  rejected_total:      0,
  stale_blocked_total: 0,
  decay_applied_total: 0,
  last_run_at:         null,
  last_approved:       0,
  last_rejected:       0,
  last_market_open:    null,
};

export function recordEliteGateRun(opts: {
  approved: number;
  rejected: number;
  stale_blocked?: number;
  decay_applied?: number;
  market_open?: boolean | null;
}): void {
  elite.approved_total      += opts.approved;
  elite.rejected_total      += opts.rejected;
  elite.stale_blocked_total += opts.stale_blocked ?? 0;
  elite.decay_applied_total += opts.decay_applied ?? 0;
  elite.last_run_at          = new Date().toISOString();
  elite.last_approved        = opts.approved;
  elite.last_rejected        = opts.rejected;
  elite.last_market_open     = opts.market_open ?? null;
}

// ── Full-scan counters ──────────────────────────────────────────────

interface FullScanCounter {
  starts:           number;
  completes:        number;
  failures:         number;
  last_started_at:  string | null;
  last_completed_at: string | null;
  last_universe:    number | null;
  last_scanned:     number | null;
  last_approved:    number | null;
  last_rejected:    number | null;
  last_elapsed_ms:  number | null;
  last_provider_coverage_pct: number | null;
}
const fullScan: FullScanCounter = {
  starts:           0,
  completes:        0,
  failures:         0,
  last_started_at:  null,
  last_completed_at: null,
  last_universe:    null,
  last_scanned:     null,
  last_approved:    null,
  last_rejected:    null,
  last_elapsed_ms:  null,
  last_provider_coverage_pct: null,
};

export function recordFullScanStart(opts: { universe_size: number | null }): void {
  fullScan.starts          += 1;
  fullScan.last_started_at  = new Date().toISOString();
  fullScan.last_universe    = opts.universe_size;
}

export function recordFullScanComplete(opts: {
  ok: boolean;
  scanned?: number;
  approved?: number;
  rejected?: number;
  elapsed_ms?: number;
  provider_coverage_pct?: number | null;
}): void {
  if (opts.ok) fullScan.completes += 1;
  else         fullScan.failures  += 1;
  fullScan.last_completed_at        = new Date().toISOString();
  fullScan.last_scanned             = opts.scanned ?? null;
  fullScan.last_approved            = opts.approved ?? null;
  fullScan.last_rejected            = opts.rejected ?? null;
  fullScan.last_elapsed_ms          = opts.elapsed_ms ?? null;
  fullScan.last_provider_coverage_pct = opts.provider_coverage_pct ?? null;
}

// ── Heartbeat counter ───────────────────────────────────────────────

interface HeartbeatCounter {
  ticks:             number;
  last_at:           string | null;
  last_universe:     number | null;
  last_cache_hits:   number | null;
  last_cache_misses: number | null;
}
const heartbeat: HeartbeatCounter = {
  ticks:             0,
  last_at:           null,
  last_universe:     null,
  last_cache_hits:   null,
  last_cache_misses: null,
};

export function recordHeartbeatTick(opts: {
  universe: number;
  cache_hits: number;
  cache_misses: number;
}): void {
  heartbeat.ticks            += 1;
  heartbeat.last_at           = new Date().toISOString();
  heartbeat.last_universe     = opts.universe;
  heartbeat.last_cache_hits   = opts.cache_hits;
  heartbeat.last_cache_misses = opts.cache_misses;
}

// ── IndianAPI ingestion counters ────────────────────────────────────
//
// Bumped by the IndianAPI adapter + ingestion orchestrator. Read by
// the health endpoint and the Prometheus renderer so operators can
// alert on 429 spikes, circuit opens, overlap skips, and sync lag.

interface IndianApiIngestCounter {
  requests_total:       number;
  failures_total:       number;
  rate_limited_total:   number;   // 429s observed
  circuit_opens_total:  number;
  overlap_skips_total:  number;   // scheduler_overlap_skipped
  budget_blocks_total:  number;   // daily/monthly/per-run budget hits
  runs_total:           number;
  runs_failed_total:    number;
  last_run_at:          string | null;
  last_run_tier:        string | null;
  last_run_processed:   number | null;
  last_run_failed:      number | null;
  last_quote_success_at: string | null;
}

const indianApiIngest: IndianApiIngestCounter = {
  requests_total:       0,
  failures_total:       0,
  rate_limited_total:   0,
  circuit_opens_total:  0,
  overlap_skips_total:  0,
  budget_blocks_total:  0,
  runs_total:           0,
  runs_failed_total:    0,
  last_run_at:          null,
  last_run_tier:        null,
  last_run_processed:   null,
  last_run_failed:      null,
  last_quote_success_at: null,
};

export function recordIndianApiRequest(opts: { ok: boolean; rateLimited?: boolean }): void {
  indianApiIngest.requests_total += 1;
  if (!opts.ok) indianApiIngest.failures_total += 1;
  if (opts.rateLimited) indianApiIngest.rate_limited_total += 1;
}

export function recordIndianApiCircuitOpen(): void {
  indianApiIngest.circuit_opens_total += 1;
}

export function recordIndianApiOverlapSkip(): void {
  indianApiIngest.overlap_skips_total += 1;
}

export function recordIndianApiBudgetBlock(): void {
  indianApiIngest.budget_blocks_total += 1;
}

export function recordIndianApiIngestionRun(opts: {
  tier: string;
  ok: boolean;
  processed?: number;
  failed?: number;
}): void {
  indianApiIngest.runs_total += 1;
  if (!opts.ok) indianApiIngest.runs_failed_total += 1;
  indianApiIngest.last_run_at        = new Date().toISOString();
  indianApiIngest.last_run_tier      = opts.tier;
  indianApiIngest.last_run_processed = opts.processed ?? null;
  indianApiIngest.last_run_failed    = opts.failed ?? null;
  if (opts.tier === 'quotes' && opts.ok) {
    indianApiIngest.last_quote_success_at = indianApiIngest.last_run_at;
  }
}

// ── Snapshot reader ─────────────────────────────────────────────────

export interface InstitutionalHealthSnapshot {
  booted_at:        string;
  uptime_s:         number;
  providers:        ProviderCounter[];
  elite:            EliteCounter;
  full_scan:        FullScanCounter;
  heartbeat:        HeartbeatCounter;
  indianapi_ingest: IndianApiIngestCounter;
  /** approved / (approved + rejected) since boot. null until first run. */
  approved_ratio:   number | null;
}

export function getInstitutionalHealthSnapshot(): InstitutionalHealthSnapshot {
  const total = elite.approved_total + elite.rejected_total;
  return {
    booted_at:    new Date(bootedAt).toISOString(),
    uptime_s:     Math.round((Date.now() - bootedAt) / 1000),
    providers:    Array.from(providers.values()),
    elite:        { ...elite },
    full_scan:    { ...fullScan },
    heartbeat:    { ...heartbeat },
    indianapi_ingest: { ...indianApiIngest },
    approved_ratio: total > 0 ? Math.round((elite.approved_total / total) * 1000) / 1000 : null,
  };
}

/** Test/debug — wipes every counter back to boot defaults. */
export function resetInstitutionalHealth(): void {
  providers.clear();
  Object.assign(elite, {
    approved_total: 0, rejected_total: 0, stale_blocked_total: 0, decay_applied_total: 0,
    last_run_at: null, last_approved: 0, last_rejected: 0, last_market_open: null,
  });
  Object.assign(fullScan, {
    starts: 0, completes: 0, failures: 0,
    last_started_at: null, last_completed_at: null,
    last_universe: null, last_scanned: null, last_approved: null,
    last_rejected: null, last_elapsed_ms: null, last_provider_coverage_pct: null,
  });
  Object.assign(heartbeat, {
    ticks: 0, last_at: null, last_universe: null,
    last_cache_hits: null, last_cache_misses: null,
  });
  Object.assign(indianApiIngest, {
    requests_total: 0, failures_total: 0, rate_limited_total: 0,
    circuit_opens_total: 0, overlap_skips_total: 0, budget_blocks_total: 0,
    runs_total: 0, runs_failed_total: 0,
    last_run_at: null, last_run_tier: null,
    last_run_processed: null, last_run_failed: null,
    last_quote_success_at: null,
  });
}
