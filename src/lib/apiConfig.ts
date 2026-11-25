import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { getAuthSession } from './securityClient';

/**
 * Centralized API & Server Endpoint Resolver for Web and Android APK
 * الرابط الافتراضي لسيرفر Hostinger: http://72.62.158.128
 */

export const HOSTINGER_DEFAULT_SERVER = 'http://72.62.158.128';

export const CANDIDATE_SERVERS: string[] = [
  'http://72.62.158.128',
  'http://72.62.158.128:3000',
  'https://ais-dev-asc5xuvnur4hlmpl5rfxpz-655986077616.europe-west2.run.app',
  'https://ais-pre-asc5xuvnur4hlmpl5rfxpz-655986077616.europe-west2.run.app',
];

const DEFAULT_REMOTE_SERVER = 'http://72.62.158.128';
const SERVER_URL_STORAGE_KEY = 'alkarrar_backend_server_url';
const LEGACY_CUSTOM_SERVER_KEY = 'alkarrar_custom_server_url';

function isLocalWebViewUrl(url: string): boolean {
  const lower = (url || '').trim().toLowerCase();
  return (
    !lower ||
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('0.0.0.0') ||
    lower.startsWith('capacitor://') ||
    lower.startsWith('ionic://') ||
    lower.startsWith('file://') ||
    lower.startsWith('content://')
  );
}

/**
 * Strict validator for external HTTP/HTTPS server URLs.
 * Rejects incomplete/truncated IPv4 addresses (like http://72.62.158 missing .128),
 * single-label hostnames, and Capacitor local WebView origins.
 */
