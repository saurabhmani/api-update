// ════════════════════════════════════════════════════════════════
//  POST /api/signals/force-seed — DISABLED under PURE_REAL_DATA_MODE
//
//  This endpoint used to insert deterministic synthetic signals into
//  q365_signals so the dashboard wasn't empty during off-hours / cold-DB
//  testing. Under the PURE_REAL_DATA_MODE contract that is forbidden:
//  every signal returned by the API must come from real strict-filtered
//  scanner output, never injected test data.
//
//  We return 410 Gone (rather than deleting the file) so that any
//  operator runbook / smoke-test script that still hits this URL gets
//  an explicit, greppable failure instead of a 404 that could be
//  mistaken for a routing problem. The handler also writes a
//  PURE_REAL_DATA_MODE log line so attempts to call it are visible
//  in the structured log.
//
//  If you genuinely need to seed test data, do it via the DB directly
//  in a non-production environment. There is no API path for it.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const log = logger.child({ component: 'force-seed' });

function gone(req: NextRequest): Response {
  log.warn('force-seed call refused — PURE_REAL_DATA_MODE', {
    path:   req.nextUrl.pathname,
    method: req.method,
  });
  return NextResponse.json(
    {
      error:   'force_seed_disabled',
      message: 'Synthetic signal seeding is disabled under PURE_REAL_DATA_MODE. ' +
               'The /api/signals endpoint returns only real, strict-filtered DB signals.',
    },
    { status: 410 },
  );
}

export async function POST(req: NextRequest): Promise<Response> { return gone(req); }
export async function GET (req: NextRequest): Promise<Response> { return gone(req); }
