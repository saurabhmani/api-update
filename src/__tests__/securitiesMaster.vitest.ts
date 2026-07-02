import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  parseEquityLCsv,
  resolveEquityLCsvPath,
} from '@/lib/marketData/securitiesMaster';

describe('securitiesMaster', () => {
  it('auto-discovers bundled src/data/EQUITY_L.csv when env unset', () => {
    const prevPath = process.env.SECURITIES_MASTER_CSV_PATH;
    const prevEquity = process.env.EQUITY_L_CSV_PATH;
    delete process.env.SECURITIES_MASTER_CSV_PATH;
    delete process.env.EQUITY_L_CSV_PATH;
    const path = resolveEquityLCsvPath();
    expect(path).toBe(resolve(process.cwd(), 'src/data/EQUITY_L.csv'));
    if (prevPath !== undefined) process.env.SECURITIES_MASTER_CSV_PATH = prevPath;
    if (prevEquity !== undefined) process.env.EQUITY_L_CSV_PATH = prevEquity;
  });

  it('resolves EQUITY_L.csv from SECURITIES_MASTER_CSV_PATH', () => {
    const prev = process.env.SECURITIES_MASTER_CSV_PATH;
    process.env.SECURITIES_MASTER_CSV_PATH = 'src/data/EQUITY_L.csv';
    const path = resolveEquityLCsvPath();
    expect(path).toBe(resolve(process.cwd(), 'src/data/EQUITY_L.csv'));
    if (prev !== undefined) process.env.SECURITIES_MASTER_CSV_PATH = prev;
    else delete process.env.SECURITIES_MASTER_CSV_PATH;
  });

  it('parses bundled EQUITY_L.csv keeping SERIES=EQ only', () => {
    const csvPath = resolve(process.cwd(), 'src/data/EQUITY_L.csv');
    const rows = parseEquityLCsv(csvPath);
    expect(rows.length).toBeGreaterThan(1500);
    expect(rows.every((r) => r.series === 'EQ')).toBe(true);
    expect(rows.every((r) => r.symbol.length > 0)).toBe(true);
    const reliance = rows.find((r) => r.symbol === 'RELIANCE');
    expect(reliance?.companyName).toBeTruthy();
    expect(reliance?.isin).toMatch(/^INE/);
  });

  it('dedupes symbols and skips non-EQ series', () => {
    const csvPath = resolve(process.cwd(), 'src/data/EQUITY_L.csv');
    const rows = parseEquityLCsv(csvPath);
    const symbols = rows.map((r) => r.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});
