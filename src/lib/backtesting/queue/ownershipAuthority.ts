import type { QueueDb } from './leaseQueue';
import { db } from '@/lib/db';
import type { BacktestProcessorOwner } from './ownership';

export interface OwnershipState { owner: BacktestProcessorOwner; epoch: number; updatedAt: Date; updatedBy: string }
export class BacktestOwnershipAuthorityError extends Error { constructor(readonly code: 'missing'|'invalid-owner'|'invalid-epoch'|'stale-epoch'|'unsafe-transition'|'unsafe-active-jobs'|'operator-required'|'transition-race', message: string) { super(message); } }
const transitions: Record<BacktestProcessorOwner, BacktestProcessorOwner[]> = {
  monolith: ['disabled'], service: ['disabled'], disabled: ['monolith','service'],
};

export class MysqlBacktestOwnershipAuthority {
  constructor(private readonly database: QueueDb = db) {}
  async read(): Promise<OwnershipState> {
    const { rows } = await this.database.query<any>('SELECT owner,epoch,updated_at,updated_by FROM backtest_processor_ownership WHERE singleton_id=1');
    if (!rows[0]) throw new BacktestOwnershipAuthorityError('missing','Backtest ownership authority is missing');
    if (!['monolith','service','disabled'].includes(rows[0].owner)) throw new BacktestOwnershipAuthorityError('invalid-owner',`Invalid authoritative owner: ${rows[0].owner}`);
    const epoch = Number(rows[0].epoch); if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new BacktestOwnershipAuthorityError('invalid-epoch',`Invalid authoritative epoch: ${rows[0].epoch}`);
    const updatedAt = new Date(rows[0].updated_at); if (Number.isNaN(updatedAt.getTime())) throw new BacktestOwnershipAuthorityError('invalid-epoch','Invalid authority updated_at');
    return { owner: rows[0].owner, epoch, updatedAt, updatedBy: String(rows[0].updated_by ?? '') };
  }
  async activeRuns() { const { rows } = await this.database.query<any>(`SELECT ownership_epoch,processor_type,COUNT(*) count,MIN(lease_expires_at) earliest_lease,MAX(lease_expires_at) latest_lease FROM backtest_runs WHERE status IN ('running','cancel_requested') GROUP BY ownership_epoch,processor_type ORDER BY ownership_epoch`); return rows; }
  async transition(expectedEpoch: number, nextOwner: BacktestProcessorOwner, operator: string, dryRun = true): Promise<OwnershipState> {
    if (!operator.trim()) throw new BacktestOwnershipAuthorityError('operator-required','Operator identity is required');
    const current = await this.read();
    if (current.epoch !== expectedEpoch) throw new BacktestOwnershipAuthorityError('stale-epoch',`Stale ownership epoch: expected ${expectedEpoch}, authoritative ${current.epoch}`);
    if (!transitions[current.owner].includes(nextOwner)) throw new BacktestOwnershipAuthorityError('unsafe-transition',`Unsafe ownership transition ${current.owner} -> ${nextOwner}; use disabled as the intermediate state`);
    const active = await this.activeRuns();
    if (current.owner === 'disabled' && active.length) throw new BacktestOwnershipAuthorityError('unsafe-active-jobs',`Cannot leave disabled with ${active.reduce((n,row)=>n+Number(row.count),0)} active old-epoch job(s)`);
    if (dryRun) return { owner: nextOwner, epoch: current.epoch + 1, updatedAt: current.updatedAt, updatedBy: operator };
    const result = await this.database.query(
      'UPDATE backtest_processor_ownership SET owner=?,epoch=epoch+1,updated_at=NOW(3),updated_by=? WHERE singleton_id=1 AND epoch=? AND owner=?',
      [nextOwner, operator, expectedEpoch, current.owner],
    );
    if ((result.affectedRows ?? 0) !== 1) throw new BacktestOwnershipAuthorityError('transition-race','Ownership transition lost an epoch race');
    const state = await this.read(); console.info(JSON.stringify({event:'backtest_ownership_transition',fromOwner:current.owner,toOwner:state.owner,fromEpoch:current.epoch,toEpoch:state.epoch,operator,timestamp:state.updatedAt.toISOString()})); return state;
  }
  async assertCurrent(kind: 'monolith'|'service', epoch: number): Promise<OwnershipState> {
    const current = await this.read();
    if (current.owner !== kind || current.epoch !== epoch) throw new Error(`Backtest ownership drift: configured ${kind}@${epoch}, authoritative ${current.owner}@${current.epoch}`);
    return current;
  }
}
