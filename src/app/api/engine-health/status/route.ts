// ════════════════════════════════════════════════════════════════
//  GET /api/engine-health/status — Public engine health probe
//
//  No authentication required. Returns a simple boolean health flag
//  for uptime monitors, load balancers, and external pollers.
//
//  Response:
//    { "healthy": true,  "generatedAt": "..." }
//    { "healthy": false, "message": "...", "generatedAt": "..." }
//
//  HTTP 200 when healthy, 503 when unhealthy.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { probeEngineHealthStatus } from '@/lib/monitor/engineHealthProbe';
import { resolveEngineHealthCheck } from '@/types/dashboard';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  const generatedAt = new Date().toISOString();

  try {
    const probe = await probeEngineHealthStatus();
    const check = resolveEngineHealthCheck(
      probe.marketOpen,
      probe.status,
      probe.message,
    );

    return NextResponse.json(
      {
        healthy: check.healthy,
        ...(check.message ? { message: check.message } : {}),
        generatedAt,
      },
      {
        status:  check.healthy ? 200 : 503,
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      },
    );
  } catch {
    return NextResponse.json(
      {
        healthy:     false,
        message:     'Engine health probe failed',
        generatedAt,
      },
      {
        status:  503,
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      },
    );
  }
}
