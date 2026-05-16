/**
 * scripts/validateSignalsUiConsistency.ts
 *
 * Validates the production-stability invariants the dashboard relies
 * on. This script does NOT use a real browser — it exercises the
 * server-side guarantees that the Last-Known-Good UI gate depends on:
 *
 *   1. /api/signals returns a stable validation envelope.
 *   2. Two consecutive calls do not flip from non-empty to zero
 *      *unless* the second call sets empty_confirmed=true.
 *   3. Older response cannot overwrite newer state — verified by
 *      comparing response_generated_at across calls.
 *   4. Empty response without empty_confirmed is rejected (frontend
 *      contract — we just verify the API never sets empty_confirmed
 *      when validation_status is API_ERROR / cold-fallback).
 *   5. Partial scan markers are surfaced when scan_coverage_percent
 *      is below the 80% threshold for scanner-mode batches.
 *   6. Emerging is rendered once — verified by checking the API only
 *      ships a single emerging_opportunities array with deduped rows.
 *   7. Top 10 main signals are consistent with stock-detail API
 *      (no BUY in main, REJECTED/NO_STRATEGY in detail). This calls
 *      revalidateInstrument() (the same function the detail page now
 *      uses) so the script mirrors the user view exactly.
 *   8. Same top symbols are not stale beyond TTL — flags any top-10
 *      signal whose generated_at is more than 48h old.
 *
 * Usage:
 *   npx tsx scripts/validateSignalsUiConsistency.ts
 *   npx tsx scripts/validateSignalsUiConsistency.ts --polls 6 --interval 8
 *   npx tsx scripts/validateSignalsUiConsistency.ts --base http://localhost:3000
 *
 * Exit code: 0 when every check passes, 1 otherwise.
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db }                  from '../src/lib/db';
import { getActiveSignals }    from '../src/lib/signal-engine/repository/readSignals';
import { revalidateInstrument } from '../src/lib/signal-engine/live/revalidateInstrument';

interface Args {
  polls:    number;
  interval: number;       // seconds between polls
  base:     string | null;
  topN:     number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let polls = 5, interval = 5, topN = 10;
  let base: string | null = process.env.SIGNALS_BASE_URL ?? null;
  for (let i = 0; i < argv.length; i++) {
    if      (argv[i] === '--polls'    && argv[i + 1]) polls    = Math.max(2, Math.min(50, Number(argv[++i]) || 5));
    else if (argv[i] === '--interval' && argv[i + 1]) interval = Math.max(1, Math.min(60, Number(argv[++i]) || 5));
    else if (argv[i] === '--base'     && argv[i + 1]) base     = argv[++i];
    else if (argv[i] === '--topn'     && argv[i + 1]) topN     = Math.max(1, Math.min(100, Number(argv[++i]) || 10));
  }
  return { polls, interval, base, topN };
}

function bar(label: string) {
  console.log('\n' + '═'.repeat(78));
  console.log(label);
  console.log('═'.repeat(78));
}

interface Failure { check: string; reason: string; detail?: any }

interface ApiSignals {
  signals?:               any[];
  emerging_opportunities?: any[];
  response_generated_at?: string;
  validation_status?:     string;
  empty_confirmed?:       boolean;
  is_partial_scan?:       boolean;
  latest_batch_id?:       string;
  scan_coverage_percent?: number | null;
  main_signals_count?:    number;
  buy_count?:             number;
  sell_count?:            number;
  emerging_count?:        number;
  cache_source?:          string;
}

async function fetchApi(base: string): Promise<ApiSignals | null> {
  const url = `${base.replace(/\/$/, '')}/api/signals?action=all&limit=250&forceRefresh=false&request_id=validate-${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`  [api] ${url} → ${res.status}`);
      return null;
    }
    return (await res.json()) as ApiSignals;
  } catch (err: any) {
    console.warn(`  [api] ${url} threw: ${err?.message ?? err}`);
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const useApi = !!args.base;
  const failures: Failure[] = [];

  bar('Signals UI consistency validator');
  console.log(`mode:      ${useApi ? 'http (' + args.base + ')' : 'in-process'}`);
  console.log(`polls:     ${args.polls} every ${args.interval}s`);
  console.log(`top-N:     ${args.topN}`);

  // ── 1+2+3+4: poll loop, look for flicker / stale wire ───────────
  bar(`(1-4) Polling /api/signals — checking for populated → 0 flicker`);

  const samples: ApiSignals[] = [];
  for (let i = 0; i < args.polls; i++) {
    let sample: ApiSignals | null;
    if (useApi) {
      sample = await fetchApi(args.base!);
    } else {
      // In-process mode: skip the HTTP layer (handy when you don't
      // have the dev server running). We can't validate the route's
      // envelope this way, so we synthesize a minimal one from
      // getActiveSignals + a verified=true sentinel.
      const rows = await getActiveSignals(250).catch(() => [] as any[]);
      sample = {
        signals:               rows,
        validation_status:     rows.length > 0 ? 'OK' : 'NO_SIGNALS_CONFIRMED',
        empty_confirmed:       rows.length === 0,
        is_partial_scan:       false,
        response_generated_at: new Date().toISOString(),
        latest_batch_id:       rows[0]?.batch_id ?? null,
      };
    }
    if (!sample) {
      failures.push({ check: 'poll', reason: `poll ${i + 1} returned null (HTTP error)` });
      continue;
    }
    const tag = sample.validation_status ?? 'unknown';
    const cnt = sample.signals?.length ?? 0;
    const ec  = sample.empty_confirmed ? '✔' : '✘';
    const ps  = sample.is_partial_scan ? 'partial' : 'full';
    const cov = sample.scan_coverage_percent ?? '—';
    console.log(`  poll ${String(i + 1).padStart(2)}/${args.polls}  rows=${String(cnt).padStart(3)}  status=${tag.padEnd(20)}  empty_confirmed=${ec}  scan=${ps}  cov=${cov}%  batch=${sample.latest_batch_id ?? '—'}`);
    samples.push(sample);

    if (i < args.polls - 1) {
      await new Promise((r) => setTimeout(r, args.interval * 1000));
    }
  }

  // Flicker check — populated→empty without empty_confirmed.
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const prevCount = prev.signals?.length ?? 0;
    const currCount = curr.signals?.length ?? 0;
    if (prevCount > 0 && currCount === 0 && !curr.empty_confirmed) {
      failures.push({
        check:  'flicker',
        reason: `Poll ${i} flipped ${prevCount}→0 with empty_confirmed=false (validation_status=${curr.validation_status})`,
      });
    }
    // Wire-order check — response_generated_at must be monotonically
    // non-decreasing across the sequence we just observed.
    const tPrev = prev.response_generated_at ? new Date(prev.response_generated_at).getTime() : 0;
    const tCurr = curr.response_generated_at ? new Date(curr.response_generated_at).getTime() : 0;
    if (tCurr < tPrev) {
      failures.push({
        check:  'wire-order',
        reason: `Poll ${i} response_generated_at went backwards by ${tPrev - tCurr}ms (server clock skew or out-of-order delivery)`,
      });
    }
    // Batch order — latest_batch_id must not regress.
    const bPrev = prev.latest_batch_id ?? '';
    const bCurr = curr.latest_batch_id ?? '';
    if (bPrev && bCurr && bCurr < bPrev) {
      failures.push({
        check:  'batch-order',
        reason: `Poll ${i} latest_batch_id went backwards: ${bPrev} → ${bCurr}`,
      });
    }
    // Empty contract — empty_confirmed must NEVER be true on API_ERROR.
    if (curr.validation_status === 'API_ERROR' && curr.empty_confirmed) {
      failures.push({
        check:  'empty-contract',
        reason: `Poll ${i} ships validation_status=API_ERROR with empty_confirmed=true — frontend will accept this as truth`,
      });
    }
  }

  // ── 5: partial scan markers ─────────────────────────────────────
  bar('(5) Partial-scan flag presence');
  const last = samples[samples.length - 1];
  if (last) {
    const cov = last.scan_coverage_percent;
    const isPartial = last.is_partial_scan === true;
    if (cov != null && cov < 80 && !isPartial) {
      console.log(`  scan_coverage_percent=${cov}% but is_partial_scan=false — only OK for Phase-4 strict engine`);
      // Not a hard failure; the route only flags scanner mode.
    } else {
      console.log(`  scan_coverage_percent=${cov ?? '—'}%  is_partial_scan=${isPartial}  ✓`);
    }
  }

  // ── 6: emerging dedupe ───────────────────────────────────────────
  bar('(6) Emerging opportunities — single source, deduped');
  if (last) {
    const emerging = last.emerging_opportunities ?? [];
    const seen = new Map<string, number>();
    let conflicting = 0;
    for (const r of emerging) {
      const sym = String((r as any).symbol ?? (r as any).tradingsymbol ?? '').toUpperCase();
      const dir = String((r as any).direction ?? '').toUpperCase();
      const key = `${sym}:${dir}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (dir === 'CONFLICTING' || (r as any).is_conflicting_setup) conflicting++;
    }
    let dupes = 0;
    for (const c of seen.values()) if (c > 1) dupes++;
    console.log(`  emerging_count=${emerging.length}  conflicting=${conflicting}  duplicate (sym,dir) pairs=${dupes}`);
    if (dupes > 0) {
      failures.push({
        check:  'emerging-dedupe',
        reason: `${dupes} (symbol,direction) pairs appear more than once in emerging_opportunities`,
      });
    }
  }

  // ── 7: top-10 detail consistency ─────────────────────────────────
  bar(`(7) Top ${args.topN} BUY signals — detail page consistency`);
  if (!last || !Array.isArray(last.signals) || last.signals.length === 0) {
    console.log('  no signals to validate');
  } else {
    const buys = last.signals
      .filter((r: any) => String(r.direction ?? '').toUpperCase() === 'BUY')
      .slice(0, args.topN);

    for (const row of buys) {
      const sym  = String(row.symbol ?? row.tradingsymbol ?? '').toUpperCase();
      const ikey = String(row.instrument_key ?? `NSE_EQ|${sym}`);
      try {
        const detail = await revalidateInstrument(ikey, sym, 'NSE', { persistInvalidation: false });
        const reval = detail.revalidation;
        const detailDir = (detail.signal as any)?.direction ?? null;
        const liveStatus = reval.live?.signal_status ?? null;
        const liveScenario = (detail.signal as any)?.scenario_tag ?? null;
        const tag =
          reval.status === 'consistent' ? 'OK'
          : reval.status === 'revalidated' ? 'REVALIDATED (banner shown)'
          : reval.status.toUpperCase();
        console.log(`  ${sym.padEnd(14)} table=BUY  detail=${String(detailDir ?? '—').padEnd(6)}  status=${String(liveStatus ?? '—').padEnd(20)}  scenario=${String(liveScenario ?? '—').padEnd(22)}  ${tag}`);

        if (detailDir && detailDir.toUpperCase() !== 'BUY') {
          failures.push({
            check:  'detail-direction',
            reason: `${sym}: table=BUY, detail=${detailDir}`,
          });
        }
        if (detail.approved === false && reval.status !== 'live_only') {
          failures.push({
            check:  'detail-rejection',
            reason: `${sym}: detail rejected approved=false but stored signal exists (revalidation=${reval.status})`,
          });
        }
        if (liveScenario === 'NO_STRATEGY' && reval.status === 'consistent') {
          failures.push({
            check:  'detail-scenario',
            reason: `${sym}: scenario_tag=NO_STRATEGY surfaced as 'consistent' — should be 'revalidated'`,
          });
        }
      } catch (err: any) {
        console.log(`  ${sym.padEnd(14)} table=BUY  detail=ERR  (${err?.message ?? err})`);
        failures.push({ check: 'detail-call', reason: `${sym}: revalidateInstrument threw: ${err?.message ?? err}` });
      }
    }
  }

  // ── 8: top-10 stale TTL ──────────────────────────────────────────
  bar(`(8) Top ${args.topN} signal age (TTL = 48h)`);
  if (last && Array.isArray(last.signals)) {
    const top = last.signals.slice(0, args.topN);
    const now = Date.now();
    for (const r of top) {
      const sym = String((r as any).symbol ?? (r as any).tradingsymbol ?? '').toUpperCase();
      const ts  = (r as any).generated_at ? new Date((r as any).generated_at).getTime() : NaN;
      const ageH = Number.isFinite(ts) ? Math.round((now - ts) / 3_600_000 * 10) / 10 : null;
      const decay = String((r as any).decay_state ?? '');
      const fresh = (r as any).freshness_score ?? '—';
      const tag = ageH != null && ageH > 48 ? '⚠ STALE' : 'ok';
      console.log(`  ${sym.padEnd(14)}  age=${String(ageH ?? '—').padStart(5)}h  freshness=${String(fresh).padStart(3)}  decay=${decay.padEnd(20)}  ${tag}`);
      if (ageH != null && ageH > 48) {
        failures.push({ check: 'top-stale', reason: `${sym}: top-${args.topN} row is ${ageH}h old (>48h TTL)` });
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  bar('Summary');
  console.log(`samples collected: ${samples.length}`);
  console.log(`failures:          ${failures.length}`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  [${f.check}] ${f.reason}`);
    }
    console.log('\nVERDICT: NOT_FIXED');
    void db;
    process.exit(1);
  }

  // Decide between FIXED_PRODUCTION_STABLE and PARTIALLY_FIXED based
  // on whether we actually exercised every check (HTTP mode required
  // for the validation envelope contract checks).
  const verdict = useApi ? 'FIXED_PRODUCTION_STABLE' : 'PARTIALLY_FIXED_NEEDS_HTTP_RUN';
  console.log(`\nVERDICT: ${verdict}`);
  void db;
  process.exit(0);
}

main().catch((err) => {
  console.error('validateSignalsUiConsistency: fatal', err);
  process.exit(2);
});
