// Sector Rotation Engine — relative strength and rotation phases

import { db } from '@/lib/db';
import type { SectorRotationSnapshot } from '../types';
import { ensureQuantTables } from '../repository/quantRepository';

const SECTOR_ETF_MAP: Record<string, string> = {
  IT: 'NIFTYIT',
  Bank: 'NIFTYBANK',
  Pharma: 'NIFTYPHARMA',
  Auto: 'NIFTYAUTO',
  Metal: 'NIFTYMETAL',
  FMCG: 'NIFTYFMCG',
  Realty: 'NIFTYREALTY',
  Energy: 'NIFTYENERGY',
};

async function sectorReturn(sector: string, days: number): Promise<number> {
  const proxy = SECTOR_ETF_MAP[sector] ?? sector;
  try {
    const { rows } = await db.query(
      `SELECT close FROM market_data_daily WHERE symbol IN (?, ?) ORDER BY ts DESC LIMIT ?`,
      [proxy, sector, days + 1],
    );
    if ((rows as any[]).length < 2) return 0;
    const closes = (rows as any[]).map((r) => Number(r.close)).reverse();
    return (closes[closes.length - 1] - closes[0]) / closes[0];
  } catch {
    return 0;
  }
}

async function benchmarkReturn(days: number): Promise<number> {
  try {
    const { rows } = await db.query(
      `SELECT close FROM market_data_daily WHERE symbol IN ('NIFTY50','NIFTY 50','^NSEI') ORDER BY ts DESC LIMIT ?`,
      [days + 1],
    );
    if ((rows as any[]).length < 2) return 0;
    const closes = (rows as any[]).map((r) => Number(r.close)).reverse();
    return (closes[closes.length - 1] - closes[0]) / closes[0];
  } catch {
    return 0;
  }
}

export async function computeSectorRotation(): Promise<SectorRotationSnapshot> {
  const sectors = Object.keys(SECTOR_ETF_MAP);
  const bench20 = await benchmarkReturn(20);
  const bench60 = await benchmarkReturn(60);

  const scores: Array<{ sector: string; relativeStrength: number; momentum: number }> = [];

  for (const sector of sectors) {
    const ret20 = await sectorReturn(sector, 20);
    const ret60 = await sectorReturn(sector, 60);
    const rs = bench20 !== 0 ? ret20 - bench20 : ret20;
    const momentum = ret20 - ret60;
    scores.push({
      sector,
      relativeStrength: Math.round(rs * 10000) / 100,
      momentum: Math.round(momentum * 10000) / 100,
    });
  }

  scores.sort((a, b) => b.relativeStrength - a.relativeStrength);
  const leaders = scores.slice(0, 3);
  const laggards = scores.slice(-3).reverse();

  const avgLeaderRs = leaders.reduce((s, l) => s + l.relativeStrength, 0) / Math.max(1, leaders.length);
  const avgLaggardRs = laggards.reduce((s, l) => s + l.relativeStrength, 0) / Math.max(1, laggards.length);

  let phase: SectorRotationSnapshot['phase'] = 'neutral';
  if (avgLeaderRs > 2 && avgLaggardRs < -1) phase = 'rotation';
  else if (avgLeaderRs > 1 && bench20 > 0) phase = 'risk_on';
  else if (bench20 < -1) phase = 'risk_off';

  const conviction = Math.min(100, Math.round(Math.abs(avgLeaderRs - avgLaggardRs) * 10));

  const narrative = phase === 'rotation'
    ? `Capital rotating into ${leaders.map((l) => l.sector).join(', ')} from ${laggards.map((l) => l.sector).join(', ')}.`
    : phase === 'risk_on'
      ? 'Broad risk-on environment with sector leaders outperforming benchmark.'
      : phase === 'risk_off'
        ? 'Defensive positioning favored; reduce cyclical exposure.'
        : 'No clear rotation signal; maintain diversified sector allocation.';

  try {
    await ensureQuantTables();
    await db.query(
      `INSERT INTO q365_sector_rotation_snapshots (phase, leaders_json, laggards_json, conviction) VALUES (?, ?, ?, ?)`,
      [phase, JSON.stringify(leaders), JSON.stringify(laggards), conviction],
    );
  } catch { /* non-fatal */ }

  return { phase, leaders, laggards, conviction, narrative };
}
