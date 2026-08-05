/**
 * GET /api/usage — IndianAPI warehouse ops projection.
 */

import { NextResponse } from 'next/server';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import {
  getMarketDataProvider,
  indianApiCredentialsPresent,
  isIndianApiEnabled,
} from '@/lib/marketData/providerFlags';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const market = getMarketStatus();
  const current_provider = getMarketDataProvider();
  const enabled = isIndianApiEnabled();
  const creds = indianApiCredentialsPresent();

  const compliance =
    !enabled || !creds ? 'UNSAFE'
      : current_provider !== 'indianapi' ? 'BORDERLINE'
        : 'SAFE';

  const reasons: string[] = [];
  if (!enabled) reasons.push('indianapi_disabled');
  if (!creds) reasons.push('indianapi_credentials_missing');
  if (current_provider !== 'indianapi') reasons.push('provider_not_indianapi');

  return NextResponse.json(
    {
      compliance,
      reasons,
      current_provider,
      market: {
        isOpen: market.isOpen,
        state: market.state,
        label: market.label,
      },
      indianapi: {
        enabled,
        credentialsConfigured: creds,
      },
      note: 'Live broker ticks unsupported — quotes from IndianAPI warehouse',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
