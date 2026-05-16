// ════════════════════════════════════════════════════════════════
//  GET /api/signal-engine/debug/conflicts
//
//  Phase 2 §4 (optional) — admin/debug view for strategy conflict
//  resolutions. Returns recent multi-strategy clusters with the
//  winning strategy, all losing strategies + rejection reasons, and
//  a join to q365_strategy_breakdowns so reviewers can see the full
//  score decomposition per candidate.
//
//  Query params (all optional):
//    symbol      — filter to one symbol
//    limit       — max conflict rows (default 50, capped at 200)
//    sinceHours  — only conflicts resolved in the last N hours
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface ConflictRow {
  id: number;
  symbol: string;
  winning_signal_id: number | null;
  winning_strategy: string;
  winning_score: number | string;
  losing_strategies_json: unknown;
  had_direction_conflict: number;
  decision_reason: string | null;
  resolved_at: string;
}

interface BreakdownRow {
  signal_id: number;
  strategy_name: string;
  matched: number;
  confidence_score: number | string;
  risk_score: number | string;
  regime_fit: number | string;
  rs_alignment: number | string;
  sector_fit: number | string;
  structural_quality: number | string;
  rejection_reason: string | null;
}

export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const symbol = req.nextUrl.searchParams.get('symbol');
  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Math.min(Number.isFinite(limitParam) ? limitParam : 50, 200);
  const sinceHoursParam = req.nextUrl.searchParams.get('sinceHours');
  const sinceHours = sinceHoursParam != null ? Number(sinceHoursParam) : null;

  try {
    // ── Build conflict query with optional filters ─────────
    const where: string[] = [];
    const args: unknown[] = [];
    if (symbol) {
      where.push('symbol = ?');
      args.push(symbol);
    }
    if (sinceHours != null && Number.isFinite(sinceHours)) {
      where.push('resolved_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)');
      args.push(sinceHours);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const conflictsResult = await db.query<ConflictRow>(
      `SELECT id, symbol, winning_signal_id, winning_strategy, winning_score,
              losing_strategies_json, had_direction_conflict,
              decision_reason, resolved_at
         FROM q365_signal_conflicts
         ${whereSql}
         ORDER BY resolved_at DESC
         LIMIT ?`,
      [...args, limit],
    ).catch(() => ({ rows: [] as ConflictRow[] }));

    const conflicts = conflictsResult.rows;

    // ── Pull breakdowns for every winning signal in one query ──
    // Avoids N+1. Only winners are joined because non-winning
    // candidates still get a breakdown row via saveStrategyBreakdowns
    // keyed on the *winning* signal id (all strategies for a symbol
    // share the one persisted signal).
    const winningIds = conflicts
      .map((c) => c.winning_signal_id)
      .filter((id): id is number => id != null);

    let breakdownsBySignal = new Map<number, BreakdownRow[]>();
    if (winningIds.length > 0) {
      const placeholders = winningIds.map(() => '?').join(',');
      const breakdownsResult = await db.query<BreakdownRow>(
        `SELECT signal_id, strategy_name, matched,
                confidence_score, risk_score,
                regime_fit, rs_alignment, sector_fit, structural_quality,
                rejection_reason
           FROM q365_strategy_breakdowns
          WHERE signal_id IN (${placeholders})
          ORDER BY confidence_score DESC`,
        winningIds,
      ).catch(() => ({ rows: [] as BreakdownRow[] }));

      for (const b of breakdownsResult.rows) {
        if (!breakdownsBySignal.has(b.signal_id)) {
          breakdownsBySignal.set(b.signal_id, []);
        }
        breakdownsBySignal.get(b.signal_id)!.push(b);
      }
    }

    // ── Shape the response ─────────────────────────────────
    const shaped = conflicts.map((c) => {
      // losing_strategies_json comes back as either a JSON string
      // or already-parsed object depending on driver. Handle both.
      let losingStrategies: unknown = c.losing_strategies_json;
      if (typeof losingStrategies === 'string') {
        try {
          losingStrategies = JSON.parse(losingStrategies);
        } catch {
          losingStrategies = [];
        }
      }

      return {
        id: c.id,
        symbol: c.symbol,
        winning_signal_id: c.winning_signal_id,
        winning_strategy: c.winning_strategy,
        winning_score: Number(c.winning_score),
        losing_strategies: losingStrategies,
        had_direction_conflict: Boolean(c.had_direction_conflict),
        decision_reason: c.decision_reason,
        resolved_at: c.resolved_at,
        breakdowns: c.winning_signal_id
          ? breakdownsBySignal.get(c.winning_signal_id) ?? []
          : [],
      };
    });

    return NextResponse.json({
      count: shaped.length,
      conflicts: shaped,
    });
  } catch (err) {
    console.error('[debug/conflicts]', err);
    return NextResponse.json(
      {
        error: 'Failed to load conflicts',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