export function validateServerUrl(rawUrl: string): {
  valid: boolean;
  cleanUrl: string;
  error?: string;
} {
  const trimmed = (rawUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { valid: false, cleanUrl: '', error: 'يرجى إدخال عنوان السيرفر' };
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return {
      valid: false,
      cleanUrl: trimmed,
      error: 'يجب أن يبدأ العنوان بـ http:// أو https:// (مثال: http://72.62.158.128)',
    };
  }
  if (isLocalWebViewUrl(trimmed)) {
    return {
      valid: false,
      cleanUrl: trimmed,
      error: 'لا يمكن استخدام عنوان محلي (localhost / capacitor) كسيرفر خارجي',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch (_e) {
    return {
      valid: false,
      cleanUrl: trimmed,
      error: 'صيغة عنوان السيرفر غير صالحة',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, cleanUrl: trimmed, error: 'بروتوكول غير مدعوم' };
  }

  const hostname = (parsed.hostname || '').trim();
  if (!hostname || isLocalWebViewUrl(hostname)) {
    return { valid: false, cleanUrl: trimmed, error: 'اسم المضيف أو IP غير صالح' };
  }

  // If hostname looks like an IPv4 attempt (digits & dots only), strictly require 4 valid octets (0-255)
  if (/^[0-9.]+$/.test(hostname)) {
    const octets = hostname.split('.');
    if (octets.length !== 4 || octets.some((o) => o === '' || !/^\d{1,3}$/.test(o) || Number(o) > 255)) {
      return {
        valid: false,
        cleanUrl: trimmed,
        error: `عنوان الـ IP غير مكتمل (${hostname}) — يجب أن يتكون من 4 أجزاء مثل 72.62.158.128`,
      };
    }
  } else if (!hostname.includes('.')) {
    return {
      valid: false,
      cleanUrl: trimmed,
      error: `اسم النطاق غير مكتمل (${hostname})`,
    };
  }

  const normalizedOrigin = `${parsed.protocol}//${parsed.host}`;
  return { valid: true, cleanUrl: normalizedOrigin };
}

export function isValidServerUrl(rawUrl: string): boolean {
  return validateServerUrl(rawUrl).valid;
}

function purgeInvalidStoredServerKeys() {
  try {
    if (typeof localStorage !== 'undefined') {
      const k1 = localStorage.getItem(SERVER_URL_STORAGE_KEY);
      if (k1 && !isValidServerUrl(k1)) {
        localStorage.removeItem(SERVER_URL_STORAGE_KEY);
      }
      const k2 = localStorage.getItem(LEGACY_CUSTOM_SERVER_KEY);
      if (k2 && !isValidServerUrl(k2)) {
        localStorage.removeItem(LEGACY_CUSTOM_SERVER_KEY);
      }
    }
  } catch (_e) {}

  try {
    Preferences.get({ key: SERVER_URL_STORAGE_KEY })
      .then((res) => {
        if (res?.value && !isValidServerUrl(res.value)) {
          Preferences.remove({ key: SERVER_URL_STORAGE_KEY }).catch(() => {});
          Preferences.remove({ key: LEGACY_CUSTOM_SERVER_KEY }).catch(() => {});
          Preferences.remove({ key: `CapacitorStorage.${SERVER_URL_STORAGE_KEY}` }).catch(() => {});
        }
      })
      .catch(() => {});
  } catch (_e) {}
}

purgeInvalidStoredServerKeys();

export function getCustomServerUrl(): string {
  try {
    const primary = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    if (primary) {
      const check = validateServerUrl(primary);
      if (check.valid) return check.cleanUrl;
      localStorage.removeItem(SERVER_URL_STORAGE_KEY);
    }
    const legacy = localStorage.getItem(LEGACY_CUSTOM_SERVER_KEY);
    if (legacy) {
      const check = validateServerUrl(legacy);
      if (check.valid) return check.cleanUrl;
      localStorage.removeItem(LEGACY_CUSTOM_SERVER_KEY);
    }
  } catch (e) {}
  return '';
}

export function getHostingerServerUrl(): string {
  const custom = getCustomServerUrl();
  if (custom) return custom;
  return HOSTINGER_DEFAULT_SERVER;
}

function syncServerUrlPreference(url: string) {
  try {
    const check = validateServerUrl(url);
    if (!check.valid) return;
    const clean = check.cleanUrl;
    Preferences.set({ key: SERVER_URL_STORAGE_KEY, value: clean }).catch(() => {});
    Preferences.set({ key: LEGACY_CUSTOM_SERVER_KEY, value: clean }).catch(() => {});
    Preferences.set({ key: `CapacitorStorage.${SERVER_URL_STORAGE_KEY}`, value: clean }).catch(() => {});
    const bridge =
      typeof window !== 'undefined'
        ? (window as any).AndroidInterface ||
          (window as any).AndroidPrinter ||
          (window as any).Android ||
          (window as any).AndroidBridge
        : null;
    if (bridge && typeof bridge.syncPendingQueueToNative === 'function') {
      try {
        const existingNative = typeof bridge.getPendingQueueFromNative === 'function' ? bridge.getPendingQueueFromNative() : null;
        if (existingNative && existingNative.startsWith('[')) {
          bridge.syncPendingQueueToNative(existingNative, clean);
        }
      } catch (_e) {}
    }
  } catch (_e) {}
}

export function setCustomServerUrl(url: string) {
  try {
    const trimmed = (url || '').trim();
    if (!trimmed) {
      activeWorkingServer = '';
      localStorage.removeItem(SERVER_URL_STORAGE_KEY);
      localStorage.removeItem(LEGACY_CUSTOM_SERVER_KEY);
      Preferences.remove({ key: SERVER_URL_STORAGE_KEY }).catch(() => {});
      Preferences.remove({ key: LEGACY_CUSTOM_SERVER_KEY }).catch(() => {});
      Preferences.remove({ key: `CapacitorStorage.${SERVER_URL_STORAGE_KEY}` }).catch(() => {});
      return;
    }

    const check = validateServerUrl(trimmed);
    if (check.valid) {
      localStorage.setItem(SERVER_URL_STORAGE_KEY, check.cleanUrl);
      localStorage.setItem(LEGACY_CUSTOM_SERVER_KEY, check.cleanUrl);
      syncServerUrlPreference(check.cleanUrl);
    }
  } catch (e) {}
}

export function setHostingerServerUrl(url: string) {
  setCustomServerUrl(url);
}

let activeWorkingServer = '';
try {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    if (saved) {
      const check = validateServerUrl(saved);
      if (check.valid) {
        activeWorkingServer = check.cleanUrl;
      } else {
        localStorage.removeItem(SERVER_URL_STORAGE_KEY);
      }
    }
  }
} catch (e) {}

function canonicalizeHeaderName(key: string): string {
  const lower = key.trim().toLowerCase();
  if (lower === 'content-type') return 'Content-Type';
  if (lower === 'accept') return 'Accept';
  if (lower === 'authorization') return 'Authorization';
  if (lower === 'cache-control') return 'Cache-Control';
  if (lower === 'x-rep-id') return 'X-Rep-Id';
  return key.trim();
}

function normalizeHeadersToRecord(headers?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  try {
    if (headers instanceof Headers) {
      headers.forEach((v, k) => {
        if (k) out[canonicalizeHeaderName(k)] = v;
      });
    } else if (Array.isArray(headers)) {
      for (const [k, v] of headers) {
        if (k) out[canonicalizeHeaderName(k)] = v;
      }
    } else {
      for (const [k, v] of Object.entries(headers)) {
        if (k && v !== undefined && v !== null) out[canonicalizeHeaderName(k)] = String(v);
      }
    }
  } catch (e) {}
  return out;
}

async function nativeCapacitorHttpRequest(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const method = (init?.method || 'GET').toUpperCase();
  const reqHeaders = normalizeHeadersToRecord(init?.headers);
  let requestData: any = undefined;

  if (init?.body !== undefined && init?.body !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof init.body === 'string') {
      try {
        requestData = JSON.parse(init.body);
      } catch (e) {
        requestData = init.body;
      }
    } else {
      requestData = init.body;
    }
    if (!reqHeaders['Content-Type'] && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) {
      reqHeaders['Content-Type'] = 'application/json';
    }
  }

  const natRes = await CapacitorHttp.request({
    url,
    method,
    headers: reqHeaders,
    ...(requestData !== undefined ? { data: requestData } : {}),
    connectTimeout: Math.min(Math.max(timeoutMs, 4000), 8000),
    readTimeout: timeoutMs,
  });

  const status = Number(natRes?.status || 0);
  if (!status || status < 100 || status > 599) {
    throw new Error(`Native HTTP invalid status: ${status}`);
  }

  const respHeaders = new Headers();
  if (natRes?.headers && typeof natRes.headers === 'object') {
    for (const [k, v] of Object.entries(natRes.headers)) {
      if (k && k.toLowerCase() !== 'null' && v !== undefined && v !== null) {
        try {
          respHeaders.set(String(k), String(v));
        } catch (e) {}
      }
    }
  }

  let bodyText: string | null = null;
  if (status !== 204 && status !== 304 && natRes?.data !== undefined && natRes?.data !== null) {
    if (typeof natRes.data === 'string') {
      bodyText = natRes.data;
      const trimmed = bodyText.trim();
      const ct = (respHeaders.get('content-type') || '').toLowerCase();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (!ct || ct.includes('text/plain'))) {
        respHeaders.set('content-type', 'application/json; charset=utf-8');
      }
    } else {
      bodyText = JSON.stringify(natRes.data);
      if (!respHeaders.get('content-type')) {
        respHeaders.set('content-type', 'application/json; charset=utf-8');
      }
    }
  }

  return new Response(bodyText, {
    status,
    headers: respHeaders,
  });
}

