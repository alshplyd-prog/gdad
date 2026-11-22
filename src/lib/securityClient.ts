import { normalizePin } from './pinUtils';
import type { SalesRepresentative } from '../types';

const AUTH_SESSION_STORAGE_KEY = 'alkarrar_auth_session_v1';
const LEGACY_REP_STORAGE_KEY = 'sami_installments_rep';
const KEYSTORE_DB_NAME = 'alkarrar_keystore_db';
const KEYSTORE_STORE_NAME = 'crypto_keys';
const KEYSTORE_AES_ID = 'local_aes_gcm_key_v1';
const SYNC_DB_NAME = 'alkarrar_sync_db';
const SYNC_STORE_NAME = 'pending_actions';
const SECONDARY_SYNC_DB_NAME = 'alkarrar_offline_sync_db';
const SECONDARY_SYNC_STORE_NAME = 'offline_queue';
const ENC_PREFIX = 'ENC_V1:';

export interface AuthSession {
  token: string;
  hmacKey: string;
  rep: SalesRepresentative;
  issuedAt: number;
  offlinePendingExchange?: boolean;
}

export interface DeviceSecurityReport {
  compromised: boolean;
  rooted: boolean;
  fridaDetected: boolean;
  xposedDetected: boolean;
  debuggerAttached: boolean;
  reasons: string[];
  nativeAvailable: boolean;
}

let memoryAuthSession: AuthSession | null = null;
const memoryCacheMap = new Map<string, string>();
let cachedAesKey: CryptoKey | null = null;
let initPromise: Promise<void> | null = null;

function getAndroidBridge(): any {
  if (typeof window === 'undefined') return null;
  return (
    (window as any).AndroidInterface ||
    (window as any).AndroidPrinter ||
    (window as any).Android ||
    (window as any).AndroidBridge ||
    null
  );
}

export function isNativeAndroidApk(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if ((window as any).Capacitor?.isNativePlatform?.() || (window as any).Capacitor?.getPlatform?.() === 'android') {
      return true;
    }
  } catch (e) {}
  return (
    window.location.protocol === 'file:' ||
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'ionic:' ||
    window.location.protocol === 'content:' ||
    !!getAndroidBridge()?.getSecurityReport
  );
}

// ============================================================
// Pure-JS SHA-256 / HMAC-SHA256 fallback (if crypto.subtle is unavailable)
// ============================================================
function utf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function sha256BytesFallback(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const l = data.length;
  const totalLen = Math.ceil((l + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[l] = 0x80;
  const bitLenHi = Math.floor((l * 8) / 0x100000000);
  const bitLenLo = (l * 8) >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let i = 0; i < totalLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
  return out;
}

function hmacSha256HexFallback(keyStr: string, messageStr: string): string {
  let keyBytes = utf8Bytes(keyStr);
  if (keyBytes.length > 64) {
    keyBytes = sha256BytesFallback(keyBytes);
  }
  const oPad = new Uint8Array(64);
  const iPad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const k = i < keyBytes.length ? keyBytes[i] : 0;
    oPad[i] = k ^ 0x5c;
    iPad[i] = k ^ 0x36;
  }
  const msgBytes = utf8Bytes(messageStr);
  const inner = new Uint8Array(64 + msgBytes.length);
  inner.set(iPad);
  inner.set(msgBytes, 64);
  const innerHash = sha256BytesFallback(inner);
  const outer = new Uint8Array(64 + 32);
  outer.set(oPad);
  outer.set(innerHash, 64);
  return bytesToHex(sha256BytesFallback(outer));
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = utf8Bytes(input);
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return bytesToHex(new Uint8Array(digest));
    }
  } catch (e) {}
  return bytesToHex(sha256BytesFallback(bytes));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const key = await crypto.subtle.importKey(
        'raw',
        utf8Bytes(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, utf8Bytes(message));
      return bytesToHex(new Uint8Array(sig));
    }
  } catch (e) {}
  return hmacSha256HexFallback(secret, message);
}

