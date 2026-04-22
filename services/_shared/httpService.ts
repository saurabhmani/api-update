// ════════════════════════════════════════════════════════════════
//  Shared HTTP service helper — cuts 80% of the boilerplate in
//  each service's server.ts. Handlers plug in as route tables.
//
//  Every service that uses this gets for free:
//    • Correlation-id propagation via x-correlation-id
//    • Bearer-token auth against SERVICE_AUTH_TOKEN
//    • Consistent ServiceResponse envelope
//    • Structured request logs
//    • Graceful SIGTERM / SIGINT shutdown
//    • /health handler with uptime + dependency block
// ════════════════════════════════════════════════════════════════

import http from 'node:http';
import { ensureCorrelationId, CORRELATION_HEADER } from '@contracts/correlation';
import type { HealthResponse, ServiceResponse } from '@contracts/api';
import { logger } from '@/lib/logger';

export type HandlerResult<T> = ServiceResponse<T> | { status: number; body: unknown };

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (ctx: RouteContext) => Promise<HandlerResult<unknown>>;
}

export interface RouteContext {
  method: string;
  pathOnly: string;
  query: Record<string, string>;
  body: unknown;
  correlationId: string;
  req: http.IncomingMessage;
}

export interface ServiceOptions {
  name: string;
  version: string;
  port: number;
  routes: RouteDef[];
  /** Optional health dependency probe — reports into HealthResponse.dependencies. */
  probeDependencies?: () => Promise<Record<string, 'ok' | 'degraded' | 'down'>>;
  /** Hooks that run once at startup (e.g. bus.subscribe wiring). */
  onStart?: () => Promise<void> | void;
}

function parseQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const idx = url.indexOf('?');
  if (idx === -1) return q;
  new URLSearchParams(url.slice(idx + 1)).forEach((v, k) => { q[k] = v; });
  return q;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); }
      catch { resolve(raw); }
    });
    req.on('error', () => resolve(undefined));
  });
}

function writeJson(res: http.ServerResponse, status: number, body: unknown, cid: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader(CORRELATION_HEADER, cid);
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export async function startHttpService(opts: ServiceOptions): Promise<http.Server> {
  const log = logger.child({ service: opts.name, port: opts.port });
  const AUTH = process.env.SERVICE_AUTH_TOKEN?.trim() || null;
  if (!AUTH && process.env.NODE_ENV === 'production') {
    throw new Error(`${opts.name}: SERVICE_AUTH_TOKEN required in production`);
  }
  const startedAt = Date.now();

  function authOk(req: http.IncomingMessage): boolean {
    if (!AUTH) return true;
    return req.headers['authorization'] === `Bearer ${AUTH}`;
  }

  if (opts.onStart) await opts.onStart();

  const server = http.createServer(async (req, res) => {
    const cid = ensureCorrelationId(req.headers as Record<string, unknown>);
    const t0 = Date.now();
    try {
      if (!authOk(req)) {
        writeJson(res, 401, { ok: false, error: 'unauthorized', correlation_id: cid }, cid);
        return;
      }

      const pathOnly = (req.url ?? '/').split('?')[0];

      // Built-in /health — always available.
      if (pathOnly === '/health' && req.method === 'GET') {
        const deps = opts.probeDependencies ? await opts.probeDependencies().catch(() => ({})) : {};
        const anyDown = Object.values(deps).includes('down');
        const anyDegraded = Object.values(deps).includes('degraded');
        const body: HealthResponse = {
          service: opts.name,
          version: opts.version,
          status: anyDown ? 'down' : anyDegraded ? 'degraded' : 'ok',
          uptime_sec: Math.round((Date.now() - startedAt) / 1000),
          dependencies: deps,
        };
        writeJson(res, anyDown ? 503 : 200, body, cid);
        return;
      }

      // Route match.
      const route = opts.routes.find(r => r.method === req.method && r.path === pathOnly);
      if (!route) {
        writeJson(res, 404, { ok: false, error: 'not found', correlation_id: cid }, cid);
        return;
      }

      const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : undefined;
      const result = await route.handler({
        method: req.method!,
        pathOnly,
        query: parseQuery(req.url ?? ''),
        body,
        correlationId: cid,
        req,
      });

      if ('status' in result) {
        writeJson(res, result.status, result.body, cid);
      } else {
        writeJson(res, result.ok ? 200 : 500, result, cid);
      }
    } catch (err) {
      log.error('unhandled', {
        correlation_id: cid,
        error: err instanceof Error ? err.message : String(err),
      });
      writeJson(res, 500, { ok: false, error: 'internal error', correlation_id: cid }, cid);
    } finally {
      log.info('request', {
        correlation_id: cid,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        elapsedMs: Date.now() - t0,
      });
    }
  });

  server.listen(opts.port, () => {
    log.info(`${opts.name} listening`, { port: opts.port, authEnabled: !!AUTH });
  });

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));

  return server;
}

export function ok<T>(data: T, correlationId: string): ServiceResponse<T> {
  return { ok: true, data, correlation_id: correlationId };
}
export function err(code: string, error: string, correlationId: string): ServiceResponse<never> {
  return { ok: false, code, error, correlation_id: correlationId } as ServiceResponse<never>;
}
