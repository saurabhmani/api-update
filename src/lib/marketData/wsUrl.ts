// Central WebSocket URL resolution for browser clients.

export function resolveMarketWsUrl(): string {
  const override = process.env.NEXT_PUBLIC_STREAM_WS_URL;
  if (override) return override;

  if (typeof window === 'undefined') {
    const devPort = process.env.NEXT_PUBLIC_STREAM_WS_PORT ?? '3001';
    return `ws://localhost:${devPort}`;
  }

  const isHttps = window.location.protocol === 'https:';
  const host    = window.location.hostname;
  if (isHttps) return `wss://${host}/ws`;

  const devPort = process.env.NEXT_PUBLIC_STREAM_WS_PORT ?? '3001';
  return `ws://${host}:${devPort}`;
}

export function isMarketWsDisabled(): boolean {
  return (process.env.NEXT_PUBLIC_STREAM_WS_DISABLED ?? '').toLowerCase() === 'true';
}
