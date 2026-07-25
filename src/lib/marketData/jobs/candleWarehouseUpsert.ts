/**
 * Source-aware upsert into shared `candles` warehouse (Phase 13).
 */

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  CANDLE_SOURCE_COLUMN,
  normalizeWarehouseCandleSource,
  shouldApplyCandleUpsert,
  type WarehouseCandleSource,
} from '@/lib/marketData/jobs/candleSourcePolicy';

const log = logger.child({ component: 'candleWarehouseUpsert' });

let sourceColumnReady: Promise<boolean> | null = null;

/**
 * Ensure `candles.source` exists (idempotent). Returns false if ALTER fails
 * so callers can fall back to legacy upsert without source rules.
 */
export async function ensureCandlesSourceColumn(): Promise<boolean> {
  if (!sourceColumnReady) {
    sourceColumnReady = (async () => {
      try {
        await db.query(
          `ALTER TABLE candles
             ADD COLUMN source VARCHAR(32) NULL DEFAULT NULL
             AFTER oi`,
        );
        log.info('candles.source column added');
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Duplicate column / already exists
        if (/duplicate column|exists/i.test(msg)) return true;
        log.warn('candles.source column unavailable — legacy upsert without precedence', {
          error: msg.slice(0, 160),
        });
        return false;
      }
    })();
  }
  return sourceColumnReady;
}

export type CandleUpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'skipped';

export interface UpsertWarehouseCandleInput {
  instrumentKey: string;
  candleType: string;
  intervalUnit: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
  source: WarehouseCandleSource;
}

/**
 * Upsert one warehouse candle with source precedence.
 * Skips when a higher-precedence source already owns the key.
 */
export async function upsertWarehouseCandle(
  input: UpsertWarehouseCandleInput,
): Promise<CandleUpsertOutcome> {
  const incoming = normalizeWarehouseCandleSource(input.source);
  const gate = shouldApplyCandleUpsert({ incoming, existing: null });
  if (!gate.apply && incoming === 'shoonya') {
    log.warn('shoonya candle write blocked', {
      instrumentKey: input.instrumentKey,
      reason: gate.reason,
    });
    return 'skipped';
  }

  const hasSource = await ensureCandlesSourceColumn();
  const oi = input.oi ?? 0;

  if (!hasSource) {
    // Legacy path — still refuse blocked sources.
    if (!shouldApplyCandleUpsert({ incoming, existing: null }).apply) {
      return 'skipped';
    }
    const result = await db.query(
      `INSERT INTO candles
         (instrument_key, candle_type, interval_unit, ts, open, high, low, close, volume, oi)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         open=VALUES(open), high=VALUES(high), low=VALUES(low),
         close=VALUES(close), volume=VALUES(volume), oi=VALUES(oi)`,
      [
        input.instrumentKey,
        input.candleType,
        input.intervalUnit,
        input.ts,
        input.open,
        input.high,
        input.low,
        input.close,
        input.volume,
        oi,
      ],
    );
    const affected = Number((result as { affectedRows?: number })?.affectedRows ?? 0);
    if (affected === 1) return 'inserted';
    if (affected === 2) return 'updated';
    return 'unchanged';
  }

  // Read existing source for this key (if any).
  const existingRes = await db.query<{ source: string | null }>(
    `SELECT ${CANDLE_SOURCE_COLUMN} AS source FROM candles
      WHERE instrument_key = ? AND candle_type = ? AND interval_unit = ? AND ts = ?
      LIMIT 1`,
    [input.instrumentKey, input.candleType, input.intervalUnit, input.ts],
  );
  const existingRaw = existingRes.rows[0]?.source ?? null;
  const existing = existingRaw
    ? normalizeWarehouseCandleSource(existingRaw)
    : null;

  const decision = shouldApplyCandleUpsert({ incoming, existing });
  if (!decision.apply) {
    return 'skipped';
  }

  const result = await db.query(
    `INSERT INTO candles
       (instrument_key, candle_type, interval_unit, ts, open, high, low, close, volume, oi, ${CANDLE_SOURCE_COLUMN})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       open=VALUES(open), high=VALUES(high), low=VALUES(low),
       close=VALUES(close), volume=VALUES(volume), oi=VALUES(oi),
       ${CANDLE_SOURCE_COLUMN}=VALUES(${CANDLE_SOURCE_COLUMN})`,
    [
      input.instrumentKey,
      input.candleType,
      input.intervalUnit,
      input.ts,
      input.open,
      input.high,
      input.low,
      input.close,
      input.volume,
      oi,
      incoming,
    ],
  );

  const affected = Number((result as { affectedRows?: number })?.affectedRows ?? 0);
  if (affected === 1) return 'inserted';
  if (affected === 2) return 'updated';
  return 'unchanged';
}
