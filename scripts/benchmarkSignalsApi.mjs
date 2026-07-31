import { config as dotenvConfig } from 'dotenv';
import mysql from 'mysql2/promise';

dotenvConfig({ path: '.env.local' });
dotenvConfig({ path: '.env.production' });

const baseUrl = process.env.UI_BASE_URL?.trim() || 'http://127.0.0.1:3000';
const requestCount = Math.max(
  1,
  Number(process.argv.find((arg) => arg.startsWith('--requests='))?.split('=')[1] ?? 100),
);
const warmupCount = Math.max(
  0,
  Number(process.argv.find((arg) => arg.startsWith('--warmups='))?.split('=')[1] ?? 5),
);
const selectedScenario = process.argv
  .find((arg) => arg.startsWith('--scenario='))
  ?.split('=')[1];

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    average: Number((sum / Math.max(1, sorted.length)).toFixed(2)),
    minimum: Number((sorted[0] ?? 0).toFixed(2)),
    maximum: Number((sorted.at(-1) ?? 0).toFixed(2)),
    p50: Number(percentile(sorted, 0.5).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
    p99: Number(percentile(sorted, 0.99).toFixed(2)),
  };
}

function parseDurationHeader(value) {
  if (!value) return null;
  const parsed = Number(value.replace(/ms$/i, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseServerTiming(value) {
  const result = {};
  for (const part of value?.split(',') ?? []) {
    const [rawName, ...parameters] = part.trim().split(';');
    const duration = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith('dur='));
    const parsed = Number(duration?.slice(4));
    if (rawName && Number.isFinite(parsed)) result[rawName] = parsed;
  }
  return result;
}

async function resolveCookie() {
  const configured = process.env.ENGINE_AUTH_COOKIE || process.env.Q365_SESSION_COOKIE;
  if (configured) return configured;
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    connectTimeout: 10_000,
  });
  try {
    const [rows] = await connection.query(
      `SELECT token
         FROM user_sessions
        WHERE expires_at > NOW()
        ORDER BY expires_at DESC
        LIMIT 1`,
    );
    if (!rows[0]?.token) throw new Error('No unexpired authenticated session is available');
    return `q200_session=${rows[0].token}`;
  } finally {
    await connection.end();
  }
}

async function sample(path, cookie) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.arrayBuffer();
  const durationMs = performance.now() - started;
  if (!response.ok) {
    const safeBody = new TextDecoder().decode(body).slice(0, 300);
    throw new Error(`${path} returned HTTP ${response.status}: ${safeBody}`);
  }
  return {
    durationMs,
    payloadBytes: body.byteLength,
    cache: response.headers.get('X-Cache') ?? 'UNREPORTED',
    dbMs: parseDurationHeader(response.headers.get('X-DB-Time')),
    providerMs: parseDurationHeader(response.headers.get('X-Provider-Time')),
    serverTiming: parseServerTiming(response.headers.get('Server-Timing')),
  };
}

async function runScenario(name, path, cookie, warmups) {
  console.error(`[benchmark-signals-api] ${name}: ${warmups} warmups + ${requestCount} samples`);
  for (let index = 0; index < warmups; index += 1) await sample(path, cookie);
  const samples = [];
  for (let index = 0; index < requestCount; index += 1) samples.push(await sample(path, cookie));
  const stages = new Map();
  for (const item of samples) {
    for (const [stage, duration] of Object.entries(item.serverTiming)) {
      const values = stages.get(stage) ?? [];
      values.push(duration);
      stages.set(stage, values);
    }
  }
  return {
    name,
    path,
    requests: samples.length,
    latencyMs: summarize(samples.map((item) => item.durationMs)),
    payloadBytes: summarize(samples.map((item) => item.payloadBytes)),
    cache: Object.fromEntries(
      [...new Set(samples.map((item) => item.cache))]
        .map((state) => [state, samples.filter((item) => item.cache === state).length]),
    ),
    dbMs: summarize(samples.flatMap((item) => item.dbMs == null ? [] : [item.dbMs])),
    providerMs: summarize(samples.flatMap((item) => item.providerMs == null ? [] : [item.providerMs])),
    stages: [...stages.entries()]
      .map(([stage, values]) => ({ function: stage, calls: values.length, ...summarize(values) }))
      .sort((a, b) => b.average - a.average),
  };
}

async function main() {
  const cookie = await resolveCookie();
  const definitions = [
    ['warm-small', '/api/signals?action=all&limit=20'],
    ['cold-small', '/api/signals?action=all&limit=20&noCache=true'],
    ['cold-large', '/api/signals?action=all&limit=1000&noCache=true'],
    ['warm-large', '/api/signals?action=all&limit=1000'],
  ];
  const scenarios = [];
  for (const [name, path] of definitions) {
    if (selectedScenario && selectedScenario !== name) continue;
    scenarios.push(await runScenario(name, path, cookie, warmupCount));
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl,
    requestCount,
    scenarios,
  }, null, 2));
}

main().catch((error) => {
  console.error('[benchmark-signals-api]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
