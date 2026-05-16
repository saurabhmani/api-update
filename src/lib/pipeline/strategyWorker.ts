// ════════════════════════════════════════════════════════════════
//  strategyWorker — consumes `market_ticks` via XREADGROUP, runs
//  the strategy decision function against each tick, and publishes
//  any resulting signal to `signals_stream`.
//
//  Fault tolerance
//  ───────────────
//  1. Consumer groups: each tick is delivered to exactly one worker.
//     Scale out by starting N processes with the same groupName and
//     distinct consumerId.
//  2. Pending-entries reclaim: on boot, the worker XCLAIMs any
//     entries that were pending for >CLAIM_IDLE_MS (i.e. the
//     previous owner crashed before XACK). This gives at-least-once
//     delivery without an external coordinator.
//  3. Per-entry try/catch: a single bad tick never takes down the
//     loop. Errors are counted, logged, and the entry is still
//     XACKed (move-poison-on) OR left unacked (retry) depending on
//     `poisonOnError`.
//  4. Graceful SIGINT/SIGTERM: the worker finishes the current
//     batch, quits its Redis connection, and exits 0.
// ════════════════════════════════════════════════════════════════

import Redis from 'ioredis';
import {
  MARKET_TICKS_STREAM,
  SIGNALS_STREAM,
  SIGNALS_MAXLEN,
  STRATEGY_GROUP,
  BLOCK_MS,
  CLAIM_IDLE_MS,
  createRedis,
  ensureGroup,
  fieldsToObject,
  parseTickEntry,
  type TickStreamEntry,
  type SignalStreamEntry,
} from './streams';
import { createLogger } from './pipelineLogger';
import { recordProcessed, recordError } from './pipelineMetrics';
import { onPriceUpdate } from './portfolioTracker';

const log = createLogger('strategyWorker');

export type StrategyFn = (tick: TickStreamEntry) => Promise<SignalStreamEntry | null> | SignalStreamEntry | null;

export interface StrategyWorkerOptions {
  consumerId:  string;
  strategy:    StrategyFn;
  /** If true, XACK entries that threw so the poison pill can't re-block. */
  poisonOnError?: boolean;
  batchSize?: number;
}

export class StrategyWorker {
  private readonly redis: Redis;
  private readonly consumerId: string;
  private readonly strategy: StrategyFn;
  private readonly poisonOnError: boolean;
  private readonly batchSize: number;
  private running = false;

  constructor(opts: StrategyWorkerOptions) {
    this.redis         = createRedis();
    this.consumerId    = opts.consumerId;
    this.strategy      = opts.strategy;
    this.poisonOnError = opts.poisonOnError ?? true;
    this.batchSize     = opts.batchSize ?? 50;
  }

  async start(): Promise<void> {
    await ensureGroup(this.redis, MARKET_TICKS_STREAM, STRATEGY_GROUP);
    await this.reclaimPending();
    this.running = true;
    log.info('started', { consumer: this.consumerId });

    while (this.running) {
      try {
        await this.tickBatch();
      } catch (err) {
        recordError('strategy', err as Error);
        log.error('loop error', { err: (err as Error).message });
        // Don't busy-loop on upstream failure.
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
      'GROUP',  STRATEGY_GROUP, this.consumerId,
      'COUNT',  this.batchSize,
      'BLOCK',  BLOCK_MS,
      'STREAMS', MARKET_TICKS_STREAM, '>',
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
    const tick = parseTickEntry(obj);

    if (!tick) {
      await this.redis.xack(MARKET_TICKS_STREAM, STRATEGY_GROUP, id);
      return;
    }

    try {
      // Mark-to-market: update any open position's last price so
      // the portfolio snapshot (and the risk manager that consumes
      // it) always reflects the latest tape. Event-driven, no poll.
      onPriceUpdate(tick.symbol, tick.ltp);

      const signal = await this.strategy(tick);
      if (signal) await this.publishSignal(signal);
      await this.redis.xack(MARKET_TICKS_STREAM, STRATEGY_GROUP, id);
      recordProcessed('strategy', Date.now() - t0);
    } catch (err) {
      recordError('strategy', err as Error);
      log.error('strategy threw', {
        id,
        symbol: tick.symbol,
        err:    (err as Error).message,
      });
      if (this.poisonOnError) {
        await this.redis.xack(MARKET_TICKS_STREAM, STRATEGY_GROUP, id);
      }
    }
  }

  private async publishSignal(s: SignalStreamEntry): Promise<void> {
    await this.redis.xadd(
      SIGNALS_STREAM,
      'MAXLEN', '~', String(SIGNALS_MAXLEN),
      '*',
      'id',       s.id,
      'sym',      s.symbol,
      'dir',      s.direction,
      'entry',    String(s.entry),
      'stop',     String(s.stop),
      'target',   String(s.target),
      'conf',     String(s.confidence),
      'strategy', s.strategy,
      'ts',       String(s.ts),
    );
  }

  /**
   * Recover entries that the previous owner (same consumer id, now
   * dead) never ACKed. We claim anything idle for CLAIM_IDLE_MS so
   * that a crashed worker's backlog is replayed by whoever boots
   * next — at-least-once delivery without a coordinator.
   */
  private async reclaimPending(): Promise<void> {
    try {
      // XAUTOCLAIM returns [nextStart, claimed[]].
      const res = await this.redis.xautoclaim(
        MARKET_TICKS_STREAM,
        STRATEGY_GROUP,
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
// Run with: node --import tsx src/lib/pipeline/strategyWorker.ts
if (require.main === module) {
  const consumerId = process.env.WORKER_ID ?? `strategy-${process.pid}`;

  // Default to the EMA/RSI crossover strategy. Swap this out for
  // generatePhase4Signals or any other StrategyFn-shaped wrapper.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createEmaRsiStrategy } = require('./strategies/emaRsiStrategy') as {
    createEmaRsiStrategy: () => StrategyFn;
  };
  const strategy = createEmaRsiStrategy();

  const worker = new StrategyWorker({ consumerId, strategy });
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
