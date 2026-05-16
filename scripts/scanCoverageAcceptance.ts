/**
 * scripts/scanCoverageAcceptance.ts
 *
 * Acceptance test for the resilient 500-symbol scan runner.
 *
 * Reproduces the operator's failure mode (sequential await loop hits
 * provider hangs / rate limits → 31/500 coverage) and verifies the
 * new runner achieves ≥ 95 % coverage in under 2 minutes against a
 * provider that:
 *   • times out on ~5 % of symbols
 *   • returns a hard error on ~3 % of symbols
 *   • is slow on the rest (50–250ms latency, with occasional 1s spikes)
 *
 * Exits non-zero on any acceptance failure so it's safe to wire into CI.
 *
 * Run:
 *   npx tsx scripts/scanCoverageAcceptance.ts
 */

import {
  runResilientScan,
  type SymbolTask,
} from '../src/lib/signal-engine/scanRunner/resilientScanRunner';

// ── Universe ────────────────────────────────────────────────────

const TOTAL = 500;
function buildUniverse(): string[] {
  return Array.from({ length: TOTAL }, (_, i) => `SYM${String(i + 1).padStart(4, '0')}`);
}

// ── Synthetic provider behaviour ───────────────────────────────

interface ProviderProfile {
  name:               string;
  /** Probability the provider hangs (>2s) on a given symbol. */
  hangProbability:    number;
  /** Probability the provider returns a hard error. */
  errorProbability:   number;
  /** Mean latency (ms) on success. */
  meanLatencyMs:      number;
  /** ±jitter around the mean. */
  jitterMs:           number;
}

const PRIMARY: ProviderProfile = {
  name: 'primary', hangProbability: 0.05, errorProbability: 0.03,
  meanLatencyMs: 80, jitterMs: 60,
};
const SECONDARY: ProviderProfile = {
  name: 'secondary', hangProbability: 0.01, errorProbability: 0.01,
  meanLatencyMs: 120, jitterMs: 80,
};

// Deterministic-per-(symbol, attempt) RNG so the test is repeatable.
function rng(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return (h >>> 0) / 0xFFFFFFFF;
}

function jitterLatency(profile: ProviderProfile, key: string): number {
  const u = rng(`lat:${profile.name}:${key}`);
  const drift = (u - 0.5) * 2 * profile.jitterMs;
  return Math.max(20, Math.round(profile.meanLatencyMs + drift));
}

function shouldHang(profile: ProviderProfile, key: string): boolean {
  return rng(`hang:${profile.name}:${key}`) < profile.hangProbability;
}

function shouldError(profile: ProviderProfile, key: string): boolean {
  return rng(`err:${profile.name}:${key}`) < profile.errorProbability;
}

function profileFor(provider: string): ProviderProfile {
  return provider === 'secondary' ? SECONDARY : PRIMARY;
}

// ── Per-symbol task ────────────────────────────────────────────

interface CandleBundle {
  symbol:     string;
  candles:    number;
  provider:   string;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('TIMEOUT'));
    }, { once: true });
  });
}

const task: SymbolTask<CandleBundle> = async (ctx) => {
  const profile = profileFor(ctx.provider);
  const key     = `${ctx.symbol}:${ctx.attempt}`;
  const baseLatency = jitterLatency(profile, key);

  // 1. Simulated hang — way past per-symbol timeout. Runner aborts via signal.
  if (shouldHang(profile, key)) {
    try {
      await delay(10_000, ctx.signal);
    } catch {
      throw new Error('TIMEOUT');
    }
    return { ok: false, code: 'TIMEOUT', message: 'provider hung' };
  }

  // 2. Simulated hard error.
  if (shouldError(profile, key)) {
    try { await delay(baseLatency, ctx.signal); } catch { return { ok: false, code: 'TIMEOUT', message: 'aborted' }; }
    return { ok: false, code: 'PROVIDER_ERROR', message: `${profile.name}: synthetic 5xx` };
  }

  // 3. Normal success.
  try {
    await delay(baseLatency, ctx.signal);
  } catch {
    return { ok: false, code: 'TIMEOUT', message: 'aborted during fetch' };
  }
  return {
    ok: true,
    data: { symbol: ctx.symbol, candles: 200, provider: ctx.provider },
  };
};

// ── Run ─────────────────────────────────────────────────────────

