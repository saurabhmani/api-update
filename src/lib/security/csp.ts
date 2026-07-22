export interface SecurityHeaderOptions {
  nonce: string;
  pathname: string;
  isDev: boolean;
  isProduction: boolean;
}

const SWAGGER_UI_ORIGIN = 'https://unpkg.com';

function normalizeDirectives(directives: string[]): string {
  return directives
    .map((directive) => directive.trim())
    .filter(Boolean)
    .join('; ');
}

function buildSwaggerDocsCsp(): string {
  return normalizeDirectives([
    "default-src 'none'",
    `script-src 'self' ${SWAGGER_UI_ORIGIN}`,
    `style-src 'self' 'unsafe-inline' ${SWAGGER_UI_ORIGIN}`,
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]);
}

export function buildContentSecurityPolicy(options: SecurityHeaderOptions): string {
  if (options.pathname === '/api-docs') {
    return buildSwaggerDocsCsp();
  }

  const connectSrc = [
    "'self'",
    ...(options.isDev
      ? [
        'ws://localhost:3001',
        'ws://127.0.0.1:3001',
        'http://localhost:3001',
        'http://127.0.0.1:3001',
      ]
      : []),
  ].join(' ');

  const scriptSrc = [
    "'self'",
    `'nonce-${options.nonce}'`,
    "'strict-dynamic'",
    ...(options.isDev ? ["'unsafe-eval'"] : []),
  ].join(' ');

  return normalizeDirectives([
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(options.isProduction ? ['upgrade-insecure-requests'] : []),
  ]);
}

export function buildPermissionsPolicy(): string {
  return [
    'accelerometer=()',
    'ambient-light-sensor=()',
    'autoplay=()',
    'battery=()',
    'camera=()',
    'display-capture=()',
    'document-domain=()',
    'encrypted-media=()',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'midi=()',
    'payment=()',
    'picture-in-picture=()',
    'publickey-credentials-get=()',
    'screen-wake-lock=()',
    'usb=()',
    'web-share=()',
  ].join(', ');
}

export function applySecurityHeaders(
  headers: Headers,
  options: SecurityHeaderOptions,
): void {
  const csp = buildContentSecurityPolicy(options);

  headers.set('Content-Security-Policy', csp);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set(
    'Referrer-Policy',
    options.pathname === '/kite/auth-complete'
      ? 'no-referrer'
      : 'strict-origin-when-cross-origin',
  );
  headers.set('Permissions-Policy', buildPermissionsPolicy());
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-site');
  headers.set('X-Frame-Options', 'DENY');

  if (options.isProduction) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  if (
    options.pathname === '/kite/auth-complete'
    || options.pathname.startsWith('/kite/')
    || options.pathname.startsWith('/api/kite/')
  ) {
    headers.set('Cache-Control', 'no-store');
  }
}

export function createRequestNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString('base64');
}
