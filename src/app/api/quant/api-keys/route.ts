// GET /api/quant/api-keys — list API clients
// POST /api/quant/api-keys — create new API key

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { createApiKey, listApiClients } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async () => {
  const user = await requireSession();
  const clients = await listApiClients(user.id);
  return { clients };
});

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? 'Default Client').slice(0, 128);
  const scopes = Array.isArray(body.scopes) ? body.scopes : ['read'];
  const key = await createApiKey(user.id, name, scopes);
  return {
    clientId: key.clientId,
    prefix: key.prefix,
    rawKey: key.rawKey,
    message: 'Store this key securely — it will not be shown again.',
  };
});
