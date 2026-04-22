// ════════════════════════════════════════════════════════════════
//  reporting — skeleton
//
//  Owns: generation + retrieval of reports (CSV/PDF/JSON).
//  Heavy work happens async so /generate returns a report_id
//  immediately; /report/:id returns status + payload when ready.
//
//  In-memory job store for now; swap for app.reports table once
//  persistence is needed.
// ════════════════════════════════════════════════════════════════

import '../../_shared/envLoader';
import { startHttpService, ok, err } from '../../_shared/httpService';
import crypto from 'node:crypto';
import { pg } from '@/lib/db/postgres';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'reporting' });
const PORT = Number(process.env.REPORTING_PORT ?? 4700);

type JobStatus = 'queued' | 'running' | 'done' | 'failed';
interface Job {
  id: string;
  user_id: string;
  report_type: string;
  status: JobStatus;
  created_at: number;
  finished_at?: number;
  payload?: unknown;
  error?: string;
}

const jobs = new Map<string, Job>();

// Stub generator — real implementations (PDF via pdfkit, CSV via
// json2csv) live in src/ and will be wired here once extracted.
async function runJob(job: Job, params: Record<string, unknown>): Promise<void> {
  job.status = 'running';
  try {
    switch (job.report_type) {
      case 'portfolio_summary': {
        const userId = params.user_id as string;
        const { rows } = await pg.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM app.portfolio_holdings
            WHERE portfolio_id IN (SELECT id FROM app.portfolios WHERE user_id = $1::uuid)
              AND closed_at IS NULL`,
          [userId],
        );
        job.payload = { user_id: userId, open_holdings: Number(rows[0]?.count ?? 0) };
        break;
      }
      default:
        throw new Error(`unsupported report_type: ${job.report_type}`);
    }
    job.status = 'done';
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
  }
  job.finished_at = Date.now();
}

startHttpService({
  name: 'reporting',
  version: '0.1.0',
  port: PORT,
  routes: [
    {
      method: 'POST',
      path: '/generate',
      handler: async (ctx) => {
        const body = ctx.body as { user_id?: string; report_type?: string; params?: Record<string, unknown> } | undefined;
        if (!body?.user_id || !body?.report_type) {
          return err('BAD_REQUEST', 'user_id + report_type required', ctx.correlationId);
        }
        const job: Job = {
          id: crypto.randomUUID(),
          user_id: body.user_id,
          report_type: body.report_type,
          status: 'queued',
          created_at: Date.now(),
        };
        jobs.set(job.id, job);
        // Fire-and-forget; /report/:id polls status.
        void runJob(job, body.params ?? { user_id: body.user_id });
        return ok({ report_id: job.id, status: job.status }, ctx.correlationId);
      },
    },
    {
      method: 'GET',
      path: '/report',
      handler: async (ctx) => {
        const id = ctx.query.id;
        if (!id) return err('BAD_REQUEST', 'id required', ctx.correlationId);
        const job = jobs.get(id);
        if (!job) return err('NOT_FOUND', 'report not found', ctx.correlationId);
        return ok(job, ctx.correlationId);
      },
    },
  ],
  probeDependencies: async () => ({
    postgres: (await pg.healthCheck()).ok ? 'ok' : 'down',
  }),
});
