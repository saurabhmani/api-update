// ════════════════════════════════════════════════════════════════
//  market-ingestion — env config parsing
//
//  ONLY env-driven — no hardcoded secrets, no file paths. Throws
//  at startup if something required is missing so a misconfigured
//  deploy fails fast instead of serving empty responses.
// ════════════════════════════════════════════════════════════════

export interface ServiceConfig {
  port: number;
  serviceAuthToken: string | null;   // null = auth disabled (dev only)
  indianApiKey: string | null;
  indianApiBaseUrl: string;
  yahooEnabled: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  nodeEnv: 'development' | 'production' | 'test';
}

export function loadConfig(): ServiceConfig {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as ServiceConfig['nodeEnv'];
  const port = Number(process.env.MARKET_INGESTION_PORT ?? 4100);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MARKET_INGESTION_PORT: ${process.env.MARKET_INGESTION_PORT}`);
  }

  const serviceAuthToken = process.env.SERVICE_AUTH_TOKEN?.trim() || null;
  if (!serviceAuthToken && nodeEnv === 'production') {
    throw new Error('SERVICE_AUTH_TOKEN is required in production');
  }

  return {
    port,
    serviceAuthToken,
    indianApiKey: process.env.INDIAN_API_KEY?.trim() || process.env.INDIANAPI_KEY?.trim() || null,
    indianApiBaseUrl: process.env.INDIAN_API_BASE_URL?.trim() ||
                      process.env.INDIANAPI_BASE_URL?.trim() ||
                      'https://stock.indianapi.in',
    yahooEnabled: (process.env.YAHOO_ENABLED ?? 'true').toLowerCase() !== 'false',
    logLevel: (process.env.LOG_LEVEL as ServiceConfig['logLevel']) ?? 'info',
    nodeEnv,
  };
}
