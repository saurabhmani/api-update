import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const user = await requireSession();

    const { rows: allRows } = await db.query(
      `SELECT * FROM trade_journal WHERE user_id=?`,
      [user.id],
    );
    const rows = allRows.filter((r: any) => r.outcome && r.outcome !== 'open');

    if (!rows.length) return NextResponse.json({
      summary: {
        total_trades: allRows.length,
        closed_trades: 0,
        open_trades: allRows.length,
        wins: 0,
        losses: 0,
        breakeven: 0,
        win_rate: 0,
        avg_pnl: 0,
        total_pnl: 0,
        avg_win: 0,
        avg_loss: 0,
        profit_factor: 0,
        avg_hold_hours: 0,
      },
      patterns: [], insights: ['Add trades to your journal to see analytics'],
      day_performance: [],
      tf_performance: [],
      mistake_performance: [],
    });

    const wins    = rows.filter(r => r.outcome === 'win').length;
    const losses  = rows.filter(r => r.outcome === 'loss').length;
    const breakeven = rows.filter(r => r.outcome === 'breakeven').length;
    const winRate = parseFloat(((wins / rows.length) * 100).toFixed(1));
    const pnls = rows.map((r) => Number.parseFloat(r.pnl ?? 0)).filter(Number.isFinite);
    const totalPnl = pnls.reduce((s, n) => s + n, 0);
    const avgPnl  = totalPnl / rows.length;
    const winPnls = pnls.filter((n) => n > 0);
    const lossPnls = pnls.filter((n) => n < 0);
    const grossProfit = winPnls.reduce((s, n) => s + n, 0);
    const grossLoss = Math.abs(lossPnls.reduce((s, n) => s + n, 0));
    const avgWin = winPnls.length ? grossProfit / winPnls.length : 0;
    const avgLoss = lossPnls.length ? grossLoss / lossPnls.length : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0;

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
    const fearExit = rows.filter(r => r.emotion_exit === 'fearful').length;

    const mistakeMap: Record<string, { total: number; losses: number; pnl: number }> = {};
    for (const t of rows) {
      for (const tag of parseTags(t.tags)) {
        if (!mistakeMap[tag]) mistakeMap[tag] = { total: 0, losses: 0, pnl: 0 };
        mistakeMap[tag].total++;
        if (t.outcome === 'loss') mistakeMap[tag].losses++;
        mistakeMap[tag].pnl += Number.parseFloat(t.pnl ?? 0) || 0;
      }
    }
    const mistakePerf = Object.entries(mistakeMap)
      .map(([tag, v]) => ({
        tag,
        trades: v.total,
        lossRate: parseFloat(((v.losses / v.total) * 100).toFixed(0)),
        pnl: parseFloat(v.pnl.toFixed(2)),
      }))
      .sort((a, b) => b.lossRate - a.lossRate || a.pnl - b.pnl)
      .slice(0, 8);

    // Build insights
    const insights: string[] = [];
    if (winRate < 40) insights.push('Win rate below 40% — review your entry criteria');
    if (earlyExits > rows.length * 0.3) insights.push('You exit profitable trades too early — consider trailing stops');
    if (fomo > rows.length * 0.2) insights.push('High FOMO entries detected — wait for setups to form properly');
    if (fearExit > rows.length * 0.25) insights.push('Fear-driven exits costing profits — set stop loss before entry');
    if (profitFactor > 0 && profitFactor < 1) insights.push('Profit factor below 1.0 — losses are larger than gains');
    if (avgLoss > avgWin && avgWin > 0) insights.push('Average loss is larger than average win — improve exits or position sizing');
    if (mistakePerf[0]) insights.push(`Most frequent mistake tag: ${mistakePerf[0].tag} (${mistakePerf[0].trades} trades)`);
    if (bestDay) insights.push(`Your best trading day is ${bestDay} — consider trading more actively then`);
    if (worstDay) insights.push(`${worstDay} has been your weakest day — trade smaller or avoid`);
    if (avgHoldHrs < 1 && rows.length > 5) insights.push('Very short average hold time — may be overtrading');

    if (!insights.length) insights.push('Good discipline so far — keep journaling to see deeper patterns');

    return NextResponse.json({
      summary: {
        total_trades: allRows.length,
        closed_trades: rows.length,
        open_trades: allRows.length - rows.length,
        wins,
        losses,
        breakeven,
        win_rate: winRate,
        avg_pnl: parseFloat(avgPnl.toFixed(2)),
        total_pnl: parseFloat(totalPnl.toFixed(2)),
        avg_win: parseFloat(avgWin.toFixed(2)),
        avg_loss: parseFloat(avgLoss.toFixed(2)),
        profit_factor: parseFloat(profitFactor.toFixed(2)),
        avg_hold_hours: parseFloat(avgHoldHrs.toFixed(1)),
        best_day: bestDay, worst_day: worstDay,
      },
      day_performance:  dayPerf,
      tf_performance:   tfPerf,
      mistake_performance: mistakePerf,
      patterns:         { early_exits: earlyExits, fomo_trades: fomo, fear_exits: fearExit, tagged_mistakes: mistakePerf.reduce((s, m) => s + m.trades, 0) },
      insights,
    });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
