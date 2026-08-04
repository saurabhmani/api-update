import type { SessionUser } from '@/lib/session';
import { db, getDb } from '@/lib/db';

export type BacktestActor =
  | { kind: 'user'; userId: number }
  | { kind: 'admin'; userId: number };

export const backtestActorFromSession = (session: SessionUser): BacktestActor =>
  session.role === 'admin' ? { kind: 'admin', userId: session.id } : { kind: 'user', userId: session.id };

const scope = (actor: BacktestActor, alias = '') => actor.kind === 'admin'
  ? { sql: '', params: [] as string[] }
  : { sql: ` AND ${alias}created_by=?`, params: [String(actor.userId)] };

export async function getBacktestForActor(runId: string, actor: BacktestActor): Promise<any | null> {
  const scoped = scope(actor);
  const { rows } = await db.query(`SELECT * FROM backtest_runs WHERE run_id=?${scoped.sql}`, [runId, ...scoped.params]);
  return rows[0] ?? null;
}

export async function listBacktestsForActor(actor: BacktestActor): Promise<any[]> {
  const scoped = scope(actor);
  const { rows } = await db.query(`SELECT run_id,name,status,started_at,completed_at,duration_ms,signal_count,trade_count,
    summary_json,strategy_breakdown_json,config_json,COALESCE(progress_percent,0) progress_percent,current_step,error
    FROM backtest_runs WHERE 1=1${scoped.sql} ORDER BY started_at DESC LIMIT 50`, scoped.params);
  return rows;
}

export type DeleteBacktestResult = 'deleted' | 'not_found_or_unauthorized' | 'active_not_deletable';
export async function deleteBacktestForActor(runId: string, actor: BacktestActor): Promise<DeleteBacktestResult> {
  const connection = await getDb().getConnection();
  const scoped = scope(actor);
  try {
    await connection.beginTransaction();
    const [rows]: any = await connection.query(`SELECT status FROM backtest_runs WHERE run_id=?${scoped.sql} FOR UPDATE`, [runId, ...scoped.params]);
    if (!rows[0]) { await connection.rollback(); return 'not_found_or_unauthorized'; }
    if (!['completed','failed','dead','cancelled','partial_success','success'].includes(String(rows[0].status))) {
      await connection.rollback(); return 'active_not_deletable';
    }
    for (const table of ['backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','backtest_equity_curve','backtest_audit_logs','calibration_snapshots','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary']) {
      await connection.query(`DELETE FROM ${table} WHERE run_id=?`, [runId]);
    }
    await connection.query(`DELETE FROM backtest_runs WHERE run_id=?${scoped.sql}`, [runId, ...scoped.params]);
    await connection.commit(); return 'deleted';
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

export function auditBacktestAuthorization(input: { actor: BacktestActor; runId?: string; route: string; operation: string; decision: string; correlationId: string }) {
  console.info(JSON.stringify({ event:'backtest_resource_authorization', actorUserId:input.actor.userId, actorKind:input.actor.kind, runId:input.runId, route:input.route, operation:input.operation, decision:input.decision, correlationId:input.correlationId, timestamp:new Date().toISOString() }));
}
