// ════════════════════════════════════════════════════════════════
//  Redis-backed counter mirror — Spec DISTRIBUTED-METRICS-2026-05.
//
//  Mirrors the in-process institutional-health counters to a single
//  Redis key per instance so a multi-replica deployment can be
//  aggregated by either:
//
//    A. Prometheus scraping each replica's /api/metrics endpoint
//       directly (preferred — Prometheus does the aggregation), OR
//
//    B. A single reader calling getAggregatedHealth() to collapse
//       every instance's last-flushed snapshot into one envelope.
//
//  Each replica writes its own snapshot to:
//
//      institutional:health:<instance>
//
//  with a TTL of 2× the flush interval. The tracker key
//
//      institutional:health:instances
//
//  holds a Set of every instance ID that has flushed in the window;
//  the reader iterates that to find every per-instance key.
//
//  Best-effort by design: a Redis outage skips the flush silently
//  (in-process counters keep accumulating), and a missing/expired
//  per-instance key is treated as "instance gone".
// ════════════════════════════════════════════════════════════════

import { cacheGet, cacheSet } from '@/lib/redis';
import {
  getInstitutionalHealthSnapshot,
  type InstitutionalHealthSnapshot,
} from './institutionalHealth';

const HEALTH_KEY_PREFIX = 'institutional:health:';
const INSTANCES_KEY     = 'institutional:health:instances';

/** TTL on each per-instance key. 2× the flush interval gives the
 *  reader a grace window to spot a stale instance before treating
 *  it as gone. Default flush=10s → TTL=20s. Override via
 *  INSTITUTIONAL_HEALTH_FLUSH_S; clamped to [5, 600]. */
function flushIntervalSeconds(): number {
  const raw = Number(process.env.INSTITUTIONAL_HEALTH_FLUSH_S);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(5, Math.min(600, Math.floor(raw)));
}

function instanceId(): string {
  return process.env.HOSTNAME
      ?? process.env.INSTANCE_ID
      ?? `pid-${process.pid}`;
}

/** Flush this process's current snapshot to Redis. Best-effort:
 *  swallows Redis errors so a transient outage doesn't break the
 *  cron/hot-path caller. */
export async function flushHealthToRedis(): Promise<void> {
  const snapshot = getInstitutionalHealthSnapshot();
  const id  = instanceId();
  const key = HEALTH_KEY_PREFIX + id;
  const ttl = flushIntervalSeconds() * 2;
  try {
    await cacheSet(key, {
      flushed_at: new Date().toISOString(),
      instance:   id,
      snapshot,
    }, ttl);
    // Track which instances have flushed recently. We use a
    // separately-keyed map (not a Redis SET) so the cacheGet/cacheSet
    // pair from @/lib/redis works without raw client access.
    const tracker = (await cacheGet<Record<string, string>>(INSTANCES_KEY)) ?? {};
    const now = Date.now();
    // Garbage-collect entries older than 4× the flush interval.
    const cutoff = now - 4 * flushIntervalSeconds() * 1000;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(tracker)) {
      const ts = Date.parse(v);
      if (Number.isFinite(ts) && ts >= cutoff) next[k] = v;
    }
    next[id] = new Date(now).toISOString();
    await cacheSet(INSTANCES_KEY, next, flushIntervalSeconds() * 8);
  } catch {
    /* Redis unavailable — counters stay in-process only. */
  }
}

interface PerInstanceSnapshot {
  flushed_at: string;
  instance:   string;
  snapshot:   InstitutionalHealthSnapshot;
}

/**
 * Read every recently-flushed instance snapshot. Returns an array
 * sorted by flushed_at DESC. Empty when Redis is unavailable or no
 * instance has flushed in the TTL window.
 */
export async function getInstanceSnapshots(): Promise<PerInstanceSnapshot[]> {
  const tracker = await cacheGet<Record<string, string>>(INSTANCES_KEY);
  if (!tracker) return [];
  const out: PerInstanceSnapshot[] = [];
  for (const id of Object.keys(tracker)) {
    const snap = await cacheGet<PerInstanceSnapshot>(HEALTH_KEY_PREFIX + id);
    if (snap) out.push(snap);
  }
  out.sort((a, b) => Date.parse(b.flushed_at) - Date.parse(a.flushed_at));
  return out;
}

/** Aggregated cluster view: sum every counter across every instance
 *  that has flushed in the TTL window. Read-only; does not mutate. */
export interface AggregatedHealth {
  instance_count:  number;
  oldest_flush_at: string | null;
  newest_flush_at: string | null;
  totals: {
    invalid_payload:    number;
    rejected_symbol:    number;
    fallback_triggered: number;
    fallback_success:   number;
    fallback_failed:    number;
    elite_approved:     number;
    elite_rejected:     number;
    elite_stale_blocked:number;
    full_scan_starts:   number;
    full_scan_completes:number;
    full_scan_failures: number;
    heartbeat_ticks:    number;
  };
}

export async function getAggregatedHealth(): Promise<AggregatedHealth> {
  const snaps = await getInstanceSnapshots();
  const totals = {
    invalid_payload:    0,
    rejected_symbol:    0,
    fallback_triggered: 0,
    fallback_success:   0,
    fallback_failed:    0,
    elite_approved:     0,
    elite_rejected:     0,
    elite_stale_blocked:0,
    full_scan_starts:   0,
    full_scan_completes:0,
    full_scan_failures: 0,
    heartbeat_ticks:    0,
  };
  for (const s of snaps) {
    for (const p of s.snapshot.providers) {
      totals.invalid_payload    += p.invalid_payload;
      totals.rejected_symbol    += p.rejected_symbol;
      totals.fallback_triggered += p.fallback_triggered;
      totals.fallback_success   += p.fallback_success;
      totals.fallback_failed    += p.fallback_failed;
    }
    totals.elite_approved      += s.snapshot.elite.approved_total;
    totals.elite_rejected      += s.snapshot.elite.rejected_total;
    totals.elite_stale_blocked += s.snapshot.elite.stale_blocked_total;
    totals.full_scan_starts    += s.snapshot.full_scan.starts;
    totals.full_scan_completes += s.snapshot.full_scan.completes;
    totals.full_scan_failures  += s.snapshot.full_scan.failures;
    totals.heartbeat_ticks     += s.snapshot.heartbeat.ticks;
  }
  return {
    instance_count:  snaps.length,
    oldest_flush_at: snaps.length > 0 ? snaps[snaps.length - 1].flushed_at : null,
    newest_flush_at: snaps.length > 0 ? snaps[0].flushed_at : null,
    totals,
  };
}
