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
require('dotenv').config({
  path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
});

const http = require('http');
const next = require('next');
const { spawn } = require('child_process');
const cron = require('node-cron');

const NEXT_PORT      = Number(process.env.PORT || process.env.NEXT_PORT) || 5000;
const STREAM_WS_PORT = Number(process.env.STREAM_WS_PORT) || 5001;
const HOSTNAME       = process.env.HOST || '0.0.0.0';
const DEV            = process.env.NODE_ENV !== 'production';

// Make sure startStreamServer() (called inside instrumentation.ts)
// binds to the port this file advertises, regardless of launch path.
process.env.STREAM_WS_PORT = String(STREAM_WS_PORT);

// tsx binary used to run TypeScript worker entrypoints. Same binary
// PM2 used to invoke in the old ecosystem config.
const TSX_BIN = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

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
    const child = spawn(TSX_BIN, [script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
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
    const child = spawn(TSX_BIN, [script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
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
  const app = next({ dev: DEV, hostname: HOSTNAME, port: NEXT_PORT });
  const handle = app.getRequestHandler();
  await app.prepare();

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[server] request error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal server error');
      }
    });
  });

  httpServer.listen(NEXT_PORT, HOSTNAME, () => {
    console.log(`[server] Next.js ready on http://${HOSTNAME}:${NEXT_PORT}`);
    console.log(`[server] WS stream on ws://${HOSTNAME}:${STREAM_WS_PORT} (via instrumentation)`);
  });

  startAllWorkers();

  process.on('SIGINT',  () => shutdown('SIGINT',  httpServer));
  process.on('SIGTERM', () => shutdown('SIGTERM', httpServer));
}

main().catch((err) => {
  console.error('[server] fatal boot error:', err);
  process.exit(1);
});
