import { describe,it,expect } from 'vitest'; import { comparePersistedResults, PERSISTED_PARITY_TABLES } from '@/lib/backtesting/parity/persistedParity';
describe('persisted Backtest parity',()=>{
  it('normalizes only operational identity and timestamps',()=>{ const base=Object.fromEntries(PERSISTED_PARITY_TABLES.map(t=>[t,[{run_id:'monolith',processor_id:'m',worker_version:'monolith',status:'completed',net_pnl:123.45}]])); const worker=structuredClone(base); for(const rows of Object.values(worker) as any[][]){rows[0].run_id='worker';rows[0].processor_id='w';rows[0].worker_version='service'} expect(comparePersistedResults(base,worker).verdict).toBe('equivalent'); });
  it('fails every unexplained business mismatch',()=>{ const a:any={backtest_trades:[{net_pnl:1}]}; const b:any={backtest_trades:[{net_pnl:2}]}; const result=comparePersistedResults(a,b); expect(result.verdict).toBe('mismatch'); expect(result.mismatches.map(x=>x.table)).toContain('backtest_trades'); });
});
