// ════════════════════════════════════════════════════════════════
//  Backtest Audit Logger — Decision Trail
//
//  Records every significant event during a backtest for
//  reproducibility and debugging. Stored in-memory during run,
//  persisted to DB after completion.
// ════════════════════════════════════════════════════════════════

import type { BacktestAuditEntry, AuditAction } from '../types';
import { db } from '@/lib/db';

function toMysqlDatetime(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export class AuditLogger {
  private entries: BacktestAuditEntry[] = [];
  private readonly runId: string;
  private readonly maxEntries: number;

  constructor(runId: string, maxEntries = 10_000) {
    this.runId = runId;
    this.maxEntries = maxEntries;
  }

  /**
   * Build a logger pre-loaded with the given entries — used by the
   * orchestrator to persist entries that were collected during a run.
   */
  static fromEntries(runId: string, entries: BacktestAuditEntry[], maxEntries = 10_000): AuditLogger {
    const logger = new AuditLogger(runId, maxEntries);
    logger.entries = [...entries];
    return logger;
  }

  log(
    barIndex: number,
    action: AuditAction,
    message: string,
    symbol: string | null = null,
    payload: Record<string, unknown> = {},
  ): void {
    if (this.entries.length >= this.maxEntries) return; // prevent memory bloat

    this.entries.push({
      runId: this.runId,
      timestamp: new Date().toISOString(),
      barIndex,
      action,
      symbol,
      message,
      payload,
    });
  }

  getEntries(): BacktestAuditEntry[] {
    return this.entries;
  }

  getEntriesForSymbol(symbol: string): BacktestAuditEntry[] {
    return this.entries.filter(e => e.symbol === symbol);
  }

  getEntriesByAction(action: AuditAction): BacktestAuditEntry[] {
    return this.entries.filter(e => e.action === action);
  }

  /** Persist all audit entries to the database */
  async persist(): Promise<void> {
    if (this.entries.length === 0) return;

    // Batch insert in chunks of 100
    const chunkSize = 100;
    for (let i = 0; i < this.entries.length; i += chunkSize) {
      const chunk = this.entries.slice(i, i + chunkSize);
      const values = chunk.map(e => [
        e.runId, toMysqlDatetime(e.timestamp), e.barIndex, e.action,
        e.symbol, e.message, JSON.stringify(e.payload),
      ]);
      const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');

      try {
        await db.query(
          `INSERT INTO backtest_audit_logs (run_id, timestamp, bar_index, action, symbol, message, payload_json)
           VALUES ${placeholders}`,
          values.flat(),
        );
      } catch (err) {
        console.error('[BacktestAudit] Failed to persist chunk:', err);
      }
    }
  }

  get count(): number {
    return this.entries.length;
  }
}
