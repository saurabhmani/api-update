// ════════════════════════════════════════════════════════════════
//  streamServer — DISABLED
//
//  The WebSocket price fan-out server has been disabled as part of
//  the Kite removal. With no Kite WebSocket feeding prices into
//  process memory, there is nothing for this server to broadcast.
//  Live prices now come from Yahoo Finance polled per-request by
//  the UI pages that need them (see /market, useLivePrices, etc.).
//
//  The module's public surface is preserved (startStreamServer,
//  stopStreamServer, seedKiteMapFromDaily) so existing importers
//  continue to compile. Each export is a safe no-op that logs one
//  line and returns the previous shape.
// ════════════════════════════════════════════════════════════════

export interface ServerState {
  /** Always false — the server never starts. */
  running: false;
}

let loggedOnce = false;
function logRemoval(caller: string): void {
  if (loggedOnce) return;
  loggedOnce = true;
  console.log(
    `[streamServer] ${caller}: WS price fan-out is disabled ` +
    `(Kite removed; Yahoo is polled per-request). Noop.`,
  );
}

export function startStreamServer(): ServerState {
  logRemoval('startStreamServer');
  return { running: false };
}

export async function seedKiteMapFromDaily(_s?: ServerState): Promise<number> {
  logRemoval('seedKiteMapFromDaily');
  return 0;
}

export function stopStreamServer(): void {
  /* no-op */
}
