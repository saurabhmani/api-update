// ════════════════════════════════════════════════════════════════
//  Fibonacci Retracement & Extension Levels
// ════════════════════════════════════════════════════════════════

export interface FibonacciLevels {
  fib236: number | null;
  fib382: number | null;
  fib50: number | null;
  fib618: number | null;
  fib786: number | null;
  fib100: number | null;
  fib1272: number | null;
  fib1618: number | null;
}

export type FibLevelName = keyof FibonacciLevels;

export interface NearestFibLevel {
  name: FibLevelName;
  value: number;
}

const NULL_LEVELS: FibonacciLevels = {
  fib236: null,
  fib382: null,
  fib50: null,
  fib618: null,
  fib786: null,
  fib100: null,
  fib1272: null,
  fib1618: null,
};

function isValidInput(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Computes Fibonacci retracement and extension price levels from a swing range.
 *
 * Retracements (23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%) are measured downward
 * from `swingHigh`. Extensions (127.2%, 161.8%) project above `swingHigh`.
 *
 * Returns all levels as `null` when inputs are invalid (non-finite numbers or
 * `swingHigh <= swingLow`).
 */
export function calculateFibonacciLevels(
  swingHigh: number,
  swingLow: number,
): FibonacciLevels {
  if (!isValidInput(swingHigh) || !isValidInput(swingLow) || swingHigh <= swingLow) {
    return { ...NULL_LEVELS };
  }

  const range = swingHigh - swingLow;

  return {
    fib236: swingHigh - 0.236 * range,
    fib382: swingHigh - 0.382 * range,
    fib50: swingHigh - 0.5 * range,
    fib618: swingHigh - 0.618 * range,
    fib786: swingHigh - 0.786 * range,
    fib100: swingHigh - 1.0 * range,
    fib1272: swingHigh + 0.272 * range,
    fib1618: swingHigh + 0.618 * range,
  };
}

/**
 * Finds the Fibonacci level closest to `currentPrice` among non-null entries
 * in `levels`. Returns `null` when price is invalid or no levels are available.
 */
export function findNearestFibLevel(
  currentPrice: number,
  levels: FibonacciLevels,
): NearestFibLevel | null {
  if (!isValidInput(currentPrice)) {
    return null;
  }

  let nearest: NearestFibLevel | null = null;
  let minDistance = Infinity;

  for (const name of Object.keys(levels) as FibLevelName[]) {
    const value = levels[name];
    if (value === null || !isValidInput(value)) {
      continue;
    }

    const distance = Math.abs(currentPrice - value);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = { name, value };
    }
  }

  return nearest;
}

/**
 * Returns `true` when `currentPrice` is within `tolerancePct` percent of `level`
 * (e.g. `tolerancePct = 1` allows ±1% from the level).
 */
/** Human-readable label for a Fibonacci level key (e.g. `fib382` → `38.2%`). */
export function formatFibLevelDisplay(name: FibLevelName | string): string {
  const labels: Record<FibLevelName, string> = {
    fib236:  '23.6%',
    fib382:  '38.2%',
    fib50:   '50%',
    fib618:  '61.8%',
    fib786:  '78.6%',
    fib100:  '100%',
    fib1272: '127.2%',
    fib1618: '161.8%',
  };
  if (name in labels) return labels[name as FibLevelName];
  return String(name);
}

export function isPriceNearFibLevel(
  currentPrice: number,
  level: number,
  tolerancePct: number,
): boolean {
  if (!isValidInput(currentPrice) || !isValidInput(level) || !isValidInput(tolerancePct)) {
    return false;
  }

  if (level === 0) {
    return currentPrice === 0;
  }

  const toleranceRatio = tolerancePct / 100;
  return Math.abs(currentPrice - level) / Math.abs(level) <= toleranceRatio;
}
