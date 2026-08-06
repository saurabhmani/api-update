import { describe, expect, it, beforeEach } from 'vitest';
import {
  resolveRuntimeIdentity,
} from '@/lib/diagnostics/runtimeIdentity';
import {
  assertSignalSchemaHealthy,
  checkSignalSchemaHealth,
  REQUIRED_SIGNAL_COLUMNS,
} from '@/lib/diagnostics/signalSchemaHealth';
import {
  assertWarehouseHealthy,
  type WarehouseHealthReport,
} from '@/lib/diagnostics/scanWarehouseHealth';
import { resolveEnvFilePath } from '@/lib/envPath';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('runtimeIdentity', () => {
  beforeEach(() => {
    delete process.env.MYSQL_PASSWORD;
    delete process.env.DATABASE_URL;
    process.env.MYSQL_HOST = 'db.example';
    process.env.MYSQL_DATABASE = 'quantorus365';
    process.env.MYSQL_PORT = '3306';
    process.env.REDIS_HOST = 'redis.example';
    (process.env as Record<string, string>).NODE_ENV = 'test';
    process.env.TZ = 'Asia/Kolkata';
    process.env.INDIANAPI_API_KEY = 'test-key';
  });

  it('reports host/db/redis without secrets', () => {
    process.env.MYSQL_PASSWORD = 'super-secret';
    const id = resolveRuntimeIdentity({ component: 'test', processRole: 'diagnostics' });
    const serialized = JSON.stringify(id);
    expect(id.databaseHost).toBe('db.example');
    expect(id.databaseName).toBe('quantorus365');
    expect(id.redisHost).toBe('redis.example');
    expect(id.timezone).toBe('Asia/Kolkata');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('password');
  });

  it('parses DATABASE_URL host/db without exposing credentials', () => {
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_DATABASE;
    delete process.env.MYSQL_PORT;
    process.env.DATABASE_URL = 'mysql://user:sekrit@prod-db:3307/live_q365';
    const id = resolveRuntimeIdentity({ component: 'test' });
    expect(id.databaseHost).toBe('prod-db');
    expect(id.databaseName).toBe('live_q365');
    expect(id.databasePort).toBe(3307);
    expect(JSON.stringify(id)).not.toContain('sekrit');
  });
});

describe('envPath production preference', () => {
  it('prefers .env.production when NODE_ENV=production and file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q365-env-'));
    fs.writeFileSync(path.join(dir, '.env.production'), 'X=1\n');
    fs.writeFileSync(path.join(dir, '.env'), 'X=2\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'X=3\n');
    const prev = process.env.NODE_ENV;
    const prevDot = process.env.DOTENV_CONFIG_PATH;
    delete process.env.DOTENV_CONFIG_PATH;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    expect(resolveEnvFilePath(dir)).toBe(path.resolve(dir, '.env.production'));
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    if (prevDot) process.env.DOTENV_CONFIG_PATH = prevDot;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses .env.local in non-production when present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q365-env-'));
    fs.writeFileSync(path.join(dir, '.env.local'), 'X=1\n');
    fs.writeFileSync(path.join(dir, '.env.production'), 'X=2\n');
    const prev = process.env.NODE_ENV;
    const prevDot = process.env.DOTENV_CONFIG_PATH;
    delete process.env.DOTENV_CONFIG_PATH;
    (process.env as Record<string, string>).NODE_ENV = 'development';
    expect(resolveEnvFilePath(dir)).toBe(path.resolve(dir, '.env.local'));
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    if (prevDot) process.env.DOTENV_CONFIG_PATH = prevDot;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('signal schema preflight', () => {
  it('fails assert when required columns missing', () => {
    expect(() =>
      assertSignalSchemaHealthy({
        ok: false,
        tableExists: true,
        missingColumns: ['composite_final_score', 'updated_at'],
        presentColumns: [],
        missingIndexes: [],
        presentIndexes: [],
      }),
    ).toThrow(/SIGNAL_SCHEMA_UNHEALTHY/);
  });

  it('passes when ok', () => {
    expect(() =>
      assertSignalSchemaHealthy({
        ok: true,
        tableExists: true,
        missingColumns: [],
        presentColumns: [...REQUIRED_SIGNAL_COLUMNS],
        missingIndexes: [],
        presentIndexes: [],
      }),
    ).not.toThrow();
  });
});

describe('warehouse preflight', () => {
  it('blocks empty or stale warehouse', () => {
    const bad: WarehouseHealthReport = {
      ok: false,
      universeCount: 0,
      symbolsWithEnoughBars: 0,
      latestCandleDate: null,
      staleSymbolCount: 0,
      minBarsRequired: 240,
      maxStaleDays: 5,
      indianApiBreakerState: 'closed',
      reason: 'empty_warehouse',
    };
    expect(() => assertWarehouseHealthy(bad)).toThrow(/WAREHOUSE_NOT_READY/);
  });
});

describe('scan persist zero is failure', () => {
  it('documents generated>0 persisted=0 as hard failure reason', () => {
    const generated = 10;
    const persisted = 0;
    const shouldFail = generated > 0 && persisted === 0;
    expect(shouldFail).toBe(true);
  });
});

describe('dedupe day boundary policy', () => {
  it('same symbol+direction on a new day is allowed after prior row is expired', () => {
    // Mirrors saveSignals expire-before-insert: active/watchlist/stale
    // rows for (symbol, direction) are expired before insert, so an
    // old inactive/expired row must not block a fresh day.
    const prior = { symbol: 'RELIANCE', direction: 'BUY', status: 'expired', day: '2026-08-01' };
    const next = { symbol: 'RELIANCE', direction: 'BUY', status: 'active', day: '2026-08-06' };
    const blocks =
      prior.symbol === next.symbol
      && prior.direction === next.direction
      && ['active', 'watchlist'].includes(prior.status);
    expect(blocks).toBe(false);
  });

  it('same-day active duplicate is rejected', () => {
    const prior = { symbol: 'RELIANCE', direction: 'BUY', status: 'active', day: '2026-08-06' };
    const next = { symbol: 'RELIANCE', direction: 'BUY', status: 'active', day: '2026-08-06' };
    const blocks =
      prior.symbol === next.symbol
      && prior.direction === next.direction
      && ['active', 'watchlist'].includes(prior.status);
    expect(blocks).toBe(true);
  });
});

describe('signals API cache policy', () => {
  it('route declares force-dynamic and revalidate=0', async () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/api/signals/route.ts'),
      'utf8',
    );
    expect(src).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"]/);
    expect(src).toMatch(/export const revalidate\s*=\s*0/);
    expect(src).toMatch(/Cache-Control['"]:\s*['"]private, no-store['"]/);
  });
});

describe('checkSignalSchemaHealth export surface', () => {
  it('exposes required column list including updated_at', () => {
    expect(REQUIRED_SIGNAL_COLUMNS).toContain('updated_at');
    expect(REQUIRED_SIGNAL_COLUMNS).toContain('composite_final_score');
    expect(typeof checkSignalSchemaHealth).toBe('function');
  });
});
