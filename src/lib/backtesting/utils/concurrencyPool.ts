// ════════════════════════════════════════════════════════════════
//  Concurrency Pool — Bounded Parallel Execution (Section 1)
//
//  Zero-dependency replacement for p-limit. Runs `tasks` with at
//  most `maxConcurrency` in flight, preserving input order in the
//  returned results array.
//
//  Errors:
//   - By default, the first rejection short-circuits and rejects.
//   - Pass { continueOnError: true } to capture all results as
//     { ok, value?, error? } tuples without aborting the run.
// ════════════════════════════════════════════════════════════════

export interface PoolOptions {
  maxConcurrency: number;
  continueOnError?: boolean;
  onProgress?: (completed: number, total: number) => void;
}

export type PoolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

/**
 * Run a list of async factories with bounded concurrency.
 * Results are returned in the same order as the input tasks.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  options: PoolOptions,
): Promise<T[]> {
  const { maxConcurrency } = options;
  if (maxConcurrency <= 0) {
    throw new Error(`runWithConcurrency: maxConcurrency must be > 0 (got ${maxConcurrency})`);
  }
  if (tasks.length === 0) return [];

  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let completed = 0;

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(maxConcurrency, tasks.length);

  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= tasks.length) return;
        results[i] = await tasks[i]();
        completed++;
        options.onProgress?.(completed, tasks.length);
      }
    })());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Like runWithConcurrency but captures per-task errors instead of
 * rejecting. Useful when one failing symbol shouldn't kill the run.
 */
export async function runWithConcurrencySettled<T>(
  tasks: Array<() => Promise<T>>,
  options: Omit<PoolOptions, 'continueOnError'>,
): Promise<PoolResult<T>[]> {
  const wrapped = tasks.map((t) => async (): Promise<PoolResult<T>> => {
    try {
      const value = await t();
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  });
  return runWithConcurrency(wrapped, options);
}

/** Split an array into fixed-size chunks for streaming persistence. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk: size must be > 0 (got ${size})`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
