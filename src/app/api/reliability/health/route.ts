import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { collectReliabilityDashboard } from '@/lib/reliability';

export const dynamic = 'force-dynamic';

/** GET /api/reliability/health — admin-gated comprehensive health probe */
export async function GET() {
  const start = Date.now();
  try {
    await requireAdmin();
    const dashboard = await collectReliabilityDashboard();

    const status = dashboard.overallStatus === 'healthy'
      ? 'ok'
      : dashboard.overallStatus === 'degraded'
        ? 'degraded'
        : 'unhealthy';

    return NextResponse.json({
      status,
      timestamp: dashboard.generatedAt,
      responseTimeMs: Date.now() - start,
      checks: {
        api: {
          status: dashboard.metrics.apiErrorRate < 0.05 ? 'ok' : dashboard.metrics.apiErrorRate < 0.20 ? 'warn' : 'fail',
          uptimePct: dashboard.metrics.apiUptimePct,
          errorRate: dashboard.metrics.apiErrorRate,
          avgLatencyMs: dashboard.metrics.apiAvgLatencyMs,
        },
        signals: {
          status: dashboard.signals.signalQuality === 'CLEAN' ? 'ok' : 'warn',
          latencyMs: dashboard.metrics.signalLatencyMs,
          quality: dashboard.signals.signalQuality,
        },
        cron: {
          status: dashboard.metrics.cronFailureCount24h === 0 ? 'ok' : 'warn',
          failures24h: dashboard.metrics.cronFailureCount24h,
          lastSuccess: dashboard.metrics.cronLastSuccess,
        },
        data: {
          status: dashboard.metrics.dataFreshnessQuality === 'STALE' ? 'warn' : 'ok',
          freshnessSeconds: dashboard.metrics.dataFreshnessSeconds,
          quality: dashboard.metrics.dataFreshnessQuality,
        },
        broker: {
          status: dashboard.metrics.brokerDownCount > 0 ? 'fail' : dashboard.metrics.brokerFailureCount24h > 0 ? 'warn' : 'ok',
          failures24h: dashboard.metrics.brokerFailureCount24h,
          downCount: dashboard.metrics.brokerDownCount,
        },
      },
      alerts: dashboard.alerts,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { status: 'unhealthy', error: e instanceof Error ? e.message : 'Unauthorized', responseTimeMs: Date.now() - start },
      { status: 401 },
    );
  }
}
