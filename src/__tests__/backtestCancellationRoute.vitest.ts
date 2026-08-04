import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { requireSession, owned, admin, ensure } = vi.hoisted(() => ({ requireSession:vi.fn(), owned:vi.fn(), admin:vi.fn(), ensure:vi.fn() }));
vi.mock('@/lib/session', () => ({ requireSession }));
vi.mock('@/lib/backtesting/repository/migrate', () => ({ ensureBacktestTables: ensure }));
vi.mock('@/lib/backtesting/queue/leaseQueue', () => ({ backtestLeaseQueue: { requestOwnedCancellation: owned, requestAdminCancellation: admin } }));
import { POST } from '@/app/api/backtests/[id]/cancel/route';

const request = () => new NextRequest('http://localhost/api/backtests/run-1/cancel', { method:'POST' });
const call = () => POST(request(), { params:Promise.resolve({ id:'run-1' }) });
describe('Backtest cancellation route authorization', () => {
  beforeEach(() => { vi.clearAllMocks(); ensure.mockResolvedValue(undefined); });
  for (const kind of ['missing','invalid','expired','revoked']) it(`returns 401 for ${kind} session without touching the queue`, async () => {
    requireSession.mockRejectedValue(new Error(kind)); const response = await call();
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ ok:false,error:'Unauthorized' });
    expect(ensure).not.toHaveBeenCalled(); expect(owned).not.toHaveBeenCalled(); expect(admin).not.toHaveBeenCalled();
  });
  it('uses authenticated user identity and preserves queued success shape', async () => {
    requireSession.mockResolvedValue({ id:101,role:'user' }); owned.mockResolvedValue({ kind:'cancelled',changed:true });
    const response = await call(); const body = await response.json();
    expect(response.status).toBe(200); expect(owned).toHaveBeenCalledWith('run-1',101);
    expect(body).toMatchObject({ ok:true,runId:'run-1',status:'CANCELLED',changed:true,reason:null });
  });
  it('uses explicit admin scope', async () => {
    requireSession.mockResolvedValue({ id:1,role:'admin' }); admin.mockResolvedValue({ kind:'cancellation_requested',changed:true });
    const response = await call(); expect(response.status).toBe(200); expect(admin).toHaveBeenCalledWith('run-1'); expect(owned).not.toHaveBeenCalled();
  });
  it('makes cross-user and nonexistent outcomes externally identical', async () => {
    requireSession.mockResolvedValue({ id:101,role:'user' }); owned.mockResolvedValue({ kind:'not_found_or_unauthorized',changed:false });
    const first = await call(); const second = await call();
    expect(first.status).toBe(404); expect(await first.json()).toEqual(await second.json());
  });
  it('preserves compatible terminal and repeated response', async () => {
    requireSession.mockResolvedValue({ id:101,role:'user' }); owned.mockResolvedValue({ kind:'not_actionable',changed:false,status:'cancelled' });
    const response = await call(); expect(await response.json()).toMatchObject({ ok:true,status:'CANCELLED',changed:false,reason:'Already in CANCELLED state.' });
  });
  it('prevents public routes from importing an unrestricted cancellation operation', () => {
    const source = fs.readFileSync('src/app/api/backtests/[id]/cancel/route.ts','utf8');
    expect(source).not.toMatch(/cancelBacktestRun\s*\(/); expect(source).toContain('requestOwnedCancellation');
  });
});
