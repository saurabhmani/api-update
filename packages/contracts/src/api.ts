// ════════════════════════════════════════════════════════════════
//  Service API contracts
//
//  These types describe what each service EXPOSES over HTTP. Shared
//  between publishers (the service implementing the route) and
//  consumers (the RPC client + gateway routes). Treat this file as
//  an internal OpenAPI — renaming a field breaks every caller at
//  compile time, which is exactly what we want.
// ════════════════════════════════════════════════════════════════

import type { MarketSnapshot, HistoricalSeries, ProviderResponse } from '@/types/market';

// Every service response shares this base so clients can branch on
// `ok` without inspecting HTTP status separately.
export interface ServiceOk<T> {
  ok: true;
  data: T;
  correlation_id: string;
}
export interface ServiceErr {
  ok: false;
  error: string;
  code?: string;
  correlation_id: string;
}
export type ServiceResponse<T> = ServiceOk<T> | ServiceErr;

export interface HealthResponse {
  service: string;
  status: 'ok' | 'degraded' | 'down';
  uptime_sec: number;
  version: string;
  dependencies?: Record<string, 'ok' | 'degraded' | 'down'>;
}

// ── market-ingestion ────────────────────────────────────────────────

export interface GetSnapshotQuery   { symbol: string; signalCritical?: boolean; forceRefresh?: boolean }
export type    GetSnapshotResponse  = ProviderResponse<MarketSnapshot>;

export interface GetHistoricalQuery { symbol: string; range?: '1d'|'5d'|'1mo'|'3mo'|'6mo'|'1y'|'5y' }
export type    GetHistoricalResponse = ProviderResponse<HistoricalSeries>;

// ── Service registry — single source of truth for service URLs ──

export const SERVICES = {
  marketIngestion: {
    name: 'market-ingestion',
    envUrl: 'MARKET_INGESTION_URL',
    defaultPort: 4100,
    routes: {
      snapshot:   '/snapshot',
      historical: '/historical',
      health:     '/health',
    },
  },
  marketIntelligence: {
    name: 'market-intelligence',
    envUrl: 'MARKET_INTELLIGENCE_URL',
    defaultPort: 4200,
    routes: {
      news:       '/news',
      events:     '/events',
      health:     '/health',
    },
  },
  alerting: {
    name: 'alerting',
    envUrl: 'ALERTING_URL',
    defaultPort: 4300,
    routes: {
      rules:   '/rules',
      history: '/history',
      health:  '/health',
    },
  },
  signalEngine: {
    name: 'signal-engine',
    envUrl: 'SIGNAL_ENGINE_URL',
    defaultPort: 4400,
    routes: {
      evaluate: '/evaluate',
      signals:  '/signals',
      health:   '/health',
    },
  },
  portfolio: {
    name: 'portfolio',
    envUrl: 'PORTFOLIO_URL',
    defaultPort: 4500,
    routes: {
      watchlists: '/watchlists',
      portfolios: '/portfolios',
      holdings:   '/holdings',
      health:     '/health',
    },
  },
  identity: {
    name: 'identity',
    envUrl: 'IDENTITY_URL',
    defaultPort: 4600,
    routes: {
      login:    '/auth/login',
      session:  '/auth/session',
      logout:   '/auth/logout',
      user:     '/user',
      health:   '/health',
    },
  },
  reporting: {
    name: 'reporting',
    envUrl: 'REPORTING_URL',
    defaultPort: 4700,
    routes: {
      generate: '/generate',
      report:   '/report',
      health:   '/health',
    },
  },
} as const;

export type ServiceName = keyof typeof SERVICES;