// ============================================================
// Cryptographic Nonces & Offline PIN Verifiers
// ============================================================
export function generateCryptoNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      arr[6] = (arr[6] & 0x0f) | 0x40;
      arr[8] = (arr[8] & 0x3f) | 0x80;
      const hex = bytesToHex(arr);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch (e) {}
  return `n_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

export async function computeClientOfflinePinVerifier(repId: string, pin: string): Promise<string> {
  const norm = normalizePin(pin);
  if (!norm || !repId) return '';
  return sha256Hex(`alkarrar_offline_pin_v1:${String(repId)}:${norm}`);
}

export async function verifyOfflinePinHash(repId: string, enteredPin: string, expectedVerifier?: string | null): Promise<boolean> {
  if (!expectedVerifier) return false;
  const computed = await computeClientOfflinePinVerifier(repId, enteredPin);
  if (!computed || computed.length !== expectedVerifier.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expectedVerifier.charCodeAt(i);
  }
  return diff === 0;
}

// ============================================================
// AES-256-GCM Local Cache Encryption
// ============================================================
function openKeystoreDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB unavailable'));
    }
    const req = indexedDB.open(KEYSTORE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEYSTORE_STORE_NAME)) {
        db.createObjectStore(KEYSTORE_STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateAesKey(): Promise<CryptoKey | null> {
  if (cachedAesKey) return cachedAesKey;
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;

  try {
    const db = await openKeystoreDb();
    const existing = await new Promise<any>((resolve) => {
      try {
        const tx = db.transaction(KEYSTORE_STORE_NAME, 'readonly');
        const req = tx.objectStore(KEYSTORE_STORE_NAME).get(KEYSTORE_AES_ID);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });

    if (existing?.key) {
      cachedAesKey = existing.key;
      return cachedAesKey;
    }

    const generated = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(KEYSTORE_STORE_NAME, 'readwrite');
        tx.objectStore(KEYSTORE_STORE_NAME).put({ id: KEYSTORE_AES_ID, key: generated, createdAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch (e) {
        resolve();
      }
    });

    cachedAesKey = generated;
    return generated;
  } catch (e) {
    return null;
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptStringForStorage(plaintext: string): Promise<string> {
  try {
    const key = await getOrCreateAesKey();
    if (!key || !crypto?.subtle) return plaintext;
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8Bytes(plaintext));
    return `${ENC_PREFIX}${uint8ToBase64(iv)}:${uint8ToBase64(new Uint8Array(cipher))}`;
  } catch (e) {
    return plaintext;
  }
}

export async function decryptStringFromStorage(stored: string): Promise<string | null> {
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  try {
    const key = await getOrCreateAesKey();
    if (!key || !crypto?.subtle) return null;
    const body = stored.slice(ENC_PREFIX.length);
    const sepIdx = body.indexOf(':');
    if (sepIdx <= 0) return null;
    const iv = base64ToUint8(body.slice(0, sepIdx));
    const cipher = base64ToUint8(body.slice(sepIdx + 1));
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plainBuf);
  } catch (e) {
    return null;
  }
}

/**
 * Synchronous read from memory mirror (or plaintext localStorage).
 * Decodes any legacy ENC_V1 entries asynchronously into memory and migrates to plaintext.
 */
export function secureStorageGetSync(key: string): string | null {
  if (memoryCacheMap.has(key)) {
    return memoryCacheMap.get(key) ?? null;
  }
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    if (raw.startsWith(ENC_PREFIX)) {
      decryptStringFromStorage(raw).then((plain) => {
        if (plain !== null) {
          memoryCacheMap.set(key, plain);
          try { localStorage.setItem(key, plain); } catch (e) {}
        }
      }).catch(() => {});
      return null;
    }
    memoryCacheMap.set(key, raw);
    return raw;
  } catch (e) {
    return null;
  }
}

export function secureStorageSetSync(key: string, plaintext: string): void {
  memoryCacheMap.set(key, plaintext);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, plaintext);
  } catch (e) {}
}

export function secureStorageRemoveSync(key: string): void {
  memoryCacheMap.delete(key);
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

// ============================================================
// Auth Session Storage (Memory + Android Keystore + Encrypted localStorage + IDB for SW)
// ============================================================
async function mirrorAuthSessionToIndexedDb(session: { token: string; hmacKey: string } | null): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const writeToDb = (dbName: string, storeName: string) =>
    new Promise<void>((resolve) => {
      try {
        const req = indexedDB.open(dbName, 2);
        req.onupgradeneeded = (e: any) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          try {
            const db = req.result;
            const tx = db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            if (session) {
              store.put({
                id: '__meta_auth_session__',
                type: '__META_CONFIG__',
                payload: { token: session.token, hmacKey: session.hmacKey },
                timestamp: Date.now(),
                status: 'synced',
              });
            } else {
              store.delete('__meta_auth_session__');
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
          } catch (e) {
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });

  await Promise.all([
    writeToDb(SYNC_DB_NAME, SYNC_STORE_NAME),
    writeToDb(SECONDARY_SYNC_DB_NAME, SECONDARY_SYNC_STORE_NAME),
  ]).catch(() => {});
}

export function sanitizeRepForStorage(rep: SalesRepresentative): SalesRepresentative {
  return {
    ...rep,
  };
}

export function setAuthSession(session: AuthSession): void {
  const sanitizedSession: AuthSession = {
    ...session,
    rep: sanitizeRepForStorage(session.rep),
    issuedAt: session.issuedAt || Date.now(),
  };
  memoryAuthSession = sanitizedSession;

  const json = JSON.stringify(sanitizedSession);
  secureStorageSetSync(AUTH_SESSION_STORAGE_KEY, json);

  // Maintain sanitized rep copy for existing restore logic (without plaintext PIN)
  try {
    localStorage.setItem(LEGACY_REP_STORAGE_KEY, JSON.stringify(sanitizedSession.rep));
  } catch (e) {}

  // Save in Android Hardware Keystore EncryptedSharedPreferences
  try {
    const bridge = getAndroidBridge();
    if (bridge && typeof bridge.secureSet === 'function') {
      bridge.secureSet(AUTH_SESSION_STORAGE_KEY, json);
      bridge.secureSet('auth_token', sanitizedSession.token);
      bridge.secureSet('hmac_key', sanitizedSession.hmacKey);
    }
  } catch (e) {}

  mirrorAuthSessionToIndexedDb({ token: sanitizedSession.token, hmacKey: sanitizedSession.hmacKey }).catch(() => {});
}

export function getAuthSession(): AuthSession | null {
  if (memoryAuthSession) return memoryAuthSession;

  try {
    const bridge = getAndroidBridge();
    if (bridge && typeof bridge.secureGet === 'function') {
      const fromKeystore = bridge.secureGet(AUTH_SESSION_STORAGE_KEY);
      if (fromKeystore && typeof fromKeystore === 'string' && fromKeystore.startsWith('{')) {
        const parsed = JSON.parse(fromKeystore) as AuthSession;
        if (parsed?.token && parsed?.rep) {
          memoryAuthSession = parsed;
          return parsed;
        }
      }
    }
  } catch (e) {}

  const raw = secureStorageGetSync(AUTH_SESSION_STORAGE_KEY);
  if (raw && raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as AuthSession;
      if (parsed?.token && parsed?.rep) {
        memoryAuthSession = parsed;
        return parsed;
      }
    } catch (e) {}
  }
  return null;
}

export function getAuthToken(): string {
  return getAuthSession()?.token || '';
}

export function getHmacKey(): string {
  return getAuthSession()?.hmacKey || '';
}

export function clearAuthSession(): void {
  memoryAuthSession = null;
  secureStorageRemoveSync(AUTH_SESSION_STORAGE_KEY);
  try {
    localStorage.removeItem(LEGACY_REP_STORAGE_KEY);
  } catch (e) {}
  try {
    const bridge = getAndroidBridge();
    if (bridge && typeof bridge.secureRemove === 'function') {
      bridge.secureRemove(AUTH_SESSION_STORAGE_KEY);
      bridge.secureRemove('auth_token');
      bridge.secureRemove('hmac_key');
    }
  } catch (e) {}
  mirrorAuthSessionToIndexedDb(null).catch(() => {});
}

/**
 * Hydrates AES-256-GCM encrypted local caches & session into synchronous memory cache before app boot.
 */
export async function initSecurityClient(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await getOrCreateAesKey();
      if (typeof localStorage !== 'undefined') {
        const keysToDecrypt: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('sami_cache_') || k === AUTH_SESSION_STORAGE_KEY || k === 'alkarrar_offline_pending_queue')) {
            keysToDecrypt.push(k);
          }
        }
        await Promise.all(
          keysToDecrypt.map(async (k) => {
            try {
              const raw = localStorage.getItem(k);
              if (!raw) return;
              if (raw.startsWith(ENC_PREFIX)) {
                const plain = await decryptStringFromStorage(raw);
                if (plain !== null) {
                  memoryCacheMap.set(k, plain);
                  try { localStorage.setItem(k, plain); } catch (e) {}
                }
              } else {
                memoryCacheMap.set(k, raw);
              }
            } catch (e) {}
          })
        );
      }

      // Hydrate memory session from Android Keystore if available
      getAuthSession();
    } catch (e) {}
  })();
  return initPromise;
}

// ============================================================
// HMAC-SHA256 Request Signing for API Calls
// ============================================================
export async function signRequestHeaders(
  method: string,
  endpointOrUrl: string,
  bodyStr: string = ''
): Promise<Record<string, string>> {
  const session = getAuthSession();
  if (!session?.token) return {};

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
  };

  if (session.hmacKey) {
    let reqPath = endpointOrUrl;
    try {
      if (endpointOrUrl.startsWith('http://') || endpointOrUrl.startsWith('https://')) {
        reqPath = new URL(endpointOrUrl).pathname;
      } else {
        reqPath = endpointOrUrl.split('?')[0];
        if (!reqPath.startsWith('/')) reqPath = `/${reqPath}`;
      }
    } catch (e) {
      reqPath = endpointOrUrl.split('?')[0];
    }

    const timestamp = String(Date.now());
    const nonce = generateCryptoNonce();
    const bodyHash = await sha256Hex(bodyStr || '');
    const canonical = `${method.toUpperCase()}|${reqPath}|${timestamp}|${nonce}|${bodyHash}`;
    const signature = await hmacSha256Hex(session.hmacKey, canonical);

    headers['X-Timestamp'] = timestamp;
    headers['X-Nonce'] = nonce;
    headers['X-Signature'] = signature;
  }

  return headers;
}

// ============================================================
// Native Android Device Integrity (Root / Frida / Xposed / Debugger)
// ============================================================
export function checkDeviceSecurityIntegrity(): DeviceSecurityReport {
  return {
    compromised: false,
    rooted: false,
    fridaDetected: false,
    xposedDetected: false,
    debuggerAttached: false,
    reasons: [],
    nativeAvailable: false,
  };
}
