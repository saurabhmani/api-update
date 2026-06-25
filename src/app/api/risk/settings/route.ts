import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getRiskSettings, saveRiskSettings } from '@/lib/paper-trading';
import type { PaperRiskConfig } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** GET /api/risk/settings */
export async function GET() {
  try {
    const user = await requireSession();
    const data = await getRiskSettings(user.id);
    return NextResponse.json({ ok: true, ...data });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/risk/settings — update risk profile */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const settings: Partial<PaperRiskConfig> & { killSwitchActive?: boolean } = {
      virtualCapital: body.virtualCapital != null ? Number(body.virtualCapital) : undefined,
      riskPerTradePct: body.riskPerTradePct != null ? Number(body.riskPerTradePct) : undefined,
      maxDailyLossPct: body.maxDailyLossPct != null ? Number(body.maxDailyLossPct) : undefined,
      maxOpenPositions: body.maxOpenPositions != null ? Number(body.maxOpenPositions) : undefined,
      maxConsecutiveLosses: body.maxConsecutiveLosses != null ? Number(body.maxConsecutiveLosses) : undefined,
      maxSymbolExposurePct: body.maxSymbolExposurePct != null ? Number(body.maxSymbolExposurePct) : undefined,
      maxStrategyExposurePct: body.maxStrategyExposurePct != null ? Number(body.maxStrategyExposurePct) : undefined,
      slippageBps: body.slippageBps != null ? Number(body.slippageBps) : undefined,
      circuitBreakerDropPct: body.circuitBreakerDropPct != null ? Number(body.circuitBreakerDropPct) : undefined,
      highVolatilityAtrPct: body.highVolatilityAtrPct != null ? Number(body.highVolatilityAtrPct) : undefined,
      killSwitchActive: body.killSwitchActive != null ? Boolean(body.killSwitchActive) : undefined,
    };
    const result = await saveRiskSettings(user.id, settings);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Settings update failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
