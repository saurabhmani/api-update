import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { auditBacktestAuthorization, backtestActorFromSession, getBacktestForActor, type BacktestActor } from './resourceAuthorization';
import { ensureBacktestTables } from '../repository/migrate';

export type BacktestRouteAccess = { ok:true; actor:BacktestActor; run:any; correlationId:string } | { ok:false; response:NextResponse };
export async function authorizeBacktestRoute(req: NextRequest, runId: string, route: string, operation: string): Promise<BacktestRouteAccess> {
  let session;
  try { session = await requireSession(); }
  catch { return { ok:false, response:NextResponse.json({ ok:false,error:'Unauthorized' },{ status:401 }) }; }
  await ensureBacktestTables();
  const actor = backtestActorFromSession(session); const correlationId = req.headers.get('x-correlation-id') ?? crypto.randomUUID();
  const run = await getBacktestForActor(runId, actor);
  if (!run) {
    auditBacktestAuthorization({ actor,runId,route,operation,decision:'not_found_or_unauthorized',correlationId });
    return { ok:false,response:NextResponse.json({ ok:false,error:'Backtest not found' },{ status:404 }) };
  }
  if (actor.kind === 'admin') auditBacktestAuthorization({ actor,runId,route,operation,decision:'admin_allowed',correlationId });
  return { ok:true,actor,run,correlationId };
}
