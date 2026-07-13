// Best-effort persistence for dual-source audit trail.

import type {
  ApprovalDecision,
  ConfirmationResult,
  FeedValidationResult,
  NormalizedFeedTick,
} from './types';

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    const { migrateDualSource } = await import('@/lib/db/migrateDualSource');
    await migrateDualSource();
    schemaReady = true;
  } catch {
    // non-blocking — in-memory monitoring still works
  }
}

export async function storeRawTick(tick: NormalizedFeedTick): Promise<void> {
  await ensureSchema();
  try {
    const { db } = await import('@/lib/db');
    await db.query(
      `INSERT INTO q365_dual_feed_raw
         (symbol, source, exchange, ltp, open_price, high_price, low_price, close_price,
          volume, bid_price, ask_price, source_timestamp, received_at, latency_ms, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), FROM_UNIXTIME(?/1000), ?, ?)`,
      [
        tick.symbol,
        tick.source,
        tick.exchange,
        tick.ltp,
        tick.open,
        tick.high,
        tick.low,
        tick.close,
        tick.volume,
        tick.bid,
        tick.ask,
        tick.sourceTimestamp,
        tick.receivedAt,
        tick.latencyMs,
        tick.raw ? JSON.stringify(tick.raw) : null,
      ],
    );
  } catch {
    // audit write is best-effort
  }
}

export async function storeValidationPipeline(
  validation: FeedValidationResult,
  approval: ApprovalDecision,
  confirmation: ConfirmationResult,
): Promise<void> {
  await ensureSchema();
  try {
    const { db } = await import('@/lib/db');
    await db.query(
      `INSERT INTO q365_dual_feed_validation
         (symbol, validated_at, validation_status, approval_status, confirmation_status,
          confidence_score, confidence_band, price_diff_bps, volume_diff_pct, timestamp_skew_ms,
          yahoo_ltp, indian_ltp, authoritative_source, authoritative_ltp,
          reasons_json, metrics_json)
       VALUES (?, FROM_UNIXTIME(?/1000), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        validation.symbol,
        validation.validatedAt,
        validation.status,
        approval.status,
        confirmation.status,
        approval.confidenceScore,
        approval.confidenceBand,
        validation.metrics.priceDiffBps,
        validation.metrics.volumeDiffPct,
        validation.metrics.timestampSkewMs,
        validation.yahoo?.ltp ?? null,
        validation.indianapi?.ltp ?? null,
        approval.authoritativeSource,
        approval.authoritativeLtp,
        JSON.stringify(validation.reasons),
        JSON.stringify(validation.metrics),
      ],
    );
  } catch {
    // audit write is best-effort
  }
}
