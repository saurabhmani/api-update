import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { loginUser, registerUser, invalidateSession, verifyTotp, createSession } from '@/services/auth';
import { getSession } from '@/lib/session';
import { authLimiter } from '@/lib/rateLimit';
import { logSecurityEvent } from '@/lib/security/audit';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import { resolvePostLoginDestination } from '@/lib/broker/connections';
import { extractErrorMessage } from '@/lib/errors';

export const dynamic = 'force-dynamic';

const COOKIE = 'q200_session';

function flattenErrorText(err: unknown): string {
  const parts: string[] = [extractErrorMessage(err, '')];
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; errno?: unknown; errors?: unknown[] };
    if (typeof e.code === 'string') parts.push(e.code);
    if (e.errno != null) parts.push(String(e.errno));
    if (Array.isArray(e.errors)) {
      for (const nested of e.errors) {
        parts.push(flattenErrorText(nested));
      }
    }
  }
  return parts.filter(Boolean).join(' | ');
}

function isDatabaseUnavailable(err: unknown): boolean {
  const text = flattenErrorText(err);
  return (
    /access denied for user/i.test(text)
    || /ECONNREFUSED/i.test(text)
    || /ENOTFOUND/i.test(text)
    || /ETIMEDOUT/i.test(text)
    || /connect ETIMEDOUT/i.test(text)
    || /unknown database/i.test(text)
    || /AggregateError/i.test(text)
    || (err instanceof AggregateError)
  );
}

function isLoopbackAppHost(): boolean {
  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const) {
    const raw = (process.env[key] ?? '').trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (
        host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host.endsWith('.localhost')
      ) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

const COOKIE_OPTS = {
  httpOnly: true,
  // Production uses Secure, but local `next start` still has NODE_ENV=production
  // while APP_* points at localhost — Secure cookies + https://localhost HSTS
  // break Shoonya/Kite OAuth round-trips on http://localhost:3000.
  secure: process.env.NODE_ENV === 'production' && !isLoopbackAppHost(),
  sameSite: 'lax' as const,
  path: '/',
  maxAge: parseInt(process.env.SESSION_MAX_AGE || '86400'),
};

async function redirectPayload(userId: number) {
  try {
    const dest = await resolvePostLoginDestination(userId);
    const redirectTo =
      dest.path === '/data-source' && dest.reason
        ? `/data-source?reason=${dest.reason}`
        : dest.path;
    return { redirectTo };
  } catch {
    return { redirectTo: '/data-source' };
  }
}

// POST /api/auth  → login / register / 2fa / logout
export async function POST(req: NextRequest) {
  try {
    // Auto-create all DB tables on first call (cached per process)
    await ensureAllSchemas().catch(() => {});

    // Rate limit auth endpoints (5 req/min per IP)
    const rateCheck = authLimiter(req);
    if (!rateCheck.ok) {
      return NextResponse.json({ success: false, error: rateCheck.error, code: 429 }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const { action, email, password, token: totpToken, userId } = body;

    // ── Login ────────────────────────────────────────────────────
    if (action === 'login' || (!action && email)) {
      if (!email || !password) {
        return NextResponse.json({ error: 'Email and password required' }, { status: 400 });
      }
      const result = await loginUser(email, password);
      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: 401 });
      }
      if (result.requires2fa) {
        return NextResponse.json({ requires2fa: true, userId: result.user.id });
      }
      const dest = await redirectPayload(result.user.id);
      const res = NextResponse.json({ user: result.user, requires2fa: false, ...dest });
      res.cookies.set(COOKIE, result.sessionToken!, COOKIE_OPTS);
      await logSecurityEvent({
        userId: result.user.id,
        actorEmail: result.user.email,
        eventType: 'auth',
        action: 'auth.login',
        ipAddress: req.headers.get('x-forwarded-for') ?? undefined,
      });
      console.log(`OK OK ✅ API SUCCESS  /api/auth  login  user=${result.user.id}`);
      return res;
    }

    // ── 2FA verify ───────────────────────────────────────────────
    if (action === '2fa' && userId && totpToken) {
      const valid = await verifyTotp(userId, totpToken);
      if (!valid) return NextResponse.json({ error: 'Invalid OTP code' }, { status: 401 });
      const sessionToken = await createSession(userId);
      const dest = await redirectPayload(Number(userId));
      const res = NextResponse.json({ success: true, ...dest });
      res.cookies.set(COOKIE, sessionToken, COOKIE_OPTS);
      return res;
    }

    // ── Register ──────────────────────────────────────────────────
    if (action === 'register') {
      const { name } = body;
      if (!email || !password || !name) {
        return NextResponse.json({ error: 'Email, password, and name are required' }, { status: 400 });
      }
      const result = await registerUser(email, password, name);
      if ('error' in result) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      // New users never have a broker connection yet
      const res = NextResponse.json({ user: result.user, redirectTo: '/data-source' });
      res.cookies.set(COOKIE, result.sessionToken, COOKIE_OPTS);
      return res;
    }

    // ── Logout ────────────────────────────────────────────────────
    if (action === 'logout') {
      const cookieStore = await cookies();
      const token = cookieStore.get(COOKIE)?.value;
      if (token) await invalidateSession(token);
      const res = NextResponse.json({ success: true });
      res.cookies.delete(COOKIE);
      return res;
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    const message = flattenErrorText(err);
    console.error('[auth POST]', message || '(empty error)');

    const dbDenied = isDatabaseUnavailable(err);

    return NextResponse.json(
      {
        error: dbDenied
          ? 'Database unavailable. Start MySQL on MYSQL_HOST:MYSQL_PORT (currently localhost:3306) and verify MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE.'
          : 'Authentication service unavailable',
        code: dbDenied ? 'database_unavailable' : 'auth_unavailable',
      },
      { status: 503 },
    );
  }
}

// GET /api/auth  → me
// Unauthenticated callers receive 200 + { user: null } so the corporate
// site (and AuthProvider) can probe session state without a 401→/login loop.
export async function GET() {
  // Auto-create all DB tables on first call (cached per process)
  await ensureAllSchemas().catch(() => {});

  try {
    const user = await getSession();
    if (!user) {
      return NextResponse.json(
        { user: null },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(
      { user },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[auth GET]', (err as Error).message);
    return NextResponse.json(
      { user: null },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
