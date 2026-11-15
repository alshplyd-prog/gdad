import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { executePg, isPgConfigured } from '../db/dbExecutor.ts';
import { fileDb } from '../db/fileDb.ts';

export interface AuthUserPayload {
  repId: string;
  repName: string;
  role: 'admin' | 'supervisor' | 'rep';
  canEdit: boolean;
  canDelete: boolean;
  canMoveCustomer: boolean;
  canSell: boolean;
  allowedListIds: string[];
  pinVersion: string;
  jti: string;
  iat: number;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUserPayload | null;
      rawBodyBuffer?: Buffer;
    }
  }
}

let cachedJwtSecret: string | null = null;
const memoryNonceCache = new Map<string, number>();

export function normalizeServerPin(pin: any): string {
  if (pin === null || pin === undefined) return '';
  return String(pin)
    .trim()
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/\s+/g, '');
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

export async function getJwtSecret(): Promise<string> {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.trim().length >= 32) {
    return process.env.JWT_SECRET.trim();
  }
  if (cachedJwtSecret) return cachedJwtSecret;

  if (isPgConfigured()) {
    try {
      const rows = await executePg("SELECT value FROM system_settings WHERE key = 'jwt_signing_secret' LIMIT 1");
      if (rows && rows[0]?.value && String(rows[0].value).length >= 32) {
        cachedJwtSecret = String(rows[0].value);
        return cachedJwtSecret;
      }
      const generated = crypto.randomBytes(48).toString('hex');
      await executePg(
        `INSERT INTO system_settings (key, value) VALUES ('jwt_signing_secret', $1)
         ON CONFLICT (key) DO NOTHING`,
        [generated]
      );
      const reread = await executePg("SELECT value FROM system_settings WHERE key = 'jwt_signing_secret' LIMIT 1");
      cachedJwtSecret = String(reread?.[0]?.value || generated);
      return cachedJwtSecret;
    } catch (e) {}
  }

  try {
    const settings = fileDb.get<any>('system_settings') || [];
    const existing = settings.find((s: any) => s.id === 'jwt_signing_secret' || s.key === 'jwt_signing_secret');
    if (existing?.value && String(existing.value).length >= 32) {
      cachedJwtSecret = String(existing.value);
      return cachedJwtSecret;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fileDb.upsert('system_settings', { id: 'jwt_signing_secret', key: 'jwt_signing_secret', value: generated });
    cachedJwtSecret = generated;
    return cachedJwtSecret;
  } catch (e) {}

  cachedJwtSecret = crypto.randomBytes(48).toString('hex');
  return cachedJwtSecret;
}

export function hashPin(pin: string, existingSalt?: string): string {
  const norm = normalizeServerPin(pin);
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(norm, salt, 32).toString('hex');
  return `scrypt_v1:${salt}:${derived}`;
}

