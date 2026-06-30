// ════════════════════════════════════════════════════════════════
//  Outcome Resolution Engine — Quantorus365 Public Signal Ledger
//
//  resolveSignalOutcomes() — fetch pending signals, walk candles,
//  persist outcomes. Never modifies q365_signals.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { migrateSignalOutcomesPublic } from '@/lib/db/migrateSignalOutcomesPublic';
import { fetchDailyCandlesWithFallback } from '@/lib/marketData/candleFallbackChain';
import {
  evaluateOutcomeResolution,
  type SignalForOutcomeResolution,
} from './evaluateOutcomeResolution';
import { saveResolvedOutcome } from '../repository/signalOutcomeLedgerRepository';
import type { SignalResolutionOutcome } from '../types/signalOutcomeLedger.types';

export interface ResolveSignalOutcomesOptions {
  limit?: number;
  sinceDays?: number;
  dryRun?: boolean;
}

export interface ResolveSignalOutcomesResult {
  processed: number;
  inserted: number;
  updated: number;
  skippedTerminal: number;
  skippedNoPlan: number;
  skippedNoCandles: number;
  errors: number;
  targetHits: number;
  stopLosses: number;
  active: number;
  expired: number;
  elapsedMs: number;
}

interface PendingSignalRow {
  id: number;
  symbol: string;
  signal_type: string;
  direction: string;
  entry_price: number;
  stop_loss: number;
  target1: number;
  created_at: string;
}

function resolveStrategyId(row: PendingSignalRow): string {
  return String(row.signal_type ?? '').trim() || 'unclassified';
}

/** Step 1 — signals without an outcome row (new pending only). */
export async function fetchPendingSignals(
  limit: number,
  sinceDays?: number,
): Promise<PendingSignalRow[]> {
  const params: unknown[] = [];
  let sinceClause = '';
  if (sinceDays != null && sinceDays > 0) {
    sinceClause = 'AND s.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';
    params.push(sinceDays);
  }
  params.push(limit);

  const { rows } = await db.query<PendingSignalRow>(
    `SELECT
       s.id,
       s.symbol,
       s.signal_type,
       s.direction,
       s.entry_price,
       s.stop_loss,
       s.target1,
       s.created_at
     FROM q365_signals s
     LEFT JOIN q365_signal_outcomes o ON s.id = o.signal_id
     WHERE o.signal_id IS NULL
     AND s.entry_price IS NOT NULL
     AND s.stop_loss IS NOT NULL
     AND s.target1 IS NOT NULL
     ${sinceClause}
     ORDER BY s.created_at ASC
     LIMIT ?`,
    params,
  );
  return rows ?? [];
}

/** Step 2 — historical candles via evaluation read path (DB → getCandles chain). */
async function loadCandlesForSymbol(symbol: string) {
  const result = await fetchDailyCandlesWithFallback(symbol, { evaluationRead: true });
  return result.candles;
}

function logResolutionSummary(result: ResolveSignalOutcomesResult): void {
  console.log(
    '[OutcomeResolution] ' +
    `processed=${result.processed} ` +
    `target_hits=${result.targetHits} ` +
    `stop_losses=${result.stopLosses} ` +
    `active=${result.active} ` +
    `expired=${result.expired} ` +
    `inserted=${result.inserted} ` +
    `updated=${result.updated} ` +
    `skipped_terminal=${result.skippedTerminal} ` +
    `errors=${result.errors} ` +
    `elapsed_ms=${result.elapsedMs}`,
  );
}

export async function resolveSignalOutcomes(
  opts: ResolveSignalOutcomesOptions = {},
): Promise<ResolveSignalOutcomesResult> {
  const t0 = Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 10_000);

  await migrateSignalOutcomesPublic();

  const signals = await fetchPendingSignals(limit, opts.sinceDays);
  const result = emptyResult();
  const candleCache = new Map<string, Awaited<ReturnType<typeof loadCandlesForSymbol>>>();

  await evaluateSignalRows(signals, opts, result, candleCache);

  result.elapsedMs = Date.now() - t0;
  logResolutionSummary(result);
  return result;
}

function countOutcome(result: ResolveSignalOutcomesResult, outcome: SignalResolutionOutcome): void {
  if (outcome === 'T1_HIT') result.targetHits++;
  else if (outcome === 'SL_HIT') result.stopLosses++;
  else if (outcome === 'EXPIRED') result.expired++;
  else if (outcome === 'ACTIVE') result.active++;
}

