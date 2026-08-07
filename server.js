// ════════════════════════════════════════════════════════════════
//  server.js — Unified Node.js entry for Quantorus365
//
//  One PM2 entry runs everything ecosystem.config.js used to run:
//
//    Main Node process
//      • Next.js HTTP server              → port 5000 (PORT / NEXT_PORT)
//      • WebSocket stream server          → port 5001 (STREAM_WS_PORT)
//        (started inside the same V8 via src/instrumentation.ts, so
//         API routes and the WS fan-out share the live tickBus
//         singleton without IPC)
//
//    Child processes (spawned + supervised from this file)
//      • quantorus365-scheduler           (long-running, auto-restart)
//          tsx src/lib/workers/scheduler.ts
//      • q365-manipulation-scan           (cron: 0 13 * * * UTC / 18:30 IST)
//          tsx src/lib/workers/manipulationScannerCli.ts
//      • q365-learning-scheduler          (cron: 0 15 * * * UTC / 20:30 IST)
//          tsx src/lib/workers/learningScheduler.ts
//
//  Why children (not in-process requires)?
//    - The workers are .ts files that need `tsx` to transpile — we
//      already have tsx as a dev-dep. Forking keeps the worker crashes
//      isolated from Next.js. If scheduler.ts blows up, it's restarted
//      on its own; the HTTP server is not affected.
//    - The cron-triggered workers were `autorestart: false` + cron_restart
//      in PM2 (one-shot per day). We mirror that with node-cron: the
//      job is spawned, runs, exits. No retry loop on failure — matches
//      the old intent.
//
//  Local dev: `npm run dev` still uses `next dev` — this file is only
//  the production entry (`npm start` → `node server.js`).
// ════════════════════════════════════════════════════════════════

'use strict';

// Load env BEFORE requiring next — instrumentation.ts and API routes
// read process.env during construction.
const path = require('path');

function resolveEnvFilePath() {
  // Keep in sync with src/lib/envPath.ts — production prefers `.env`.
  const fs = require('fs');
  if (process.env.DOTENV_CONFIG_PATH) return process.env.DOTENV_CONFIG_PATH;
  if (process.env.NODE_ENV === 'production') {
    const flat = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(flat)) return flat;
    const legacy = path.resolve(process.cwd(), '.env.production');
    if (fs.existsSync(legacy)) return legacy;
    return flat;
  }
  const local = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(local)) return local;
  return path.resolve(process.cwd(), '.env');
}

require('dotenv').config({ path: resolveEnvFilePath() });

// Prefer explicit IST for scan dates / cron child inheritance.
if (!process.env.TZ) process.env.TZ = 'Asia/Kolkata';

// Safe identity (no secrets) — helps catch wrong DB on boot.
console.log(
  `[RUNTIME_IDENTITY] component=server.js processRole=web ` +
  `databaseHost=${process.env.MYSQL_HOST || 'unset'} ` +
  `databaseName=${process.env.MYSQL_DATABASE || 'unset'} ` +
  `redisHost=${process.env.REDIS_HOST || 'unset'} ` +
  `nodeEnv=${process.env.NODE_ENV || 'undefined'} ` +
  `timezone=Asia/Kolkata processTz=${process.env.TZ || 'unset'} ` +
  `envFileHint=${resolveEnvFilePath()}`,
);

// server.js is the production custom entry (`start:server` / PM2). Local
// `.env.local` often sets NODE_ENV=development for `next dev` — if we keep
// that here, Next boots in *dev* mode through the custom server (turbopack
// lock, Edge instrumentation noise, "Another next dev server is already
// running", and absolute URLs built from hostname 0.0.0.0). That diverges
// from working `next start` and breaks login/OAuth/session round-trips.
// Opt into custom-server development only with Q365_CUSTOM_SERVER_DEV=1.
if (process.env.Q365_CUSTOM_SERVER_DEV === '1') {
  if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
} else {
  process.env.NODE_ENV = 'production';
}

