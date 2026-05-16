// ════════════════════════════════════════════════════════════════
//  runCounter — persistent monotonically-increasing run counter
//  used by the smart-rotation universe picker in
//  /api/run-signal-engine.
//
//  Why persistent: rotation offset = (runCount * CHUNK_SIZE) %
//  universe.length. Without persistence the counter resets to 0 on
//  every dev-server restart and the same first chunk gets scanned
//  forever — defeating the rotation.
//
//  Atomic write (tmp + rename) so concurrent reads never see a
//  half-written file. Stored next to the IndianAPI usage file
//  under `.next/` so both share the same persistence root.
// ════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), '.next', 'signal-run-counter.json');

interface CounterState {
  runCount: number;
  lastAt:   number;
}

function readState(): CounterState {
  try {
    if (!existsSync(STORE_PATH)) return { runCount: 0, lastAt: 0 };
    const raw = readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CounterState>;
    return {
      runCount: Number.isFinite(parsed?.runCount) ? Number(parsed!.runCount) : 0,
      lastAt:   Number.isFinite(parsed?.lastAt)   ? Number(parsed!.lastAt)   : 0,
    };
  } catch {
    return { runCount: 0, lastAt: 0 };
  }
}

let _state: CounterState | null = null;
function loadOnce(): CounterState {
  if (_state == null) _state = readState();
  return _state;
}

function persist(): void {
  if (_state == null) return;
  try {
    const dir = path.dirname(STORE_PATH);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = STORE_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(_state), 'utf8');
    renameSync(tmp, STORE_PATH);
  } catch {
    /* swallow — disk failure must not break the call path */
  }
}

/** Current run counter (0-indexed). Used to compute rotation offset
 *  WITHOUT advancing the counter. */
export function getRunCount(): number {
  return loadOnce().runCount;
}

/** Advance the run counter by 1 and persist. Returns the new value.
 *  Call this once per pipeline run, AFTER picking the rotation chunk
 *  (so two runs in the same process always pick distinct chunks). */
export function incrementRunCount(): number {
  const s = loadOnce();
  s.runCount += 1;
  s.lastAt    = Date.now();
  persist();
  return s.runCount;
}

/** Test-only reset. */
export function __resetRunCounterForTests(): void {
  _state = { runCount: 0, lastAt: 0 };
  persist();
}
