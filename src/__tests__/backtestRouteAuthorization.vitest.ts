import { beforeEach,describe,expect,it,vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks=vi.hoisted(()=>({ requireSession:vi.fn(), ensure:vi.fn(), get:vi.fn(), audit:vi.fn() }));
vi.mock('@/lib/session',()=>({ requireSession:mocks.requireSession }));
vi.mock('@/lib/backtesting/repository/migrate',()=>({ ensureBacktestTables:mocks.ensure }));
vi.mock('@/lib/backtesting/authorization/resourceAuthorization',()=>({
  backtestActorFromSession:(session:any)=>session.role==='admin'?{kind:'admin',userId:session.id}:{kind:'user',userId:session.id},
  getBacktestForActor:mocks.get,auditBacktestAuthorization:mocks.audit,
}));
import { authorizeBacktestRoute } from '@/lib/backtesting/authorization/routeAuthorization';
const req=()=>new NextRequest('http://localhost/api/backtests/run-1/trades');
describe('shared Backtest route authorization',()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.ensure.mockResolvedValue(undefined);});
  it('authenticates before schema or resource access',async()=>{
    mocks.requireSession.mockRejectedValue(new Error('invalid')); const result=await authorizeBacktestRoute(req(),'run-1','/route','read');
    expect('response' in result&&result.response.status).toBe(401); expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
  });
  it('maps foreign, ownerless-hidden, and nonexistent parents to one 404',async()=>{
    mocks.requireSession.mockResolvedValue({id:101,role:'user'}); mocks.get.mockResolvedValue(null);
    const outcomes=await Promise.all(['foreign','ownerless','missing'].map(id=>authorizeBacktestRoute(req(),id,'/route','read')));
    for(const outcome of outcomes){expect('response' in outcome&&outcome.response.status).toBe(404); if('response' in outcome) expect(await outcome.response.clone().json()).toEqual({ok:false,error:'Backtest not found'});}
  });
  it('allows an owned parent and explicitly audits admin access',async()=>{
    mocks.get.mockResolvedValue({run_id:'run-1'}); mocks.requireSession.mockResolvedValue({id:101,role:'user'});
    expect(await authorizeBacktestRoute(req(),'run-1','/route','read')).toMatchObject({ok:true,actor:{kind:'user',userId:101}});
    mocks.requireSession.mockResolvedValue({id:1,role:'admin'}); expect(await authorizeBacktestRoute(req(),'run-1','/route','read')).toMatchObject({ok:true,actor:{kind:'admin',userId:1}}); expect(mocks.audit).toHaveBeenCalled();
  });
});
