// GET /api/market-data/dual-source/status — dual-source feed health + validation
import { NextResponse } from 'next/server';
import { ensureLiveMarketStack } from '@/lib/marketData/ensureLiveMarketStack';
import { getDualSourceConfig } from '@/lib/marketData/providerFlags';
import { getDualSourceMonitoringSnapshot } from '@/lib/marketData/dualSource/monitoringService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  await ensureLiveMarketStack();
  const config = getDualSourceConfig();
  const snapshot = getDualSourceMonitoringSnapshot();

  return NextResponse.json({
    config: {
      enabled: config.enabled,
      priceToleranceBps: config.priceToleranceBps,
      volumeTolerancePct: config.volumeTolerancePct,
      timestampToleranceMs: config.timestampToleranceMs,
      minConfidenceForSignal: config.minConfidenceForSignal,
      allowSingleSourceSignals: config.allowSingleSourceSignals,
      authoritativeOnConflict: config.authoritativeOnConflict,
    },
    ...snapshot,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
