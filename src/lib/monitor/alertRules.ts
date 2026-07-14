// ════════════════════════════════════════════════════════════════
//  Production Alert Rules — Spec PRODUCTION-ALERTS-2026-05.
//
//  Pure rule engine that consumes the institutional-health snapshot
//  + auxiliary probes (candle freshness, breaker state) and emits a
//  list of triggered alerts. Each rule is independent and side-
//  effect free; the caller (HTTP endpoint, cron) decides whether to
//  notify (Slack / PagerDuty / email).
//
//  Severity levels mirror PagerDuty's:
//    info     — informational, no human action needed
//    warning  — degraded state; investigate during business hours
//    critical — revenue / governance impact; page the on-call
//
//  Rules:
//    feed_frozen                 — critical
//    invalid_payload_spike       — warning when rate exceeds floor
//    no_full_scan                — warning at 30 min, critical at 90 min
//    elite_zero_output_anomaly   — critical when approved_ratio is
//                                  near zero over a meaningful sample
//    scan_coverage_below_floor   — warning when last full scan
//                                  covered < 90% of universe
//    approval_ratio_collapse     — critical when approved_ratio
//                                  drops far below historical norm
//    kite_*                      — auth / rate-limit / unavailable
//
//  Pure module — no I/O. Caller wires the snapshot.
// ════════════════════════════════════════════════════════════════

import type { InstitutionalHealthSnapshot } from './institutionalHealth';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id:        string;
  severity:  AlertSeverity;
  title:     string;
  detail:    string;
  /** Per-rule context payload — what numbers triggered the alert. */
  context:   Record<string, unknown>;
  triggered_at: string;
}

export interface AlertEvaluationInput {
  snapshot: InstitutionalHealthSnapshot;
  candle?: {
    candle_age_seconds: number | null;
    freshness_quality:  string;
    feed_frozen:        boolean;
    market_open:        boolean;
  } | null;
  /** @deprecated Unused — retained for call-site compile compatibility. */
  breaker?: {
    open:        boolean;
    state:       string;
    auth_failed: boolean;
  } | null;
  /** Confirmed-snapshot funnel probe (PRODUCTION-READINESS 2026-07). */
  signalsPipeline?: {
    market_open:            boolean;
    active_confirmed_count: number | null;
    /** Latest q365_confirmed_signal_snapshots write, epoch ms. */
    last_pipeline_run_ms:   number | null;
  } | null;
  /** In-process live feed state (getLiveFeedState). */
  liveFeed?: {
    quality:           string;
    market_open:       boolean;
    approvals_blocked: boolean;
    tick_age_ms:       number | null;
  } | null;
  /** Custom-universe scanner in-flight lock (scannerState). */
  scanner?: {
    in_flight:  boolean;
    elapsed_ms: number | null;
  } | null;
  /** @deprecated Unused — monthly vendor quotas are not alerted. */
  quota?: {
    daily_percent:   number;
    monthly_percent: number;
    state:           string;
  } | null;
  /** Kite availability (no monthly quota). */
  kite?: {
    configured: boolean;
    available: boolean;
    auth_failed: boolean;
    rate_limited: boolean;
    rate_limit_events: number;
    last_error_code: string | null;
  } | null;
  /** Selected MARKET_DATA_PROVIDER (read-only). */
  current_provider?: string | null;
}

interface RuleConfig {
  invalid_payload_spike_floor:   number;
  no_full_scan_warning_minutes:  number;
  no_full_scan_critical_minutes: number;
  scan_coverage_floor_pct:       number;
  approval_ratio_collapse_floor: number;
  elite_zero_output_min_sample:  number;
  no_confirmed_signals_minutes:  number;
  stuck_in_flight_minutes:       number;
}

function envNum(name: string, fb: number, lo: number, hi: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fb;
  return Math.max(lo, Math.min(hi, raw));
}

function getRuleConfig(): RuleConfig {
  return {
    invalid_payload_spike_floor:   envNum('ALERT_INVALID_PAYLOAD_FLOOR',     50, 1,  10_000),
    no_full_scan_warning_minutes:  envNum('ALERT_NO_FULL_SCAN_WARN_MIN',     30, 5,  1440),
    no_full_scan_critical_minutes: envNum('ALERT_NO_FULL_SCAN_CRIT_MIN',     90, 5,  1440),
    scan_coverage_floor_pct:       envNum('ALERT_SCAN_COVERAGE_FLOOR_PCT',   90, 0,  100),
    approval_ratio_collapse_floor: envNum('ALERT_APPROVAL_RATIO_FLOOR',      0.001, 0, 1),
    elite_zero_output_min_sample:  envNum('ALERT_ELITE_ZERO_MIN_SAMPLE',     100, 10, 100_000),
    no_confirmed_signals_minutes:  envNum('ALERT_NO_CONFIRMED_SIGNALS_MIN',  30, 5,  1440),
    stuck_in_flight_minutes:       envNum('ALERT_STUCK_INFLIGHT_MIN',        5,  1,  120),
  };
}