// PROD CRON OWNERSHIP — server.js unconditionally spawns the scheduler
// worker below (registerWorker('scheduler', ...)). That worker registers
// rescore + regen crons in its own Node process. Without this line the
// Next.js process ALSO registers the same crons via bootInProcScheduler
// (gated on Q365_INPROC_REGEN=1 / Q365_INPROC_SCHEDULER=1, which local
// .env files often set for `next dev`) — so every rescore + regen tick
// fires TWICE. Always force OFF here: this entrypoint owns the child.
process.env.Q365_INPROC_SCHEDULER = '0';

const http = require('http');
const { parse } = require('url');
const next = require('next');
const { spawn } = require('child_process');
const cron = require('node-cron');

const NEXT_PORT = Number(process.env.PORT || process.env.NEXT_PORT) || 5000;
// Bind on all interfaces for Docker/PM2, but never pass 0.0.0.0 into
// next({ hostname }) — that poisons nextUrl.origin / redirects / OAuth.
const BIND_HOST = process.env.HOST || '0.0.0.0';

function resolveNextHostname() {
  if (process.env.NEXT_HOSTNAME) return process.env.NEXT_HOSTNAME;
  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL']) {
    const raw = (process.env[key] || '').trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname;
      if (host && host !== '0.0.0.0') return host;
    } catch { /* ignore invalid */ }
  }
  return 'localhost';
}

const NEXT_HOSTNAME = resolveNextHostname();
const DEV = process.env.NODE_ENV !== 'production';

// Kite WebSocket stream server removed — live ticks are served by
// removed vendor polling + WebSocket fan-out (see instrumentation.ts).

// Prefer the JS CLI entry so spawn works without cmd.exe quoting issues
// when the project path contains spaces (e.g. "api-update - Copy").
const TSX_CLI = path.resolve(
  process.cwd(),
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
);
const TSX_BIN = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

