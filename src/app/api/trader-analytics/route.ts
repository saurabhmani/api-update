import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();

    const { rows } = await db.query(
      `SELECT * FROM trade_journal WHERE user_id=? AND outcome != 'open'`, [user.id]
    );

    if (!rows.length) return NextResponse.json({
      summary: { total_trades: 0, wins: 0, losses: 0, win_rate: 0, avg_pnl: 0 },
      patterns: [], insights: ['Add trades to your journal to see analytics'],
    });

    const wins    = rows.filter(r => r.outcome === 'win').length;
    const losses  = rows.filter(r => r.outcome === 'loss').length;
    const winRate = parseFloat(((wins / rows.length) * 100).toFixed(1));
    const avgPnl  = rows.reduce((s, r) => s + parseFloat(r.pnl ?? 0), 0) / rows.length;

    // Day-of-week performance
    const dayMap: Record<string, { wins: number; total: number }> = {};
    for (const t of rows) {
      const day = new Date(t.entry_date).toLocaleDateString('en-IN', { weekday: 'short' });
      if (!dayMap[day]) dayMap[day] = { wins: 0, total: 0 };
      dayMap[day].total++;
      if (t.outcome === 'win') dayMap[day].wins++;
    }
    const dayPerf = Object.entries(dayMap).map(([day, v]) => ({
      day, winRate: parseFloat(((v.wins / v.total) * 100).toFixed(0)), trades: v.total,
    })).sort((a, b) => b.winRate - a.winRate);

    const bestDay  = dayPerf[0]?.day;
    const worstDay = dayPerf[dayPerf.length - 1]?.day;

    // Timeframe performance
    const tfMap: Record<string, { wins: number; total: number }> = {};
    for (const t of rows) {
      const tf = t.timeframe || 'unknown';
      if (!tfMap[tf]) tfMap[tf] = { wins: 0, total: 0 };
      tfMap[tf].total++;
      if (t.outcome === 'win') tfMap[tf].wins++;
    }
    const tfPerf = Object.entries(tfMap).map(([tf, v]) => ({
      timeframe: tf, winRate: parseFloat(((v.wins / v.total) * 100).toFixed(0)), trades: v.total,
    }));

    // Hold time analysis
    const withExit = rows.filter(r => r.exit_date && r.entry_date);
    const avgHoldHrs = withExit.length
      ? withExit.reduce((s, r) => {
          const diff = (new Date(r.exit_date).getTime() - new Date(r.entry_date).getTime()) / 3600000;
          return s + diff;
        }, 0) / withExit.length
      : 0;

    // Early exit detection (exits before T1 even on wins)
    const earlyExits = rows.filter(r =>
      r.outcome === 'win' && r.pnl_pct && parseFloat(r.pnl_pct) < 1
    ).length;

    // Emotion analysis
    const fomo = rows.filter(r => r.emotion_entry === 'fomo').length;
    const fearExit = rows.filter(r => r.emotion_exit === 'fear').length;

    // Build insights
    const insights: string[] = [];
    if (winRate < 40) insights.push('Win rate below 40% — review your entry criteria');
    if (earlyExits > rows.length * 0.3) insights.push('You exit profitable trades too early — consider trailing stops');
    if (fomo > rows.length * 0.2) insights.push('High FOMO entries detected — wait for setups to form properly');
    if (fearExit > rows.length * 0.25) insights.push('Fear-driven exits costing profits — set stop loss before entry');
    if (bestDay) insights.push(`Your best trading day is ${bestDay} — consider trading more actively then`);
    if (worstDay) insights.push(`${worstDay} has been your weakest day — trade smaller or avoid`);
    if (avgHoldHrs < 1 && rows.length > 5) insights.push('Very short average hold time — may be overtrading');

    if (!insights.length) insights.push('Good discipline so far — keep journaling to see deeper patterns');

    return NextResponse.json({
      summary: {
        total_trades: rows.length, wins, losses, win_rate: winRate,
        avg_pnl: parseFloat(avgPnl.toFixed(2)), avg_hold_hours: parseFloat(avgHoldHrs.toFixed(1)),
        best_day: bestDay, worst_day: worstDay,
      },
      day_performance:  dayPerf,
      tf_performance:   tfPerf,
      patterns:         { early_exits: earlyExits, fomo_trades: fomo, fear_exits: fearExit },
      insights,
    });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
