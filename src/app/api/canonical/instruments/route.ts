// GET /api/canonical/instruments — List canonical instruments
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getInstruments } from '@/services/canonicalDataService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const instruments = await getInstruments({
    exchange: sp.get('exchange') ?? undefined,
    assetType: sp.get('assetType') ?? undefined,
    sectorId: sp.get('sectorId') ? Number(sp.get('sectorId')) : undefined,
    activeOnly: sp.get('activeOnly') !== 'false',
    limit: sp.get('limit') ? Number(sp.get('limit')) : 500,
    offset: sp.get('offset') ? Number(sp.get('offset')) : 0,
  });
  return { data: instruments, count: instruments.length };
});