async function fetchWithRaceTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const isExternalHttp = url.startsWith('http://') || url.startsWith('https://');
  const canUseNativeHttp =
    isExternalHttp &&
    isNativeOrApkEnvironment() &&
    CapacitorHttp &&
    typeof CapacitorHttp.request === 'function';

  let timer: any;
  let timedOut = false;
  let nativeErrMsg = '';
  const controller = new AbortController();
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          controller.abort();
        } catch (e) {}
        reject(new DOMException('Timeout', 'AbortError'));
      }, timeoutMs);
    });

    if (canUseNativeHttp) {
      try {
        return await Promise.race([nativeCapacitorHttpRequest(url, init, timeoutMs), timeoutPromise]);
      } catch (nativeErr: any) {
        if (timedOut) {
          throw nativeErr;
        }
        nativeErrMsg = nativeErr?.message || String(nativeErr || 'CapacitorHttp failed');
        // Fallback to WebView fetch so mixed content & CORS remain usable if native plugin fails,
        // while preserving nativeErrMsg if WebView fetch also fails.
        console.warn('[API] CapacitorHttp error, falling back to fetch:', url, nativeErrMsg);
      }
    }

    try {
      const fetchPromise = fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (fetchErr: any) {
      if (nativeErrMsg && fetchErr?.name !== 'AbortError') {
        const fetchMsg = fetchErr?.message || String(fetchErr || 'Failed to fetch');
        throw new Error(`NativeHTTP: ${nativeErrMsg} | WebView: ${fetchMsg}`);
      }
      throw fetchErr;
    }
  } finally {
    clearTimeout(timer);
  }
}