export function verifyPinHash(enteredPin: string, storedHashOrPlain?: string | null): boolean {
  const normEntered = normalizeServerPin(enteredPin);
  if (!normEntered) return false;
  if (!storedHashOrPlain) return false;

  if (storedHashOrPlain.startsWith('scrypt_v1:')) {
    const parts = storedHashOrPlain.split(':');
    if (parts.length !== 3) return false;
    const [, salt, expectedHex] = parts;
    const derivedBuf = crypto.scryptSync(normEntered, salt, 32);
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (derivedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(derivedBuf, expectedBuf);
  }

  const normStored = normalizeServerPin(storedHashOrPlain);
  if (!normStored) return false;
  const a = Buffer.from(normEntered, 'utf8');
  const b = Buffer.from(normStored, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function computePinVersion(repId: string, pinOrHash?: string | null): string {
  const raw = String(pinOrHash || '');
  if (raw.startsWith('scrypt_v1:')) {
    return crypto.createHash('sha256').update(`pv:${repId}:${raw}`).digest('hex').slice(0, 16);
  }
  const norm = normalizeServerPin(raw);
  return crypto.createHash('sha256').update(`pv_legacy:${repId}:${norm}`).digest('hex').slice(0, 16);
}

export function computeOfflinePinVerifier(repId: string, pin: string): string {
  const norm = normalizeServerPin(pin);
  if (!norm) return '';
  return crypto
    .createHash('sha256')
    .update(`alkarrar_offline_pin_v1:${String(repId)}:${norm}`)
    .digest('hex');
}

export async function signAuthToken(user: Omit<AuthUserPayload, 'jti' | 'iat' | 'exp'>): Promise<{
  token: string;
  hmacKey: string;
  payload: AuthUserPayload;
}> {
  const secret = await getJwtSecret();
  const nowSec = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const payload: AuthUserPayload = {
    ...user,
    jti,
    iat: nowSec,
    exp: nowSec + 14 * 24 * 3600,
  };

  const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = base64UrlEncode(crypto.createHmac('sha256', secret).update(signingInput).digest());
  const token = `${signingInput}.${sigB64}`;
  const hmacKey = deriveSessionHmacKeySync(secret, jti, user.repId);

  return { token, hmacKey, payload };
}

export function deriveSessionHmacKeySync(secret: string, jti: string, repId: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`alkarrar_hmac_session_v1:${jti}:${repId}`)
    .digest('hex');
}

export async function verifyAuthToken(token: string): Promise<AuthUserPayload | null> {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;

  try {
    const secret = await getJwtSecret();
    const [headerB64, payloadB64, sigB64] = parts;
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
    );
    const a = Buffer.from(sigB64, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }

    const decoded = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as AuthUserPayload;
    if (!decoded || !decoded.repId || !decoded.jti) return null;
    if (decoded.exp && Math.floor(Date.now() / 1000) > decoded.exp) {
      return null;
    }
    return decoded;
  } catch (e) {
    return null;
  }
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export async function extractAuthUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req);
    if (token) {
      const user = await verifyAuthToken(token);
      if (user) {
        req.authUser = user;
      }
    }
  } catch (e) {}
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser) {
    const token = extractBearerToken(req);
    if (token) {
      req.authUser = await verifyAuthToken(token);
    }
  }
  if (!req.authUser) {
    return res.status(401).json({
      error: 'غير مصرح: يرجى تسجيل الدخول للحصول على جلسة موثقة من السيرفر',
      code: 'AUTH_REQUIRED',
    });
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'غير مصرح: يرجى تسجيل الدخول أولاً', code: 'AUTH_REQUIRED' });
  }
  if (req.authUser.role !== 'admin') {
    return res.status(403).json({
      error: 'ممنوع: هذه العملية مخصصة لمدير النظام فقط',
      code: 'ADMIN_ONLY',
    });
  }
  next();
}

export function requireAdminOrSupervisor(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'غير مصرح: يرجى تسجيل الدخول أولاً', code: 'AUTH_REQUIRED' });
  }
  if (req.authUser.role !== 'admin' && req.authUser.role !== 'supervisor') {
    return res.status(403).json({
      error: 'ممنوع: هذه الصلاحية متاحة للمدير أو المسؤول فقط',
      code: 'PRIVILEGE_REQUIRED',
    });
  }
  next();
}

export function requirePermission(perm: 'canEdit' | 'canDelete' | 'canSell' | 'canMoveCustomer') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.authUser) {
      return res.status(401).json({ error: 'غير مصرح: يرجى تسجيل الدخول أولاً', code: 'AUTH_REQUIRED' });
    }
    if (req.authUser.role === 'admin') {
      return next();
    }
    if (!req.authUser[perm]) {
      return res.status(403).json({
        error: 'ممنوع: لا تملك صلاحية تنفيذ هذه العملية',
        code: 'PERMISSION_DENIED',
      });
    }
    next();
  };
}

/**
 * Consumes a one-time cryptographic nonce in PostgreSQL used_nonces table.
 * Returns { ok: true } if freshly recorded, or { ok: false, duplicate: true, existing } if replayed.
 */
