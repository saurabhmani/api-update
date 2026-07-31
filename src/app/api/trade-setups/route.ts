import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { cacheKeys } from '@/lib/cache/cacheKeys';
import { cacheService } from '@/lib/cache/cacheService';
import { CACHE_POLICIES } from '@/lib/cache/cachePolicy';
import {
  cacheAcquireDistributedLock,
  cacheReleaseLock,
} from '@/lib/redis';
import { db } from '@/lib/db';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import { ENGINE_VERSION } from '@/lib/signal-engine/constants/engineVersion';
import { generateSignal, type Signal } from '@/lib/signal-engine/live/analyzeInstrument';
import { getRegistryEntry } from '@/lib/strategy-hub/registry';
import { requireSession } from '@/lib/session';
import {
  getLatestCompletedTradingDay,
  getMarketStatus,
} from '@/lib/marketData/marketHours';
import { logger } from '@/lib/logger';
import { resolvePrice } from '@/lib/marketData/resolver/marketDataResolver';
import {
  observeProvider,
  observeRedis,
  recordTradeSetupDeduplicated,
  recordTradeSetupGeneration,
} from '@/lib/monitor/apiPerformanceMetrics';
import { VALIDITY_HOURS } from '@/lib/constants/signals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PROVIDER_TIMEOUT_MS = 20_000;
const DATABASE_TIMEOUT_MS = 5_000;
const LOCK_TTL_SECONDS = 45;
const ALLOWED_TIMEFRAMES = new Set(['swing']);
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9&.-]{0,29}$/;
const inFlight = new Map<string, Promise<GenerationPayload>>();
const log = logger.child({ component: 'tradeSetupApi' });

interface GenerationRequest {
  symbol: string;
  strategyId: string;
  timeframe: 'swing';
  force: boolean;
}

interface InstrumentRef {
  instrument_key: string;
  tradingsymbol: string;
  exchange: string;
}

interface TradeSetup {
  id?: number;
  tradingsymbol: string;
  exchange: string;
  direction: string;
  entry_price: number;
  stop_loss: number;
  target1: number;
  target2: number | null;
  risk_reward: number;
  confidence: number;
  timeframe: string;
  reason: string;
  scenario_tag: string;
  regime: string;
  expires_at: Date | string;
  created_at?: Date | string;
}

interface GenerationPayload {
  success: true;
  setup: TradeSetup | null;
  setups: TradeSetup[];
  generationStatus: 'complete' | 'no_setup';
  reused?: boolean;
  note: string;
}

class TimeoutError extends Error {
  constructor(readonly operation: 'database' | 'provider') {
    super(`${operation}_timeout`);
  }
}

function isSchemaError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'ER_NO_SUCH_TABLE'
    || code === 'ER_BAD_FIELD_ERROR'
    || /doesn't exist|unknown column|no such table/i.test(message)
  );
}