let activeDetectPromise: Promise<string> | null = null;

export async function autoDetectActiveServer(forceProbe = false): Promise<string> {
  if (activeWorkingServer && isValidServerUrl(activeWorkingServer) && !forceProbe) {
    return activeWorkingServer;
  }
  if (activeDetectPromise) return activeDetectPromise;

  activeDetectPromise = (async () => {
    const probeOne = async (server: string): Promise<string> => {
      const res = await fetchWithRaceTimeout(
        `${server}/api/health`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        },
        4500
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html')) throw new Error('HTML response');
      const data = await res.json().catch(() => null);
      if (!data || (data.status !== 'ok' && data.ok !== true && !data.database)) {
        throw new Error('Invalid health payload');
      }
      return server;
    };

    // Priority 1: Saved custom server URL (must pass strict URL/IP validation)
    const custom = getCustomServerUrl();
    if (custom && isValidServerUrl(custom)) {
      try {
        const okCustom = await probeOne(custom);
        setActiveWorkingServer(okCustom);
        return okCustom;
      } catch (_e) {}
    }

    // Priority 2: Primary Hostinger VPS endpoints (port 80 and port 3000) BEFORE any Cloud Run URLs
    const hostingerServers = CANDIDATE_SERVERS.filter((s) => !s.includes('run.app'));
    if (hostingerServers.length > 0) {
      try {
        const winner = await Promise.any(hostingerServers.map((s) => probeOne(s)));
        if (winner) {
          setActiveWorkingServer(winner);
          return winner;
        }
      } catch (_e) {}
    }

    // Priority 3: Fallback Cloud Run endpoints only if Hostinger is unreachable
    const cloudRunServers = CANDIDATE_SERVERS.filter((s) => s.includes('run.app'));
    for (const s of cloudRunServers) {
      try {
        const winner = await probeOne(s);
        if (winner) {
          setActiveWorkingServer(winner);
          return winner;
        }
      } catch (_e) {}
    }

    return (activeWorkingServer && isValidServerUrl(activeWorkingServer) ? activeWorkingServer : '') || DEFAULT_REMOTE_SERVER;
  })().finally(() => {
    activeDetectPromise = null;
  });

  return activeDetectPromise;
}

export function setActiveWorkingServer(url: string) {
  const check = validateServerUrl(url);
  if (check.valid) {
    activeWorkingServer = check.cleanUrl;
    try {
      localStorage.setItem(SERVER_URL_STORAGE_KEY, activeWorkingServer);
      localStorage.setItem(LEGACY_CUSTOM_SERVER_KEY, activeWorkingServer);
    } catch (e) {}
    syncServerUrlPreference(activeWorkingServer);
  }
}

