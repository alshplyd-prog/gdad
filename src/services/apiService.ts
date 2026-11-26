/**
 * Dedicated API Service Layer
 * Connects the React client to the Node.js backend server via standard REST endpoints.
 */

import { getApiBaseUrl, isNativeOrApkEnvironment } from '../lib/apiConfig';

/**
 * Production backend URL for mobile APK and external environments
 * استبدل الرابط بالرابط الحقيقي لسيرفرك في Hostinger (مثال: http://72.62.158.128/api أو https://your-domain.com/api)
 */
export const CLOUD_API_URL = 'http://127.0.0.1:3000/api';

/**
 * Dynamic API Base URL resolver:
 * - In mobile / APK requests, directs to configured server or VPS backend
 * - In web browser, uses relative `/api` or custom server
 */
export function getActiveApiUrl(): string {
  if (typeof window !== 'undefined') {
    const custom = getApiBaseUrl();
    if (custom && custom.trim() !== '') {
      return `${custom.trim().replace(/\/+$/, '')}/api`;
    }
    if (!isNativeOrApkEnvironment()) {
      return '/api';
    }
  }
  return CLOUD_API_URL;
}

export const API_BASE_URL = getActiveApiUrl();

// Helper function for all HTTP requests with timeout & error handling
async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const cleanEndpoint = endpoint.replace(/^\/+/, '');
  const baseUrl = getActiveApiUrl();
  const url = `${baseUrl.replace(/\/+$/, '')}/${cleanEndpoint}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      if (text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().startsWith('<html')) {
        throw new Error('استجابة السيرفر غير صالحة (يعرض صفحة HTML بدلاً من JSON)');
      }
      throw new Error('خطأ في قراءة رد السيرفر');
    }

    if (!response.ok) {
      throw new Error(data.message || data.error || `خطأ في الاتصال بالسيرفر (${response.status})`);
    }

    return data;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بالسيرفر. يرجى التحقق من اتصال الإنترنت.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
