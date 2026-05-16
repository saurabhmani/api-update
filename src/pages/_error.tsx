// ════════════════════════════════════════════════════════════════
//  src/pages/_error.tsx — Pages Router fallback error page
//
//  Why this file exists in an App Router project:
//
//    Next.js 14, even when the entire app is under src/app/, still
//    falls back to `pages/_error.js` when its App Router error pipeline
//    can't render an error itself. Without this file the runtime tries
//    to require `.next/server/pages/_error.js`, fails with
//    `MODULE_NOT_FOUND`, and the original error is masked by a worse
//    secondary crash:
//
//      Error: Cannot find module '/var/www/api-update/.next/server/pages/_error.js'
//
//    This file is the minimum needed to satisfy that fallback. Real
//    user-facing error UX still flows through src/app/error.tsx and
//    src/app/global-error.tsx, which the App Router renders first.
//
//  Creating this file does NOT make the project a hybrid Pages+App
//  Router app — Next.js only treats src/pages/ as routable for actual
//  pages. Special files like _error / _document / _app are exempt.
// ════════════════════════════════════════════════════════════════

import type { NextPageContext } from 'next';

interface ErrorProps {
  statusCode?: number;
}

function ErrorPage({ statusCode }: ErrorProps) {
  return (
    <div
      style={{
        minHeight:    '100vh',
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'center',
        background:   '#0A1628',
        color:        '#E2E8F0',
        fontFamily:   'system-ui, -apple-system, sans-serif',
        padding:      24,
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 480 }}>
        <div style={{ fontSize: 48, fontWeight: 300, color: '#C9A84C', marginBottom: 16 }}>
          {statusCode ?? 'Error'}
        </div>
        <div style={{ fontSize: 16, color: '#94A3B8', marginBottom: 8 }}>
          {statusCode === 404
            ? 'Page not found'
            : 'Something went wrong on our side.'}
        </div>
        <div style={{ fontSize: 13, color: '#64748B' }}>
          Try refreshing, or go back to the <a href="/" style={{ color: '#3B82F6' }}>home page</a>.
        </div>
      </div>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext): ErrorProps => {
  const statusCode = res?.statusCode ?? err?.statusCode ?? 404;
  return { statusCode };
};

export default ErrorPage;