/**
 * Evaluate every rule against the snapshot. Returns the array of
 * triggered alerts (empty when the system is healthy). Rule order
 * is stable so a Slack consumer can dedupe by id.
 */
export function evaluateAlerts(input: AlertEvaluationInput): Alert[] {
  const cfg = getRuleConfig();
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  // ── feed_frozen ──────────────────────────────────────────────
  if (input.candle?.feed_frozen) {
    alerts.push({
      id:        'feed_frozen',
      severity:  'critical',
      title:     'Candle feed frozen — elite gate refuses to ship',
      detail:    `Candle age ${input.candle.candle_age_seconds}s exceeds the frozen-feed threshold; signals[] is empty for every consumer until the feed updates.`,
      context: {
        candle_age_seconds: input.candle.candle_age_seconds,
        market_open:        input.candle.market_open,
        freshness_quality:  input.candle.freshness_quality,
      },
      triggered_at: now,
    });
  }

  // ── invalid_payload_spike ────────────────────────────────────
  const totalInvalid = input.snapshot.providers.reduce((s, p) => s + p.invalid_payload, 0);
  if (totalInvalid >= cfg.invalid_payload_spike_floor) {
    alerts.push({
      id:        'invalid_payload_spike',
      severity:  totalInvalid >= cfg.invalid_payload_spike_floor * 5 ? 'critical' : 'warning',
      title:     `Invalid payload spike — ${totalInvalid} rejections since boot`,
      detail:    `Provider validators have dropped ${totalInvalid} payloads. Spot-check the offending provider's last_invalid_reason for the dominant cause.`,
      context: {
        total_invalid: totalInvalid,
        per_provider:  input.snapshot.providers.map((p) => ({
          name:                p.name,
          invalid_payload:     p.invalid_payload,
          last_invalid_reason: p.last_invalid_reason,
        })),
        floor: cfg.invalid_payload_spike_floor,
      },
      triggered_at: now,
    });
  }

  // ── no_full_scan ─────────────────────────────────────────────
  const lastCompleted = input.snapshot.full_scan.last_completed_at;
  if (input.snapshot.full_scan.starts === 0 && input.snapshot.uptime_s > cfg.no_full_scan_warning_minutes * 60) {
    // Process has been up long enough that a scan should have run.
    alerts.push({
      id:        'no_full_scan',
      severity:  'warning',
      title:     'No full institutional scan has run since boot',
      detail:    `Process uptime ${Math.round(input.snapshot.uptime_s / 60)} min and 0 [FULL_SCAN_START] events seen. The cron may be misconfigured.`,
      context: {
        uptime_s: input.snapshot.uptime_s,
        starts:   input.snapshot.full_scan.starts,
      },
      triggered_at: now,
    });
  } else if (lastCompleted) {
    const ageMs = Date.now() - Date.parse(lastCompleted);
    const ageMin = ageMs / 60_000;
    if (ageMin >= cfg.no_full_scan_critical_minutes) {
      alerts.push({
        id:        'no_full_scan',
        severity:  'critical',
        title:     `No full scan completed in ${Math.round(ageMin)} min`,
        detail:    `Last [FULL_SCAN_COMPLETE] was ${Math.round(ageMin)} min ago — the engine is producing stale signals.`,
        context: { last_completed_at: lastCompleted, age_minutes: ageMin },
        triggered_at: now,
      });
    } else if (ageMin >= cfg.no_full_scan_warning_minutes) {
      alerts.push({
        id:        'no_full_scan',
        severity:  'warning',
        title:     `No full scan completed in ${Math.round(ageMin)} min`,
        detail:    `Last [FULL_SCAN_COMPLETE] was ${Math.round(ageMin)} min ago. Cron cadence is 10 min during market hours — check the worker.`,
        context: { last_completed_at: lastCompleted, age_minutes: ageMin },
        triggered_at: now,
      });
    }
  }

  // ── scan_coverage_below_floor ────────────────────────────────
  // Only during market hours — off-hours / manual dev scans routinely
  // skip symbols with no fresh intraday data; sub-90% coverage there
  // is expected and must not degrade the admin dashboard.
  if (input.candle?.market_open === true
      && input.snapshot.full_scan.last_provider_coverage_pct != null
      && input.snapshot.full_scan.last_provider_coverage_pct < cfg.scan_coverage_floor_pct) {
    alerts.push({
      id:        'scan_coverage_below_floor',
      severity:  'warning',
      title:     `Last scan coverage ${input.snapshot.full_scan.last_provider_coverage_pct}% below ${cfg.scan_coverage_floor_pct}% floor`,
      detail:    'Provider coverage dropped — Phase 3 didn\'t reach every symbol. Rate-limit / breaker / network are likely culprits.',
      context: {
        last_universe:   input.snapshot.full_scan.last_universe,
        last_scanned:    input.snapshot.full_scan.last_scanned,
        coverage_pct:    input.snapshot.full_scan.last_provider_coverage_pct,
        floor_pct:       cfg.scan_coverage_floor_pct,
      },
      triggered_at: now,
    });
  }

  // ── elite_zero_output_anomaly ────────────────────────────────
  const totalElite = input.snapshot.elite.approved_total + input.snapshot.elite.rejected_total;
  if (totalElite >= cfg.elite_zero_output_min_sample
      && (input.snapshot.approved_ratio ?? 0) < cfg.approval_ratio_collapse_floor) {
    alerts.push({
      id:        'elite_zero_output_anomaly',
      severity:  'critical',
      title:     'Elite gate producing near-zero approved rows',
      detail:    `Approved ratio ${(input.snapshot.approved_ratio ?? 0).toFixed(4)} over ${totalElite} runs is below the collapse floor (${cfg.approval_ratio_collapse_floor}). Either the floors are mis-tuned, the feed is degraded, or the universe is truly weak.`,
      context: {
        approved_total:  input.snapshot.elite.approved_total,
        rejected_total:  input.snapshot.elite.rejected_total,
        approved_ratio:  input.snapshot.approved_ratio,
        floor:           cfg.approval_ratio_collapse_floor,
        sample_size:     totalElite,
      },
      triggered_at: now,
    });
  }

  // ── approval_ratio_collapse ──────────────────────────────────
  // Triggers when the LAST run was 0% approved over a >= 50-row
  // sample — finer-grained than elite_zero_output_anomaly which
  // looks at the cumulative ratio.
  const lastTotal = input.snapshot.elite.last_approved + input.snapshot.elite.last_rejected;
  if (lastTotal >= 50 && input.snapshot.elite.last_approved === 0) {
    alerts.push({
      id:        'approval_ratio_collapse',
      severity:  'warning',
      title:     'Last elite run produced 0 approved rows',
      detail:    `Last run rejected ${input.snapshot.elite.last_rejected} of ${lastTotal}. A single empty run is not always actionable; persistence over multiple runs is.`,
      context: {
        last_approved: input.snapshot.elite.last_approved,
        last_rejected: input.snapshot.elite.last_rejected,
        last_run_at:   input.snapshot.elite.last_run_at,
      },
      triggered_at: now,
    });
  }

  // ── no_confirmed_signals ─────────────────────────────────────
  // PRODUCTION-READINESS 2026-07 alert 1: zero ACTIVE confirmed
  // snapshots during market hours, sustained past the threshold after
  // the last pipeline write. This is the exact "empty UI, full DB"
  // failure mode the funnel playbook targets.
  const sp = input.signalsPipeline;
  if (sp?.market_open === true && sp.active_confirmed_count === 0) {
    const lastRunAgeMin = sp.last_pipeline_run_ms != null
      ? (Date.now() - sp.last_pipeline_run_ms) / 60_000
      : null;
    if (lastRunAgeMin === null || lastRunAgeMin >= cfg.no_confirmed_signals_minutes) {
      alerts.push({
        id:        'no_confirmed_signals',
        severity:  'critical',
        title:     'No confirmed signals during market hours',
        detail:    lastRunAgeMin === null
          ? 'q365_confirmed_signal_snapshots has 0 ACTIVE rows and no pipeline write has ever been recorded. Run diagnoseSignalFunnel.ts.'
          : `0 ACTIVE confirmed snapshots and the last pipeline write was ${Math.round(lastRunAgeMin)} min ago (threshold ${cfg.no_confirmed_signals_minutes} min). The dashboard and signals page are empty for every user.`,
        context: {
          active_confirmed_count: sp.active_confirmed_count,
          last_pipeline_run_ms:   sp.last_pipeline_run_ms,
          last_run_age_minutes:   lastRunAgeMin,
          threshold_minutes:      cfg.no_confirmed_signals_minutes,
        },
        triggered_at: now,
      });
    }
  }

  // ── live_feed_stale ──────────────────────────────────────────
  // Alert 2: live feed stale/disconnected during market hours. When
  // approvals_blocked is true the engine also refuses to approve new
  // signals, so this compounds into alert 1 if left unattended.
  const lf = input.liveFeed;
  if (lf?.market_open === true
      && (lf.quality === 'stale' || lf.quality === 'disconnected' || lf.approvals_blocked)) {
    alerts.push({
      id:        'live_feed_stale',
      severity:  'critical',
      title:     `Live feed ${lf.quality} during market hours`,
      detail:    `Last tick was ${lf.tick_age_ms != null ? Math.round(lf.tick_age_ms / 1000) + 's' : 'never'} ago and approvals are ${lf.approvals_blocked ? 'BLOCKED' : 'still allowed'}. Probe with scripts/probeLiveWs.ts; check STREAM_WS_DISABLED and the live feed provider.`,
      context: {
        quality:           lf.quality,
        tick_age_ms:       lf.tick_age_ms,
        approvals_blocked: lf.approvals_blocked,
      },
      triggered_at: now,
    });
  }

  // ── pipeline_stuck_in_flight ─────────────────────────────────
  // Alert 3: the scanner in-flight lock has been held far past the
  // ~30s stale watchdog — auto-recovery itself has failed, so every
  // subsequent run request is 409-blocked.
  const sc = input.scanner;
  if (sc?.in_flight === true
      && sc.elapsed_ms != null
      && sc.elapsed_ms >= cfg.stuck_in_flight_minutes * 60_000) {
    alerts.push({
      id:        'pipeline_stuck_in_flight',
      severity:  'critical',
      title:     `Scanner in-flight lock held for ${Math.round(sc.elapsed_ms / 60_000)} min`,
      detail:    `The in-flight lock outlived the stale watchdog (threshold ${cfg.stuck_in_flight_minutes} min); new scans are refused with 409. Clear via GET /api/scanner/custom-universe/status (watchdog) or npm run unblock:execution-lock for the engine lock.`,
      context: {
        elapsed_ms:        sc.elapsed_ms,
        threshold_minutes: cfg.stuck_in_flight_minutes,
      },
      triggered_at: now,
    });
  }

  // ── kite_authentication_failed / kite_rate_limit ─────────────
  const kite = input.kite;
  if (kite?.configured) {
    if (kite.auth_failed) {
      alerts.push({
        id:       'kite_authentication_failed',
        severity: 'critical',
        title:    'Kite authentication failed',
        detail:   `Kite access token / session is invalid`
          + (kite.last_error_code ? ` (${kite.last_error_code})` : '')
          + `. Cascade to yahoo/nse/db if configured; refresh KITE_ACCESS_TOKEN.`,
        context: {
          provider: 'kite',
          auth_failed: true,
          last_error_code: kite.last_error_code,
          current_provider: input.current_provider ?? null,
        },
        triggered_at: now,
      });
    }
    if (kite.rate_limited) {
      alerts.push({
        id:       'kite_rate_limit_exceeded',
        severity: 'warning',
        title:    'Kite rate limit exceeded',
        detail:   `Kite soft rate-limit is active (`
          + `${kite.rate_limit_events} events since boot). `
          + `Scheduler should continue via yahoo/nse/db fallback — do not invent monthly quotas.`,
        context: {
          provider: 'kite',
          rate_limited: true,
          rate_limit_events: kite.rate_limit_events,
          current_provider: input.current_provider ?? null,
        },
        triggered_at: now,
      });
    }
    if (
      input.current_provider === 'kite'
      && kite.configured
      && !kite.available
      && !kite.auth_failed
      && !kite.rate_limited
    ) {
      alerts.push({
        id:       'kite_unavailable',
        severity: 'warning',
        title:    'Kite unavailable',
        detail:   'MARKET_DATA_PROVIDER=kite but Kite health reports unavailable.',
        context: { provider: 'kite', available: false },
        triggered_at: now,
      });
    }
  }

  return alerts;
}

/** Roll-up summary — { critical, warning, info } counts. */
export function summariseAlerts(alerts: readonly Alert[]): {
  critical: number;
  warning:  number;
  info:     number;
  total:    number;
  worst_severity: AlertSeverity | null;
} {
  let critical = 0, warning = 0, info = 0;
  for (const a of alerts) {
    if (a.severity === 'critical') critical += 1;
    else if (a.severity === 'warning') warning += 1;
    else info += 1;
  }
  const worst = critical > 0 ? 'critical' : warning > 0 ? 'warning' : info > 0 ? 'info' : null;
  return { critical, warning, info, total: alerts.length, worst_severity: worst };
}