export function isNativeOrApkEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (Capacitor.isNativePlatform() || Capacitor.getPlatform() === 'android' || Capacitor.getPlatform() === 'ios') {
      return true;
    }
  } catch (e) {}
  return (
    window.location.protocol === 'file:' ||
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'ionic:' ||
    window.location.protocol === 'content:' ||
    !!(window as any).Capacitor?.isNativePlatform?.() ||
    (window as any).Capacitor?.getPlatform?.() === 'android' ||
    (window.location.hostname === 'localhost' && window.location.port !== '3000' && window.location.port !== '5173') ||
    (window.location.origin && window.location.origin.includes('localhost') && !window.location.port)
  );
}

export function getApiBaseUrl(): string {
  const isNative = isNativeOrApkEnvironment();
  let base = '';
  if (activeWorkingServer && isValidServerUrl(activeWorkingServer)) {
    base = activeWorkingServer;
  } else if (
    !isNative &&
    typeof window !== 'undefined' &&
    window.location.origin &&
    isValidServerUrl(window.location.origin)
  ) {
    base = window.location.origin;
  } else {
    const custom = getCustomServerUrl();
    if (custom && isValidServerUrl(custom)) {
      base = custom;
    } else {
      base = DEFAULT_REMOTE_SERVER;
    }
  }
  return base.replace(/\/+$/, '');
}

export function getPublicShareBaseUrl(): string {
  const custom = getCustomServerUrl();
  if (custom && isValidServerUrl(custom)) {
    return custom;
  }
  if (activeWorkingServer && isValidServerUrl(activeWorkingServer)) {
    return activeWorkingServer;
  }
  if (
    typeof window !== 'undefined' &&
    window.location.origin &&
    isValidServerUrl(window.location.origin)
  ) {
    return window.location.origin.replace(/\/+$/, '');
  }
  return DEFAULT_REMOTE_SERVER;
}

export function getFullApiUrl(endpoint: string, baseOverride?: string): string {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const base = baseOverride !== undefined ? baseOverride : getApiBaseUrl();
  if (!base) return cleanEndpoint;
  return `${base}${cleanEndpoint}`;
}

export async function isNetworkConnected(): Promise<boolean> {
  try {
    const status = await Network.getStatus();
    if (typeof status?.connected === 'boolean') {
      return status.connected;
    }
  } catch (e) {}
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}

/**
 * Universal fetch that automatically tries candidate servers and local endpoints with fallback
 */
