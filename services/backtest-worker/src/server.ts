import http from 'node:http';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { loadBacktestWorkerConfig } from './config';
import { BacktestWorker } from './worker';
import { closeDbPool } from '@/lib/db';

async function main() {
  const config = loadBacktestWorkerConfig();
  if (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER) throw new Error('MySQL DB_HOST, DB_NAME, and DB_USER are required');
  await ensureBacktestTables();
  const worker = new BacktestWorker(config);
  worker.start();
  const server = http.createServer((request, response) => {
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true }));
    if (request.url === '/ready') { response.statusCode = worker.ready ? 200 : 503; return response.end(JSON.stringify(worker.readiness())); }
    if (request.url === '/metrics') { response.setHeader('content-type', 'text/plain'); return response.end(worker.metrics.render()); }
    response.statusCode = 404; response.end();
  });
  server.listen(config.port, config.host);
  const shutdown = async () => { server.close(); await worker.stop(); await closeDbPool(); process.exit(0); };
  process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
  console.info(JSON.stringify({ event: 'backtest_worker_started', processorId: config.processorId, workerVersion: config.workerVersion, owner: config.owner }));
}
void main().catch(error => { console.error(JSON.stringify({ event: 'backtest_worker_start_failed', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
