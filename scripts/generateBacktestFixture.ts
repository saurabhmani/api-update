import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('src/test-fixtures/backtesting');
const VERIFY = process.argv.includes('--verify');
const SEED = 36502;
const BAR_COUNT = 280;

type Candle = { symbol: string; date: string; timestamp: string; open: number; high: number; low: number; close: number; volume: number };

function tradingDates(count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date('2024-01-02T03:45:00.000Z');
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function series(symbol: string, base: number, shape: 'benchmark' | 'breakout' | 'rejected'): Candle[] {
  let close = base;
  return tradingDates(BAR_COUNT).map((timestamp, index) => {
    const wave = Math.sin((index + SEED % 17) / 7) * 0.18;
    const trend = shape === 'rejected' ? -0.01 : 0.06;
    let move = trend + wave;
    if (shape === 'breakout' && index === 245) move = 8.5;
    if (shape === 'breakout' && index > 245 && index < 252) move = 1.25;
    if (shape === 'breakout' && index === 252) move = -5.5;
    if (shape === 'breakout' && index > 252) move = -0.35 + wave;
    const open = close;
    close = Math.max(55, close + move);
    const spread = shape === 'breakout' && index >= 245 ? 1.8 : 0.75;
    const volume = shape === 'rejected' ? 25_000 + (index % 7) * 500 : 220_000 + (index % 13) * 4_000 + (shape === 'breakout' && index >= 245 ? 500_000 : 0);
    return {
      symbol,
      date: timestamp.slice(0, 10),
      timestamp,
      open: round(open),
      high: round(Math.max(open, close) + spread),
      low: round(Math.min(open, close) - spread),
      close: round(close),
      volume,
    };
  });
}

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function sha(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }

async function build() {
  const candles = [
    ...series('FIXTURE-A', 100, 'breakout'),
    ...series('FIXTURE-B', 200, 'rejected'),
    ...series('FIXTURE-BENCH', 20_000, 'benchmark'),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.symbol.localeCompare(b.symbol));
  const fixture = {
    fixtureId: 'q365-backtest-canary-synthetic-v2', fixtureVersion: '2.0.0', timezone: 'Asia/Kolkata',
    marketCalendar: 'Weekday-only deterministic synthetic calendar; no exchange-holiday claims', randomSeed: SEED,
    inputVersion: '2', strategyVersion: 'strategy-engine-contract-v1', marketDataFixtureVersion: '2',
    minimumRunnerVersion: 'backtest-runner-v2', instruments: ['FIXTURE-A', 'FIXTURE-B'], benchmarkSymbol: 'FIXTURE-BENCH',
    startDate: candles[0].date, endDate: candles[candles.length - 1].date, warmupBars: 220,
    startingCapital: 1_000_000, feesBps: 5, slippageBps: 10,
    risk: { maxPositionPercent: 10, maxDrawdownPercent: 20 },
    strategy: { acceptedSymbol: 'FIXTURE-A', rejectedSymbol: 'FIXTURE-B' },
    provenance: { kind: 'deterministic-synthetic-market-shaped', generator: 'scripts/generateBacktestFixture.ts', historicalExchangeTruth: false },
  };
  const expected = {
    acceptedCandidatesAtLeast: 1, rejectedCandidatesAtLeast: 1, openedTradesAtLeast: 1, closedTradesAtLeast: 1,
    requiresFees: true, requiresSlippage: true, requiresEquityChange: true, requiresDrawdown: true,
    requiresStrategyBreakdown: true, requiredProgressCheckpoints: [25, 75, 100], finalStatus: 'completed',
    notes: 'Path expectations must be proven by the real runner; the verifier never fabricates business results.',
  };
  const files: Record<string, string> = {
    'fixture.json': json(fixture), 'candles.json': json(candles), 'expected-characteristics.json': json(expected),
  };
  const manifest = json({
    fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion, createdAt: '2026-08-04', generatorSeed: SEED,
    generator: 'scripts/generateBacktestFixture.ts', files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, sha(value)])),
  });
  files['manifest.json'] = manifest;
  const differences: string[] = [];
  for (const [name, value] of Object.entries(files)) {
    const target = path.join(ROOT, name);
    if (VERIFY) {
      const current = await fs.readFile(target, 'utf8').catch(() => '');
      if (current !== value) differences.push(name);
    } else await fs.writeFile(target, value, 'utf8');
  }
  if (differences.length) throw new Error(`generated fixture differs: ${differences.join(', ')}`);
  console.log(JSON.stringify({ ok: true, mode: VERIFY ? 'verify' : 'write', fixtureId: fixture.fixtureId, barsPerSymbol: BAR_COUNT, files: Object.keys(files) }, null, 2));
}

void build().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