function databaseFailureResponse(error: unknown): NextResponse {
  if (error instanceof TimeoutError) {
    return NextResponse.json({
      error: 'Database operation timed out. Please retry.',
      code: 'DATABASE_TIMEOUT',
    }, { status: 504 });
  }
  if (isSchemaError(error)) {
    log.error('Trade setups schema missing or outdated', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({
      error: 'Trade setups storage is not ready. Please retry in a moment.',
      code: 'TRADE_SETUPS_SCHEMA_UNAVAILABLE',
    }, { status: 503 });
  }
  log.error('Trade setups database failure', error instanceof Error ? error : new Error(String(error)));
  return NextResponse.json({
    error: 'Unable to load trade setups right now. Please retry.',
    code: 'TRADE_SETUPS_DATABASE_ERROR',
  }, { status: 500 });
}

async function ensureTradeSetupStorage(): Promise<void> {
  await ensureAllSchemas().catch((err) => {
    log.warn('ensureAllSchemas during trade-setups failed', {
      error_name: err instanceof Error ? err.name : 'UnknownError',
    });
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: 'database' | 'provider',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(operation)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function validateBody(body: unknown): GenerationRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  const strategyId = String(input.strategyId ?? '').trim();
  const timeframe = String(input.timeframe ?? '').trim().toLowerCase();
  if (
    !SYMBOL_PATTERN.test(symbol) ||
    !strategyId ||
    !ALLOWED_TIMEFRAMES.has(timeframe) ||
    (strategyId !== 'auto' && !getRegistryEntry(strategyId))
  ) return null;
  return {
    symbol,
    strategyId,
    timeframe: timeframe as 'swing',
    force: input.force === true,
  };
}

async function resolveAuthorizedInstrument(
  userId: string | number,
  symbol: string,
): Promise<InstrumentRef | null> {
  const { rows } = await withTimeout(
    db.query<InstrumentRef>(
      `SELECT candidate.instrument_key, candidate.tradingsymbol, candidate.exchange
         FROM (
           SELECT instrument_key, tradingsymbol, exchange
             FROM rankings WHERE UPPER(tradingsymbol)=?
           UNION
           SELECT instrument_key, tradingsymbol, exchange
             FROM watchlist_items wi
             JOIN watchlists w ON w.id=wi.watchlist_id
            WHERE w.user_id=? AND UPPER(wi.tradingsymbol)=?
           UNION
           SELECT pp.instrument_key, pp.tradingsymbol, pp.exchange
             FROM portfolio_positions pp
             JOIN portfolios p ON p.id=pp.portfolio_id
            WHERE p.user_id=? AND UPPER(pp.tradingsymbol)=?
           UNION
           SELECT instrument_key, tradingsymbol, exchange
             FROM instruments WHERE UPPER(tradingsymbol)=?
         ) candidate
        LIMIT 1`,
      [symbol, userId, symbol, userId, symbol, symbol],
    ),
    DATABASE_TIMEOUT_MS,
    'database',
  );
  return rows[0] ?? null;
}

async function loadFreshnessVersion(symbol: string): Promise<string> {
  const { rows } = await withTimeout(
    db.query<{ latest: Date | string | null }>(
      `SELECT MAX(ts) AS latest FROM market_data_daily WHERE UPPER(symbol)=?`,
      [symbol],
    ),
    DATABASE_TIMEOUT_MS,
    'database',
  );
  const latest = rows[0]?.latest;
  return latest ? new Date(latest).toISOString() : 'no-candle-version';
}

async function loadRecentSetup(
  userId: string | number,
  identity: string,
): Promise<TradeSetup | null> {
  const { rows } = await withTimeout(
    db.query<TradeSetup>(
      `SELECT id, tradingsymbol, exchange, direction, entry_price, stop_loss,
              target1, target2, risk_reward, confidence, timeframe, reason,
              scenario_tag, regime, expires_at, created_at
         FROM trade_setups
        WHERE user_id=? AND generation_identity=? AND status='active'
          AND (expires_at IS NULL OR expires_at>NOW())
        LIMIT 1`,
      [userId, identity],
    ),
    DATABASE_TIMEOUT_MS,
    'database',
  );
  return rows[0] ?? null;
}

function signalToSetup(signal: Signal): TradeSetup {
  const hours = VALIDITY_HOURS[signal.timeframe as keyof typeof VALIDITY_HOURS]
    ?? VALIDITY_HOURS.swing;
  return {
    tradingsymbol: signal.tradingsymbol,
    exchange: signal.exchange,
    direction: signal.direction,
    entry_price: signal.entry_price,
    stop_loss: signal.stop_loss,
    target1: signal.target1,
    target2: signal.target2 || null,
    risk_reward: signal.risk_reward,
    confidence: signal.confidence,
    timeframe: signal.timeframe,
    reason: signal.reasons.slice(0, 3).map((reason) => reason.text).join('. '),
    scenario_tag: signal.scenario_tag,
    regime: signal.regime,
    expires_at: new Date(Date.now() + hours * 60 * 60 * 1000),
  };
}

/** Mark prior active setups for this user+symbol as expired before inserting a fresh one. */
async function expirePriorActiveSetups(
  userId: string | number,
  symbol: string,
  keepIdentity: string,
): Promise<void> {
  await withTimeout(
    db.query(
      `UPDATE trade_setups
          SET status='expired', updated_at=NOW()
        WHERE user_id=? AND UPPER(tradingsymbol)=? AND status='active'
          AND (generation_identity IS NULL OR generation_identity<>?)`,
      [userId, symbol.toUpperCase(), keepIdentity],
    ),
    DATABASE_TIMEOUT_MS,
    'database',
  );
}

async function persistSetup(
  userId: string | number,
  identity: string,
  strategyId: string,
  instrument: InstrumentRef,
  setup: TradeSetup,
): Promise<void> {
  await expirePriorActiveSetups(userId, setup.tradingsymbol, identity);
  await withTimeout(
    db.query(
      `INSERT INTO trade_setups
        (user_id, generation_identity, strategy_id, instrument_key,
         tradingsymbol, exchange, direction, entry_price, stop_loss, target1,
         target2, risk_reward, confidence, timeframe, reason, scenario_tag,
         regime, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
         direction=VALUES(direction), entry_price=VALUES(entry_price),
         stop_loss=VALUES(stop_loss), target1=VALUES(target1),
         target2=VALUES(target2), risk_reward=VALUES(risk_reward),
         confidence=VALUES(confidence), reason=VALUES(reason),
         scenario_tag=VALUES(scenario_tag), regime=VALUES(regime),
         status='active', expires_at=VALUES(expires_at), updated_at=NOW()`,
      [
        userId, identity, strategyId, instrument.instrument_key,
        setup.tradingsymbol, setup.exchange, setup.direction,
        setup.entry_price, setup.stop_loss, setup.target1, setup.target2,
        setup.risk_reward, setup.confidence, setup.timeframe, setup.reason,
        setup.scenario_tag, setup.regime, setup.expires_at,
      ],
    ),
    DATABASE_TIMEOUT_MS,
    'database',
  );
}

async function generateOne(
  userId: string | number,
  request: GenerationRequest,
  instrument: InstrumentRef,
  identity: string,
): Promise<GenerationPayload> {
  const providerStarted = Date.now();
  const [resolvedPrice, signal] = await withTimeout(
    observeProvider(() => Promise.all([
      resolvePrice(instrument.tradingsymbol),
      generateSignal(
        instrument.instrument_key,
        instrument.tradingsymbol,
        instrument.exchange,
      ),
    ])),
    PROVIDER_TIMEOUT_MS,
    'provider',
  );
  log.info('Provider generation completed', {
    symbol: request.symbol,
    provider: resolvedPrice.source,
    dataQuality: resolvedPrice.quality,
    durationMs: Date.now() - providerStarted,
  });

  const generatedStrategy = signal?.strategy ?? null;
  const eligible = Boolean(
    resolvedPrice.price != null &&
    signal &&
    signal.direction !== 'HOLD' &&
    signal.rejection_reasons.length === 0 &&
    signal.entry_price > 0 &&
    signal.stop_loss > 0 &&
    signal.target1 > 0 &&
    (request.strategyId === 'auto' || generatedStrategy === request.strategyId),
  );
  if (!signal || !eligible) {
    recordTradeSetupGeneration(Date.now() - providerStarted);
    return {
      success: true,
      setup: null,
      setups: [],
      generationStatus: 'no_setup',
      note: request.strategyId !== 'auto' && generatedStrategy
        ? `The current setup matched ${generatedStrategy}, not ${request.strategyId}.`
        : !resolvedPrice.price
          ? `No usable market price for ${request.symbol} — check data sources and retry.`
          : signal?.direction === 'HOLD'
            ? `${request.symbol} has no actionable signal right now (HOLD).`
            : (signal?.rejection_reasons?.length ?? 0) > 0
              ? `${request.symbol} was rejected by risk gates.`
              : 'No setup currently passes the generation and risk gates.',
    };
  }

  const setup = signalToSetup(signal);
  await persistSetup(userId, identity, request.strategyId, instrument, setup);
  recordTradeSetupGeneration(Date.now() - providerStarted);
  return {
    success: true,
    setup,
    setups: [setup],
    generationStatus: 'complete',
    note: `${request.symbol} trade setup generated.`,
  };
}

async function handleGet(req: NextRequest) {
  const user = await requireSession();
  await ensureTradeSetupStorage();
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? 20);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    return NextResponse.json({ error: 'limit must be an integer from 1 to 100' }, { status: 400 });
  }
  try {
    await withTimeout(
      db.query(
        `UPDATE trade_setups SET status='expired', updated_at=NOW()
          WHERE user_id=? AND status='active' AND expires_at IS NOT NULL AND expires_at<=NOW()`,
        [user.id],
      ),
      DATABASE_TIMEOUT_MS,
      'database',
    );

    const { rows } = await withTimeout(
      db.query<TradeSetup>(
        `SELECT id, tradingsymbol, exchange, direction, entry_price, stop_loss,
                target1, target2, risk_reward, confidence, timeframe, reason,
                scenario_tag, regime, expires_at, created_at
           FROM trade_setups
          WHERE user_id=? AND status='active'
            AND (expires_at IS NULL OR expires_at>NOW())
          ORDER BY confidence DESC, created_at DESC LIMIT ?`,
        [user.id, limitRaw],
      ),
      DATABASE_TIMEOUT_MS,
      'database',
    );
    return NextResponse.json({ setups: rows, count: rows.length });
  } catch (error) {
    return databaseFailureResponse(error);
  }
}

async function handlePost(req: NextRequest) {
  const started = Date.now();
  const user = await requireSession();
  await ensureTradeSetupStorage();
  const request = validateBody(await req.json().catch(() => null));
  if (!request) {
    return NextResponse.json({
      error: 'symbol, valid strategyId, and timeframe=swing are required',
    }, { status: 400 });
  }

  try {
    const [instrument, freshnessVersion] = await Promise.all([
      resolveAuthorizedInstrument(user.id, request.symbol),
      loadFreshnessVersion(request.symbol),
    ]);
    if (!instrument) {
      return NextResponse.json({
        error: 'Symbol is not available in your watchlist, portfolio, ranked universe, or instrument master',
      }, { status: 403 });
    }

    const market = getMarketStatus();
    const marketContext = `${getLatestCompletedTradingDay()}:${market.state}`;
    const identity = [
      user.id, request.symbol, request.strategyId, request.timeframe,
      marketContext, ENGINE_VERSION, freshnessVersion,
    ].join('|');
    const resultKey = cacheKeys.tradeSetupGenerationResult(
      user.id,
      request.symbol,
      request.strategyId,
      request.timeframe,
      marketContext,
      ENGINE_VERSION,
      freshnessVersion,
    );

    if (request.force) {
      await cacheService.delete(resultKey);
    } else {
      const cached = await cacheService.get<GenerationPayload>(resultKey);
      if (cached) {
        return NextResponse.json({ ...cached, reused: true }, {
          headers: { 'X-Cache': 'HIT' },
        });
      }
      const recent = await loadRecentSetup(user.id, identity);
      if (recent) {
        const payload: GenerationPayload = {
          success: true,
          setup: recent,
          setups: [recent],
          generationStatus: 'complete',
          reused: true,
          note: 'Recently generated setup reused.',
        };
        await cacheService.set(resultKey, payload, CACHE_POLICIES.tradeSetup);
        return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS-DB' } });
      }
    }

    const existing = inFlight.get(identity);
    if (existing) {
      recordTradeSetupDeduplicated();
      const payload = await existing;
      return NextResponse.json({ ...payload, reused: true }, {
        headers: { 'X-Request-Coalesced': 'true' },
      });
    }

    const lockKey = cacheKeys.tradeSetupRequestLock(
      user.id,
      request.symbol,
      request.strategyId,
      request.timeframe,
    );
    const lockToken = randomUUID();
    const lockState = await observeRedis(() => cacheAcquireDistributedLock(
      lockKey,
      lockToken,
      LOCK_TTL_SECONDS,
    ));
    if (lockState === 'held') {
      recordTradeSetupDeduplicated();
      return NextResponse.json({
        success: true,
        generationStatus: 'in_progress',
        setups: [],
        note: 'An identical trade setup request is already running.',
      }, { status: 202, headers: { 'Retry-After': '2' } });
    }

    const concurrentAfterLock = inFlight.get(identity);
    if (concurrentAfterLock) {
      if (lockState === 'acquired') {
        await observeRedis(() => cacheReleaseLock(lockKey, lockToken));
      }
      recordTradeSetupDeduplicated();
      const payload = await concurrentAfterLock;
      return NextResponse.json({ ...payload, reused: true }, {
        headers: { 'X-Request-Coalesced': 'true' },
      });
    }

    const work = (async () => {
      const afterLock = request.force
        ? null
        : await cacheService.get<GenerationPayload>(resultKey);
      if (afterLock) return { ...afterLock, reused: true };
      const payload = await generateOne(
        user.id,
        request,
        instrument,
        identity,
      );
      await cacheService.set(
        resultKey,
        payload,
        market.isOpen
          ? CACHE_POLICIES.tradeSetup
          : { ttlSeconds: 60 * 60 },
      );
      return payload;
    })();
    inFlight.set(identity, work);

    try {
      const payload = await work;
      log.info('Generation request completed', {
        symbol: request.symbol,
        strategyId: request.strategyId,
        timeframe: request.timeframe,
        marketContext,
        durationMs: Date.now() - started,
        cacheBypassed: request.force,
        redisLock: lockState,
      });
      return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } });
    } finally {
      if (inFlight.get(identity) === work) inFlight.delete(identity);
      if (lockState === 'acquired') {
        await observeRedis(() => cacheReleaseLock(lockKey, lockToken));
      }
    }
  } catch (error) {
    if (error instanceof TimeoutError) {
      return NextResponse.json({
        error: error.operation === 'provider'
          ? 'Market data provider timed out. Please retry.'
          : 'Database operation timed out. Please retry.',
        code: `${error.operation.toUpperCase()}_TIMEOUT`,
      }, { status: 504 });
    }
    if (isSchemaError(error)) {
      return databaseFailureResponse(error);
    }
    log.error('Trade setup generation failed', new Error('Trade setup generation failed'), {
      error_name: error instanceof Error ? error.name : 'UnknownError',
    });
    return NextResponse.json({
      error: 'Trade setup generation failed safely. Please retry.',
      code: 'TRADE_SETUP_GENERATION_FAILED',
    }, { status: 500 });
  }
}

export const GET = withApiHandler(handleGet);
export const POST = withApiHandler(handlePost);
