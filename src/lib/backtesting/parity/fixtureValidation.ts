import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_FILES = ['fixture.json', 'candles.json', 'expected-characteristics.json'] as const;

export async function validateDeterministicBacktestFixture(root = path.resolve('src/test-fixtures/backtesting')) {
  const categories = {
    contentIntegrity: { ok: true, errors: [] as string[] },
    manifestIntegrity: { ok: true, errors: [] as string[] },
    hashIntegrity: { ok: true, errors: [] as string[] },
    schemaValidity: { ok: true, errors: [] as string[] },
    runnerSuitability: { ok: true, errors: [] as string[] },
    expectedPathSuitability: { ok: true, errors: [] as string[] },
  };
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8'));
  const candles = JSON.parse(await fs.readFile(path.join(root, 'candles.json'), 'utf8'));
  const expected = JSON.parse(await fs.readFile(path.join(root, 'expected-characteristics.json'), 'utf8'));
  const hashes: Record<string, string> = {};
  for (const file of REQUIRED_FILES) hashes[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex');
  if (manifest.fixtureId !== fixture.fixtureId || manifest.fixtureVersion !== fixture.fixtureVersion) categories.manifestIntegrity.errors.push('manifest identity does not match fixture');
  for (const file of REQUIRED_FILES) if (hashes[file] !== manifest.files?.[file]) categories.hashIntegrity.errors.push(`${file} hash mismatch`);
  if (!Array.isArray(candles) || candles.length === 0) categories.schemaValidity.errors.push('candles must be a non-empty array');
  const requiredCandleFields = ['symbol', 'date', 'timestamp', 'open', 'high', 'low', 'close', 'volume'];
  for (const [index, candle] of candles.entries()) {
    for (const field of requiredCandleFields) if (candle[field] === undefined) categories.schemaValidity.errors.push(`candle ${index} missing ${field}`);
    if (!(candle.low <= candle.open && candle.low <= candle.close && candle.high >= candle.open && candle.high >= candle.close)) categories.contentIntegrity.errors.push(`candle ${index} has invalid OHLC geometry`);
    if (candle.volume < 0) categories.contentIntegrity.errors.push(`candle ${index} has negative volume`);
  }
  const perSymbol: Record<string, number> = {};
  for (const candle of candles) perSymbol[candle.symbol] = (perSymbol[candle.symbol] ?? 0) + 1;
  const requiredBars = Math.max(Number(fixture.warmupBars ?? 0), 220) + 40;
  for (const symbol of [...fixture.instruments, fixture.benchmarkSymbol]) if ((perSymbol[symbol] ?? 0) < requiredBars) categories.runnerSuitability.errors.push(`${symbol} has ${perSymbol[symbol] ?? 0} bars; requires ${requiredBars} including safety margin`);
  if (fixture.provenance?.kind !== 'deterministic-synthetic-market-shaped' || fixture.provenance?.historicalExchangeTruth !== false) categories.contentIntegrity.errors.push('synthetic provenance must be explicit');
  const accepted = candles.filter((c: any) => c.symbol === fixture.strategy.acceptedSymbol);
  const rejected = candles.filter((c: any) => c.symbol === fixture.strategy.rejectedSymbol);
  if (!accepted.some((c: any, index: number) => index > 0 && c.volume >= accepted[index - 1].volume * 2)) categories.expectedPathSuitability.errors.push('accepted series has no deterministic volume expansion');
  if (!accepted.some((c: any, index: number) => index > 0 && c.close >= accepted[index - 1].close * 1.05)) categories.expectedPathSuitability.errors.push('accepted series has no deterministic breakout');
  if (!rejected.every((c: any) => c.volume < 100_000)) categories.expectedPathSuitability.errors.push('rejected series does not consistently exercise liquidity rejection');
  if (Number(expected.acceptedCandidatesAtLeast) < 1 || Number(expected.rejectedCandidatesAtLeast) < 1 || Number(expected.openedTradesAtLeast) < 1 || Number(expected.closedTradesAtLeast) < 1) categories.expectedPathSuitability.errors.push('required business path expectations are incomplete');
  for (const category of Object.values(categories)) category.ok = category.errors.length === 0;
  const blockers = Object.entries(categories).flatMap(([name, result]) => result.errors.map(error => `${name}: ${error}`));
  return {
    ok: blockers.length === 0, fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), hashes, categories, blockers,
    counts: { candles: candles.length, perSymbol, configuredWarmupBars: fixture.warmupBars, requiredBars },
    caveat: 'Static expected-path suitability does not replace real-runner execution evidence.',
  };
}
