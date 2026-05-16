// ════════════════════════════════════════════════════════════════
//  executionWorker — consumes `signals_stream` and routes each
//  signal to the order placement layer. Uses the same consumer-
//  group + XAUTOCLAIM pattern as strategyWorker so execution
//  horizontally scales and recovers from crashes.
//
//  This is intentionally a thin skeleton — the actual order-
//  placement logic lives in src/lib/execution/*. The worker's job
//  is to pull signals off Redis, call into that layer, and XACK.
// ════════════════════════════════════════════════════════════════

import Redis from 'ioredis';
import {
  SIGNALS_STREAM,
  EXECUTION_GROUP,
  BLOCK_MS,
  CLAIM_IDLE_MS,
  createRedis,
  ensureGroup,
  fieldsToObject,
  parseSignalEntry,
  type SignalStreamEntry,
} from './streams';
import { createLogger } from './pipelineLogger';
import { recordProcessed, recordError } from './pipelineMetrics';
import { evaluateRisk, DEFAULT_RISK_CONFIG, type RiskConfig } from './riskManager';
import { snapshot as portfolioSnapshot, onFill, loadPortfolio, persistPortfolio } from './portfolioTracker';

const log = createLogger('executionWorker');

export interface ExecutionResult {
  accepted: boolean;
  reason?:  string;
  quantity: number;
  fillPrice: number;
}

export type ExecutionHandler = (
  signal:   SignalStreamEntry,
  quantity: number,
) => Promise<ExecutionResult>;

export interface ExecutionWorkerOptions {
  consumerId:  string;
  handler:     ExecutionHandler;
  batchSize?:  number;
  riskConfig?: RiskConfig;
}

export class ExecutionWorker {
  private readonly redis: Redis;
  private readonly consumerId: string;
  private readonly handler: ExecutionHandler;
  private readonly batchSize: number;
  private readonly riskConfig: RiskConfig;
  private running = false;

  constructor(opts: ExecutionWorkerOptions) {
    this.redis      = createRedis();
    this.consumerId = opts.consumerId;
    this.handler    = opts.handler;
    this.batchSize  = opts.batchSize ?? 10;
    this.riskConfig = opts.riskConfig ?? DEFAULT_RISK_CONFIG;
  }

  async start(): Promise<void> {
    await ensureGroup(this.redis, SIGNALS_STREAM, EXECUTION_GROUP);
    await loadPortfolio();
    await this.reclaimPending();
    this.running = true;
    log.info('started', { consumer: this.consumerId });

    while (this.running) {
      try {
        await this.tickBatch();
      } catch (err) {
        recordError('execution', err as Error);
        log.error('loop error', { err: (err as Error).message });
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    await this.redis.quit().catch(() => { /* noop */ });
    log.info('stopped', { consumer: this.consumerId });
  }

  stop(): void {
    this.running = false;
  }

  private async tickBatch(): Promise<void> {
    const res = await this.redis.xreadgroup(
      'GROUP',  EXECUTION_GROUP, this.consumerId,
      'COUNT',  this.batchSize,
      'BLOCK',  BLOCK_MS,
      'STREAMS', SIGNALS_STREAM, '>',
    ) as Array<[string, Array<[string, string[]]>]> | null;
    if (!res) return;

    for (const [, entries] of res) {
      for (const [id, flat] of entries) {
        await this.handleEntry(id, flat);
      }
    }
  }

  private async handleEntry(id: string, flat: string[]): Promise<void> {
    const t0 = Date.now();
    const obj = fieldsToObject(flat);
    const signal = parseSignalEntry(obj);
    if (!signal) {
      await this.redis.xack(SIGNALS_STREAM, EXECUTION_GROUP, id);
      return;
    }

    try {
      // 1. Risk gate — evaluate against the live portfolio snapshot.
      const verdict = evaluateRisk(signal, portfolioSnapshot(), this.riskConfig);
      if (!verdict.ok || !verdict.sizedQuantity) {
        log.warn('risk rejected', {
          id:     signal.id,
          symbol: signal.symbol,
          code:   verdict.code,
          reason: verdict.reason,
        });
        await this.redis.xack(SIGNALS_STREAM, EXECUTION_GROUP, id);
        return;
      }

      // 2. Hand to the broker adapter.
      const result = await this.handler(signal, verdict.sizedQuantity);

      // 3. If filled, update the portfolio ledger + persist.
      if (result.accepted) {
        onFill({
          symbol: signal.symbol,
          side:   signal.direction,
          qty:    result.quantity,
          price:  result.fillPrice,
          ts:     Date.now(),
        });
        await persistPortfolio().catch((e: Error) => log.warn('portfolio persist failed', { err: e.message }));
      }

      await this.redis.xack(SIGNALS_STREAM, EXECUTION_GROUP, id);
      recordProcessed('execution', Date.now() - t0);
      log.info('executed', {
        id:       signal.id,
        symbol:   signal.symbol,
        dir:      signal.direction,
        entry:    signal.entry,
        qty:      result.quantity,
        accepted: result.accepted,
        reason:   result.reason ?? null,
      });
    } catch (err) {
      recordError('execution', err as Error);
      log.error('execution failed', {
        id:     signal.id,
        symbol: signal.symbol,
        err:    (err as Error).message,
      });
      // Don't XACK — leave on PEL for retry/claim by another worker.
    }
  }

  private async reclaimPending(): Promise<void> {
    try {
      const res = await this.redis.xautoclaim(
        SIGNALS_STREAM,
        EXECUTION_GROUP,
        this.consumerId,
        CLAIM_IDLE_MS,
        '0-0',
        'COUNT', 100,
      ) as [string, Array<[string, string[]]>] | null;
      const claimed = res?.[1] ?? [];
      if (claimed.length > 0) {
        log.info('reclaimed pending', { count: claimed.length });
        for (const [id, flat] of claimed) await this.handleEntry(id, flat);
      }
    } catch (err) {
      log.warn('xautoclaim failed', { err: (err as Error).message });
    }
  }
}

// ── CLI entry ──────────────────────────────────────────────────
if (require.main === module) {
  const consumerId = process.env.WORKER_ID ?? `execution-${process.pid}`;

  // Plug in the real execution pipeline. Keep the import dynamic so
  // the worker can boot even if the execution module is being
  // refactored — it'll fail on the first signal instead of at boot.
  const handler: ExecutionHandler = async (signal, quantity) => {
    const { placeOrder } = await import('@/lib/execution/placeOrder');
    const res = await placeOrder({
      symbol:    signal.symbol,
      type:      signal.direction,
      quantity,
      orderType: 'LIMIT',
      price:     signal.entry,
      exchange:  'NSE',
      product:   'MIS',
    });
    return {
      accepted:  res.ok,
      reason:    res.error,
      quantity,
      fillPrice: signal.entry,
    };
  };

  const worker = new ExecutionWorker({ consumerId, handler });
  worker.start().catch((e: Error) => {
    log.error('fatal', { err: e.message });
    process.exit(1);
  });

  const shutdown = (): void => {
    log.info('SIGINT/SIGTERM received — draining');
    worker.stop();
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}
