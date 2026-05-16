// ════════════════════════════════════════════════════════════════
//  verifyScanCoverage — one-shot diagnostic for the spec
//  "is the full NSE stock list actually being scanned?"
//
//  Probes every link in the pipeline and prints a single spec-shape
//  report:
//
//    Step 1:  read nse_stocks_list.xlsx  → total_rows, unique symbols
//    Step 2:  read baked nseUniverse.json → cold-boot symbol count
//    Step 3:  read q365_universe (DB)    → active scan input under
//                                          UNIVERSE_MODE=NIFTY500
//    Step 4:  read latest scan batch in q365_signals → scanned size,
//                                                       insert lag,
//                                                       generation_source
//    Step 5:  count strict + relaxed candidates in q365_signals using
//             the same SQL the closed-market loader uses
//    Step 6:  read scanner-last-summary.json on disk for the last
//             custom-universe scan completion
//    Step 7:  compute scan_status: FULL / PARTIAL / FAILED and print
//             the SCAN_WORKING ✅ / SCAN_BROKEN ❌ verdict
//
//  Run with:
//    npx tsx scripts/verifyScanCoverage.ts
//    npx tsx scripts/verifyScanCoverage.ts --excel "C:\path\to\nse_stocks_list.xlsx"
//    npx tsx scripts/verifyScanCoverage.ts --json   # machine-readable
//
//  No upstream API calls. Pure DB + filesystem reads.
// ════════════════════════════════════════════════════════════════

/* eslint-disable no-console */
import * as XLSX from 'xlsx';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { db } from '@/lib/db';
import {
  STRICT_CONFIDENCE_FLOOR,
  STRICT_FINAL_FLOOR,
  STRICT_RR_FLOOR,
} from '@/lib/signals/confirmedSignalPolicy';

const argv = process.argv.slice(2);
const argFlag = (name: string): string | null => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return null;
};
const JSON_OUT = argv.includes('--json');

// ── 1. Excel ────────────────────────────────────────────────────

interface ExcelReport {
  path:           string;
  exists:         boolean;
  total_rows:     number;
  unique_symbols: number;
  inav_skipped:   number;
  blank_rows:     number;
  duplicates:     number;
  first_5:        string[];
  last_5:         string[];
}

function readExcel(): ExcelReport {
  const candidates = [
    argFlag('excel'),
    resolve(process.cwd(), 'nse_stocks_list.xlsx'),
    'C:\\Users\\pranj\\Downloads\\nse_stocks_list.xlsx',
  ].filter(Boolean) as string[];

  const path = candidates.find((p) => p && existsSync(p));
  if (!path) {
    return {
      path: candidates[0] ?? '(none)',
      exists: false,
      total_rows: 0, unique_symbols: 0, inav_skipped: 0, blank_rows: 0, duplicates: 0,
      first_5: [], last_5: [],
    };
  }

  const wb = XLSX.readFile(path);
  // Try the named sheet first; fall back to the first sheet.
  const sheetName = wb.SheetNames.includes('NSE_STOCKS') ? 'NSE_STOCKS' : wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });

  // Resolve the symbol column. The buildNseUniverse script uses
  // 'Trading Symbol'; tolerate a few common alternates.
  const symbolKey =
    rows.length > 0
      ? (['Trading Symbol', 'Symbol', 'TRADINGSYMBOL', 'tradingsymbol', 'symbol']
          .find((k) => Object.prototype.hasOwnProperty.call(rows[0], k))
          ?? Object.keys(rows[0])[0])
      : 'Trading Symbol';

  const seen = new Set<string>();
  const symbols: string[] = [];
  let blank = 0;
  let dup = 0;
  let inav = 0;
  for (const r of rows) {
    const raw = r[symbolKey];
    if (raw == null) { blank += 1; continue; }
    const sym = String(raw).trim().toUpperCase();
    if (!sym) { blank += 1; continue; }
    if (/INAV$/.test(sym)) { inav += 1; continue; }
    if (seen.has(sym))      { dup  += 1; continue; }
    seen.add(sym);
    symbols.push(sym);
  }

  return {
    path,
    exists: true,
    total_rows:     rows.length,
    unique_symbols: symbols.length,
    inav_skipped:   inav,
    blank_rows:     blank,
    duplicates:     dup,
    first_5:        symbols.slice(0, 5),
    last_5:         symbols.slice(-5),
  };
}

