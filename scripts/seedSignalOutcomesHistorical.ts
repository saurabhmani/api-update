// ════════════════════════════════════════════════════════════════
//  seedSignalOutcomesHistorical.ts — Public Signal Ledger backfill
//
//  Reads historical terminal signals from MySQL, maps outcomes, and
//  persists rows into q365_signal_outcomes (public ledger columns).
//  Never modifies q365_signals.
//
//  Usage:
//    npx tsx scripts/seedSignalOutcomesHistorical.ts
//    npx tsx scripts/seedSignalOutcomesHistorical.ts --dry-run
//    npx tsx scripts/seedSignalOutcomesHistorical.ts --since=90d
//    npx tsx scripts/seedSignalOutcomesHistorical.ts --evaluate-candles
//    npx tsx scripts/seedSignalOutcomesHistorical.ts --json
// ════════════════════════════════════════════════════════════════

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';
import { migrateSignalOutcomesPublic } from '@/lib/db/migrateSignalOutcomesPublic';
import {
  evaluateSignalOutcome,
  type SignalForBacktest,
} from '@/lib/signals/dailyBacktestEngine';
import type {
  SignalOutcomeLedgerInsert,
  SignalOutcomeLedgerStatus,
} from '@/lib/signals/types/signalOutcomeLedger.types';
import {
  getExistingSignalOutcomeIds,
  getSignalOutcomeCoverage,
  insertSignalOutcome,
} from '@/lib/signals/repository/signalOutcomeLedgerRepository';

const TERMINAL_SNAPSHOT_STATUSES = new Set([
  'TARGET_HIT',
  'STOP_LOSS_HIT',
  'SL_HIT',
  'EXPIRED',
  'INVALIDATED',
]);

const argv = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const dryRun          = argv.has('dry-run');
const emitJson        = argv.has('json');
const evaluateCandles = argv.has('evaluate-candles');
const limit           = Math.max(1, Number(argv.get('limit') ?? '10000'));
const minAgeDays      = Math.max(1, Number(argv.get('min-age-days') ?? '10'));

function parseSince(spec: string): number {
  const m = spec.match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`invalid --since: ${spec}`);
  const mul: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(m[1]) * (mul[(m[2] || 'd').toLowerCase()] ?? 86400);
}

const sinceSec = argv.has('since') ? parseSince(String(argv.get('since'))) : undefined;

export interface SeedSignalOutcomesResult {
  generatedAt: string;
  dryRun: boolean;
  scanned: number;
  inserted: number;
  skippedExisting: number;
  skippedYoung: number;
  skippedActive: number;
  skippedNoSignalRef: number; // kept for API compat; unused on MySQL-only path
  errors: number;
  coverageBefore: Awaited<ReturnType<typeof getSignalOutcomeCoverage>>;
  coverageAfter: Awaited<ReturnType<typeof getSignalOutcomeCoverage>>;
  elapsedMs: number;
}

interface CandidateRow {
  signal_id: number;
  symbol: string;
  strategy_id: string;
  direction: string;
  status: string;
  entry_price: number | null;
  stop_loss: number | null;
  target1: number | null;
  generated_at: string;
  resolved_at: string;
}

function resolveStrategyId(row: Record<string, unknown>): string {
  const raw = row.strategy ?? row.strategy_id ?? row.signal_type ?? row.signalType;
  return String(raw ?? '').trim() || 'unclassified';
}

function mapSnapshotStatus(status: string): SignalOutcomeLedgerStatus | null {
  const s = status.toUpperCase();
  if (s === 'TARGET_HIT') return 'WIN';
  if (s === 'STOP_LOSS_HIT' || s === 'SL_HIT') return 'LOSS';
  if (s === 'EXPIRED') return 'EXPIRED';
  if (s === 'INVALIDATED') return 'INVALIDATED';
  return null;
}

