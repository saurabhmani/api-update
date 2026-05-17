// ════════════════════════════════════════════════════════════════
//  normalizeSignalReasons — Phase 1 QA helper
//
//  Guarantees a consistent four-bucket reason envelope on every
//  signal-shaped object, regardless of which upstream path produced
//  it. Eliminates the case where a downstream consumer reads
//  `signal.rejectionReasons` and gets `undefined` because the path
//  used `missingApprovalFactors` instead.
//
//  Output shape:
//    {
//      confirmationReasons: string[],
//      watchlistReasons:    string[],
//      rejectionReasons:    string[],
//      missingRequirements: string[],
//    }
//
//  Rules:
//    - Every field is always an array (never undefined/null).
//    - Every entry is a non-empty, trimmed string.
//    - Duplicates are removed.
//    - Whitespace-only / "Unknown" / "—" / "null" / "undefined"
//      entries are stripped.
// ════════════════════════════════════════════════════════════════

export interface NormalizedSignalReasons {
  confirmationReasons: string[];
  watchlistReasons:    string[];
  rejectionReasons:    string[];
  missingRequirements: string[];
}

/** Shape this helper accepts on input — every field is optional so
 *  callers can pass partial signal objects. */
export interface ReasonsInput {
  confirmationReasons?:    unknown;
  watchlistReasons?:       unknown;
  rejectionReasons?:       unknown;
  missingRequirements?:    unknown;
  /** Common synonyms surfaced by older paths. Both are mapped to
   *  `missingRequirements` so downstream consumers see one bucket. */
  missingApprovalFactors?: unknown;
  blockReasons?:           unknown;
  /** Legacy single-string reason — fed into watchlistReasons. */
  reason?:                 unknown;
}

const NOISE_VALUES = new Set([
  '', '—', '-', '–', 'unknown', 'undefined', 'null', 'n/a', 'na', 'none',
]);

function toCleanArray(v: unknown): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    if (item == null) continue;
    const s = String(item).replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (NOISE_VALUES.has(s.toLowerCase())) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function normalizeSignalReasons(input: ReasonsInput | null | undefined): NormalizedSignalReasons {
  const safe = input ?? {};
  const watchlistReasons   = toCleanArray(safe.watchlistReasons);
  const rejectionReasons   = toCleanArray(safe.rejectionReasons);
  const confirmationReasons = toCleanArray(safe.confirmationReasons);
  // Merge the two common "missing" synonyms.
  const missingRequirements = Array.from(new Set([
    ...toCleanArray(safe.missingRequirements),
    ...toCleanArray(safe.missingApprovalFactors),
    ...toCleanArray(safe.blockReasons),
  ]));
  // Legacy single `reason` — append to watchlistReasons only when
  // there isn't already an explicit entry, so we never duplicate.
  const legacy = toCleanArray(safe.reason);
  for (const line of legacy) {
    if (!watchlistReasons.includes(line)) watchlistReasons.push(line);
  }
  return { confirmationReasons, watchlistReasons, rejectionReasons, missingRequirements };
}
