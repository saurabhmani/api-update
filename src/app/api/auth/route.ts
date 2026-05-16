import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { loginUser, registerUser, invalidateSession, verifyTotp, createSession } from '@/services/auth';
import { getSession } from '@/lib/session';
import { authLimiter } from '@/lib/rateLimit';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';

export const dynamic = 'force-dynamic';

const COOKIE = 'q200_session';







const COOKIE_OPTS = {
  httpOnly: true,
  // Only mark Secure in production so dev (http://localhost) still
  // works. Production ALWAYS gets Secure so the cookie is never sent
  // over plaintext.
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path:     '/',
  maxAge:   parseInt(process.env.SESSION_MAX_AGE || '86400'),
};

// POST /api/auth  → login / register / 2fa / logout
export async function POST(req: NextRequest) {
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
    const res = NextResponse.json({ user: result.user, requires2fa: false });
    res.cookies.set(COOKIE, result.sessionToken!, COOKIE_OPTS);
    console.log(`OK OK ✅ API SUCCESS  /api/auth  login  user=${result.user.id}`);
    return res;
  }

  // ── 2FA verify ───────────────────────────────────────────────
  if (action === '2fa' && userId && totpToken) {
    const valid = await verifyTotp(userId, totpToken);
    if (!valid) return NextResponse.json({ error: 'Invalid OTP code' }, { status: 401 });
    const sessionToken = await createSession(userId);
    const res = NextResponse.json({ success: true });
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
    const res = NextResponse.json({ user: result.user });
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
}

// GET /api/auth  → me
export async function GET() {
  // Auto-create all DB tables on first call (cached per process)
  await ensureAllSchemas().catch(() => {});

  try {
    const user = await getSession();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ user });
  } catch (err) {
    console.error('[auth GET]', (err as Error).message);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
