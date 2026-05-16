// ════════════════════════════════════════════════════════════════
//  envSafetyLock — production-mode env guardrails.
//
//  Called at boot from instrumentation.ts. When NODE_ENV='production'
//  the process REFUSES to boot if any of the following invariants
//  are violated:
//
//    • FORCE_MARKET_OPEN must be unset / falsy.
//      (Same applies to MOCK_MARKET_OPEN and BYPASS_MARKET_HOURS,
//       which are documented aliases — getMarketStatus() honours all
//       three so they all need to be off in production.)
//    • CANDLE_MAX_PER_CYCLE must be ≤ 100. Higher values defeat the
//      per-cycle cap that keeps the candle scheduler under quota.
//    • INDIANAPI_PER_RUN_LIMIT must be ≤ 500. Higher values let one
//      pipeline run blow through a daily 2500-call budget.
//
//  Outside production this is a no-op — dev / test environments need
//  the overrides to iterate.
// ════════════════════════════════════════════════════════════════

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isTruthy(v: string | undefined): boolean {
  return v != null && TRUTHY.has(v.trim().toLowerCase());
}

function readNumeric(envName: string): number | null {
  const raw = process.env[envName];
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface EnvSafetyViolation {
  envName: string;
  value:   string | undefined;
  rule:    string;
}

/** Pure check — returns the list of violations without throwing. Used
 *  by tests and the boot path's structured log line. */
export function checkProductionEnvSafety(): EnvSafetyViolation[] {
  const violations: EnvSafetyViolation[] = [];

  for (const name of ['FORCE_MARKET_OPEN', 'MOCK_MARKET_OPEN', 'BYPASS_MARKET_HOURS']) {
    if (isTruthy(process.env[name])) {
      violations.push({
        envName: name,
        value:   process.env[name],
        rule:    `${name} must be false/unset in production — overrides the market-hours gate and lets the pipeline burn quota off-hours`,
      });
    }
  }

  const maxPerCycle = readNumeric('CANDLE_MAX_PER_CYCLE');
  if (maxPerCycle != null && maxPerCycle > 100) {
    violations.push({
      envName: 'CANDLE_MAX_PER_CYCLE',
      value:   process.env.CANDLE_MAX_PER_CYCLE,
      rule:    'CANDLE_MAX_PER_CYCLE must be ≤ 100 in production — higher values defeat the per-cycle quota cap',
    });
  }

  const perRunLimit = readNumeric('INDIANAPI_PER_RUN_LIMIT');
  if (perRunLimit != null && perRunLimit > 500) {
    violations.push({
      envName: 'INDIANAPI_PER_RUN_LIMIT',
      value:   process.env.INDIANAPI_PER_RUN_LIMIT,
      rule:    'INDIANAPI_PER_RUN_LIMIT must be ≤ 500 in production — one run could otherwise exhaust the daily budget',
    });
  }

  return violations;
}

/** Boot-time enforcer. In production, throws if any invariant is
 *  violated. Outside production, logs the would-be violations as
 *  warnings but never throws. */
export function enforceProductionEnvSafety(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const violations = checkProductionEnvSafety();
  if (violations.length === 0) {
    console.log('[ENV SAFETY] production env passed all guardrails');
    return;
  }

  for (const v of violations) {
    console.error(
      `[ENV SAFETY VIOLATION] ${v.envName}=${v.value ?? '<unset>'} — ${v.rule}`,
    );
  }
  const summary = violations.map(v => v.envName).join(', ');
  throw new Error(
    `[ENV SAFETY] production boot blocked — ${violations.length} violation(s): ${summary}. ` +
    `Fix the offending env vars and restart. See [ENV SAFETY VIOLATION] log lines above for details.`,
  );
}
