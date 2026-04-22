// ════════════════════════════════════════════════════════════════
//  Kite Connect session management
//
//  Responsibilities:
//    - Build the kite login redirect URL
//    - Compute the SHA-256 checksum for the session/token exchange
//    - Call POST /session/token with request_token → access_token
//    - Persist the access_token to MySQL, linked to the logged-in
//      app user (q200_session JWT row in user_sessions). One Kite
//      token per (api_key, user_id) tuple so multiple operators on
//      the same api_key don't overwrite each other.
//    - Hand out the token to fetchFromKite via getKiteAccessToken()
//
//  Kite tokens are valid until ~06:00 IST the next calendar day.
//  We persist `created_at` and treat the token as expired if the
//  stored row's created_at is older than that cutoff — a fresh
//  login is required daily.
//
//  user_id = 0  → "shared / anonymous" token, used as a fallback
//                 when no app session is present (CLI tools, worker
//                 processes, the WebSocket ticker singleton, etc.)
// ════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { encrypt, decrypt } from '@/lib/encryption';

const log = logger.child({ component: 'kiteSession' });

const KITE_LOGIN_BASE = 'https://kite.trade/connect/login';
const KITE_API_BASE   = 'https://api.kite.trade';
const TIMEOUT_MS      = 6000;

export const SHARED_USER_ID = 0;

export interface KiteSessionTokenResponse {
  status: 'success' | 'error';
  data?: {
    user_id: string;
    user_name: string;
    email: string;
    access_token: string;
    refresh_token?: string;
    enctoken?: string;
    public_token?: string;
  };
  message?: string;
}

// ── Schema ensure ─────────────────────────────────────────────

let schemaEnsured = false;

async function ensureKiteSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    // Base table — created if first run. Note that old deployments
    // have api_key as the sole PK; the migration block below detects
    // that and upgrades to a composite (api_key, user_id) PK.
    await db.query(`
      CREATE TABLE IF NOT EXISTS kite_tokens (
        api_key       VARCHAR(64)  NOT NULL,
        user_id       INT          NOT NULL DEFAULT 0,
        access_token  VARCHAR(255) NOT NULL,
        kite_user_id  VARCHAR(64),
        kite_user_name VARCHAR(128),
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (api_key, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Idempotent migration for pre-existing installs ────────
    // Old schema: `api_key` PK, no `user_id`, `user_id`/`user_name`
    // columns held the *kite* user (renamed below to `kite_user_id`
    // / `kite_user_name` for clarity vs. the app session user).
    const { rows: cols } = await db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kite_tokens'`,
    );
    const have = new Set((cols as any[]).map((r) => r.COLUMN_NAME));

    if (!have.has('user_id')) {
      console.log('[kiteSession] migrating kite_tokens: adding user_id column');
      await db.query(`ALTER TABLE kite_tokens ADD COLUMN user_id INT NOT NULL DEFAULT 0`);
      // Rebuild PK as (api_key, user_id). Wrapped in try to tolerate
      // older MySQL versions where this syntax differs slightly.
      try {
        await db.query(`ALTER TABLE kite_tokens DROP PRIMARY KEY, ADD PRIMARY KEY (api_key, user_id)`);
      } catch (e: any) {
        console.warn('[kiteSession] PK rebuild failed (continuing):', e?.message);
      }
    }
    if (have.has('user_id') && have.has('user_name') && !have.has('kite_user_id')) {
      // Old column names collided with the app `user_id` concept.
      // Rename them so the new `user_id INT` can coexist.
      console.log('[kiteSession] migrating kite_tokens: renaming user_id → kite_user_id');
      try {
        await db.query(`ALTER TABLE kite_tokens CHANGE COLUMN user_id kite_user_id VARCHAR(64)`);
        await db.query(`ALTER TABLE kite_tokens CHANGE COLUMN user_name kite_user_name VARCHAR(128)`);
        await db.query(`ALTER TABLE kite_tokens ADD COLUMN user_id INT NOT NULL DEFAULT 0`);
        await db.query(`ALTER TABLE kite_tokens DROP PRIMARY KEY, ADD PRIMARY KEY (api_key, user_id)`);
      } catch (e: any) {
        console.warn('[kiteSession] legacy column rename failed (continuing):', e?.message);
      }
    }
    if (!have.has('kite_user_id') && have.has('user_id')) {
      // The very first install created with THIS file has `user_id INT`
      // but no kite_user_id/kite_user_name columns. Add them.
      try {
        await db.query(`ALTER TABLE kite_tokens ADD COLUMN kite_user_id VARCHAR(64) NULL`);
        await db.query(`ALTER TABLE kite_tokens ADD COLUMN kite_user_name VARCHAR(128) NULL`);
      } catch (e: any) {
        // Columns may already exist from a prior partial run — ignore
        if (!/duplicate column/i.test(e?.message ?? '')) {
          console.warn('[kiteSession] adding kite_user_* columns failed:', e?.message);
        }
      }
    }

    schemaEnsured = true;
    console.log('[kiteSession] kite_tokens schema ensured');
  } catch (err: any) {
    console.error('[kiteSession] ensureKiteSchema FAILED:', err?.message);
    throw err;
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Build the URL the user should be redirected to in order to log
 * into Kite and authorize this app. Kite will redirect back to the
 * configured redirect URL (set in the Kite developer console) with
 * ?request_token=… which is consumed by /api/kite/callback.
 */
export function getKiteLoginUrl(): string {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    throw new Error('KITE_API_KEY is not set in environment');
  }
  return `${KITE_LOGIN_BASE}?api_key=${encodeURIComponent(apiKey)}&v=3`;
}