function spawnTsxWorker(scriptRel) {
  const scriptPath = path.resolve(process.cwd(), scriptRel);
  const fs = require('fs');
  // node + tsx/cli.mjs avoids shell and handles spaces in cwd/script.
  if (fs.existsSync(TSX_CLI)) {
    return spawn(process.execPath, [TSX_CLI, scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  // Fallback: quote paths for cmd.exe when shell is required.
  const quotedBin = process.platform === 'win32' ? `"${TSX_BIN}"` : TSX_BIN;
  const quotedScript = process.platform === 'win32' ? `"${scriptPath}"` : scriptPath;
  return spawn(quotedBin, [quotedScript], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });
}

// ── Child-process supervision ────────────────────────────────────
//
// registerWorker() keeps one tsx child alive by auto-restarting it
// after an exit. Respects a cooldown and a max-restart cap to avoid
// tight crash loops. `shuttingDown` flips during graceful shutdown
// so we don't fight pm2/systemd when it's trying to kill us.
//
// runOnceWorker() spawns a one-shot tsx child, pipes its output, and
// resolves when it exits — used by the cron schedules. A failure
// never auto-retries (matches the old `autorestart: false` intent).

const workers = new Map(); // name → ChildProcess
let shuttingDown = false;

function logLines(prefix, stream) {
  stream.setEncoding('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) process.stdout.write(`[${prefix}] ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buf) process.stdout.write(`[${prefix}] ${buf}\n`);
  });
}

function registerWorker(name, script, opts = {}) {
  const { restartDelayMs = 3000, maxRestarts = 20 } = opts;
  let restarts = 0;
  let lastStartAt = 0;

  const start = () => {
    if (shuttingDown) return;
    lastStartAt = Date.now();
    console.log(`[server] starting worker: ${name} (${script})`);
    const child = spawnTsxWorker(script);
    workers.set(name, child);
    logLines(name, child.stdout);
    logLines(name, child.stderr);

    child.on('exit', (code, signal) => {
      workers.delete(name);
      console.log(`[server] worker ${name} exited code=${code} signal=${signal ?? ''}`);
      if (shuttingDown) return;

      // If the process stayed alive for a while, reset the counter —
      // a healthy long-running worker should not count earlier restarts
      // against its current budget.
      const uptimeMs = Date.now() - lastStartAt;
      if (uptimeMs > 60_000) restarts = 0;

      if (restarts >= maxRestarts) {
        console.error(`[server] worker ${name} exceeded ${maxRestarts} restarts — giving up`);
        return;
      }
      restarts += 1;
      setTimeout(start, restartDelayMs);
    });

    child.on('error', (err) => {
      console.error(`[server] worker ${name} spawn error:`, err);
    });
  };

  start();
}

function runOnceWorker(name, script) {
  if (shuttingDown) return Promise.resolve();
  if (workers.has(name)) {
    console.warn(`[server] ${name} still running from previous cron tick — skipping`);
    return Promise.resolve();
  }
  console.log(`[server] running one-shot worker: ${name}`);
  return new Promise((resolve) => {
    const child = spawnTsxWorker(script);
    workers.set(name, child);
    logLines(name, child.stdout);
    logLines(name, child.stderr);
    child.on('exit', (code, signal) => {
      workers.delete(name);
      console.log(`[server] ${name} finished code=${code} signal=${signal ?? ''}`);
      resolve();
    });
    child.on('error', (err) => {
      workers.delete(name);
      console.error(`[server] ${name} spawn error:`, err);
      resolve();
    });
  });
}

function startAllWorkers() {
  // Long-running — market data scheduler. Auto-restarts on crash.
  registerWorker(
    'scheduler',
    'src/lib/workers/scheduler.ts',
    { restartDelayMs: 5000, maxRestarts: 10 },
  );

  // Cron-triggered one-shots. Times match the original ecosystem.config.js:
  //   13:00 UTC = 18:30 IST  — manipulation surveillance sweep
  //   15:00 UTC = 20:30 IST  — learning / calibration cycle
  // node-cron syntax: minute hour day month weekday
  cron.schedule('0 13 * * *', () => {
    runOnceWorker('manipulation-scan', 'src/lib/workers/manipulationScannerCli.ts');
  }, { timezone: 'UTC' });

  cron.schedule('0 15 * * *', () => {
    runOnceWorker('learning-scheduler', 'src/lib/workers/learningScheduler.ts');
  }, { timezone: 'UTC' });
}

// ── Graceful shutdown ────────────────────────────────────────────
function shutdown(signal, httpServer) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — shutting down`);

  // Signal every child, then force-kill after a grace period.
  for (const [name, child] of workers) {
    try {
      console.log(`[server] killing worker ${name} (pid=${child.pid})`);
      child.kill('SIGTERM');
    } catch (err) {
      console.error(`[server] error killing ${name}:`, err);
    }
  }
  setTimeout(() => {
    for (const [name, child] of workers) {
      try {
        console.log(`[server] force-killing ${name}`);
        child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
  }, 8000).unref();

  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(
    `[server] boot mode NODE_ENV=${process.env.NODE_ENV} next.dev=${DEV}`
    + ` bind=${BIND_HOST}:${NEXT_PORT} next.hostname=${NEXT_HOSTNAME}`,
  );

  const app = next({ dev: DEV, hostname: NEXT_HOSTNAME, port: NEXT_PORT });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = http.createServer((req, res) => {
    // Pass parsedUrl so query strings (OAuth code/state, auth callbacks)
    // reach Next the same way `next start` does.
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl).catch((err) => {
      console.error('[server] request error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal server error');
      }
    });
  });

  // Bind first; only then spawn workers. Spawning before listen succeeds
  // would leave supervised children running if the port is taken
  // (EADDRINUSE) or the bind otherwise fails.
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(NEXT_PORT, BIND_HOST, () => {
      httpServer.removeListener('error', reject);
      console.log(`[server] Next.js ready on http://${BIND_HOST}:${NEXT_PORT} (hostname=${NEXT_HOSTNAME})`);
      console.log(`[server] Live market WS feed boots via Next instrumentation (STREAM_WS_PORT)`);
      resolve();
    });
  });

  startAllWorkers();

  process.on('SIGINT',  () => shutdown('SIGINT',  httpServer));
  process.on('SIGTERM', () => shutdown('SIGTERM', httpServer));
}

main().catch((err) => {
  console.error('[server] fatal boot error:', err);
  process.exit(1);
});