function mapSignalStatus(status: string): SignalOutcomeLedgerStatus | null {
  const s = status.toLowerCase();
  if (s === 'target_hit') return 'WIN';
  if (s === 'sl_hit' || s === 'stop_loss_hit') return 'LOSS';
  if (s === 'expired') return 'EXPIRED';
  if (s === 'invalidated') return 'INVALIDATED';
  return null;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

async function loadSnapshotCandidates(): Promise<CandidateRow[]> {
  const sinceClause = sinceSec != null
    ? `AND cs.status_changed_at >= DATE_SUB(NOW(), INTERVAL ${Math.ceil(sinceSec / 86400)} DAY)`
    : '';

  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT
       cs.source_signal_id AS signal_id,
       cs.symbol,
       cs.strategy,
       cs.direction,
       cs.status,
       cs.entry_price,
       cs.stop_loss,
       cs.target1,
       cs.confirmed_at,
       cs.status_changed_at,
       s.signal_type,
       s.generated_at
     FROM q365_confirmed_signal_snapshots cs
     LEFT JOIN q365_signals s ON s.id = cs.source_signal_id
     WHERE cs.source_signal_id IS NOT NULL
       AND cs.status IN ('TARGET_HIT','STOP_LOSS_HIT','SL_HIT','EXPIRED','INVALIDATED')
       ${sinceClause}
     ORDER BY cs.status_changed_at ASC
     LIMIT ?`,
    [limit],
  );

  const out: CandidateRow[] = [];
  for (const r of rows ?? []) {
    const signalId = Number(r.signal_id);
    if (!Number.isFinite(signalId) || signalId <= 0) continue;
    const generatedAt = String(r.generated_at ?? r.confirmed_at ?? r.status_changed_at ?? '');
    const resolvedAt = String(r.status_changed_at ?? r.confirmed_at ?? generatedAt);
    out.push({
      signal_id: signalId,
      symbol: String(r.symbol ?? ''),
      strategy_id: resolveStrategyId(r),
      direction: String(r.direction ?? 'BUY'),
      status: String(r.status ?? ''),
      entry_price: r.entry_price != null ? Number(r.entry_price) : null,
      stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
      target1: r.target1 != null ? Number(r.target1) : null,
      generated_at: generatedAt,
      resolved_at: resolvedAt,
    });
  }
  return out;
}

async function loadMatureSignalCandidates(): Promise<CandidateRow[]> {
  const sinceClause = sinceSec != null
    ? `AND s.generated_at >= DATE_SUB(NOW(), INTERVAL ${Math.ceil(sinceSec / 86400)} DAY)`
    : '';

  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT
       s.id AS signal_id,
       s.symbol,
       s.signal_type,
       s.direction,
       s.status,
       s.entry_price,
       s.stop_loss,
       s.target1,
       s.generated_at
     FROM q365_signals s
     WHERE s.generated_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND s.status IN ('expired','invalidated','target_hit','sl_hit','stop_loss_hit')
       ${sinceClause}
     ORDER BY s.generated_at ASC
     LIMIT ?`,
    [minAgeDays, limit],
  );

  return (rows ?? []).map((r) => ({
    signal_id: Number(r.signal_id),
    symbol: String(r.symbol ?? ''),
    strategy_id: resolveStrategyId(r),
    direction: String(r.direction ?? 'BUY'),
    status: String(r.status ?? ''),
    entry_price: r.entry_price != null ? Number(r.entry_price) : null,
    stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
    target1: r.target1 != null ? Number(r.target1) : null,
    generated_at: String(r.generated_at ?? ''),
    resolved_at: String(r.generated_at ?? ''),
  }));
}

async function buildInsertFromCandidate(
  row: CandidateRow,
): Promise<SignalOutcomeLedgerInsert | null> {
  const outcome = mapSnapshotStatus(row.status) ?? mapSignalStatus(row.status);
  if (!outcome) return null;

  if (evaluateCandles && row.entry_price != null && row.entry_price > 0) {
    const { rows: cRows } = await db.query<Record<string, unknown>>(
      `SELECT ts, open, high, low, close, volume
         FROM market_data_daily
        WHERE symbol = ?
          AND ts > ?
        ORDER BY ts ASC
        LIMIT 60`,
      [row.symbol, row.generated_at],
    );
    const candles = (cRows ?? []).map((c) => ({
      ts: String(c.ts),
      open: Number(c.open ?? c.close ?? 0),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume ?? 0),
    }));

    if (candles.length >= minAgeDays) {
      const review = evaluateSignalOutcome(
        {
          symbol: row.symbol,
          direction: row.direction,
          signal_type: row.strategy_id,
          entry_price: row.entry_price,
          stop_loss: row.stop_loss,
          target1: row.target1,
          generated_at: row.generated_at,
          __candles: candles,
        } as SignalForBacktest,
        { reviewWindowLabel: '30D' },
      );
      return {
        signalId: row.signal_id,
        strategyId: row.strategy_id,
        symbol: row.symbol,
        outcome: review.outcome as SignalOutcomeLedgerStatus,
        outcomeAt: row.resolved_at,
        daysHeld: daysBetween(row.generated_at, row.resolved_at),
        maxGainPct: review.maxFavorableMovePercent,
        candleCheckCount: candles.length,
      };
    }
  }

  return {
    signalId: row.signal_id,
    strategyId: row.strategy_id,
    symbol: row.symbol,
    outcome,
    outcomeAt: row.resolved_at,
    daysHeld: daysBetween(row.generated_at, row.resolved_at),
    maxGainPct: null,
    candleCheckCount: 0,
  };
}

