/// <reference types="node" />
/**
 * scripts/validateScannerSmokeTest.ts
 *
 * Smoke test for the custom-universe Yahoo scanner. Runs against a
 * small fixed list of large/mid-cap NSE names and prints a per-symbol
 * audit table plus a static check that /api/signals no longer
 * contains an in-route pipeline trigger.
 *
 * Usage
 *   npx tsx scripts/validateScannerSmokeTest.ts
 *   npx tsx scripts/validateScannerSmokeTest.ts --persist     # write to q365_signals
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { runCustomUniverseScan, type ScannerOutcome } from '../src/lib/scanner/customUniverseBatchScanner';

const SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'NLCINDIA', 'BEL', 'SUZLON', 'TATAMOTORS',
];

const persistFlag = process.argv.includes('--persist');

// ── ASCII table renderer ─────────────────────────────────────────
type Row = Record<string, string>;
function renderTable(headers: string[], rows: Row[]): string {
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => (r[h] ?? '').length)),
  );
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmtRow = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const out: string[] = [];
  out.push(sep);
  out.push(fmtRow(headers));
  out.push(sep);
  for (const r of rows) out.push(fmtRow(headers.map((h) => r[h] ?? '')));
  out.push(sep);
  return out.join('\n');
}

function fmtScore(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}
function fmtRR(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function preFilterCell(o: ScannerOutcome): string {
  if (o.status === 'fetch_failed')      return `fetch_failed (${o.fetchError ?? '—'})`;
  if (o.status === 'pre_rejected')      return 'rejected: ' + (o.preFilterReasons?.join('; ').slice(0, 60) ?? '');
  return 'PASSED';
}
function rejectionCell(o: ScannerOutcome): string {
  const parts: string[] = [];
  if (o.preFilterReasons?.length)  parts.push(...o.preFilterReasons);
  if (o.indicatorWarnings?.length) parts.push(...o.indicatorWarnings);
  if (o.noDirectionReason)         parts.push(o.noDirectionReason);
  if (o.hardRejects?.length)       parts.push(...o.hardRejects.map((c) => `scanner:${c}`));
  if (o.rejectionCodes?.length)    parts.push(...o.rejectionCodes.map((c) => `engine:${c}`));
  if (o.fetchError)                parts.push(`fetch:${o.fetchError}`);
  return parts.length === 0 ? '—' : parts.join('; ').slice(0, 70);
}

function buildRow(o: ScannerOutcome): Row {
  return {
    symbol:         o.symbol,
    candles:        String(o.candlesCount ?? '—'),
    pre_filter:     preFilterCell(o),
    strategy:       o.strategy ?? '—',
    final_score:    fmtScore(o.finalScore),
    classification: o.classification ?? '—',
    risk_reward:    fmtRR(o.riskRewardRatio),
    decision:       o.decision ?? o.status,
    rejection_reasons: rejectionCell(o),
  };
}

// ── /api/signals static verification ─────────────────────────────
function verifyApiSignalsHasNoScan(): { ok: boolean; details: string } {
  const routePath = path.resolve(process.cwd(), 'src/app/api/signals/route.ts');
  if (!fs.existsSync(routePath)) {
    return { ok: false, details: `route file missing: ${routePath}` };
  }
  const src = fs.readFileSync(routePath, 'utf8');

  // Strip single-line comments before scanning so doc references in
  // comments (e.g. "see /api/signal-engine for generatePhase4Signals")
  // don't false-positive. The active code uses `//` exclusively, so
  // line-level stripping is sufficient.
  const codeOnly = src
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      // Keep the line if there's no `//`, or naively keep prefix.
      // (We don't try to handle `//` inside strings — there are none in this file.)
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');

  const forbidden = ['generatePhase4Signals', 'checkCandleFreshness', '__signalsPipelineInFlight'];
  const found = forbidden.filter((s) => codeOnly.includes(s));
  if (found.length > 0) {
    return { ok: false, details: `forbidden symbol(s) still present in active code: ${found.join(', ')}` };
  }
  const hasMarker = src.includes('forceRefresh=true — ignored');
  return {
    ok: hasMarker,
    details: hasMarker
      ? 'forceRefresh is a no-op; no in-route pipeline trigger; no candle-freshness probe.'
      : 'no-op marker missing — manual review needed',
  };
}

// ── Main ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`# scanner smoke test — ${SYMBOLS.length} symbols`);
  console.log(`symbols: ${SYMBOLS.join(', ')}`);
  console.log(`persist:  ${persistFlag}`);

  // Write a temp universe file so the regular loader runs end-to-end.
  const tempPath = path.join(os.tmpdir(), `scanner-smoke-${Date.now()}.txt`);
  fs.writeFileSync(tempPath, '# smoke-test universe\n' + SYMBOLS.join('\n') + '\n', 'utf8');
  console.log(`tempUniverse: ${tempPath}`);

  const t0 = Date.now();
  const result = await runCustomUniverseScan({
    filePath:        tempPath,
    concurrency:     5,
    range:           '6mo',
    dryRun:          !persistFlag,
    perSymbolDelayMs: 50,
  });
  const elapsed = Date.now() - t0;

  fs.unlinkSync(tempPath);

  // ── Per-symbol table ───────────────────────────────────────────
  const headers = [
    'symbol', 'candles', 'pre_filter', 'strategy',
    'final_score', 'classification', 'risk_reward',
    'decision', 'rejection_reasons',
  ];
  const rows = result.outcomes.map(buildRow);
  console.log('\n' + renderTable(headers, rows));

  // ── Summary ────────────────────────────────────────────────────
  const s = result.summary;
  console.log('\n# summary');
  console.log(
    `total=${s.totalSymbols}  fetched=${s.fetched}  failed=${s.failed}  ` +
    `preFiltered=${s.preFiltered}  preRejected=${s.preRejected}  ` +
    `scored=${s.scored}  approved=${s.approved}  watchlist=${s.watchlist}  ` +
    `rejected=${s.rejected}  noDirection=${s.noDirection}  insufficient=${s.insufficient}`,
  );
  console.log(`durationMs=${s.durationMs}  total_wall=${elapsed}ms  batchId=${s.batchId}`);

  // ── /api/signals static check ──────────────────────────────────
  const apiCheck = verifyApiSignalsHasNoScan();
  console.log('\n# /api/signals refresh check');
  console.log(`status: ${apiCheck.ok ? 'PASS' : 'FAIL'}`);
  console.log(`detail: ${apiCheck.details}`);

  // ── Exit code ──────────────────────────────────────────────────
  // PASS criteria for the smoke test:
  //   • at least one symbol fetched successfully
  //   • /api/signals no-scan check passes
  // (We do NOT fail the test on rejections — that's the engine
  //  doing its job, not a regression.)
  const fetchOk = s.fetched > 0;
  const passed  = fetchOk && apiCheck.ok;
  console.log('\n# verdict');
  console.log(passed ? 'SMOKE TEST PASSED' : 'SMOKE TEST FAILED');
  process.exit(passed ? 0 : 2);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
