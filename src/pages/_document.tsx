// ════════════════════════════════════════════════════════════════
//  src/pages/_document.tsx — Required by Next.js 16 when pages/
//  directory exists alongside the App Router.
//
//  This is the minimum _document needed to satisfy Next.js's Pages
//  Router bootstrapper when _error.tsx is present. The App Router
//  (src/app/) still handles all actual routing and rendering.
// ════════════════════════════════════════════════════════════════

import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