export async function fetchWithFallback(
  endpoint: string,
  options?: RequestInit,
  timeoutMs: number = 10000
): Promise<Response> {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const isNative = isNativeOrApkEnvironment();

  const urlsToTry: string[] = [];

  if (isNative) {
    if (activeWorkingServer && isValidServerUrl(activeWorkingServer)) {
      const activeUrl = `${activeWorkingServer}${cleanEndpoint}`;
      if (!urlsToTry.includes(activeUrl)) urlsToTry.push(activeUrl);
    }
    const custom = getCustomServerUrl();
    if (custom && isValidServerUrl(custom)) {
      const customUrl = `${custom}${cleanEndpoint}`;
      if (!urlsToTry.includes(customUrl)) urlsToTry.push(customUrl);
    }
    for (const server of CANDIDATE_SERVERS) {
      const candidateUrl = `${server}${cleanEndpoint}`;
      if (!urlsToTry.includes(candidateUrl)) {
        urlsToTry.push(candidateUrl);
      }
    }
  } else {
    const hasHttpOrigin =
      typeof window !== 'undefined' &&
      Boolean(window.location.origin) &&
      (window.location.origin.startsWith('http://') || window.location.origin.startsWith('https://'));

    if (hasHttpOrigin) {
      if (!urlsToTry.includes(cleanEndpoint)) {
        urlsToTry.push(cleanEndpoint);
      }
      const custom = getCustomServerUrl();
      if (custom && custom !== window.location.origin) {
        const customUrl = `${custom}${cleanEndpoint}`;
        if (!urlsToTry.includes(customUrl)) urlsToTry.push(customUrl);
      }
    } else {
      if (!urlsToTry.includes(cleanEndpoint)) {
        urlsToTry.push(cleanEndpoint);
      }
      if (activeWorkingServer && isValidServerUrl(activeWorkingServer)) {
        const activeUrl = `${activeWorkingServer}${cleanEndpoint}`;
        if (!urlsToTry.includes(activeUrl)) urlsToTry.push(activeUrl);
      }
      const primaryUrl = getFullApiUrl(cleanEndpoint);
      if (!urlsToTry.includes(primaryUrl)) {
        urlsToTry.push(primaryUrl);
      }
      for (const server of CANDIDATE_SERVERS) {
        const candidateUrl = `${server}${cleanEndpoint}`;
        if (!urlsToTry.includes(candidateUrl)) {
          urlsToTry.push(candidateUrl);
        }
      }
    }
  }

  let lastError: any = null;
  const skipSigning = cleanEndpoint.startsWith('/api/auth/login') || cleanEndpoint.startsWith('/api/auth/logout');
  const methodUpper = (options?.method || 'GET').toUpperCase();

  let sessionHeaders: Record<string, string> = {};
  if (!skipSigning) {
    try {
      const session = getAuthSession();
      if (session?.token) sessionHeaders['Authorization'] = `Bearer ${session.token}`;
      if (session?.rep?.id) sessionHeaders['X-Rep-Id'] = String(session.rep.id);
    } catch (_e) {}
  }

  const mergedHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    ...sessionHeaders,
    ...normalizeHeadersToRecord(options?.headers),
  };

  for (let idx = 0; idx < urlsToTry.length; idx++) {
    const url = urlsToTry[idx];
    try {
      const baseTimeout = timeoutMs || (isNative ? 15000 : 10000);
      const perUrlTimeout =
        idx === 0 || idx === urlsToTry.length - 1
          ? baseTimeout
          : Math.min(baseTimeout, methodUpper === 'GET' ? 6000 : 10000);

      const res = await fetchWithRaceTimeout(
        url,
        {
          ...options,
          headers: mergedHeaders,
        },
        perUrlTimeout
      );

      if (res.ok) {
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('text/html')) {
          continue;
        }

        if (isNative && url.startsWith('http')) {
          try {
            const urlObj = new URL(url);
            setActiveWorkingServer(urlObj.origin);
          } catch (e) {}
        }
        return res;
      }

      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 409 || res.status === 422) {
        if (
          res.status === 401 &&
          !skipSigning &&
          !cleanEndpoint.startsWith('/api/auth/') &&
          typeof window !== 'undefined'
        ) {
          try {
            window.dispatchEvent(new CustomEvent('alkarrar:auth-401', { detail: { endpoint: cleanEndpoint } }));
          } catch (e) {}
        }
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('text/html') || idx === urlsToTry.length - 1) {
          return res;
        }
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Network fetch failed for ${endpoint}`);
}

export async function universalApiFetch(
  endpoint: string,
  options?: RequestInit
): Promise<Response> {
  return fetchWithFallback(endpoint, options, 12000);
}

export async function checkServerHealth(url?: string): Promise<{ ok: boolean; status?: string; database?: string; latencyMs: number; error?: string }> {
  const start = Date.now();
  let baseUrl = '';
  if (url !== undefined && url.trim() !== '') {
    const check = validateServerUrl(url);
    if (!check.valid) {
      return {
        ok: false,
        latencyMs: 0,
        error: check.error || 'عنوان السيرفر غير صالح',
      };
    }
    baseUrl = check.cleanUrl;
  } else {
    baseUrl = getApiBaseUrl();
  }

  const targetUrl = baseUrl ? `${baseUrl}/api/health` : '/api/health';

  try {
    const res = await fetchWithRaceTimeout(
      targetUrl,
      { headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' } },
      6000
    );
    const latencyMs = Date.now() - start;
    const ct = (res.headers.get('content-type') || '').toLowerCase();

    if (res.ok) {
      if (ct.includes('text/html')) {
        return {
          ok: false,
          latencyMs,
          error: 'الخادم أعاد صفحة HTML بدلاً من API (/api/health غير موجه)',
        };
      }
      const data = await res.json().catch(() => null);
      if (!data || (data.status !== 'ok' && data.ok !== true && !data.database)) {
        return {
          ok: false,
          latencyMs,
          error: 'استجابة غير متوقعة من /api/health',
        };
      }
      return {
        ok: true,
        status: data.status || 'ok',
        database: data.database || 'postgresql',
        latencyMs,
      };
    } else {
      return {
        ok: false,
        latencyMs,
        error: `HTTP ${res.status}: ${res.statusText || 'Error'}`,
      };
    }
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      latencyMs,
      error: err.name === 'AbortError' ? 'انتهت مهلة الاتصال بالخادم (Timeout)' : (err.message || 'تعذر الاتصال بالخادم'),
    };
  }
}

export async function testBatchSyncEndpoint(url?: string): Promise<{ ok: boolean; status?: number; latencyMs: number; responsePreview?: string; error?: string }> {
  const start = Date.now();
  let baseUrl = '';
  if (url !== undefined && url.trim() !== '') {
    const check = validateServerUrl(url);
    if (!check.valid) {
      return {
        ok: false,
        latencyMs: 0,
        error: check.error || 'عنوان السيرفر غير صالح',
      };
    }
    baseUrl = check.cleanUrl;
  } else {
    baseUrl = getApiBaseUrl();
  }

  const targetUrl = baseUrl ? `${baseUrl}/api/sync/batch` : '/api/sync/batch';
  try {
    const res = await fetchWithRaceTimeout(
      targetUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ actions: [] }),
      },
      7000
    );
    const latencyMs = Date.now() - start;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const rawText = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}: ${rawText.slice(0, 120)}` };
    }
    if (ct.includes('text/html') || rawText.trim().startsWith('<')) {
      return { ok: false, status: res.status, latencyMs, error: 'HTML response instead of JSON' };
    }
    return { ok: true, status: res.status, latencyMs, responsePreview: rawText.slice(0, 140) };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err?.name === 'AbortError' ? 'Timeout (7000ms)' : (err?.message || 'Network error'),
    };
  }
}

