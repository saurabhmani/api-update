/**
 * Broker WebSocket streaming retired — IndianAPI warehouse has no live ticks.
 * Kept as a no-op so any residual callers do not load kiteconnect.
 */

export async function ensureStreamingAfterBrokerConnect(_opts?: {
  userId?: number;
  broker?: string;
}): Promise<void> {
  // no-op
}

export async function ensureBrokerStreamingForUser(_userId: number): Promise<void> {
  // no-op
}

export async function disconnectBrokerStreaming(_opts?: {
  userId?: number;
  broker?: string;
}): Promise<void> {
  // no-op
}