// ── 2. Baked nseUniverse.json ──────────────────────────────────

interface BakedReport {
  path:    string;
  exists:  boolean;
  count:   number;
  source:  string | null;
}

function readBaked(): BakedReport {
  const path = resolve(process.cwd(), 'src/lib/signal-engine/constants/nseUniverse.json');
  if (!existsSync(path)) {
    return { path, exists: false, count: 0, source: null };
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as { count?: number; symbols?: string[]; source?: string };
  return {
    path,
    exists: true,
    count: Number(parsed.count ?? parsed.symbols?.length ?? 0),
    source: parsed.source ?? null,
  };
}

// ── 3. q365_universe (DB) ──────────────────────────────────────

interface UniverseReport {
  ok:           boolean;
  active_count: number;
  total_count:  number;
  error:        string | null;
}

async function readQ365Universe(): Promise<UniverseReport> {
  try {
    const { rows } = await db.query<{ active: number; total: number }>(
      `SELECT
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
         COUNT(*)                                       AS total
         FROM q365_universe`,
    );
    const r = (rows as Array<{ active: number; total: number }>)[0];
    return {
      ok: true,
      active_count: Number(r?.active ?? 0),
      total_count:  Number(r?.total  ?? 0),
      error: null,
    };
  } catch (err) {
    return {
      ok: false, active_count: 0, total_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── 4. Latest scan batch (q365_signals) ────────────────────────

interface BatchReport {
  ok:                 boolean;
  latest_batch_id:    string | null;
  latest_generated:   string | null;
  rows_in_batch:      number;
  generation_source:  string | null;
  ageMinutes:         number | null;
  buy_count:          number;
  sell_count:         number;
  error:              string | null;
}

async function readLatestBatch(): Promise<BatchReport> {
  try {
    const { rows: batchRow } = await db.query<{
      batch_id: string | null; generation_source: string | null;
      generated_at: Date | string;
    }>(
      `SELECT batch_id, generation_source, generated_at
         FROM q365_signals
        WHERE batch_id IS NOT NULL
        ORDER BY generated_at DESC
        LIMIT 1`,
    );
    const head = (batchRow as Array<{ batch_id: string | null; generation_source: string | null; generated_at: Date | string }>)[0];
    if (!head?.batch_id) {
      return {
        ok: true, latest_batch_id: null, latest_generated: null, rows_in_batch: 0,
        generation_source: null, ageMinutes: null, buy_count: 0, sell_count: 0, error: null,
      };
    }
    const { rows } = await db.query<{ direction: string; c: number }>(
      `SELECT direction, COUNT(*) AS c
         FROM q365_signals
        WHERE batch_id = ?
        GROUP BY direction`,
      [head.batch_id],
    );
    let buy = 0, sell = 0;
    for (const r of rows as Array<{ direction: string; c: number }>) {
      if (String(r.direction).toUpperCase() === 'BUY')  buy  = Number(r.c);
      if (String(r.direction).toUpperCase() === 'SELL') sell = Number(r.c);
    }
    const generatedTs = head.generated_at instanceof Date
      ? head.generated_at.getTime()
      : Date.parse(String(head.generated_at).replace(' ', 'T'));
    return {
      ok: true,
      latest_batch_id:   head.batch_id,
      latest_generated:  new Date(generatedTs).toISOString(),
      rows_in_batch:     buy + sell,
      generation_source: head.generation_source,
      ageMinutes:        Number.isFinite(generatedTs)
                            ? Math.round((Date.now() - generatedTs) / 60_000) : null,
      buy_count:         buy,
      sell_count:        sell,
      error:             null,
    };
  } catch (err) {
    return {
      ok: false, latest_batch_id: null, latest_generated: null, rows_in_batch: 0,
      generation_source: null, ageMinutes: null, buy_count: 0, sell_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── 5. Filter breakdown ────────────────────────────────────────

interface FilterReport {
  ok:              boolean;
  candidates:      number;       // any active row, regardless of floor
  strict_passed:   number;       // 70/75/1.5 + APPROVED_SIGNAL + classification
  relaxed_passed:  number;       // 60/65/1.2 + APPROVED_SIGNAL/DEVELOPING_SETUP
  force_seed_rows: number;       // belt-and-braces — should be 0
  error:           string | null;
}

async function readFilterBreakdown(): Promise<FilterReport> {
  try {
    const candidates = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE direction IN ('BUY','SELL')
          AND COALESCE(invalidation_reason,'') = ''
          AND UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')`,
    );
    const strict = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE direction IN ('BUY','SELL')
          AND confidence_score >= ?
          AND COALESCE(final_score, 0)  >= ?
          AND COALESCE(risk_reward, 0)  >= ?
          AND COALESCE(invalidation_reason,'') = ''
          AND UPPER(COALESCE(signal_status,'')) = 'APPROVED_SIGNAL'
          AND UPPER(COALESCE(classification,'')) <> 'WATCHLIST_ONLY'
          AND UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')
          AND COALESCE(signal_type,'') <> 'force_seed'
          AND COALESCE(batch_id,'') NOT LIKE 'force_seed%'`,
      [STRICT_CONFIDENCE_FLOOR, STRICT_FINAL_FLOOR, STRICT_RR_FLOOR],
    );
    const relaxed = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE direction IN ('BUY','SELL')
          AND confidence_score >= 60
          AND COALESCE(final_score, 0)  >= 65
          AND COALESCE(risk_reward, 0)  >= 1.2
          AND COALESCE(invalidation_reason,'') = ''
          AND UPPER(COALESCE(signal_status,'')) IN ('APPROVED_SIGNAL','DEVELOPING_SETUP')
          AND UPPER(COALESCE(classification,'')) <> 'WATCHLIST_ONLY'
          AND UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')
          AND COALESCE(signal_type,'') <> 'force_seed'
          AND COALESCE(batch_id,'') NOT LIKE 'force_seed%'`,
    );
    const seeded = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE COALESCE(signal_type,'') = 'force_seed'
           OR COALESCE(batch_id,'')    LIKE 'force_seed%'`,
    );
    const num = (r: { rows: unknown }) =>
      Number((r.rows as Array<{ c: number }>)[0]?.c ?? 0);
    return {
      ok:              true,
      candidates:      num(candidates),
      strict_passed:   num(strict),
      relaxed_passed:  num(relaxed),
      force_seed_rows: num(seeded),
      error:           null,
    };
  } catch (err) {
    return {
      ok: false, candidates: 0, strict_passed: 0, relaxed_passed: 0, force_seed_rows: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── 6. Custom-universe scanner last summary on disk ────────────

interface DiskScanReport {
  exists:        boolean;
  path:          string;
  batchId:       string | null;
  scannedTotal:  number | null;
  matched:       number | null;
  rejected:      number | null;
  endedAt:       string | null;
}

function readDiskSummary(): DiskScanReport {
  const path = resolve(process.cwd(), '.next/scanner-last-summary.json');
  if (!existsSync(path)) {
    return { exists: false, path, batchId: null, scannedTotal: null, matched: null, rejected: null, endedAt: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return {
      exists:        true,
      path,
      batchId:       (parsed.batchId as string) ?? null,
      scannedTotal:  Number(parsed.scannedTotal ?? parsed.scanned ?? 0) || null,
      matched:       Number(parsed.matched      ?? 0) || null,
      rejected:      Number(parsed.rejected     ?? 0) || null,
      endedAt:       (parsed.endedAt as string) ?? null,
    };
  } catch {
    return { exists: false, path, batchId: null, scannedTotal: null, matched: null, rejected: null, endedAt: null };
  }
}

// ── 7. Verdict ─────────────────────────────────────────────────

interface SpecReport {
  total_symbols:     number;
  scanned:           number;
  candidates:        number;
  strict:            number;
  relaxed:           number;
  final_signals:     number;
  scan_status:       'FULL' | 'PARTIAL' | 'FAILED';
  verdict:           'SCAN_WORKING ✅' | 'SCAN_BROKEN ❌';
  failure_signals:   string[];
}

function buildVerdict(args: {
  excel:    ExcelReport;
  baked:    BakedReport;
  univ:     UniverseReport;
  batch:    BatchReport;
  filter:   FilterReport;
  diskScan: DiskScanReport;
  envMode:  string;
}): SpecReport {
  const failureSignals: string[] = [];

  // Pick "expected universe size" from whichever source the scanner
  // would actually use.
  const expectedUniverse =
      args.envMode === 'FULL' ? args.baked.count
    : args.univ.active_count > 0 ? args.univ.active_count
    : args.baked.count;

  const lastScanSize = args.batch.rows_in_batch;     // rows persisted by
                                                     // the latest scan batch
  const candidates    = args.filter.candidates;
  const strict        = args.filter.strict_passed;
  const relaxed       = args.filter.relaxed_passed;
  const finalSignals  = strict > 0 ? strict : relaxed;

  // Failure detection.
  if (!args.excel.exists)              failureSignals.push('excel_missing');
  if (!args.baked.exists)              failureSignals.push('nseUniverse_json_missing');
  if (!args.univ.ok)                   failureSignals.push('q365_universe_unreadable');
  if (args.envMode !== 'FULL' && args.univ.active_count === 0) failureSignals.push('q365_universe_empty');
  if (!args.batch.ok)                  failureSignals.push('q365_signals_unreadable');
  if (args.batch.latest_batch_id == null) failureSignals.push('no_scan_batch_in_db');
  if (args.filter.force_seed_rows > 0) failureSignals.push(`${args.filter.force_seed_rows}_force_seed_rows_present`);
  if (args.batch.ageMinutes != null && args.batch.ageMinutes > 24 * 60) {
    failureSignals.push(`stale_batch_${args.batch.ageMinutes}min_old`);
  }
  if (lastScanSize > 0 && lastScanSize < expectedUniverse * 0.5) {
    failureSignals.push(`scan_coverage_${Math.round((lastScanSize / expectedUniverse) * 100)}pct`);
  }

  // scan_status taxonomy — spec section 8.
  let scanStatus: SpecReport['scan_status'];
  if (lastScanSize === 0)                       scanStatus = 'FAILED';
  else if (lastScanSize >= expectedUniverse * 0.95) scanStatus = 'FULL';
  else                                          scanStatus = 'PARTIAL';

  // Verdict — spec section 9. Healthy = scan ≈ universe size and at
  // least one candidate present (final_signals can legitimately be 0
  // when the regime is bearish; that alone shouldn't fail the verdict).
  const healthy =
       failureSignals.length === 0
    && scanStatus === 'FULL'
    && candidates > 0;

  return {
    total_symbols:    expectedUniverse,
    scanned:          lastScanSize,
    candidates,
    strict,
    relaxed,
    final_signals:    finalSignals,
    scan_status:      scanStatus,
    verdict:          healthy ? 'SCAN_WORKING ✅' : 'SCAN_BROKEN ❌',
    failure_signals:  failureSignals,
  };
}

// ── Entry point ────────────────────────────────────────────────

async function main(): Promise<void> {
  const envMode = (process.env.UNIVERSE_MODE ?? 'NIFTY500').trim().toUpperCase();
  const excel    = readExcel();
  const baked    = readBaked();
  const univ     = await readQ365Universe();
  const batch    = await readLatestBatch();
  const filter   = await readFilterBreakdown();
  const diskScan = readDiskSummary();
  const verdict  = buildVerdict({ excel, baked, univ, batch, filter, diskScan, envMode });

  if (JSON_OUT) {
    console.log(JSON.stringify({ envMode, excel, baked, univ, batch, filter, diskScan, verdict }, null, 2));
    process.exit(verdict.verdict.startsWith('SCAN_WORKING') ? 0 : 1);
  }

  const line = (label: string, value: string | number | null | undefined) =>
    `  ${label.padEnd(28)} ${value ?? '—'}`;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  verifyScanCoverage — NSE scan coverage diagnostic');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`UNIVERSE_MODE=${envMode}\n`);

  console.log('[1] Excel source');
  console.log(line('path',           excel.path));
  console.log(line('exists',         excel.exists ? 'yes' : 'no'));
  console.log(line('total_rows',     excel.total_rows));
  console.log(line('unique_symbols', excel.unique_symbols));
  console.log(line('inav_skipped',   excel.inav_skipped));
  console.log(line('blank_rows',     excel.blank_rows));
  console.log(line('duplicates',     excel.duplicates));
  if (excel.exists) {
    console.log(line('first_5',      excel.first_5.join(', ')));
    console.log(line('last_5',       excel.last_5.join(', ')));
  }
  console.log();

  console.log('[2] Baked nseUniverse.json');
  console.log(line('path',           baked.path));
  console.log(line('exists',         baked.exists ? 'yes' : 'no'));
  console.log(line('count',          baked.count));
  console.log(line('source',         baked.source));
  console.log();

  console.log('[3] q365_universe (DB)');
  console.log(line('reachable',      univ.ok ? 'yes' : 'no'));
  console.log(line('active_count',   univ.active_count));
  console.log(line('total_count',    univ.total_count));
  if (univ.error) console.log(line('error',           univ.error));
  console.log();

  console.log('[4] Latest scan batch (q365_signals)');
  console.log(line('reachable',         batch.ok ? 'yes' : 'no'));
  console.log(line('latest_batch_id',   batch.latest_batch_id));
  console.log(line('latest_generated',  batch.latest_generated));
  console.log(line('age_minutes',       batch.ageMinutes));
  console.log(line('rows_in_batch',     batch.rows_in_batch));
  console.log(line('generation_source', batch.generation_source));
  console.log(line('buy / sell',        `${batch.buy_count} / ${batch.sell_count}`));
  if (batch.error) console.log(line('error',              batch.error));
  console.log();

  console.log('[5] Filter breakdown (current DB state)');
  console.log(line('candidates',        filter.candidates));
  console.log(line('strict_passed',     filter.strict_passed));
  console.log(line('relaxed_passed',    filter.relaxed_passed));
  console.log(line('force_seed_rows',   filter.force_seed_rows));
  if (filter.error) console.log(line('error',              filter.error));
  console.log();

  console.log('[6] Disk scanner-last-summary');
  console.log(line('exists',         diskScan.exists ? 'yes' : 'no'));
  console.log(line('batchId',        diskScan.batchId));
  console.log(line('scannedTotal',   diskScan.scannedTotal));
  console.log(line('matched',        diskScan.matched));
  console.log(line('rejected',       diskScan.rejected));
  console.log(line('endedAt',        diskScan.endedAt));
  console.log();

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  FINAL REPORT (spec shape)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(line('total_symbols',  verdict.total_symbols));
  console.log(line('scanned',        verdict.scanned));
  console.log(line('candidates',     verdict.candidates));
  console.log(line('strict',         verdict.strict));
  console.log(line('relaxed',        verdict.relaxed));
  console.log(line('final_signals',  verdict.final_signals));
  console.log(line('scan_status',    verdict.scan_status));
  if (verdict.failure_signals.length > 0) {
    console.log(line('failure_signals', verdict.failure_signals.join(', ')));
  }
  console.log();
  console.log(`  ${verdict.verdict}`);
  console.log();

  process.exit(verdict.verdict.startsWith('SCAN_WORKING') ? 0 : 1);
}

main().catch((err) => {
  console.error('verifyScanCoverage failed:', err);
  process.exit(2);
});
