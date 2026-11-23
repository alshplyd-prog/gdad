import { normalizePin } from './pinUtils';
import type { SalesRepresentative } from '../types';

const AUTH_SESSION_STORAGE_KEY = 'alkarrar_auth_session_v1';
const LEGACY_REP_STORAGE_KEY = 'sami_installments_rep';
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
    !!getAndroidBridge()?.syncPendingQueueToNative
  );
}

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

export async function hmacSha256Hex(_secret: string, _message: string): Promise<string> {
  return '';
}

export function generateCryptoNonce(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
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
  return !!computed && computed === expectedVerifier;
}

export async function encryptStringForStorage(plaintext: string): Promise<string> {
  return plaintext;
}

export async function decryptStringFromStorage(stored: string): Promise<string | null> {
  if (!stored || typeof stored !== 'string') return null;
  if (stored.startsWith(ENC_PREFIX)) return null;
  return stored;
}

/**
 * Synchronous read directly from memory or plaintext localStorage (no encryption).
 */
export function secureStorageGetSync(key: string): string | null {
  if (memoryCacheMap.has(key)) {
    return memoryCacheMap.get(key) ?? null;
  }
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.startsWith(ENC_PREFIX)) return null;
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
// Auth Session Storage (Plain localStorage + Memory)
// ============================================================
async function clearLegacySessionFromIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const deleteFromDb = (dbName: string, storeName: string) =>
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
            if (!db.objectStoreNames.contains(storeName)) {
              resolve();
              return;
            }
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete('__meta_auth_session__');
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
    deleteFromDb(SYNC_DB_NAME, SYNC_STORE_NAME),
    deleteFromDb(SECONDARY_SYNC_DB_NAME, SECONDARY_SYNC_STORE_NAME),
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
    hmacKey: '',
    rep: sanitizeRepForStorage(session.rep),
    issuedAt: session.issuedAt || Date.now(),
  };
  memoryAuthSession = sanitizedSession;

  const json = JSON.stringify(sanitizedSession);
  secureStorageSetSync(AUTH_SESSION_STORAGE_KEY, json);

  try {
    localStorage.setItem(LEGACY_REP_STORAGE_KEY, JSON.stringify(sanitizedSession.rep));
  } catch (e) {}

  try {
    const bridge = getAndroidBridge();
    if (bridge && typeof bridge.secureSet === 'function') {
      bridge.secureSet(AUTH_SESSION_STORAGE_KEY, json);
    }
  } catch (e) {}
}

export function getAuthSession(): AuthSession | null {
  if (memoryAuthSession) return memoryAuthSession;

  try {
    const bridge = getAndroidBridge();
    if (bridge && typeof bridge.secureGet === 'function') {
      const fromNative = bridge.secureGet(AUTH_SESSION_STORAGE_KEY);
      if (fromNative && typeof fromNative === 'string' && fromNative.startsWith('{')) {
        const parsed = JSON.parse(fromNative) as AuthSession;
        if (parsed?.rep) {
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
      if (parsed?.rep) {
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
  return '';
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
  clearLegacySessionFromIndexedDb().catch(() => {});
}

/**
 * Loads plaintext local caches & session into synchronous memory cache before app boot (no encryption/keystore).
 */
export async function initSecurityClient(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = Promise.resolve().then(() => {
    try {
      if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('sami_cache_') || k === AUTH_SESSION_STORAGE_KEY || k === 'alkarrar_offline_pending_queue')) {
            try {
              const raw = localStorage.getItem(k);
              if (raw && !raw.startsWith(ENC_PREFIX)) {
                memoryCacheMap.set(k, raw);
              }
            } catch (e) {}
          }
        }
      }
      getAuthSession();
    } catch (e) {}
  });
  return initPromise;
}

// ============================================================
// No Signing or Auth Protection Headers
// ============================================================
export async function signRequestHeaders(
  _method: string,
  _endpointOrUrl: string,
  _bodyStr: string = ''
): Promise<Record<string, string>> {
  return {};
}

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
