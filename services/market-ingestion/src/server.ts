// ════════════════════════════════════════════════════════════════
//  market-ingestion — standalone HTTP server
//
//  Node's built-in `http` (no Express / Fastify dependency) keeps
//  the service deployable as a single TS file + tsx. Trivial to
//  swap to Fastify once we need middleware / validation.
//
//  Run locally:
//    tsx services/market-ingestion/src/server.ts
//    curl "http://localhost:4100/snapshot?symbol=RELIANCE"
//    curl "http://localhost:4100/health"
// ════════════════════════════════════════════════════════════════

// ⚠ ORDER MATTERS: the env loader must run BEFORE any import that
// consumes process.env (config, providers, adapters). In ESM mode
// (which tsx defaults to on recent Node versions) all `import`
// statements are hoisted above inline statements, so a side-effect
// import is the only way to guarantee the env file is read first.
import '../../_shared/envLoader';

import http from 'node:http';
import { loadConfig } from './config';
import { handleSnapshot, handleHistorical, handleHealth } from './handlers';
import { ensureCorrelationId, CORRELATION_HEADER } from '@contracts/correlation';
import { logger } from '@/lib/logger';

const cfg = loadConfig();
const log = logger.child({ service: 'market-ingestion', port: cfg.port });

function json(res: http.ServerResponse, status: number, body: unknown, correlationId: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(CORRELATION_HEADER, correlationId);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function checkAuth(req: http.IncomingMessage): boolean {
  if (!cfg.serviceAuthToken) return true;  // auth disabled
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string') return false;
  return auth === `Bearer ${cfg.serviceAuthToken}`;
}

function parseQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const idx = url.indexOf('?');
  if (idx === -1) return q;
  const sp = new URLSearchParams(url.slice(idx + 1));
  sp.forEach((v, k) => { q[k] = v; });
  return q;
}

const logLine = (level: string, msg: string, meta?: Record<string, unknown>) => {
  const fn = (log as unknown as Record<string, (m: string, d?: unknown) => void>)[level] ?? log.info;
  fn.call(log, msg, meta);
};

const server = http.createServer(async (req, res) => {
  const correlationId = ensureCorrelationId(req.headers as Record<string, unknown>);
  const start = Date.now();

  try {
    if (!checkAuth(req)) {
      json(res, 401, { ok: false, error: 'unauthorized', correlation_id: correlationId }, correlationId);
      return;
    }

    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];
    const query = parseQuery(url);

    if (req.method === 'GET' && pathOnly === '/snapshot') {
      const body = await handleSnapshot(
        {
          symbol: query.symbol,
          signalCritical: query.signalCritical === '1' || query.signalCritical === 'true',
          forceRefresh: query.forceRefresh === '1' || query.forceRefresh === 'true',
        },
        correlationId,
        logLine,
      );
      json(res, body.ok ? 200 : body.code === 'BAD_REQUEST' ? 400 : body.code === 'STALE' ? 503 : 500, body, correlationId);
      return;
    }

    if (req.method === 'GET' && pathOnly === '/historical') {
      const body = await handleHistorical(
        { symbol: query.symbol, range: query.range },
        correlationId,
        logLine,
      );
      json(res, body.ok ? 200 : body.code === 'BAD_REQUEST' ? 400 : body.code === 'STALE' ? 503 : 500, body, correlationId);
      return;
    }

    if (req.method === 'GET' && pathOnly === '/health') {
      const body = handleHealth();
      json(res, body.status === 'down' ? 503 : 200, body, correlationId);
      return;
    }

    json(res, 404, { ok: false, error: 'not found', correlation_id: correlationId }, correlationId);
  } catch (err) {
    log.error('unhandled error', {
      correlation_id: correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    json(res, 500, { ok: false, error: 'internal error', correlation_id: correlationId }, correlationId);
  } finally {
    log.info('request', {
      correlation_id: correlationId,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      elapsedMs: Date.now() - start,
    });
  }
});

server.listen(cfg.port, () => {
  log.info('market-ingestion listening', {
    port: cfg.port,
    yahooEnabled: cfg.yahooEnabled,
    indianApiConfigured: !!cfg.indianApiKey,
    authEnabled: !!cfg.serviceAuthToken,
  });
});

function shutdown(signal: string): void {
  log.info('shutdown signal', { signal });
  server.close(() => {
    log.info('server closed');
    process.exit(0);
  });
  // Fail-safe: force exit after 5s if close hangs.
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
