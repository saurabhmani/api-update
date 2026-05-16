/**
 * GET /api-docs
 *
 * Swagger UI viewer. Loads swagger-ui-dist from CDN and points it at
 * /api/openapi (the auto-generated spec). Admin-gated in production,
 * open in dev so engineers can browse the surface without logging in.
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    try { await requireAdmin(); }
    catch { return new NextResponse('Unauthorized', { status: 401 }); }
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quantorus365 API — Swagger UI</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css" />
    <style>
      body { margin: 0; background: #fafafa; }
      .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
    <script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-standalone-preset.js" crossorigin></script>
    <script>
      window.addEventListener('load', function () {
        window.ui = SwaggerUIBundle({
          url: '/api/openapi',
          dom_id: '#swagger-ui',
          deepLinking: true,
          docExpansion: 'none',
          filter: true,
          tagsSorter: 'alpha',
          operationsSorter: 'alpha',
          tryItOutEnabled: true,
          requestInterceptor: function (req) {
            req.credentials = 'include';
            return req;
          },
          presets: [
            SwaggerUIBundle.presets.apis,
            SwaggerUIStandalonePreset,
          ],
          layout: 'BaseLayout',
        });
      });
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    headers: {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