function emptyResult(): ResolveSignalOutcomesResult {
  return {
    processed: 0,
    inserted: 0,
    updated: 0,
    skippedTerminal: 0,
    skippedNoPlan: 0,
    skippedNoCandles: 0,
    errors: 0,
    targetHits: 0,
    stopLosses: 0,
    active: 0,
    expired: 0,
    elapsedMs: 0,
  };
}

interface ActiveOutcomeSignalRow {
  signal_id: number;
  strategy_id: string;
  symbol: string;
  signal_type: string;
  direction: string;
  entry_price: number;
  stop_loss: number;
  target1: number;
  created_at: string;
}

/** Step 2 — ledger rows still marked ACTIVE (re-evaluate with latest candles). */
export async function fetchActiveOutcomeSignals(
  limit: number,
): Promise<ActiveOutcomeSignalRow[]> {
  const capped = Math.min(Math.max(limit, 1), 10_000);
  const { rows } = await db.query<ActiveOutcomeSignalRow>(
    `SELECT
       o.signal_id,
       o.strategy_id,
       o.symbol,
       s.signal_type,
       s.direction,
       s.entry_price,
       s.stop_loss,
       s.target1,
       s.created_at
     FROM q365_signal_outcomes o
     INNER JOIN q365_signals s ON s.id = o.signal_id
     WHERE o.outcome = 'ACTIVE'
       AND s.entry_price IS NOT NULL
       AND s.stop_loss IS NOT NULL
       AND s.target1 IS NOT NULL
     ORDER BY o.outcome_at ASC
     LIMIT ?`,
    [capped],
  );
  return rows ?? [];
}

async function evaluateSignalRows(
  rows: Array<PendingSignalRow | ActiveOutcomeSignalRow>,
  opts: { dryRun?: boolean },
  result: ResolveSignalOutcomesResult,
  candleCache: Map<string, Awaited<ReturnType<typeof loadCandlesForSymbol>>>,
): Promise<void> {
  for (const row of rows) {
    const signalId = 'id' in row ? row.id : row.signal_id;
    const entry = Number(row.entry_price);
    const stop = Number(row.stop_loss);
    const target = Number(row.target1);
    if (!Number.isFinite(entry) || entry <= 0
      || !Number.isFinite(stop) || stop <= 0
      || !Number.isFinite(target) || target <= 0) {
      result.skippedNoPlan++;
      continue;
    }

    try {
      let candles = candleCache.get(row.symbol);
      if (!candles) {
        candles = await loadCandlesForSymbol(row.symbol);
        candleCache.set(row.symbol, candles);
      }
      if (!candles.length) {
        result.skippedNoCandles++;
        continue;
      }

      const signal: SignalForOutcomeResolution = {
        signalId,
        symbol: String(row.symbol ?? ''),
        strategyId: 'strategy_id' in row && row.strategy_id
          ? String(row.strategy_id)
          : resolveStrategyId(row as PendingSignalRow),
        direction: String(row.direction ?? 'BUY'),
        entryPrice: entry,
        stopLoss: stop,
        target1: target,
        createdAt: String(row.created_at),
      };

      const resolution = evaluateOutcomeResolution(signal, candles);
      if (!resolution) {
        result.skippedNoPlan++;
        continue;
      }

      result.processed++;
      countOutcome(result, resolution.outcome);

      if (opts.dryRun) continue;

      const saved = await saveResolvedOutcome({
        signalId: resolution.signalId,
        strategyId: resolution.strategyId,
        symbol: resolution.symbol,
        outcome: resolution.outcome,
        outcomeAt: resolution.outcomeAt,
        daysHeld: resolution.daysHeld,
        maxGainPct: resolution.maxGainPct,
        candleCheckCount: resolution.candleCheckCount,
      });

      if (saved.inserted) result.inserted++;
      else if (saved.updated) result.updated++;
      else if (saved.skippedTerminal) result.skippedTerminal++;
    } catch (err) {
      result.errors++;
      console.error('[OutcomeResolution] signal evaluation failed', {
        signalId,
        symbol: row.symbol,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Re-evaluate ACTIVE ledger rows against the latest candle warehouse. */
export async function refreshActiveSignalOutcomes(
  opts: ResolveSignalOutcomesOptions = {},
): Promise<ResolveSignalOutcomesResult> {
  const t0 = Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 10_000);

  await migrateSignalOutcomesPublic();

  const rows = await fetchActiveOutcomeSignals(limit);
  const result = emptyResult();
  const candleCache = new Map<string, Awaited<ReturnType<typeof loadCandlesForSymbol>>>();

  await evaluateSignalRows(rows, opts, result, candleCache);

  result.elapsedMs = Date.now() - t0;
  logResolutionSummary(result);
  return result;
}
