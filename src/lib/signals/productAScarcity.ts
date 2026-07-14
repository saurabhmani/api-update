// ════════════════════════════════════════════════════════════════
//  Phase 9 — Signal scarcity messaging (Product A)
//
//  Zero elite is acceptable. Never invoke relax mode or synthetic
//  fallbacks merely to fill the page.
// ════════════════════════════════════════════════════════════════

export interface ScarcityContext {
  eliteCount: number;
  actionableCount: number;
  watchlistCount: number;
  highPotentialCount?: number;
}

export interface ScarcityMessage {
  title: string;
  subtitle: string;
  /** True when the empty state is intentional quality filtering. */
  scarcityOk: boolean;
}

/**
 * Subscriber-facing scarcity copy when elite/actionable pools are empty.
 */
export function buildProductAScarcityMessage(ctx: ScarcityContext): ScarcityMessage | null {
  if (ctx.eliteCount > 0 || ctx.actionableCount > 0) return null;

  const watch = ctx.watchlistCount + (ctx.highPotentialCount ?? 0);
  if (watch > 0) {
    return {
      title: 'No elite setup currently meets Quantorus quality standards.',
      subtitle:
        `${watch} opportunit${watch === 1 ? 'y' : 'ies'} remain on the watchlist awaiting confirmation.`,
      scarcityOk: true,
    };
  }

  return {
    title: 'No elite setup currently meets Quantorus quality standards.',
    subtitle:
      'Scarcity is intentional — Quantorus will not fill this page with synthetic or relaxed signals.',
    scarcityOk: true,
  };
}

/** Upgrade legacy empty-state strings toward Phase 9 wording. */
export function enrichEmptyStateMessage(
  legacy: string | null,
  ctx: ScarcityContext,
): string | null {
  const scarcity = buildProductAScarcityMessage(ctx);
  if (!scarcity) return legacy;
  if (!legacy) return `${scarcity.title} ${scarcity.subtitle}`;
  if (/no (institutional|execution-ready|fully confirmed)/i.test(legacy)) {
    return `${scarcity.title} ${scarcity.subtitle}`;
  }
  return legacy;
}