export async function consumeReplayNonce(
  nonce: string,
  route: string,
  actionType: string,
  repId?: string | null,
  amount?: number | null,
  contractId?: string | null
): Promise<{ ok: boolean; duplicate?: boolean; existing?: any }> {
  const cleanNonce = String(nonce || '').trim();
  if (!cleanNonce || cleanNonce.length < 8) {
    return { ok: true };
  }

  // Prune old memory nonces (> 2 hours)
  const now = Date.now();
  if (memoryNonceCache.size > 5000) {
    for (const [k, ts] of memoryNonceCache.entries()) {
      if (now - ts > 2 * 3600 * 1000) memoryNonceCache.delete(k);
    }
  }

  if (isPgConfigured()) {
    try {
      const inserted = await executePg(
        `INSERT INTO used_nonces (nonce, route, action_type, rep_id, amount, contract_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (nonce) DO NOTHING
         RETURNING nonce`,
        [cleanNonce, route, actionType, repId || null, amount ?? null, contractId || null]
      );
      if (inserted && inserted.length > 0) {
        memoryNonceCache.set(cleanNonce, now);
        return { ok: true };
      }
      const existingRows = await executePg(
        `SELECT * FROM used_nonces WHERE nonce = $1 LIMIT 1`,
        [cleanNonce]
      ).catch(() => []);
      return { ok: false, duplicate: true, existing: existingRows?.[0] || null };
    } catch (err) {
      // Fall through to in-memory check if table does not exist yet
    }
  }

  if (memoryNonceCache.has(cleanNonce)) {
    return { ok: false, duplicate: true };
  }
  memoryNonceCache.set(cleanNonce, now);
  return { ok: true };
}

/**
 * Verifies HMAC-SHA256 signature & anti-replay request headers against the user's server-issued session HMAC key.
 * Signature canonical string:
 * `${METHOD}|${PATH}|${TIMESTAMP}|${NONCE}|${SHA256_HEX_OF_RAW_BODY}`
 */
export async function verifyHmacRequest(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'غير مصرح: جلسة مفقودة أو منتهية', code: 'AUTH_REQUIRED' });
  }

  const tsHeader = req.headers['x-timestamp'];
  const nonceHeader = req.headers['x-nonce'];
  const sigHeader = req.headers['x-signature'];

  if (typeof tsHeader !== 'string' || typeof nonceHeader !== 'string' || typeof sigHeader !== 'string') {
    return res.status(403).json({
      error: 'تم رفض الطلب: توقيع الحماية المشفر (HMAC) مفقود',
      code: 'HMAC_MISSING',
    });
  }

  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
    return res.status(403).json({
      error: 'تم رفض الطلب: انتهت صلاحية الطابع الزمني للطلب',
      code: 'HMAC_TIMESTAMP_EXPIRED',
    });
  }

  const nonce = nonceHeader.trim();
  if (nonce.length < 12) {
    return res.status(403).json({ error: 'رقم منع التكرار (Nonce) غير صالح', code: 'INVALID_NONCE' });
  }

  const secret = await getJwtSecret();
  const sessionHmacKey = deriveSessionHmacKeySync(secret, req.authUser.jti, req.authUser.repId);

  const rawBody = req.rawBodyBuffer
    ? req.rawBodyBuffer
    : Buffer.from(
        req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
          ? JSON.stringify(req.body)
          : typeof req.body === 'string'
          ? req.body
          : '',
        'utf8'
      );

  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const reqPath = (req.originalUrl || req.url || req.path || '').split('?')[0];
  const canonical = `${req.method.toUpperCase()}|${reqPath}|${tsHeader.trim()}|${nonce}|${bodyHash}`;
  const expectedSig = crypto.createHmac('sha256', sessionHmacKey).update(canonical).digest('hex');

  const sigBuf = Buffer.from(sigHeader.trim().toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expectedSig.toLowerCase(), 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return res.status(403).json({
      error: 'تحذير أمني: تم رفض الطلب لعدم تطابق التوقيع الرقمي (احتمال تلاعب بالبيانات أثناء النقل)',
      code: 'HMAC_SIGNATURE_MISMATCH',
    });
  }

  const consumed = await consumeReplayNonce(
    `req:${nonce}`,
    reqPath,
    req.method.toUpperCase(),
    req.authUser.repId
  );
  if (!consumed.ok) {
    return res.status(409).json({
      error: 'تم رفض الطلب: محاولة إعادة إرسال طلب مكرر (Replay Attack)',
      code: 'REPLAY_DETECTED',
    });
  }

  next();
}