async function main() {
  const universe = buildUniverse();

  console.log('='.repeat(110));
  console.log('SCAN COVERAGE ACCEPTANCE — Resilient 500-symbol scan');
  console.log('='.repeat(110));
  console.log(`Universe: ${universe.length}   primary={hang=${PRIMARY.hangProbability}, err=${PRIMARY.errorProbability}}   secondary={hang=${SECONDARY.hangProbability}, err=${SECONDARY.errorProbability}}`);
  console.log('');

  const startedAt = Date.now();
  const report = await runResilientScan<CandleBundle>({
    symbols: universe,
    task,
    config: {
      concurrency:        24,
      perSymbolTimeoutMs: 1_500,
      maxRetries:         2,
      backoffBaseMs:      100,
      providers:          ['primary', 'secondary'],
      progressEveryN:     50,
    },
  });
  const elapsed = Date.now() - startedAt;

  console.log('');
  console.log('-'.repeat(110));
  console.log('ACCEPTANCE METRICS');
  console.log('  coverage_percent : ' + report.coveragePercent + '%');
  console.log('  scan_duration    : ' + (elapsed / 1000).toFixed(2) + 's (run report: ' +
              (report.durationMs / 1000).toFixed(2) + 's)');
  console.log('  success_count    : ' + report.succeeded);
  console.log('  failure_count    : ' + report.failed);
  console.log('  timeout_count    : ' + report.timeoutCount);
  console.log('  retry_count      : ' + report.retryCount);
  console.log('  avg_latency_ms   : ' + report.avgLatencyMs);
  console.log('');
  console.log('  provider_breakdown:');
  for (const p of report.providerHealth) {
    console.log(
      `    ${p.provider.padEnd(10)} attempts=${String(p.attempts).padStart(4)} ` +
      `success=${String(p.successes).padStart(4)} failed=${String(p.failures).padStart(3)} ` +
      `timeout=${String(p.timeouts).padStart(3)} avg_ms=${String(p.avgLatencyMs).padStart(4)} ` +
      `failure_rate=${(p.failureRate * 100).toFixed(1)}% unhealthy=${p.unhealthy}`,
    );
  }
  console.log('');

  // ── Acceptance assertions ──────────────────────────────────
  let failed = false;

  // ≥ 95 % coverage
  if (report.coveragePercent < 95.0) {
    console.log(`  ❌ coverage ${report.coveragePercent}% < 95 % threshold`);
    failed = true;
  } else {
    console.log(`  ✅ coverage ${report.coveragePercent}% ≥ 95 %`);
  }

  // < 2 minutes
  if (elapsed > 120_000) {
    console.log(`  ❌ scan_duration ${(elapsed / 1000).toFixed(2)}s > 120s budget`);
    failed = true;
  } else {
    console.log(`  ✅ scan_duration ${(elapsed / 1000).toFixed(2)}s ≤ 120s budget`);
  }

  // No silent abort — every symbol got at least one attempt
  if (report.scanned !== report.totalSymbols) {
    console.log(`  ❌ partial scan: scanned=${report.scanned} of ${report.totalSymbols}`);
    failed = true;
  } else {
    console.log(`  ✅ every symbol attempted (${report.scanned}/${report.totalSymbols})`);
  }

  // Failed symbols got retried separately (retry_count > timeout_count
  // because retry attempts include hard errors, not just timeouts)
  if (report.failed > 0 && report.retryCount === 0) {
    console.log(`  ❌ failures observed (${report.failed}) but retry_count=0 — retry path inactive`);
    failed = true;
  } else {
    console.log(`  ✅ retry path active (${report.retryCount} retry attempts across ${report.failed} ultimate failures)`);
  }

  // Provider fallback exercised (secondary attempts > 0)
  const sec = report.providerHealth.find((p) => p.provider === 'secondary');
  if (!sec || sec.attempts === 0) {
    console.log('  ⚠️  secondary provider never used — fallback path untested');
  } else {
    console.log(`  ✅ secondary provider used (${sec.attempts} attempts)`);
  }

  console.log('');
  if (failed) {
    console.log('RESULT: ❌ FAIL');
    process.exit(1);
  }
  console.log('RESULT: ✅ PASS — resilient scanner meets institutional coverage targets.');
}

main().catch((err) => {
  // Top-level fatal — should never happen because the runner never throws,
  // but guard so CI sees the actual stack.
  // eslint-disable-next-line no-console
  console.error('FATAL', err);
  process.exit(2);
});
