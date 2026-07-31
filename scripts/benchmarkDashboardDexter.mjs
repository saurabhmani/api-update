import { config as dotenvConfig } from 'dotenv';
import mysql from 'mysql2/promise';

dotenvConfig({ path: '.env.local' });

const baseUrl = process.env.UI_BASE_URL?.trim() || 'http://127.0.0.1:3000';
const requests = Math.max(1, Number(process.argv.find((v) => v.startsWith('--requests='))?.split('=')[1] ?? 100));
const selected = process.argv.find((v) => v.startsWith('--scenario='))?.split('=')[1];

function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    minimum: Number((sorted[0] ?? 0).toFixed(2)),
    maximum: Number((sorted.at(-1) ?? 0).toFixed(2)),
    average: Number((sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)).toFixed(2)),
    p50: Number(percentile(sorted, 0.50).toFixed(2)),
    p95: Number(percentile(sorted, 0.95).toFixed(2)),
    p99: Number(percentile(sorted, 0.99).toFixed(2)),
  };
}
function serverTiming(value) {
  const out = {};
  for (const part of value?.split(',') ?? []) {
    const [name, ...params] = part.trim().split(';');
    const duration = Number(params.find((v) => v.trim().startsWith('dur='))?.trim().slice(4));
    if (name && Number.isFinite(duration)) out[name] = duration;
  }
  return out;
}

async function cookie() {
  if (process.env.Q365_SESSION_COOKIE) return process.env.Q365_SESSION_COOKIE;
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  try {
    const [rows] = await db.query(
      'SELECT token FROM user_sessions WHERE expires_at>NOW() ORDER BY expires_at DESC LIMIT 1',
    );
    if (!rows[0]?.token) throw new Error('No unexpired authenticated session is available');
    return `q200_session=${rows[0].token}`;
  } finally { await db.end(); }
}

async function run(name, path, authCookie) {
  const samples = [];
  for (let index = 0; index < 5; index += 1) await request(path, authCookie);
  for (let index = 0; index < requests; index += 1) samples.push(await request(path, authCookie));
  const stageValues = new Map();
  for (const sample of samples) {
    for (const [stage, duration] of Object.entries(sample.stages)) {
      const values = stageValues.get(stage) ?? [];
      values.push(duration);
      stageValues.set(stage, values);
    }
  }
  return {
    name, path, requests,
    latencyMs: stats(samples.map((sample) => sample.ms)),
    payloadBytes: stats(samples.map((sample) => sample.bytes)),
    errorRate: samples.filter((sample) => sample.status >= 400).length / samples.length,
    cache: Object.fromEntries([...new Set(samples.map((sample) => sample.cache))]
      .map((state) => [state, samples.filter((sample) => sample.cache === state).length])),
    stages: [...stageValues.entries()]
      .map(([stage, values]) => ({ stage, calls: values.length, ...stats(values) }))
      .sort((a, b) => b.average - a.average),
  };
}

async function request(path, authCookie) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: authCookie }, signal: AbortSignal.timeout(120_000),
  });
  const body = await response.arrayBuffer();
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return {
    status: response.status,
    ms: performance.now() - started,
    bytes: body.byteLength,
    cache: response.headers.get('X-Cache') ?? 'UNREPORTED',
    stages: serverTiming(response.headers.get('Server-Timing')),
  };
}

const definitions = [
  ['dashboard-warm', '/api/dashboard'],
  ['dashboard-cold-cache', '/api/dashboard?noCache=true'],
  ['dexter-warm', '/api/signal-engine/dexter?days=7'],
  ['dexter-cold-cache', '/api/signal-engine/dexter?days=7&noCache=true'],
  ['dexter-minimal', '/api/signal-engine/dexter?days=1'],
];
const authCookie = await cookie();
const results = [];
for (const [name, path] of definitions) {
  if (selected && selected !== name) continue;
  results.push(await run(name, path, authCookie));
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, results }, null, 2));
