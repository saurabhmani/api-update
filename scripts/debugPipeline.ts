/**
 * scripts/debugPipeline.ts
 *
 * Spec "BUILD DEBUG SCRIPT" — for the first 10 NIFTY 500 symbols,
 * probe each candle source independently and print a row-per-symbol
 * comparison so an operator can answer:
 *
 *   - Which sources are returning data right now?
 *   - How many bars per source?
 *   - What's the latency budget of each?
 *   - When a source fails, what's the reason?
 *
 * The script does NOT use the production fallback chain — it
 * deliberately calls each provider in isolation so the operator
 * sees raw per-source health, not the masked "first one that worked"
 * result. Use `npm run debug:pipeline` (or `npx tsx scripts/debugPipeline.ts`).
 *
 * Output:
 *
 *   [SYMBOL] RELIANCE
 *     indianapi: ok=true  bars=251 latency=842ms
 *     nse:       ok=false reason="DISABLED" latency=0ms
 *     db:        ok=true  bars=247 latency=4ms
 *     winner:    indianapi
 *
 * Final summary lists per-source success counts and the worst-case
 * latency.
 *
 * Exit codes:
 *   0 — every probed symbol had ≥1 source returning bars.
 *   1 — at least one symbol had ZERO sources working.
 *   2 — script error (env / DB connection).
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import {
  getNifty500Symbols,
  initNifty500UniverseFromDb,
  isNifty500Initialized,
} from '../src/lib/marketData/nifty500Universe';
import { getHistorical as getIndianApiHistorical } from '../src/lib/marketData/providers/indianApiProvider';
import {
  fetchNseHistoricalCandles,
  getNseHistoricalState,
} from '../src/lib/marketData/providers/nseHistoricalProvider';

const DEFAULT_LIMIT = 10;
const LIMIT = (() => {
  const raw = Number(process.env.DEBUG_PIPELINE_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(50, Math.floor(raw));
})();

interface SourceResult {
  ok:        boolean;
  bars:      number;
  latencyMs: number;
  reason?:   string;
  latestTs?: string | null;
}

async function probeIndianApi(symbol: string): Promise<SourceResult> {
  const t0 = Date.now();
  try {
    const inv = await getIndianApiHistorical(symbol, '1y');
    const latency = Date.now() - t0;
    if (inv.status !== 'success' || !inv.data) {
      return {
        ok: false,
        bars: 0,
        latencyMs: latency,
        reason: inv.errorCode ?? `status:${inv.status}`,
      };
    }
    const candles = inv.data.candles ?? [];
    const last = candles[candles.length - 1];
    return {
      ok: candles.length > 0,
      bars: candles.length,
      latencyMs: latency,
      latestTs: last ? new Date(last.t).toISOString() : null,
    };
  } catch (err) {
    return {
      ok: false,
      bars: 0,
      latencyMs: Date.now() - t0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeNse(symbol: string): Promise<SourceResult> {
  const r = await fetchNseHistoricalCandles(symbol);
  const last = r.candles[r.candles.length - 1];
  return {
    ok: r.ok,
    bars: r.candles.length,
    latencyMs: r.latencyMs,
    reason: r.ok ? undefined : (r.errorCode ?? 'unknown'),
    latestTs: last ? new Date(last.ts as any).toISOString() : null,
  };
}

async function probeDb(symbol: string): Promise<SourceResult> {
  const t0 = Date.now();
  try {
    const result = await db.query(
      `SELECT ts, open, high, low, close, volume FROM (
         SELECT ts, open, high, low, close, volume
         FROM market_data_daily
         WHERE symbol = ?
         ORDER BY ts DESC
         LIMIT 300
       ) t ORDER BY ts ASC`,
      [symbol],
    );
    const rows = result.rows as any[];
    const last = rows[rows.length - 1];
    return {
      ok: rows.length > 0,
      bars: rows.length,
      latencyMs: Date.now() - t0,
      latestTs: last ? new Date(last.ts).toISOString() : null,
    };
  } catch (err) {
    return {
      ok: false,
      bars: 0,
      latencyMs: Date.now() - t0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function pickWinner(r: { indianapi: SourceResult; nse: SourceResult; db: SourceResult }): string {
  if (r.indianapi.ok) return 'indianapi';
  if (r.nse.ok)       return 'nse';
  if (r.db.ok)        return 'db';
  return 'NONE';
}

function fmtSource(label: string, r: SourceResult): string {
  if (r.ok) {
    return `    ${label.padEnd(10)} ok=true  bars=${String(r.bars).padStart(3)} ` +
           `latency=${r.latencyMs}ms latest=${r.latestTs ?? 'n/a'}`;
  }
  return `    ${label.padEnd(10)} ok=false reason="${r.reason ?? 'n/a'}" ` +
         `latency=${r.latencyMs}ms`;
}

async function main(): Promise<number> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  DEBUG PIPELINE — per-source candle probe');
  console.log('═══════════════════════════════════════════════════════════════════');

  // Load NIFTY 500 universe.
  if (!isNifty500Initialized()) {
    console.log('Loading NIFTY 500 universe from DB...');
    await initNifty500UniverseFromDb();
  }
  const all = getNifty500Symbols();
  if (all.length === 0) {
    console.error('✗ NIFTY 500 universe is empty — populate `instruments` and re-run.');
    return 2;
  }
  const symbols = all.slice(0, LIMIT);
  console.log(`Probing first ${symbols.length} symbols (universe size=${all.length}):`);
  console.log(symbols.join(', '));
  console.log();

  // Print NSE provider state up front so the operator knows whether
  // [NSE FETCH FAIL] reasons are configuration or upstream.
  const nseState = getNseHistoricalState();
  console.log('NSE Historical Provider state:', nseState);
  console.log();

  const summary = {
    indianapi: { ok: 0, fail: 0, total_latency_ms: 0, max_latency_ms: 0 },
    nse:       { ok: 0, fail: 0, total_latency_ms: 0, max_latency_ms: 0 },
    db:        { ok: 0, fail: 0, total_latency_ms: 0, max_latency_ms: 0 },
    winners:   {} as Record<string, number>,
  };
  let symbolsWithNoSource = 0;

  for (const symbol of symbols) {
    // Probe sources sequentially: NSE has a min-gap rate limit and
    // IndianAPI has a budget — running them in parallel would
    // confuse the latency numbers.
    const indianapi = await probeIndianApi(symbol);
    const nse       = await probeNse(symbol);
    const dbR       = await probeDb(symbol);
    const result = { indianapi, nse, db: dbR };

    console.log(`[SYMBOL] ${symbol}`);
    console.log(fmtSource('indianapi:', indianapi));
    console.log(fmtSource('nse:',       nse));
    console.log(fmtSource('db:',        dbR));
    const winner = pickWinner(result);
    console.log(`    winner:    ${winner}`);
    console.log();

    // Roll up summary numbers.
    for (const [k, r] of Object.entries(result) as [keyof typeof result, SourceResult][]) {
      const bucket = summary[k];
      if (r.ok) bucket.ok++;
      else bucket.fail++;
      bucket.total_latency_ms += r.latencyMs;
      bucket.max_latency_ms    = Math.max(bucket.max_latency_ms, r.latencyMs);
    }
    summary.winners[winner] = (summary.winners[winner] ?? 0) + 1;
    if (winner === 'NONE') symbolsWithNoSource++;
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');
  for (const k of ['indianapi', 'nse', 'db'] as const) {
    const b = summary[k];
    const avgLat = symbols.length > 0 ? Math.round(b.total_latency_ms / symbols.length) : 0;
    console.log(
      `  ${k.padEnd(10)} ok=${b.ok}/${symbols.length} ` +
      `fail=${b.fail} avg_latency=${avgLat}ms max_latency=${b.max_latency_ms}ms`,
    );
  }
  console.log(`  winners:    ${JSON.stringify(summary.winners)}`);
  console.log(`  symbols_with_NO_source: ${symbolsWithNoSource}`);
  console.log();

  if (symbolsWithNoSource > 0) {
    console.error(
      `✗ ${symbolsWithNoSource}/${symbols.length} symbol(s) had ZERO sources returning data. ` +
      `Phase 3 will reject these symbols at the candle gate.`,
    );
    return 1;
  }
  console.log(
    `✓ All ${symbols.length} symbols had at least one source returning data. ` +
    `Pipeline candle inputs are healthy.`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('debug:pipeline crashed:', err);
    process.exit(2);
  });