export async function seedHistoricalSignalOutcomes(): Promise<SeedSignalOutcomesResult> {
  const t0 = Date.now();
  const coverageBefore = await getSignalOutcomeCoverage().catch(() => ({
    totalSignals: 0,
    withOutcome: 0,
    withoutOutcome: 0,
    coveragePct: null,
  }));

  const bySignalId = new Map<number, CandidateRow>();
  for (const row of [...await loadMatureSignalCandidates(), ...await loadSnapshotCandidates()]) {
    if (!bySignalId.has(row.signal_id)) bySignalId.set(row.signal_id, row);
  }
  const candidates = [...bySignalId.values()].slice(0, limit);
  const existing = await getExistingSignalOutcomeIds(candidates.map((c) => c.signal_id));

  let inserted = 0;
  let skippedExisting = 0;
  let skippedYoung = 0;
  let skippedActive = 0;
  let skippedNoSignalRef = 0;
  let errors = 0;

  for (const row of candidates) {
    if (existing.has(row.signal_id)) {
      skippedExisting++;
      continue;
    }

    const ageDays = daysBetween(row.generated_at, new Date().toISOString());
    if (ageDays < minAgeDays && !TERMINAL_SNAPSHOT_STATUSES.has(row.status.toUpperCase())) {
      skippedYoung++;
      continue;
    }

    try {
      const payload = await buildInsertFromCandidate(row);
      if (!payload) {
        skippedActive++;
        continue;
      }

      if (dryRun) {
        inserted++;
        continue;
      }

      const result = await insertSignalOutcome(payload);
      if (result.inserted) {
        inserted++;
        existing.add(row.signal_id);
      } else {
        skippedExisting++;
      }
    } catch {
      errors++;
    }
  }

  const coverageAfter = dryRun
    ? coverageBefore
    : await getSignalOutcomeCoverage().catch(() => coverageBefore);

  return {
    generatedAt: new Date().toISOString(),
    dryRun,
    scanned: candidates.length,
    inserted,
    skippedExisting,
    skippedYoung,
    skippedActive,
    skippedNoSignalRef,
    errors,
    coverageBefore,
    coverageAfter,
    elapsedMs: Date.now() - t0,
  };
}

function printReport(result: SeedSignalOutcomesResult): void {
  console.log('══════════════════════════════════════════════════');
  console.log('  Public Signal Ledger — Historical Seed');
  console.log('══════════════════════════════════════════════════\n');
  console.log(`Generated: ${result.generatedAt}`);
  console.log(`Mode:      ${result.dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log(`Elapsed:   ${result.elapsedMs}ms\n`);
  console.log(`Scanned:           ${result.scanned}`);
  console.log(`Inserted:          ${result.inserted}`);
  console.log(`Skipped (existing):  ${result.skippedExisting}`);
  console.log(`Skipped (too young): ${result.skippedYoung}`);
  console.log(`Skipped (active):    ${result.skippedActive}`);
  console.log(`Errors:              ${result.errors}\n`);
  console.log(
    `Coverage: ${result.coverageBefore.withOutcome}/${result.coverageBefore.totalSignals}` +
    ` → ${result.coverageAfter.withOutcome}/${result.coverageAfter.totalSignals}`,
  );
}

async function main(): Promise<void> {
  try {
    await migrateSignalOutcomesPublic();
    const result = await seedHistoricalSignalOutcomes();
    if (emitJson) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
  } catch (err) {
    console.error('[seedSignalOutcomesHistorical] FAILED:', (err as Error).message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