/**
 * Compute the checksum Kite requires on the session/token exchange:
 *   sha256(api_key + request_token + api_secret)
 */
export function computeKiteChecksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return crypto
    .createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');
}

/**
 * Exchange request_token → access_token and persist the result
 * against the given app user (or SHARED_USER_ID when no session).
 */
export async function exchangeRequestToken(
  requestToken: string,
  appUserId: number = SHARED_USER_ID,
): Promise<{ access_token: string; kite_user_id?: string; kite_user_name?: string }> {
  const apiKeyRaw    = process.env.KITE_API_KEY;
  const apiSecretRaw = process.env.KITE_API_SECRET;
  if (!apiKeyRaw || !apiSecretRaw) {
    throw new Error('KITE_API_KEY / KITE_API_SECRET not configured');
  }
  const apiKey       = apiKeyRaw.trim();
  const apiSecret    = apiSecretRaw.trim();
  const requestTok   = requestToken.trim();

  const checksum = computeKiteChecksum(apiKey, requestTok, apiSecret);

  console.log(
    `[kiteSession] exchange  api_key.len=${apiKey.length}  ` +
    `req_token.len=${requestTok.length}  api_secret.len=${apiSecret.length}  ` +
    `checksum=${checksum.slice(0, 8)}…${checksum.slice(-4)}  app_user=${appUserId}`
  );

  const body = new URLSearchParams({
    api_key:       apiKey,
    request_token: requestTok,
    checksum,
  });

  const res = await fetch(`${KITE_API_BASE}/session/token`, {
    method: 'POST',
    headers: {
      'X-Kite-Version': '3',
      'Content-Type':   'application/x-www-form-urlencoded',
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const json = (await res.json()) as KiteSessionTokenResponse;

  if (!res.ok || json.status !== 'success' || !json.data?.access_token) {
    const reason = json.message ?? `HTTP ${res.status}`;
    throw new Error(`Kite session/token exchange failed: ${reason}`);
  }

  const { access_token, user_id: kiteUserId, user_name: kiteUserName } = json.data;

  await ensureKiteSchema();

  // Encrypt the access token before persisting (AES-256-GCM)
  const encryptedToken = encrypt(access_token);

  await db.query(
    `INSERT INTO kite_tokens (api_key, user_id, access_token, kite_user_id, kite_user_name)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       access_token   = VALUES(access_token),
       kite_user_id   = VALUES(kite_user_id),
       kite_user_name = VALUES(kite_user_name),
       updated_at     = CURRENT_TIMESTAMP,
       created_at     = CURRENT_TIMESTAMP`,
    [apiKey, appUserId, encryptedToken, kiteUserId ?? null, kiteUserName ?? null],
  );

  // Always mirror the latest token to SHARED_USER_ID as well — this
  // lets background workers (ticker singleton, cron jobs, the CLI)
  // pick up a valid token even when they have no app session.
  if (appUserId !== SHARED_USER_ID) {
    await db.query(
      `INSERT INTO kite_tokens (api_key, user_id, access_token, kite_user_id, kite_user_name)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token   = VALUES(access_token),
         kite_user_id   = VALUES(kite_user_id),
         kite_user_name = VALUES(kite_user_name),
         updated_at     = CURRENT_TIMESTAMP,
         created_at     = CURRENT_TIMESTAMP`,
      [apiKey, SHARED_USER_ID, encryptedToken, kiteUserId ?? null, kiteUserName ?? null],
    );
  }

  console.log(
    `[kiteSession] access_token stored  api_key=${apiKey.slice(0, 6)}…  ` +
    `app_user=${appUserId}  kite_user=${kiteUserName ?? kiteUserId ?? 'unknown'}`
  );
  return { access_token, kite_user_id: kiteUserId, kite_user_name: kiteUserName };
}

/**
 * Return the best usable access_token for this process.
 *
 * Resolution order:
 *   1. The token row linked to the given appUserId (if provided)
 *   2. The SHARED_USER_ID row (mirrored on every fresh login)
 *   3. The most recently updated row for this api_key
 *
 * Returns null if no usable (non-expired) token exists.
 */
export async function getKiteAccessToken(appUserId?: number): Promise<string | null> {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    console.warn('[kiteSession] KITE_API_KEY not set — Kite disabled');
    return null;
  }

  try {
    await ensureKiteSchema();
  } catch {
    return null;
  }

  try {
    // Ordering: exact user match first, then shared, then newest.
    // The ORDER BY uses a CASE so we don't need three separate
    // queries — one SELECT hands back the best candidate.
    const { rows } = await db.query(
      `SELECT access_token, created_at
       FROM kite_tokens
       WHERE api_key = ?
       ORDER BY
         (user_id = ?) DESC,
         (user_id = 0) DESC,
         updated_at DESC
       LIMIT 1`,
      [apiKey, appUserId ?? -1],
    );
    const row = (rows as any[])[0];
    if (!row) {
      console.warn(
        '[kiteSession] no access_token stored for this api_key — ' +
        'visit /api/kite/login in a browser to complete the daily OAuth flow'
      );
      return null;
    }

    if (isTokenExpired(new Date(row.created_at))) {
      console.warn(
        '[kiteSession] stored token is past the 20h cutoff — ' +
        'visit /api/kite/login to refresh'
      );
      return null;
    }
    // Decrypt token (transparent: handles both encrypted and legacy plaintext)
    return decrypt(row.access_token as string);
  } catch (err: any) {
    console.warn('[kiteSession] getKiteAccessToken SELECT failed:', err?.message);
    return null;
  }
}

function isTokenExpired(createdAt: Date): boolean {
  const MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20h
  return Date.now() - createdAt.getTime() > MAX_AGE_MS;
}

/**
 * Cheap REST preflight against `/user/profile` to verify a stored
 * access_token is actually accepted by Kite RIGHT NOW. Used by the
 * WebSocket ticker before opening the socket, so we fail with a
 * clean "LOGIN_REQUIRED" instead of an opaque `Unexpected server
 * response: 403` from the ws handshake.
 *
 * Returns { ok: true } on 200, otherwise { ok:false, status, message }.
 * A 403 here means the token is dead server-side — the caller
 * should clear the stored row and prompt for re-login.
 */
export async function validateKiteToken(
  accessToken: string,
): Promise<{ ok: boolean; status: number; message?: string }> {
  const apiKey = process.env.KITE_API_KEY?.trim();
  if (!apiKey) return { ok: false, status: 0, message: 'KITE_API_KEY not set' };
  try {
    const res = await fetch(`${KITE_API_BASE}/user/profile`, {
      headers: {
        'X-Kite-Version': '3',
        Authorization:    `token ${apiKey}:${accessToken}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 200) return { ok: true, status: 200 };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, message: body.slice(0, 200) };
  } catch (e: any) {
    return { ok: false, status: 0, message: e?.message ?? 'network error' };
  }
}

export type KiteStatus = 'ok' | 'login_required' | 'expired';

export async function getKiteStatus(appUserId?: number): Promise<KiteStatus> {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return 'login_required';

  try {
    await ensureKiteSchema();
  } catch {
    return 'login_required';
  }

  try {
    const { rows } = await db.query(
      `SELECT created_at FROM kite_tokens
       WHERE api_key = ?
       ORDER BY (user_id = ?) DESC, (user_id = 0) DESC, updated_at DESC
       LIMIT 1`,
      [apiKey, appUserId ?? -1],
    );
    const row = (rows as any[])[0];
    if (!row) return 'login_required';
    return isTokenExpired(new Date(row.created_at)) ? 'expired' : 'ok';
  } catch {
    return 'login_required';
  }
}

/** Manual clear — used by /api/kite/logout or admin tools. */
export async function clearKiteAccessToken(appUserId?: number): Promise<void> {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) return;
  await ensureKiteSchema();
  if (appUserId == null) {
    await db.query(`DELETE FROM kite_tokens WHERE api_key = ?`, [apiKey]).catch(() => {});
  } else {
    await db.query(
      `DELETE FROM kite_tokens WHERE api_key = ? AND user_id = ?`,
      [apiKey, appUserId],
    ).catch(() => {});
  }
}