export interface ServerProbeResult {
  url: string;
  ok: boolean;
  latencyMs: number;
  database?: string;
  error?: string;
}

export async function probeAllCandidateServers(extraUrl?: string): Promise<ServerProbeResult[]> {
  const targets: string[] = [];
  if (extraUrl) {
    const v = validateServerUrl(extraUrl);
    if (v.valid && !targets.includes(v.cleanUrl)) targets.push(v.cleanUrl);
  }
  for (const s of CANDIDATE_SERVERS) {
    if (!targets.includes(s)) targets.push(s);
  }
  return Promise.all(
    targets.map(async (target) => {
      const h = await checkServerHealth(target);
      return {
        url: target,
        ok: h.ok,
        latencyMs: h.latencyMs,
        database: h.database,
        error: h.error,
      };
    })
  );
}

export async function repairAndResetServerUrl(): Promise<{
  activeUrl: string;
  probes: ServerProbeResult[];
}> {
  setCustomServerUrl('');
  const [detected, probes] = await Promise.all([
    autoDetectActiveServer(true).catch(() => HOSTINGER_DEFAULT_SERVER),
    probeAllCandidateServers(),
  ]);
  const working = probes.find((p) => p.ok)?.url || detected || HOSTINGER_DEFAULT_SERVER;
  setActiveWorkingServer(working);
  return { activeUrl: working, probes };
}

// Automatically probe priority candidate servers on APK startup
if (typeof window !== 'undefined' && isNativeOrApkEnvironment()) {
  autoDetectActiveServer(true).catch(() => {});
}
