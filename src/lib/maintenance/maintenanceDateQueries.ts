import { db } from '@/lib/db';
import { getLatestCompletedTradingDay, getMarketStatus } from '@/lib/marketData/marketHours';

/** Pure date logic — safe to import from Next.js API routes (no worker deps). */
function previousWeekdays(endDate: string, count: number): string[] {
  const date = new Date(`${endDate}T12:00:00.000Z`);
  const dates: string[] = [];
  while (dates.length < count) {
    const day = date.getUTCDay();
    const dateString = date.toISOString().slice(0, 10);
    const marketDay = getMarketStatus(new Date(`${dateString}T06:00:00.000Z`));
    if (day !== 0 && day !== 6 && marketDay.state !== 'holiday') dates.push(dateString);
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return dates.reverse();
}

export async function findMaintenanceDatesToRun(
  options: { lookbackTradingDays?: number; maxDates?: number } = {},
): Promise<string[]> {
  const candidates = previousWeekdays(
    getLatestCompletedTradingDay(),
    options.lookbackTradingDays ?? 7,
  );
  if (candidates.length === 0) return [];
  const { rows } = await db.query<any>(
    `SELECT trading_date FROM q365_maintenance_job_runs
      WHERE job_name='health_snapshot' AND status='succeeded'
        AND trading_date BETWEEN ? AND ?`,
    [candidates[0], candidates[candidates.length - 1]],
  ).catch(() => ({ rows: [] }));
  const completed = new Set(rows.map((row: any) => String(row.trading_date).slice(0, 10)));
  return candidates.filter((date) => !completed.has(date)).slice(0, options.maxDates ?? 2);
}
