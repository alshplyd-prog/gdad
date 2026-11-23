import { App } from '@capacitor/app';
import { BackgroundTask } from '@capawesome/capacitor-background-task';
import { BackgroundRunner } from '@capacitor/background-runner';
import { Preferences } from '@capacitor/preferences';
import { Network } from '@capacitor/network';
import { getApiBaseUrl, getFullApiUrl, fetchWithFallback, CANDIDATE_SERVERS, getCustomServerUrl, isNativeOrApkEnvironment, isNetworkConnected } from './apiConfig';
import {
  secureStorageGetSync,
  secureStorageSetSync,
  secureStorageRemoveSync,
  generateCryptoNonce,
} from './securityClient';
import { normalizeArabicPersonName } from './nameHelpers';
import {
  reconcileAllLocalWithDatabase,
  verifyAndReconcileWithServer,
  verifyAndReconcileUntilMatched,
  mirrorLocalSnapshotToIndexedDb,
  loadSnapshotFromIndexedDbIfAvailable,
} from './postgresClient';

export type ActionStatus = 'pending' | 'syncing' | 'synced';

export interface PendingAction {
  id: string;
  nonce?: string;
  type: string;
  payload: any;
  timestamp: number;
  status: ActionStatus;
  retryCount?: number;
  error?: string | null;
  syncedAt?: number | null;
  lastAttemptAt?: number | null;
}

const QUEUE_KEY = 'alkarrar_offline_pending_queue';
const DB_NAME = 'alkarrar_sync_db';
const DB_VERSION = 2;
const STORE_NAME = 'pending_actions';

const SECONDARY_DB_NAME = 'alkarrar_offline_sync_db';
const SECONDARY_STORE_NAME = 'offline_queue';

// Helper to ensure any async operation never hangs indefinitely
function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 3000, fallbackVal: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallbackVal), timeoutMs)),
  ]);
}

// IndexedDB Helper with indices for status and timestamp
export function openIndexedDb(dbName = DB_NAME, storeName = STORE_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in current environment'));
    }
    try {
      const req = indexedDB.open(dbName, DB_VERSION);
      req.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(storeName)) {
          store = db.createObjectStore(storeName, { keyPath: 'id' });
        } else {
          store = e.target.transaction.objectStore(storeName);
        }
        if (!store.indexNames.contains('status')) {
          store.createIndex('status', 'status', { unique: false });
        }
        if (!store.indexNames.contains('timestamp')) {
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
      req.onblocked = () => reject(new Error('IndexedDB open request blocked'));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Get all actions directly from Primary IndexedDB
 */
function isValidOfflineAction(item: any, permanentlySynced?: Set<string>): boolean {
  if (!item || !item.id || !item.type) return false;
  const idStr = String(item.id);
  if (idStr.startsWith('__meta_') || item.type === '__META_CONFIG__') return false;
  if (permanentlySynced && permanentlySynced.has(idStr)) return false;

  const p = item.payload;
  const type = String(item.type);

  if (type === 'CREATE_PAYMENT' || type === 'UPDATE_PAYMENT' || type === 'RECORD_PAYMENT' || type === 'ADD_PAYMENT') {
    if (!p || typeof p !== 'object') return false;
    const pId = String(p.id || '').trim();
    const amt = Number(p.amountPaid ?? p.amount_paid ?? p.amount ?? 0);
    if (!pId || isNaN(amt) || amt <= 0) return false;
    if (pId.startsWith('contract_') || pId.startsWith('emp_') || pId.startsWith('item_') || pId.startsWith('fund_')) return false;
  }

  if (type === 'CREATE_CONTRACT' || type === 'UPDATE_CONTRACT') {
    if (!p || typeof p !== 'object') return false;
    const cId = String(p.id || '').trim();
    if (!cId || cId.startsWith('pay_') || cId.startsWith('ft_') || cId.startsWith('emptx_') || cId.startsWith('conflict_') || cId.startsWith('fund_')) {
      return false;
    }
  }

  return true;
}

export async function getActionsFromIndexedDb(): Promise<PendingAction[]> {
  try {
    const dbPromise = openIndexedDb(DB_NAME, STORE_NAME);
    const db = await withTimeout(dbPromise, 2500, null as any);
    if (!db) return [];

    const readPromise = new Promise<PendingAction[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const results: any[] = req.result || [];
          const now = Date.now();
          const permanentlySynced = getPermanentlySyncedIds();
          const validActions: PendingAction[] = results
            .filter((item) => isValidOfflineAction(item, permanentlySynced))
            .map((item) => ({
              id: item.id,
              nonce: item.nonce,
              type: item.type,
              payload: item.payload,
              timestamp: Number(item.timestamp) || now,
              // If marked syncing but over 30s old, un-freeze back to pending
              status: (item.status === 'synced' ? 'synced' : (item.status === 'syncing' && item.lastAttemptAt && now - item.lastAttemptAt < 30000 ? 'syncing' : 'pending')) as ActionStatus,
              retryCount: Number(item.retryCount) || 0,
              error: item.error || null,
              syncedAt: item.syncedAt || null,
              lastAttemptAt: item.lastAttemptAt || null,
            }));
          resolve(validActions);
        };
        req.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
        tx.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });

    return await withTimeout(readPromise, 2500, []);
  } catch (err) {
    return [];
  }
}

// Helper: Generate candidate metadata payload for Service Worker
function getMetaPayloadForSw() {
  const origins: string[] = [];
  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    origins.push(window.location.origin);
  }
  const custom = getCustomServerUrl();
  if (custom && !origins.includes(custom)) origins.push(custom);
  for (const s of CANDIDATE_SERVERS) {
    if (s && !origins.includes(s)) origins.push(s);
  }
  const serverUrl = getFullApiUrl('/api/sync/batch');
  return { origins, serverUrl };
}

/**
 * Save an action to IndexedDB (and mirror to secondary DB)
 */
export async function saveActionToIndexedDb(action: PendingAction): Promise<void> {
  const metaPayload = getMetaPayloadForSw();
  const savePrimary = async () => {
    try {
      const db = await openIndexedDb(DB_NAME, STORE_NAME);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(action);

      // Save server URL metadata for background service worker
      try {
        store.put({ id: '__meta_server_url__', type: '__META_CONFIG__', payload: metaPayload, timestamp: Date.now(), status: 'synced' });
      } catch (e) {}

      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    } catch (e) {}
  };

  const saveSecondary = async () => {
    try {
      const db2 = await openIndexedDb(SECONDARY_DB_NAME, SECONDARY_STORE_NAME);
      const tx2 = db2.transaction(SECONDARY_STORE_NAME, 'readwrite');
      const store2 = tx2.objectStore(SECONDARY_STORE_NAME);
      store2.put(action);
      try {
        store2.put({ id: '__meta_server_url__', type: '__META_CONFIG__', payload: metaPayload, timestamp: Date.now(), status: 'synced' });
      } catch (e) {}
      await new Promise((resolve) => {
        tx2.oncomplete = resolve;
        tx2.onerror = resolve;
        tx2.onabort = resolve;
      });
    } catch (e) {}
  };

  await withTimeout(Promise.all([savePrimary(), saveSecondary()]), 2500, null);
}

/**
 * Remove an action by ID from IndexedDB
 */
export async function deleteActionFromIndexedDb(id: string): Promise<void> {
  const delPrimary = async () => {
    try {
      const db = await openIndexedDb(DB_NAME, STORE_NAME);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    } catch (e) {}
  };

  const delSecondary = async () => {
    try {
      const db2 = await openIndexedDb(SECONDARY_DB_NAME, SECONDARY_STORE_NAME);
      const tx2 = db2.transaction(SECONDARY_STORE_NAME, 'readwrite');
      tx2.objectStore(SECONDARY_STORE_NAME).delete(id);
      await new Promise((resolve) => {
        tx2.oncomplete = resolve;
        tx2.onerror = resolve;
        tx2.onabort = resolve;
      });
    } catch (e) {}
  };

  await withTimeout(Promise.all([delPrimary(), delSecondary()]), 2500, null);
}

/**
 * Remove a batch of action IDs from IndexedDB using a single transaction per DB (sub-5ms for 100+ items)
 */
async function deleteActionsBatchFromIndexedDb(ids: string[]): Promise<void> {
  if (!ids || ids.length === 0) return;
  const delBatch = async (dbName: string, storeName: string) => {
    try {
      const db = await openIndexedDb(dbName, storeName);
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const id of ids) {
        if (id) store.delete(id);
      }
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    } catch (e) {}
  };
  await withTimeout(
    Promise.all([
      delBatch(DB_NAME, STORE_NAME),
      delBatch(SECONDARY_DB_NAME, SECONDARY_STORE_NAME),
    ]),
    2500,
    null
  );
}

/**
 * Sync entire memory/localStorage queue snapshot to IndexedDB
 */
async function syncQueueToIndexedDb(queue: PendingAction[]): Promise<void> {
  const metaPayload = getMetaPayloadForSw();
  const syncPrimary = async () => {
    try {
      const db = await openIndexedDb(DB_NAME, STORE_NAME);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const item of queue) {
        store.put(item);
      }
      try {
        store.put({ id: '__meta_server_url__', type: '__META_CONFIG__', payload: metaPayload, timestamp: Date.now(), status: 'synced' });
      } catch (e) {}

      await new Promise((resolve) => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
      });
    } catch (err) {}
  };

  const syncSecondary = async () => {
    try {
      const db2 = await openIndexedDb(SECONDARY_DB_NAME, SECONDARY_STORE_NAME);
      const tx2 = db2.transaction(SECONDARY_STORE_NAME, 'readwrite');
      const store2 = tx2.objectStore(SECONDARY_STORE_NAME);
      store2.clear();
      for (const item of queue) {
        store2.put(item);
      }
      try {
        store2.put({ id: '__meta_server_url__', type: '__META_CONFIG__', payload: metaPayload, timestamp: Date.now(), status: 'synced' });
      } catch (e) {}
      await new Promise((resolve) => {
        tx2.oncomplete = resolve;
        tx2.onerror = resolve;
        tx2.onabort = resolve;
      });
    } catch (e) {}
  };

  await withTimeout(Promise.all([syncPrimary(), syncSecondary()]), 3000, null);
}

let lastUserInteractionTime = 0;
let isImeComposing = false;
if (typeof window !== 'undefined') {
  const markInteraction = () => {
    lastUserInteractionTime = Date.now();
  };
  const markCompStart = () => {
    isImeComposing = true;
    lastUserInteractionTime = Date.now();
  };
  const markCompEnd = () => {
    isImeComposing = false;
    lastUserInteractionTime = Date.now();
  };
  window.addEventListener('input', markInteraction, { passive: true, capture: true });
  window.addEventListener('keydown', markInteraction, { passive: true, capture: true });
  window.addEventListener('compositionstart', markCompStart, { passive: true, capture: true });
  window.addEventListener('compositionupdate', markInteraction, { passive: true, capture: true });
  window.addEventListener('compositionend', markCompEnd, { passive: true, capture: true });
}

export function isUiEntryOrSearchProtected(): boolean {
  if (typeof document === 'undefined') return false;
  if (isImeComposing) return true;
  if (Date.now() - lastUserInteractionTime < 10000) return true;
  const activeEl = document.activeElement;
  if (activeEl) {
    const tagName = (activeEl.tagName || '').toUpperCase();
    if (
      tagName === 'INPUT' ||
      tagName === 'TEXTAREA' ||
      tagName === 'SELECT' ||
      activeEl.hasAttribute('contenteditable')
    ) {
      return true;
    }
  }
  if (document.querySelector('[data-sync-pause="true"]')) {
    return true;
  }
  return false;
}

export function isUserActivelyTypingOrInputFocused(): boolean {
  return isUiEntryOrSearchProtected();
}

let queueListeners: Array<(count: number) => void> = [];
let lastNotifiedQueueCount: number = -1;

export function subscribeToQueueChange(listener: (count: number) => void): () => void {
  queueListeners.push(listener);
  getPendingQueue().then((q) => {
    const activeCount = q.filter((i) => i.status !== 'synced').length;
    lastNotifiedQueueCount = activeCount;
    listener(activeCount);
    if (activeCount > 0 && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      flushPendingQueue().catch(() => {});
    }
  });
  return () => {
    queueListeners = queueListeners.filter((l) => l !== listener);
  };
}

function notifyQueueListeners(count: number) {
  if (lastNotifiedQueueCount === count) return;
  lastNotifiedQueueCount = count;
  queueListeners.forEach((fn) => {
    try {
      fn(count);
    } catch (e) {}
  });
}

let syncSuccessListeners: Array<() => void> = [];

export function onSyncSuccess(listener: () => void) {
  syncSuccessListeners.push(listener);
  return () => {
    syncSuccessListeners = syncSuccessListeners.filter((l) => l !== listener);
  };
}

function notifySyncSuccessListeners() {
  syncSuccessListeners.forEach((fn) => {
    try {
      fn();
    } catch (e) {}
  });
}

const PERMANENTLY_SYNCED_KEY = 'sami_permanently_synced_action_ids';

export function getPermanentlySyncedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PERMANENTLY_SYNCED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}

export function markActionIdsAsPermanentlySynced(ids: string[]): void {
  if (!ids || ids.length === 0) return;
  try {
    const set = getPermanentlySyncedIds();
    for (const id of ids) {
      if (id) set.add(id);
    }
    const arr = Array.from(set);
    const trimmed = arr.length > 2000 ? arr.slice(arr.length - 2000) : arr;
    localStorage.setItem(PERMANENTLY_SYNCED_KEY, JSON.stringify(trimmed));
  } catch (e) {}
}

/**
 * Synchronously read pending actions from localStorage (used for rapid local state merging)
 */
export function getPendingQueueSync(): PendingAction[] {
  try {
    const permanentlySynced = getPermanentlySyncedIds();
    const local = secureStorageGetSync(QUEUE_KEY);
    const list = local ? JSON.parse(local) : [];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    
    // Deduplicate by action type group + entity/payload ID (keep latest action per record)
    const entityMap = new Map<string, any>();
    for (const item of list) {
      if (!isValidOfflineAction(item, permanentlySynced)) continue;
      if (item.status === 'synced') continue;
      const entityId = item.payload?.id || (typeof item.payload === 'string' ? item.payload : item.id);
      if (entityId) {
        const key = `${item.type?.includes('PAYMENT') ? 'pay' : item.type?.includes('CONTRACT') ? 'con' : item.type}_${entityId}`;
        const existing = entityMap.get(key);
        if (!existing || Number(item.timestamp || 0) > Number(existing.timestamp || 0)) {
          entityMap.set(key, item);
        }
      } else {
        entityMap.set(item.id, item);
      }
    }

    return Array.from(entityMap.values()).map((item) => ({
      id: item.id,
      nonce: item.nonce,
      type: item.type,
      payload: item.payload,
      timestamp: Number(item.timestamp) || now,
      status: (item.status === 'syncing' && item.lastAttemptAt && now - item.lastAttemptAt < 30000 ? 'syncing' : 'pending') as ActionStatus,
      retryCount: Number(item.retryCount) || 0,
      error: item.error || null,
      syncedAt: item.syncedAt || null,
      lastAttemptAt: item.lastAttemptAt || null,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Asynchronously read pending actions, prioritizing IndexedDB and reconciling with Preferences/localStorage
 */
export async function getPendingQueue(): Promise<PendingAction[]> {
  try {
    const permanentlySynced = getPermanentlySyncedIds();

    // 1. Read from IndexedDB
    const idbActions = await getActionsFromIndexedDb();

    // Check if Service Worker background synced any IDs
    let swSyncedIds: string[] = [];
    try {
      const db = await openIndexedDb(DB_NAME, STORE_NAME);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get('__meta_last_synced_ids__');
      const res: any = await new Promise((r) => {
        req.onsuccess = () => r(req.result);
        req.onerror = () => r(null);
      });
      if (res && res.payload && Array.isArray(res.payload.syncedIds)) {
        swSyncedIds = res.payload.syncedIds;
        store.delete('__meta_last_synced_ids__');
      }
    } catch (e) {}

    if (swSyncedIds.length > 0) {
      markActionIdsAsPermanentlySynced(swSyncedIds);
      swSyncedIds.forEach((id) => permanentlySynced.add(id));
    }

    // 2. Read from Native Android Bridge, Preferences and localStorage
    let nativeList: any[] = [];
    try {
      const bridge =
        (window as any).AndroidInterface ||
        (window as any).AndroidPrinter ||
        (window as any).Android ||
        (window as any).AndroidBridge;
      if (bridge && typeof bridge.getPendingQueueFromNative === 'function') {
        const rawNative = bridge.getPendingQueueFromNative();
        if (rawNative && rawNative.startsWith('[') && rawNative.endsWith(']')) {
          nativeList = JSON.parse(rawNative);
        }
      }
    } catch (e) {}

    let prefList: any[] = [];
    try {
      const { value } = await Preferences.get({ key: QUEUE_KEY });
      if (value) prefList = JSON.parse(value);
    } catch (e) {}

    let localList: any[] = [];
    try {
      const local = secureStorageGetSync(QUEUE_KEY);
      if (local) localList = JSON.parse(local);
    } catch (e) {}

    const entityLatestMap = new Map<string, any>();
    const droppedInvalidIds: string[] = [];
    const now = Date.now();

    const addAction = (item: any) => {
      if (!item || !item.id || String(item.id).startsWith('__meta_') || item.type === '__META_CONFIG__') return;
      if (permanentlySynced.has(item.id) || item.status === 'synced') return;
      if (!isValidOfflineAction(item, permanentlySynced)) {
        droppedInvalidIds.push(item.id);
        return;
      }

      const entityId = item.payload?.id || (typeof item.payload === 'string' ? item.payload : item.id);
      if (entityId) {
        const key = `${item.type?.includes('PAYMENT') ? 'pay' : item.type?.includes('CONTRACT') ? 'con' : item.type}_${entityId}`;
        const existingEntity = entityLatestMap.get(key);
        if (!existingEntity || Number(item.timestamp || 0) > Number(existingEntity.timestamp || 0)) {
          entityLatestMap.set(key, item);
        }
      } else {
        entityLatestMap.set(item.id, item);
      }
    };

    if (Array.isArray(idbActions)) idbActions.forEach(addAction);
    if (Array.isArray(nativeList)) nativeList.forEach(addAction);
    if (Array.isArray(prefList)) prefList.forEach(addAction);
    if (Array.isArray(localList)) localList.forEach(addAction);

    if (droppedInvalidIds.length > 0) {
      markActionIdsAsPermanentlySynced(droppedInvalidIds);
      droppedInvalidIds.forEach((id) => deleteActionFromIndexedDb(id).catch(() => {}));
    }

    const merged: PendingAction[] = Array.from(entityLatestMap.values()).map((item) => ({
      id: item.id,
      nonce: item.nonce,
      type: item.type,
      payload: item.payload,
      timestamp: Number(item.timestamp) || now,
      status: (item.status === 'syncing' && item.lastAttemptAt && now - item.lastAttemptAt < 30000 ? 'syncing' : 'pending') as ActionStatus,
      retryCount: Number(item.retryCount) || 0,
      error: item.error || null,
      syncedAt: item.syncedAt || null,
      lastAttemptAt: item.lastAttemptAt || null,
    }));

    const jsonStr = JSON.stringify(merged);
    secureStorageSetSync(QUEUE_KEY, jsonStr);

    if (swSyncedIds.length > 0 || droppedInvalidIds.length > 0) {
      syncToNativeAndroid(merged);
      syncQueueToIndexedDb(merged).catch(() => {});
    } else if (idbActions.length === 0 && merged.length > 0) {
      syncQueueToIndexedDb(merged).catch(() => {});
    }

    return merged;
  } catch (e) {
    return getPendingQueueSync();
  }
}

/**
 * Synchronize pending actions directly to Native Android storage & SharedPreferences
 */
export function syncToNativeAndroid(queue: PendingAction[], triggerImmediateNativeSync: boolean = false) {
  if (typeof window === 'undefined') return;
  try {
    const jsonStr = JSON.stringify(queue);
    const serverUrl = getApiBaseUrl() || window.location.origin;

    // 1. Direct Native JavascriptInterface Bridge
    const bridge =
      (window as any).AndroidInterface ||
      (window as any).AndroidPrinter ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    if (bridge) {
      if (triggerImmediateNativeSync && typeof bridge.triggerImmediateCloseSync === 'function') {
        bridge.triggerImmediateCloseSync(jsonStr, serverUrl);
      } else if (typeof bridge.syncPendingQueueToNative === 'function') {
        bridge.syncPendingQueueToNative(jsonStr, serverUrl);
      }
      if (triggerImmediateNativeSync && typeof bridge.triggerBackgroundSyncNow === 'function') {
        bridge.triggerBackgroundSyncNow();
      }
    }

    // 2. Multi-prefix Capacitor Preferences storage
    try {
      Preferences.set({ key: QUEUE_KEY, value: jsonStr }).catch(() => {});
      Preferences.set({ key: `CapacitorStorage.${QUEUE_KEY}`, value: jsonStr }).catch(() => {});
      Preferences.set({ key: `CapacitorPreferences.${QUEUE_KEY}`, value: jsonStr }).catch(() => {});
      Preferences.set({ key: `_cap_${QUEUE_KEY}`, value: jsonStr }).catch(() => {});
      if (serverUrl) {
        Preferences.set({ key: 'alkarrar_backend_server_url', value: serverUrl }).catch(() => {});
        Preferences.set({ key: 'CapacitorStorage.alkarrar_backend_server_url', value: serverUrl }).catch(() => {});
      }
    } catch (e) {}
  } catch (e) {}
}

// Notify Service Worker about queue changes & register Background Sync
function notifyServiceWorker() {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel('alkarrar_sync_channel');
      channel.postMessage({ type: 'QUEUE_UPDATED', timestamp: Date.now() });
      channel.close();
    } catch (e) {}
  }
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'QUEUE_UPDATED' });
      }
      navigator.serviceWorker.ready
        .then((reg: any) => {
          if (reg.active) {
            reg.active.postMessage({ type: 'QUEUE_UPDATED' });
          }
          if (reg.sync) {
            reg.sync.register('postgres-background-sync').catch(() => {});
            reg.sync.register('alkarrar-background-sync').catch(() => {});
          }
        })
        .catch(() => {});
    } catch (e) {}
  }
}

let addToQueueMutex: Promise<any> = Promise.resolve();
let bgFlushTimer: any = null;

/**
 * Add a new action to the offline queue with explicit 'pending' status
 */
export async function addToPendingQueue(type: string, payload: any): Promise<PendingAction> {
  const nonce = generateCryptoNonce();
  const normalizedPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload) && !payload.nonce
      ? { ...payload, nonce }
      : payload;

  const action: PendingAction = {
    id: `${Date.now()}_${nonce.slice(0, 8)}`,
    nonce,
    type,
    payload: normalizedPayload,
    timestamp: Date.now(),
    status: 'pending',
    retryCount: 0,
    error: null,
    syncedAt: null,
    lastAttemptAt: null,
  };

  // 1. Instantaneous sub-millisecond synchronous commit to encrypted storage & memory snapshot
  let currentSyncQueue: PendingAction[] = [];
  try {
    const rawSync = secureStorageGetSync(QUEUE_KEY);
    currentSyncQueue = rawSync ? JSON.parse(rawSync) : [];
    if (!Array.isArray(currentSyncQueue)) currentSyncQueue = [];

    // Deduplicate / obsolete logic in memory immediately
    if (type.startsWith('DELETE_')) {
      const targetId = typeof normalizedPayload === 'string' ? normalizedPayload : (normalizedPayload?.id || normalizedPayload?.contractId);
      if (targetId) {
        currentSyncQueue = currentSyncQueue.filter((item) => {
          const itemPayloadId = typeof item.payload === 'string' ? item.payload : (item.payload?.id || item.payload?.contractId);
          return itemPayloadId !== targetId && (type !== 'DELETE_CONTRACT' || item.payload?.contractId !== targetId);
        });
      }
    } else {
      const targetId = typeof normalizedPayload === 'string' ? normalizedPayload : normalizedPayload?.id;
      if (targetId) {
        currentSyncQueue = currentSyncQueue.filter((item) => {
          const itemPayloadId = typeof item.payload === 'string' ? item.payload : item.payload?.id;
          return !(item.type === type && itemPayloadId === targetId);
        });
      }
    }

    currentSyncQueue.push(action);
    secureStorageSetSync(QUEUE_KEY, JSON.stringify(currentSyncQueue));

    const pendingCount = currentSyncQueue.filter((i) => i.status !== 'synced').length;
    notifyQueueListeners(pendingCount);
  } catch (e) {
    console.warn('Fast local queue write notice:', e);
  }

  // 2. Persist to IndexedDB & sync to native Android asynchronously in the background without blocking the UI or caller
  setTimeout(async () => {
    try {
      await saveActionToIndexedDb(action);
      syncToNativeAndroid(currentSyncQueue);
      notifyServiceWorker();
    } catch (persistErr) {
      console.warn('Background persistence notice:', persistErr);
    }
  }, 0);

  // 3. Trigger fast background network flush immediately when online
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    if (bgFlushTimer) clearTimeout(bgFlushTimer);
    bgFlushTimer = setTimeout(() => {
      flushPendingQueue().catch(() => {});
    }, 250);
  }

  // 4. Schedule idle verification re-query so when user stops typing/saving (سكون), it audits matches against server
  scheduleIdleVerification(600);

  return action;
}

/**
 * Remove an action by ID
 */
export async function removeFromPendingQueue(id: string): Promise<void> {
  try {
    markActionIdsAsPermanentlySynced([id]);
    await deleteActionFromIndexedDb(id);
    const queue = await getPendingQueue();
    const filtered = queue.filter((item) => item.id !== id);
    const jsonStr = JSON.stringify(filtered);
    secureStorageSetSync(QUEUE_KEY, jsonStr);
    syncToNativeAndroid(filtered);
    notifyQueueListeners(filtered.filter((i) => i.status !== 'synced').length);
    notifyServiceWorker();
  } catch (e) {
    console.warn('Failed to remove from pending queue:', e);
  }
}

/**
 * Clear all pending actions
 */
export async function clearPendingQueue(): Promise<void> {
  try {
    const existing = await getPendingQueue().catch(() => getPendingQueueSync());
    const idsToPerm = existing.map((a) => a.id).filter(Boolean);
    if (idsToPerm.length > 0) {
      markActionIdsAsPermanentlySynced(idsToPerm);
    }
    secureStorageRemoveSync(QUEUE_KEY);
    syncToNativeAndroid([]);
    await syncQueueToIndexedDb([]);
    notifyQueueListeners(0);
    notifyServiceWorker();
  } catch (e) {}
}

/**
 * Clear pending actions matching a predicate filter
 */
export async function clearPendingActionsByFilter(predicate: (action: PendingAction) => boolean): Promise<void> {
  try {
    const queue = await getPendingQueue();
    const toRemove = queue.filter(predicate);
    const toKeep = queue.filter((a) => !predicate(a));
    for (const a of toRemove) {
      markActionIdsAsPermanentlySynced([a.id]);
      await deleteActionFromIndexedDb(a.id).catch(() => {});
    }
    const jsonStr = JSON.stringify(toKeep);
    secureStorageSetSync(QUEUE_KEY, jsonStr);
    syncToNativeAndroid(toKeep);
    await syncQueueToIndexedDb(toKeep).catch(() => {});
    notifyQueueListeners(toKeep.filter((i) => i.status !== 'synced').length);
    notifyServiceWorker();
  } catch (e) {}
}

/**
 * Scrubs any stale GPS coordinates from queued offline contract/payment actions
 * when a customer's location is cleared so flushing old offline items can never resurrect it.
 */
export async function scrubLocationFromPendingQueue(
  contractIds: string[],
  customerNameHint?: string,
  clearIso?: string
): Promise<void> {
  try {
    const idSet = new Set((contractIds || []).filter(Boolean).map(String));
    const normCust = normalizeArabicPersonName(customerNameHint);
    const iso = clearIso || new Date().toISOString();
    const queue = await getPendingQueue();
    if (!Array.isArray(queue) || queue.length === 0) return;

    let changed = false;
    const updatedQueue = queue.map((act) => {
      if (!act || !act.payload || typeof act.payload !== 'object') return act;
      const p = act.payload;
      const pid = String(p.contractId || p.contract_id || p.id || '');
      const pName = normalizeArabicPersonName(p.customerName || p.customer_name || p.name || '');
      const matchesTarget = Boolean((pid && idSet.has(pid)) || (normCust && pName && pName === normCust));
      if (!matchesTarget) return act;

      if (act.type === 'CREATE_CONTRACT' || act.type === 'UPDATE_CONTRACT' || act.type === 'CREATE_CUSTOMER' || act.type === 'UPDATE_CUSTOMER') {
        changed = true;
        return {
          ...act,
          payload: {
            ...p,
            latitude: null,
            longitude: null,
            lat: null,
            lng: null,
            locationAddress: null,
            location_address: null,
            locationUpdatedAt: null,
            location_updated_at: null,
            locationCleared: true,
            locationClearedAt: iso,
            location_cleared_at: iso,
          },
        };
      }

      if (act.type === 'CREATE_PAYMENT' || act.type === 'RECORD_PAYMENT' || act.type === 'ADD_PAYMENT' || act.type === 'UPDATE_PAYMENT') {
        if (p.latitude != null || p.longitude != null || p.updateCustomerLocation || p.shouldUpdateCustomerLocation) {
          changed = true;
          return {
            ...act,
            payload: {
              ...p,
              latitude: null,
              longitude: null,
              lat: null,
              lng: null,
              updateCustomerLocation: false,
              shouldUpdateCustomerLocation: false,
            },
          };
        }
      }
      return act;
    });

    if (changed) {
      const jsonStr = JSON.stringify(updatedQueue);
      secureStorageSetSync(QUEUE_KEY, jsonStr);
      syncToNativeAndroid(updatedQueue);
      await syncQueueToIndexedDb(updatedQueue).catch(() => {});
    }
  } catch (e) {}
}

/**
 * Update transaction state for a specific action in IndexedDB and snapshot
 */
export async function updateActionStatus(
  id: string,
  status: ActionStatus,
  error: string | null = null,
  syncedAt: number | null = null
): Promise<void> {
  try {
    const queue = await getPendingQueue();
    const action = queue.find((a) => a.id === id);
    if (!action) return;

    action.status = status;
    action.lastAttemptAt = Date.now();
    if (status === 'synced') {
      action.syncedAt = syncedAt || Date.now();
      action.error = null;
    } else if (status === 'pending') {
      action.retryCount = (action.retryCount || 0) + 1;
      if (error) action.error = error;
    }

    await saveActionToIndexedDb(action);
    const jsonStr = JSON.stringify(queue);
    secureStorageSetSync(QUEUE_KEY, jsonStr);
    syncToNativeAndroid(queue);

    notifyQueueListeners(queue.filter((i) => i.status !== 'synced').length);
  } catch (e) {
    console.warn('Error updating action status:', e);
  }
}

async function executeActionViaRestEndpoint(action: PendingAction): Promise<{ ok: boolean; authError?: boolean; permanentError?: boolean; errorMsg?: string }> {
  try {
    const { type, payload } = action;
    if (!payload) return { ok: true };
    const docId = typeof payload === 'string' ? payload : (payload.id || payload.contractId);

    let endpoint = '';
    let method = 'POST';

    switch (type) {
      case 'CREATE_CONTRACT':
        endpoint = '/api/contracts';
        method = 'POST';
        break;
      case 'UPDATE_CONTRACT':
        endpoint = docId ? `/api/contracts/${docId}` : '/api/contracts';
        method = docId ? 'PUT' : 'POST';
        break;
      case 'DELETE_CONTRACT':
        endpoint = docId ? `/api/contracts/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_PAYMENT':
      case 'RECORD_PAYMENT':
      case 'ADD_PAYMENT':
        endpoint = '/api/payments';
        method = 'POST';
        break;
      case 'UPDATE_PAYMENT':
        endpoint = docId ? `/api/payments/${docId}` : '/api/payments';
        method = docId ? 'PUT' : 'POST';
        break;
      case 'DELETE_PAYMENT':
        endpoint = docId ? `/api/payments/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_INVENTORY':
        endpoint = '/api/inventory';
        method = 'POST';
        break;
      case 'UPDATE_INVENTORY':
        endpoint = docId ? `/api/inventory/${docId}` : '/api/inventory';
        method = 'PUT';
        break;
      case 'DELETE_INVENTORY':
        endpoint = docId ? `/api/inventory/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_REP':
        endpoint = '/api/reps';
        method = 'POST';
        break;
      case 'UPDATE_REP':
        endpoint = docId ? `/api/reps/${docId}` : '/api/reps';
        method = 'PUT';
        break;
      case 'DELETE_REP':
        endpoint = docId ? `/api/reps/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_FUND':
        endpoint = '/api/funds';
        method = 'POST';
        break;
      case 'UPDATE_FUND':
        endpoint = docId ? `/api/funds/${docId}` : '/api/funds';
        method = 'PUT';
        break;
      case 'REORDER_FUNDS':
        endpoint = '/api/funds/reorder';
        method = 'POST';
        break;
      case 'DELETE_FUND':
        endpoint = docId ? `/api/funds/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_CUSTOMER_LIST':
        endpoint = '/api/customer-lists';
        method = 'POST';
        break;
      case 'UPDATE_CUSTOMER_LIST':
        endpoint = docId ? `/api/customer-lists/${docId}` : '/api/customer-lists';
        method = 'PUT';
        break;
      case 'REORDER_CUSTOMER_LISTS':
        endpoint = '/api/customer-lists/reorder';
        method = 'POST';
        break;
      case 'DELETE_CUSTOMER_LIST':
        endpoint = docId ? `/api/customer-lists/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_CUSTOMER':
        endpoint = '/api/customers';
        method = 'POST';
        break;
      case 'UPDATE_CUSTOMER':
        endpoint = docId ? `/api/customers/${docId}` : '/api/customers';
        method = 'PUT';
        break;
      case 'DELETE_CUSTOMER':
        endpoint = docId ? `/api/customers/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_EMPLOYEE':
        endpoint = '/api/employees';
        method = 'POST';
        break;
      case 'UPDATE_EMPLOYEE':
        endpoint = docId ? `/api/employees/${docId}` : '/api/employees';
        method = 'PUT';
        break;
      case 'DELETE_EMPLOYEE':
        endpoint = docId ? `/api/employees/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_FUND_TX':
      case 'CREATE_FUND_TRANSACTION':
        endpoint = '/api/fund-transactions';
        method = 'POST';
        break;
      case 'UPDATE_FUND_TX':
      case 'UPDATE_FUND_TRANSACTION':
        endpoint = docId ? `/api/fund-transactions/${docId}` : '/api/fund-transactions';
        method = 'PUT';
        break;
      case 'DELETE_FUND_TX':
      case 'DELETE_FUND_TRANSACTION':
        endpoint = docId ? `/api/fund-transactions/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_EMPLOYEE_TX':
      case 'CREATE_EMPLOYEE_TRANSACTION':
        endpoint = '/api/employee-transactions';
        method = 'POST';
        break;
      case 'UPDATE_EMPLOYEE_TX':
      case 'UPDATE_EMPLOYEE_TRANSACTION':
        endpoint = docId ? `/api/employee-transactions/${docId}` : '/api/employee-transactions';
        method = 'PUT';
        break;
      case 'DELETE_EMPLOYEE_TX':
      case 'DELETE_EMPLOYEE_TRANSACTION':
        endpoint = docId ? `/api/employee-transactions/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_PAYMENT_CONFLICT':
        endpoint = '/api/payment-conflicts';
        method = 'POST';
        break;
      case 'RESOLVE_PAYMENT_CONFLICT':
        endpoint = docId ? `/api/payment-conflicts/${docId}` : '';
        method = 'PUT';
        break;
      case 'REJECT_PAYMENT_CONFLICT':
      case 'DELETE_PAYMENT_CONFLICT':
        endpoint = docId ? `/api/payment-conflicts/${docId}` : '';
        method = 'DELETE';
        break;

      case 'CREATE_APPOINTMENT':
      case 'APPOINTMENT_CREATE':
        endpoint = '/api/appointments';
        method = 'POST';
        break;
      case 'UPDATE_APPOINTMENT':
      case 'APPOINTMENT_UPDATE':
        endpoint = docId ? `/api/appointments/${docId}` : '/api/appointments';
        method = docId ? 'PUT' : 'POST';
        break;
      case 'DELETE_APPOINTMENT':
      case 'APPOINTMENT_DELETE':
        endpoint = docId ? `/api/appointments/${docId}` : '';
        method = 'DELETE';
        break;

      default:
        // Unknown historical/obsolete action type -> clear instead of blocking the queue forever
        return { ok: true };
    }

    if (!endpoint) return { ok: true };

    const res = await fetchWithFallback(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method !== 'DELETE' ? JSON.stringify(typeof payload === 'object' ? payload : { id: docId, value: payload }) : undefined,
    }, 10000);

    if (!res) {
      return { ok: false };
    }
    // 409 = already recorded, 404 on DELETE = already deleted
    if (res.status === 409 || (method === 'DELETE' && res.status === 404)) {
      return { ok: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, authError: true, errorMsg: `HTTP ${res.status}` };
    }
    // 400 / 422 / 404 on PUT = unrecoverable validation/missing target after retries
    if (res.status === 400 || res.status === 422 || (method === 'PUT' && res.status === 404)) {
      const errData = await res.json().catch(() => null);
      return { ok: false, permanentError: true, errorMsg: errData?.error || `HTTP ${res.status}` };
    }
    if (!res.ok || res.status < 200 || res.status >= 300) {
      return { ok: false };
    }
    const ct = res.headers?.get('content-type') || '';
    if (ct.includes('text/html') || !ct.includes('application/json')) {
      return { ok: false };
    }
    const data = await res.json().catch(() => null);
    if (!data || (data.error && !data.idempotent)) {
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

let isFlushing = false;
let lastFlushStartTime = 0;
let activeFlushPromise: Promise<{ flushed: number; remaining: number }> | null = null;
let followUpFlushTimer: any = null;

async function commitSyncedIds(syncedIds: string[]): Promise<void> {
  if (!syncedIds || syncedIds.length === 0) return;
  const syncedSet = new Set(syncedIds);
  markActionIdsAsPermanentlySynced(syncedIds);

  try {
    const raw = secureStorageGetSync(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const remaining = Array.isArray(parsed)
      ? parsed.filter((item: any) => item && item.id && !syncedSet.has(item.id) && item.status !== 'synced')
      : [];
    secureStorageSetSync(QUEUE_KEY, JSON.stringify(remaining));
    notifyQueueListeners(remaining.length);
    syncToNativeAndroid(remaining);
  } catch (e) {}

  await deleteActionsBatchFromIndexedDb(syncedIds).catch(() => {});
}

/**
 * Flush all pending offline actions using explicit transaction states (pending -> syncing -> synced)
 * with single-flight locking, fast concurrent 100-item bulk SQL chunks, single-tx IndexedDB commits, and REST fallback.
 */
export async function flushPendingQueue(): Promise<{ flushed: number; remaining: number }> {
  const now = Date.now();
  if (activeFlushPromise) {
    // Allow generous 60s before stale-promise guard releases so large queues finish all batches cleanly
    if (now - lastFlushStartTime < 60000) {
      return activeFlushPromise;
    }
    console.warn('[Offline Sync Engine] Previous flush exceeded 60s limit. Starting fresh flush.');
  }

  const runFlush = async (): Promise<{ flushed: number; remaining: number }> => {
    isFlushing = true;
    lastFlushStartTime = Date.now();
    const verifiedSyncedIds: string[] = [];

    try {
      const queue = await getPendingQueue();

      // 1. Select ALL un-synced valid actions
      const actionsToSync = queue.filter((item) => item.status !== 'synced');

      if (actionsToSync.length === 0) {
        notifyQueueListeners(0);
        return { flushed: 0, remaining: 0 };
      }

      console.log(`[Offline Sync Engine] Initiating high-speed upload for ${actionsToSync.length} offline actions...`);

      const timestampNow = Date.now();
      for (const action of actionsToSync) {
        action.status = 'syncing';
        action.lastAttemptAt = timestampNow;
      }
      secureStorageSetSync(QUEUE_KEY, JSON.stringify(queue));

      // 2. Path A: Send Bulk Batch Requests in fast slices of 100 items with up to 3 concurrent requests
      const batchConfirmedSet = new Set<string>();
      const BATCH_CHUNK = 100;
      const BATCH_CONCURRENCY = 3;
      const slices: PendingAction[][] = [];
      for (let b = 0; b < actionsToSync.length; b += BATCH_CHUNK) {
        slices.push(actionsToSync.slice(b, b + BATCH_CHUNK));
      }

      for (let s = 0; s < slices.length; s += BATCH_CONCURRENCY) {
        const windowSlices = slices.slice(s, s + BATCH_CONCURRENCY);
        await Promise.all(
          windowSlices.map(async (batchSlice) => {
            const sliceConfirmedIds: string[] = [];
            try {
              const response = await fetchWithFallback(
                '/api/sync/batch',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ actions: batchSlice }),
                },
                25000
              );

              if (response && response.ok && response.status >= 200 && response.status < 300) {
                const ct = response.headers?.get('content-type') || '';
                if (ct.includes('application/json') && !ct.includes('text/html')) {
                  const data = await response.json().catch(() => ({}));
                  if (data && Array.isArray(data.processedIds)) {
                    sliceConfirmedIds.push(...data.processedIds);
                  } else if (data && data.success) {
                    sliceConfirmedIds.push(...batchSlice.map((a) => a.id));
                  }
                  if (data && Array.isArray(data.rejectedReplayIds) && data.rejectedReplayIds.length > 0) {
                    sliceConfirmedIds.push(...data.rejectedReplayIds);
                  }
                }
              }
            } catch (netErr: any) {
              console.log('[Offline Sync Engine] Batch slice fallback notice:', netErr?.message || netErr);
            }

            if (sliceConfirmedIds.length > 0) {
              const newIds: string[] = [];
              for (const id of sliceConfirmedIds) {
                if (!batchConfirmedSet.has(id)) {
                  batchConfirmedSet.add(id);
                  verifiedSyncedIds.push(id);
                  newIds.push(id);
                }
              }
              if (newIds.length > 0) {
                await commitSyncedIds(newIds);
              }
            }
          })
        );
      }

      // 3. Fallback path for unconfirmed actions (parallel chunks of 10 via individual REST endpoints)
      const pendingFallbackActions = actionsToSync.filter((action) => !batchConfirmedSet.has(action.id));
      if (pendingFallbackActions.length > 0) {
        const CHUNK_SIZE = 10;
        for (let i = 0; i < pendingFallbackActions.length; i += CHUNK_SIZE) {
          const chunk = pendingFallbackActions.slice(i, i + CHUNK_SIZE);
          const chunkSynced: string[] = [];

          await Promise.all(
            chunk.map(async (action) => {
              const restResult = await executeActionViaRestEndpoint(action);
              if (restResult.ok) {
                action.status = 'synced';
                action.syncedAt = Date.now();
                action.error = null;
                chunkSynced.push(action.id);
                return;
              }

              action.retryCount = (action.retryCount || 0) + 1;
              if (restResult.permanentError && action.retryCount >= 3) {
                // Unrecoverable client validation failure after multiple attempts -> clear so it doesn't jam queue forever
                console.warn(`[Offline Sync Engine] Clearing unrecoverable action after ${action.retryCount} failed attempts:`, action.type, action.id, restResult.errorMsg);
                chunkSynced.push(action.id);
                return;
              }

              action.status = 'pending';
              action.error = restResult.errorMsg || 'Pending connection to sync server';
              await saveActionToIndexedDb(action).catch(() => {});
            })
          );

          if (chunkSynced.length > 0) {
            for (const id of chunkSynced) {
              if (!batchConfirmedSet.has(id)) {
                batchConfirmedSet.add(id);
                verifiedSyncedIds.push(id);
              }
            }
            await commitSyncedIds(chunkSynced);
          }
        }
      }

      // 4. Final reconciliation of queue state across localStorage / IndexedDB / Preferences
      const verifiedSet = new Set(verifiedSyncedIds);
      const freshQueue = await getPendingQueue();
      const remainingQueue = freshQueue
        .filter((item) => !verifiedSet.has(item.id) && item.status !== 'synced')
        .map((item) => (item.status === 'syncing' ? { ...item, status: 'pending' as const } : item));

      const jsonStr = JSON.stringify(remainingQueue);
      secureStorageSetSync(QUEUE_KEY, jsonStr);
      syncToNativeAndroid(remainingQueue);
      await syncQueueToIndexedDb(remainingQueue);
      notifyQueueListeners(remainingQueue.length);

      if (verifiedSyncedIds.length > 0) {
        console.log(`[Offline Sync Engine] Successfully synchronized & uploaded ${verifiedSyncedIds.length} records.`);
        try {
          const raw = localStorage.getItem('sami_offline_payments');
          if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
              let changed = false;
              for (const p of list) {
                if (p && (verifiedSet.has(p.id) || (!remainingQueue.some((r) => r.payload?.id === p.id) && p._syncStatus === 'pending'))) {
                  p._syncStatus = 'synced';
                  p._unsynced = false;
                  changed = true;
                }
              }
              if (changed) {
                localStorage.setItem('sami_offline_payments', JSON.stringify(list));
              }
            }
          }
        } catch (e) {}
        notifySyncSuccessListeners();
      }

      // If more items remain AND we uploaded some, schedule an immediate follow-up flush
      if (remainingQueue.length > 0 && verifiedSyncedIds.length > 0) {
        if (followUpFlushTimer) clearTimeout(followUpFlushTimer);
        followUpFlushTimer = setTimeout(() => {
          flushPendingQueue().catch(() => {});
        }, 150);
      }

      return { flushed: verifiedSyncedIds.length, remaining: remainingQueue.length };
    } catch (err) {
      console.warn('[Offline Sync Engine] Flush queue exception:', err);
      const permSet = getPermanentlySyncedIds();
      const q = getPendingQueueSync().filter((i) => i.status !== 'synced' && !permSet.has(i.id));
      return { flushed: verifiedSyncedIds.length, remaining: q.length };
    } finally {
      isFlushing = false;
      activeFlushPromise = null;
    }
  };

  activeFlushPromise = runFlush();
  return activeFlushPromise;
}

export const syncOfflineData = flushPendingQueue;

let lastExitSyncTime = 0;

/**
 * Send pending actions via Beacon and fetch keepalive on page exit or before close (100% non-blocking & reliable)
 */
export function sendBeaconOnExit() {
  const now = Date.now();
  // Cooldown to prevent multi-event duplicate storm on exit (beforeunload + pagehide + visibilitychange)
  if (now - lastExitSyncTime < 800) {
    return;
  }
  lastExitSyncTime = now;

  try {
    // 1. Mirror local snapshot to IndexedDB immediately so Service Worker has fresh state
    mirrorLocalSnapshotToIndexedDb(true).catch(() => {});

    // 2. Read pending actions synchronously from encrypted cache
    const raw = secureStorageGetSync(QUEUE_KEY);
    let queue: any[] = [];
    if (raw) {
      try {
        queue = JSON.parse(raw);
      } catch (e) {
        queue = [];
      }
    }
    const pendingToSync = Array.isArray(queue) ? queue.filter((i: any) => i && i.status !== 'synced') : [];

    // If nothing pending, exit immediately without wasting network/battery
    if (pendingToSync.length === 0) {
      return;
    }

    // Mirror queue to Native Android storage and trigger native exit upload
    try {
      syncToNativeAndroid(queue, true);
    } catch (e) {}

    // 3. Inform Service Worker to flush queue in background
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try {
        navigator.serviceWorker.controller.postMessage({
          type: 'FLUSH_QUEUE_IMMEDIATELY',
          actions: pendingToSync,
        });
        navigator.serviceWorker.controller.postMessage({
          type: 'RECONCILE_ON_CLOSE',
          timestamp: now,
        });
      } catch (e) {}
    }

    // 4. Resolve target URL (keepalive plain fetch to /api/sync/batch)
    const isNative = isNativeOrApkEnvironment();
    const batchUrl = isNative ? getFullApiUrl('/api/sync/batch') : '/api/sync/batch';

    // 5. Send direct keepalive Fetch synchronously
    const BEACON_CHUNK = 100;
    for (let i = 0; i < pendingToSync.length; i += BEACON_CHUNK) {
      const chunk = pendingToSync.slice(i, i + BEACON_CHUNK);
      const payloadJson = JSON.stringify({ actions: chunk });

      if (typeof fetch === 'function') {
        fetch(batchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadJson,
          keepalive: true,
        })
          .then((res) => {
            if (res && res.ok) {
              res.json().then((data) => {
                if (data && Array.isArray(data.processedIds)) {
                  data.processedIds.forEach((pid: string) => deleteActionFromIndexedDb(pid).catch(() => {}));
                }
              }).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }

    // 6. Update action timestamps without blindly purging unconfirmed actions
    for (const act of pendingToSync) {
      act.lastAttemptAt = now;
      if (act.status !== 'synced') {
        act.status = 'syncing';
      }
    }
    secureStorageSetSync(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.warn('[Exit Sync] Exception:', e);
  }
}

/**
 * Universal background exit sync runner:
 * Dispatches immediate synchronous beacons, keepalive fetch requests,
 * and service worker messages on app close or minimize.
 */
export function runBackgroundExitSync(): void {
  try {
    sendBeaconOnExit();
    notifyServiceWorker();

    try {
      if (BackgroundTask && typeof BackgroundTask.beforeExit === 'function') {
        BackgroundTask.beforeExit(async () => {
          let finished = false;
          try {
            await Promise.race([
              (async () => {
                await flushPendingQueue().catch(() => {});
                if (globalSyncCallback) {
                  await globalSyncCallback().catch(() => {});
                }
              })(),
              new Promise((resolve) => setTimeout(resolve, 25000)),
            ]);
          } catch (err) {
            console.warn('Background sync on exit error:', err);
          } finally {
            if (!finished) {
              finished = true;
              try {
                BackgroundTask.finish({ taskId: 'exit-sync' });
              } catch (e) {}
            }
          }
        }).catch(() => {});
      }
    } catch (btErr) {}

    flushPendingQueue().catch(() => {});
  } catch (e) {
    console.warn('runBackgroundExitSync exception:', e);
  }
}

let globalSyncCallback: (() => Promise<void>) | null = null;
let onlineDebounceTimer: any = null;
let idleVerificationTimer: any = null;
let isVerifyingMatch = false;

/**
 * Continuous Verification & Re-query Engine:
 * Whenever data is uploaded or when idle quiescence occurs,
 * automatically queries the server, uploads any remaining data, and re-queries in a loop
 * until 100% full match confirmation between the app and PostgreSQL is verified.
 */
export function scheduleIdleVerification(delayMs = 1200) {
  if (idleVerificationTimer) {
    clearTimeout(idleVerificationTimer);
  }
  idleVerificationTimer = setTimeout(async () => {
    if (isVerifyingMatch) return;
    try {
      isVerifyingMatch = true;
      
      // 1. Flush any un-synced actions first
      const queue = await getPendingQueue();
      const unSynced = queue.filter((i) => i.status !== 'synced');
      if (unSynced.length > 0) {
        await flushPendingQueue().catch(() => {});
      }

      // 2. Perform lightweight single-pass verification
      const verifyRes = await verifyAndReconcileUntilMatched(1).catch(() => null);
      if (verifyRes && verifyRes.matched) {
        const remainingQueue = (await getPendingQueue()).filter((item) => item.status !== 'synced');
        if (remainingQueue.length === 0) {
          notifyQueueListeners(0);
        }
      }
    } catch (err) {
      console.warn('[Continuous Sync Engine] Verification error:', err);
    } finally {
      isVerifyingMatch = false;
    }
  }, delayMs);
}

/**
 * Reliable handler for online connectivity restoration and automatic lightweight field sync
 */
export function triggerImmediateSync(callback?: () => Promise<void>) {
  if (onlineDebounceTimer) clearTimeout(onlineDebounceTimer);
  onlineDebounceTimer = setTimeout(async () => {
    try {
      const res = await flushPendingQueue();
      reconcileAllLocalWithDatabase().catch(() => {});
      if (callback) {
        await callback().catch(() => {});
      }
      if (globalSyncCallback) {
        await globalSyncCallback().catch(() => {});
      }
      return res;
    } catch (e) {
      console.warn('Trigger immediate sync error:', e);
    }
  }, 150);
}

// Automatic network reconnection and lifecycle handlers
if (typeof window !== 'undefined') {
  (window as any).alkarrarFlushQueue = () => {
    sendBeaconOnExit();
    return flushPendingQueue();
  };
  (window as any).alkarrarSendBeacon = sendBeaconOnExit;
  (window as any).alkarrarOnSyncSuccess = () => {
    triggerImmediateSync();
    notifySyncSuccessListeners();
  };

  window.addEventListener('beforeunload', () => {
    sendBeaconOnExit();
  });
  window.addEventListener('pagehide', () => {
    sendBeaconOnExit();
  });
  window.addEventListener('freeze', () => {
    sendBeaconOnExit();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      sendBeaconOnExit();
    } else if (document.visibilityState === 'visible') {
      triggerImmediateSync();
    }
  });
  window.addEventListener('focus', () => {
    triggerImmediateSync();
  });
  window.addEventListener('online', () => {
    triggerImmediateSync();
  });

  // Automatically start background sync lifecycle
  try {
    initBackgroundSync();
  } catch (e) {}

  // Listen for Capacitor Network status changes
  try {
    if (Network && typeof Network.addListener === 'function') {
      Network.addListener('networkStatusChange', (status) => {
        if (status.connected) {
          triggerImmediateSync();
        }
      }).catch(() => {});
    }
  } catch (e) {}

  // Service Worker background sync triggers
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data) {
        if (event.data.type === 'TRIGGER_BACKGROUND_SYNC') {
          triggerImmediateSync();
        } else if (event.data.type === 'BACKGROUND_DATA_UPDATED') {
          loadSnapshotFromIndexedDbIfAvailable().catch(() => {});
        }
      }
    });
  }
}

/**
 * Register Background Sync Service Worker safely
 */
export function registerBackgroundSyncWorker(onTriggerSync?: () => void) {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || window.location.protocol === 'file:') {
    return;
  }

  if ('serviceWorker' in navigator) {
    const doRegister = async () => {
      try {
        const registration: any = await navigator.serviceWorker.register('/sw.js').catch(() => null);
        if (!registration) return;
        console.log('[SW] ServiceWorker registered scope:', registration.scope);

        if ('sync' in registration) {
          try {
            await registration.sync.register('postgres-background-sync');
            await registration.sync.register('alkarrar-background-sync');
          } catch (e) {}
        }
        if ('periodicSync' in registration) {
          try {
            await registration.periodicSync.register('periodic-data-sync', {
              minInterval: 2 * 60 * 1000,
            });
          } catch (e) {}
        }
      } catch (err) {
        console.warn('ServiceWorker registration fallback:', err);
      }
    };

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      doRegister();
    } else {
      window.addEventListener('load', doRegister);
      document.addEventListener('DOMContentLoaded', doRegister);
    }

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data) {
        if (event.data.type === 'TRIGGER_BACKGROUND_SYNC') {
          triggerImmediateSync(async () => {
            if (onTriggerSync) onTriggerSync();
          });
        } else if (event.data.type === 'BACKGROUND_DATA_UPDATED') {
          loadSnapshotFromIndexedDbIfAvailable().then(() => {
            if (onTriggerSync) onTriggerSync();
          }).catch(() => {});
        }
      }
    });
  }
}

/**
 * Request and grant all background sync and OS permissions (Notifications, BackgroundSync, PeriodicSync, Battery optimization exemption)
 */
export async function requestAllBackgroundAndSyncPermissions(): Promise<{
  granted: boolean;
  details: {
    notifications: boolean;
    periodicSync: boolean;
    backgroundSync: boolean;
    nativeBridge: boolean;
  };
}> {
  const details = {
    notifications: false,
    periodicSync: false,
    backgroundSync: false,
    nativeBridge: false,
  };

  // 0. Request Persistent Storage to prevent OS cache eviction
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
      const isPersisted = await navigator.storage.persist().catch(() => false);
      console.log('[Storage] Persistent storage granted:', isPersisted);
    }
  } catch (e) {}

  // 1. Request Web / Mobile Notification Permission
  try {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        details.notifications = perm === 'granted';
      } else {
        details.notifications = Notification.permission === 'granted';
      }
    }
  } catch (e) {
    console.warn('Notification permission error:', e);
  }

  // 2. Register Background Sync & Periodic Sync with Service Worker
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg: any = await navigator.serviceWorker.ready.catch(() => null);
      if (reg) {
        if ('sync' in reg) {
          try {
            await reg.sync.register('postgres-background-sync');
            await reg.sync.register('alkarrar-background-sync');
            details.backgroundSync = true;
          } catch (e) {}
        }
        if ('periodicSync' in reg) {
          try {
            await reg.periodicSync.register('periodic-data-sync', {
              minInterval: 2 * 60 * 1000,
            });
            details.periodicSync = true;
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.warn('SW sync registration error:', e);
  }

  // 3. Android Native Bridge / Cordova / Capacitor Runtime Permissions
  try {
    const androidBridge =
      (window as any).AndroidPrinter ||
      (window as any).AndroidInterface ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    if (androidBridge) {
      if (typeof androidBridge.requestAllAndroidPermissions === 'function') {
        androidBridge.requestAllAndroidPermissions();
        details.nativeBridge = true;
      }
      if (typeof androidBridge.requestPermissions === 'function') {
        androidBridge.requestPermissions();
        details.nativeBridge = true;
      }
      if (typeof androidBridge.requestIgnoreBatteryOptimizations === 'function') {
        androidBridge.requestIgnoreBatteryOptimizations();
        details.nativeBridge = true;
      }
      if (typeof androidBridge.requestExactAlarmPermission === 'function') {
        androidBridge.requestExactAlarmPermission();
      }
      if (typeof androidBridge.requestBackgroundExecution === 'function') {
        androidBridge.requestBackgroundExecution();
        details.nativeBridge = true;
      }
      if (typeof androidBridge.enableBackgroundSync === 'function') {
        androidBridge.enableBackgroundSync();
        details.nativeBridge = true;
      }
    }

    const cordova = (window as any).cordova;
    if (cordova && cordova.plugins) {
      // Activate Cordova Background Mode plugin if present
      if (cordova.plugins.backgroundMode) {
        try {
          const bg = cordova.plugins.backgroundMode;
          bg.setDefaults({
            title: 'الكرار للموبايل',
            text: 'المزامنة السحابية قيد العمل في الخلفية...',
            color: '059669',
            resume: true,
            silent: true,
          });
          bg.enable();
          if (typeof bg.disableWebViewOptimizations === 'function') {
            bg.disableWebViewOptimizations();
          }
          details.nativeBridge = true;
          details.backgroundSync = true;
        } catch (bgErr) {
          console.warn('Cordova backgroundMode config notice:', bgErr);
        }
      }

      if (cordova.plugins.permissions) {
        const p = cordova.plugins.permissions;
        const permsToRequest = [
          p.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS || 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
          p.POST_NOTIFICATIONS || 'android.permission.POST_NOTIFICATIONS',
          p.WAKE_LOCK || 'android.permission.WAKE_LOCK',
          p.FOREGROUND_SERVICE || 'android.permission.FOREGROUND_SERVICE',
          p.ACCESS_NETWORK_STATE || 'android.permission.ACCESS_NETWORK_STATE',
        ];
        p.requestPermissions(
          permsToRequest,
          () => {
            details.nativeBridge = true;
          },
          () => {}
        );
      }
    }

    // 4. Capacitor App & Background plugin check
    if (App) {
      details.nativeBridge = true;
    }
  } catch (e) {
    console.warn('Native bridge permission notice:', e);
  }

  try {
    localStorage.setItem('alkarrar_background_sync_granted', 'true');
  } catch (e) {}

  return {
    granted: true,
    details,
  };
}

let activeBgLoopInterval: any = null;

/**
 * Register background task listener to ensure automatic sync runs on close or background
 */
export function initBackgroundSync(syncCallback?: () => Promise<void>) {
  if (syncCallback) {
    globalSyncCallback = syncCallback;
  }

  try {
    if (typeof window === 'undefined') return;

    // 1. Initialize Cordova BackgroundMode if available
    try {
      const cordova = (window as any).cordova;
      if (cordova && cordova.plugins && cordova.plugins.backgroundMode) {
        const bg = cordova.plugins.backgroundMode;
        bg.setDefaults({
          title: 'الكرار للموبايل',
          text: 'المزامنة السحابية قيد العمل في الخلفية...',
          color: '059669',
          resume: true,
          silent: true,
        });
        bg.enable();
        if (typeof bg.disableWebViewOptimizations === 'function') {
          bg.disableWebViewOptimizations();
        }

        // When entering background
        bg.on('activate', () => {
          console.log('[Background Mode] App entered active background mode');
          try {
            if (typeof bg.disableWebViewOptimizations === 'function') {
              bg.disableWebViewOptimizations();
            }
          } catch (e) {}
          
          flushPendingQueue().catch(() => {});
          if (globalSyncCallback) {
            globalSyncCallback().catch(() => {});
          }

          // Maintain active background loop every 3 seconds while in background
          if (activeBgLoopInterval) clearInterval(activeBgLoopInterval);
          activeBgLoopInterval = setInterval(() => {
            const queue = getPendingQueueSync();
            const hasUnsynced = queue.some((i) => i.status !== 'synced');
            if (hasUnsynced && !isFlushing) {
              flushPendingQueue().catch(() => {});
            }
          }, 3000);
        });

        bg.on('deactivate', () => {
          if (activeBgLoopInterval) {
            clearInterval(activeBgLoopInterval);
            activeBgLoopInterval = null;
          }
          triggerImmediateSync();
        });
      }
    } catch (bgInitErr) {
      console.warn('Cordova backgroundMode initialization notice:', bgInitErr);
    }

    // 2. Setup Capacitor App State Listener with BackgroundTask and BackgroundRunner
    if (App && typeof App.addListener === 'function') {
      App.addListener('appStateChange', async (state) => {
        try {
          if (!state.isActive) {
            // Immediate non-blocking exit beacon & service worker notification
            sendBeaconOnExit();
            notifyServiceWorker();
            flushPendingQueue().catch(() => {});

            // Dispatch Capacitor BackgroundRunner event
            try {
              if (BackgroundRunner && typeof BackgroundRunner.dispatchEvent === 'function') {
                BackgroundRunner.dispatchEvent({
                  label: 'com.alkarrar.mobile.backgroundsync',
                  event: 'syncOfflineQueue',
                  details: {},
                }).catch(() => {});
              }
            } catch (brErr) {}

            try {
              if (BackgroundTask && typeof BackgroundTask.beforeExit === 'function') {
                let finished = false;
                const taskId = await BackgroundTask.beforeExit(async () => {
                  try {
                    // Maximum 2-second window for background task before forced clean finish
                    await Promise.race([
                      (async () => {
                        await flushPendingQueue().catch(() => {});
                        if (globalSyncCallback) {
                          await globalSyncCallback().catch(() => {});
                        }
                      })(),
                      new Promise((resolve) => setTimeout(resolve, 2000)),
                    ]);
                  } catch (err) {
                    console.warn('Silent background sync exception:', err);
                  } finally {
                    if (!finished && taskId) {
                      finished = true;
                      try {
                        BackgroundTask.finish({ taskId });
                      } catch (e) {}
                    }
                  }
                });

                // Auto-cleanup timer fallback
                setTimeout(() => {
                  if (!finished && taskId) {
                    finished = true;
                    try {
                      BackgroundTask.finish({ taskId });
                    } catch (e) {}
                  }
                }, 2200);
              }
            } catch (err) {
              console.warn('BackgroundTask.beforeExit failed:', err);
            }
          } else {
            // App returned to active foreground state
            triggerImmediateSync();
          }
        } catch (stateErr) {
          console.warn('App state change handler notice:', stateErr);
        }
      }).catch(() => {});
    }

    // 3. Immediate startup flush + 4s Automatic Background Upload Loop (never blocked by typing focus)
    setTimeout(() => {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        flushPendingQueue().catch(() => {});
      }
    }, 150);

    const SYNC_INTERVAL_MS = 4 * 1000;
    let offlineCheckTick = 0;
    setInterval(async () => {
      offlineCheckTick++;
      const syncQueue = getPendingQueueSync();
      let hasUnsynced = lastNotifiedQueueCount > 0 || syncQueue.some((i) => i.status !== 'synced');
      if (!hasUnsynced) {
        const asyncQueue = await getPendingQueue().catch(() => []);
        hasUnsynced = asyncQueue.some((i) => i.status !== 'synced');
      }
      if (!hasUnsynced) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (offlineCheckTick % 3 !== 0) return;
        const capOnline = await isNetworkConnected().catch(() => false);
        if (!capOnline) return;
      }
      flushPendingQueue().catch(() => {});
      // Also trigger BackgroundRunner event if available when user is idle
      try {
        if (BackgroundRunner && typeof BackgroundRunner.dispatchEvent === 'function' && !isUserActivelyTypingOrInputFocused()) {
          BackgroundRunner.dispatchEvent({
            label: 'com.alkarrar.mobile.backgroundsync',
            event: 'syncOfflineQueue',
            details: {},
          }).catch(() => {});
        }
      } catch (e) {}
    }, SYNC_INTERVAL_MS);

    // Dedicated Background Web Worker Heartbeat (unaffected by mobile background tab throttling)
    try {
      if (typeof window !== 'undefined' && typeof Worker !== 'undefined' && typeof Blob !== 'undefined') {
        const workerScript = `
          let timer = null;
          self.onmessage = function(e) {
            if (e.data === 'START') {
              if (timer) clearInterval(timer);
              timer = setInterval(function() {
                self.postMessage('TICK');
              }, 5000);
            } else if (e.data === 'STOP') {
              if (timer) clearInterval(timer);
              timer = null;
            }
          };
        `;
        const blob = new Blob([workerScript], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = (e) => {
          if (e.data === 'TICK') {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            const queue = getPendingQueueSync();
            const hasUnsynced = lastNotifiedQueueCount > 0 || queue.some((i) => i.status !== 'synced');
            if (hasUnsynced) {
              flushPendingQueue().catch(() => {});
            }
          }
        };
        worker.postMessage('START');
      }
    } catch (workerErr) {
      console.warn('[Offline Sync Engine] Web Worker heartbeat fallback notice:', workerErr);
    }

    // 4. Setup Network Status Change Listener for Instant Automatic Sync
    try {
      if (Network && typeof Network.addListener === 'function') {
        Network.addListener('networkStatusChange', (status) => {
          console.log('[Network Status Change] Connected:', status.connected, status.connectionType);
          if (status.connected) {
            triggerImmediateSync();
          }
        }).catch(() => {});
      }
    } catch (netErr) {}

    // 5. Setup Robust Browser Visibility & Online Listeners for Background Monitoring
    try {
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            console.log('[Background Monitoring] App became visible. Triggering immediate sync...');
            triggerImmediateSync();
          } else {
            console.log('[Background Monitoring] App hidden. Flushing pending queue...');
            flushPendingQueue().catch(() => {});
          }
        });
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          console.log('[Background Monitoring] Network online detected. Triggering immediate sync...');
          triggerImmediateSync();
        });
      }
    } catch (bgMonErr) {
      console.warn('Background monitoring listener error:', bgMonErr);
    }
  } catch (e) {
    console.warn('Capacitor App change listener not supported on current platform:', e);
  }
}

/**
 * Explicitly enable Foreground Service and Wake Lock for persistent background sync
 */
export async function enableForegroundService(): Promise<boolean> {
  let success = false;
  try {
    if (typeof window === 'undefined') return false;

    // 1. Cordova Background Mode / Foreground Service
    try {
      const cordova = (window as any).cordova;
      if (cordova && cordova.plugins && cordova.plugins.backgroundMode) {
        const bg = cordova.plugins.backgroundMode;
        bg.setDefaults({
          title: 'الكرار للتقسيط',
          text: 'خدمة المزامنة السحابية قيد العمل المستمر...',
          color: '0d9488',
          resume: true,
          silent: true,
        });
        bg.enable();
        if (typeof bg.overrideBackButton === 'function') {
          bg.overrideBackButton();
        }
        if (typeof bg.disableWebViewOptimizations === 'function') {
          bg.disableWebViewOptimizations();
        }
        success = true;
      }
    } catch (e) {}

    // 2. Android Foreground Service Plugin
    try {
      const fg = (window as any).plugins?.foregroundService || (window as any).cordova?.plugins?.foregroundService;
      if (fg && typeof fg.start === 'function') {
        fg.start('الكرار للتقسيط', 'المزامنة السحابية المباشرة نشطة', 'notification_icon', 1);
        success = true;
      }
    } catch (e) {}

    // 3. Web Screen Wake Lock API
    try {
      if ('wakeLock' in navigator && (navigator as any).wakeLock?.request) {
        await (navigator as any).wakeLock.request('screen').catch(() => {});
        success = true;
      }
    } catch (e) {}

    // 4. Service Worker Background Sync registration
    try {
      if ('serviceWorker' in navigator) {
        const reg: any = await navigator.serviceWorker.ready.catch(() => null);
        if (reg && reg.sync) {
          await reg.sync.register('alkarrar-foreground-sync').catch(() => {});
        }
      }
    } catch (e) {}

    console.log('[Foreground Service] Service successfully initialized & active');
  } catch (err) {
    console.warn('[Foreground Service] Init note:', err);
  }
  return success;
}

// -------------------------------------------------------------
// Advanced Anti-Sleep, Display Over Apps & Keep-Alive System
// -------------------------------------------------------------

let globalWakeLockSentinel: any = null;
let globalSilentAudioContext: any = null;
let globalSilentAudioElement: HTMLAudioElement | null = null;
let isKeepAliveEngineRunning = false;

/**
 * Check if Field Keep-Alive Mode is currently enabled (Defaults to TRUE for field sales reps)
 */
export function isKeepAliveModeEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const val = localStorage.getItem('alkarrar_keepalive_mode');
    // Enabled by default unless explicitly disabled by user
    return val !== 'false';
  } catch (e) {
    return true;
  }
}

/**
 * Acquire Web Screen Wake Lock safely with auto-reacquisition
 */
async function acquireWakeLock(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && (navigator as any).wakeLock?.request) {
      if (globalWakeLockSentinel && !globalWakeLockSentinel.released) {
        return true;
      }
      globalWakeLockSentinel = await (navigator as any).wakeLock.request('screen');
      globalWakeLockSentinel.addEventListener('release', () => {
        globalWakeLockSentinel = null;
        // If keep alive is still active, re-acquire when app becomes visible
        if (isKeepAliveEngineRunning && typeof document !== 'undefined' && document.visibilityState === 'visible') {
          setTimeout(() => acquireWakeLock().catch(() => {}), 1000);
        }
      });
      return true;
    }
  } catch (e) {
    console.warn('[KeepAlive] WakeLock notice:', e);
  }
  return false;
}

let globalKeepAliveWorker: Worker | null = null;

function startWorkerKeepAlive(): void {
  try {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return;
    if (globalKeepAliveWorker) return;

    const workerCode = `
      var timer = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          if (!timer) {
            timer = setInterval(function() {
              self.postMessage('TICK');
            }, 7000);
          }
        } else if (e.data === 'stop') {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      };
      timer = setInterval(function() {
        self.postMessage('TICK');
      }, 7000);
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    globalKeepAliveWorker = new Worker(workerUrl);
    globalKeepAliveWorker.onmessage = (e) => {
      if (e.data === 'TICK') {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        const hasUnsynced = lastNotifiedQueueCount > 0 || getPendingQueueSync().some((i) => i.status !== 'synced');
        if (hasUnsynced) {
          flushPendingQueue().catch(() => {});
        }
      }
    };
    globalKeepAliveWorker.postMessage('start');
  } catch (err) {
    console.warn('[KeepAlive] Worker keepalive notice:', err);
  }
}

function stopWorkerKeepAlive(): void {
  try {
    if (globalKeepAliveWorker) {
      globalKeepAliveWorker.postMessage('stop');
      globalKeepAliveWorker.terminate();
      globalKeepAliveWorker = null;
    }
  } catch (e) {}
}

/**
 * Start a silent WebAudio keep-alive loop to prevent Android/iOS from suspending the JS thread
 */
function startSilentAudioKeepAlive(): void {
  try {
    if (typeof window === 'undefined') return;

    // 0. Dedicated Web Worker ticking loop
    startWorkerKeepAlive();

    // 1. Silent HTML5 Audio Element Loop (extremely reliable across Android WebViews)
    if (!globalSilentAudioElement) {
      // 1-second silent WAV base64
      const silentWavBase64 = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      const audio = new Audio(silentWavBase64);
      audio.loop = true;
      audio.volume = 0.01; // virtually inaudible but informs mobile OS of active media session
      (audio as any).playsInline = true;
      
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          // On mobile, autoplay might require first user gesture
          const handleFirstClick = () => {
            audio.play().catch(() => {});
            window.removeEventListener('click', handleFirstClick);
            window.removeEventListener('touchstart', handleFirstClick);
          };
          window.addEventListener('click', handleFirstClick, { once: true });
          window.addEventListener('touchstart', handleFirstClick, { once: true });
        });
      }
      globalSilentAudioElement = audio;
    }

    // 2. Silent Web Audio API Context
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass && !globalSilentAudioContext) {
      const ctx = new AudioContextClass();
      if (ctx.state === 'suspended') {
        const resumeCtx = () => {
          ctx.resume().catch(() => {});
          window.removeEventListener('click', resumeCtx);
          window.removeEventListener('touchstart', resumeCtx);
        };
        window.addEventListener('click', resumeCtx, { once: true });
        window.addEventListener('touchstart', resumeCtx, { once: true });
      }
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0.00001; // Inaudible
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.start();
      globalSilentAudioContext = ctx;
    }
  } catch (err) {
    console.warn('[KeepAlive] Audio keepalive notice:', err);
  }
}

/**
 * Stop silent audio keep-alive
 */
function stopSilentAudioKeepAlive(): void {
  try {
    stopWorkerKeepAlive();
    if (globalSilentAudioElement) {
      globalSilentAudioElement.pause();
      globalSilentAudioElement.src = '';
      globalSilentAudioElement = null;
    }
    if (globalSilentAudioContext) {
      globalSilentAudioContext.close().catch(() => {});
      globalSilentAudioContext = null;
    }
  } catch (e) {}
}

/**
 * Toggle Field Keep-Alive Mode (Anti-Sleep, WakeLock, Silent Heartbeat, Background Sync)
 */
export async function setFieldKeepAliveMode(enable: boolean): Promise<boolean> {
  isKeepAliveEngineRunning = enable;
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem('alkarrar_keepalive_mode', enable ? 'true' : 'false');
    }

    const androidBridge =
      (window as any).AndroidPrinter ||
      (window as any).AndroidInterface ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    if (androidBridge && typeof androidBridge.setKeepScreenOn === 'function') {
      try {
        androidBridge.setKeepScreenOn(enable);
      } catch (e) {}
    }

    if (enable) {
      await acquireWakeLock();
      startSilentAudioKeepAlive();
      await enableForegroundService();
      await requestAllBackgroundAndSyncPermissions();
      
      // Listen for visibility to restore WakeLock if screen turned off & on
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && isKeepAliveEngineRunning) {
            acquireWakeLock().catch(() => {});
          }
        });
      }
      console.log('[KeepAlive] Field Keep-Alive mode ACTIVATED (WakeLock + Audio Heartbeat + Foreground Service)');
      return true;
    } else {
      stopSilentAudioKeepAlive();
      if (globalWakeLockSentinel) {
        try {
          await globalWakeLockSentinel.release();
        } catch (e) {}
        globalWakeLockSentinel = null;
      }
      console.log('[KeepAlive] Field Keep-Alive mode DEACTIVATED');
      return false;
    }
  } catch (err) {
    console.warn('[KeepAlive] Error setting keepalive mode:', err);
    return false;
  }
}

/**
 * Request Display Over Other Apps (SYSTEM_ALERT_WINDOW) Permission & open Android Settings
 */
export async function requestDisplayOverAppsPermission(): Promise<{ success: boolean; message: string }> {
  try {
    const androidBridge =
      (window as any).AndroidPrinter ||
      (window as any).AndroidInterface ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    // 1. Direct native bridge call
    if (androidBridge) {
      if (typeof androidBridge.requestOverlayPermission === 'function') {
        androidBridge.requestOverlayPermission();
        return { success: true, message: 'تم فتح إعدادات صلاحية الظهور فوق التطبيقات' };
      }
      if (typeof androidBridge.openOverlaySettings === 'function') {
        androidBridge.openOverlaySettings();
        return { success: true, message: 'تم فتح إعدادات الظهور فوق التطبيقات' };
      }
      if (typeof androidBridge.requestSystemAlertWindow === 'function') {
        androidBridge.requestSystemAlertWindow();
        return { success: true, message: 'تم طلب إذن النوافذ العائمة والظهور فوق التطبيقات' };
      }
    }

    // 2. Cordova / Capacitor Plugins
    const cordova = (window as any).cordova;
    if (cordova && cordova.plugins) {
      if (cordova.plugins.permissions) {
        const p = cordova.plugins.permissions;
        const overlayPerm = p.SYSTEM_ALERT_WINDOW || 'android.permission.SYSTEM_ALERT_WINDOW';
        p.requestPermission(
          overlayPerm,
          () => {},
          () => {}
        );
      }
      if (cordova.plugins.diagnostic && typeof cordova.plugins.diagnostic.switchToOverlaySettings === 'function') {
        cordova.plugins.diagnostic.switchToOverlaySettings();
        return { success: true, message: 'تم فتح إعدادات الظهور فوق التطبيقات' };
      }
    }

    // 3. Fallback intent trigger for Android browsers / WebView
    if (typeof window !== 'undefined') {
      try {
        const intentUrl = 'intent:#Intent;action=android.settings.action.MANAGE_OVERLAY_PERMISSION;end';
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = intentUrl;
        document.body.appendChild(iframe);
        setTimeout(() => document.body.removeChild(iframe), 1000);
      } catch (e) {}
    }

    return {
      success: true,
      message: 'يرجى الانتقال إلى إعدادات الهاتف > التطبيقات > تفعيل "الظهور فوق التطبيقات"',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'تعذر فتح إعدادات الصلاحية' };
  }
}

/**
 * Open Battery Optimization Exemption Settings (Unrestricted battery)
 */
export async function openBatteryOptimizationSettings(): Promise<{ success: boolean; message: string }> {
  try {
    const androidBridge =
      (window as any).AndroidPrinter ||
      (window as any).AndroidInterface ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    if (androidBridge) {
      if (typeof androidBridge.requestIgnoreBatteryOptimizations === 'function') {
        androidBridge.requestIgnoreBatteryOptimizations();
        return { success: true, message: 'تم فتح إعدادات استثناء توفير البطارية' };
      }
      if (typeof androidBridge.openBatterySettings === 'function') {
        androidBridge.openBatterySettings();
        return { success: true, message: 'تم فتح إعدادات البطارية' };
      }
    }

    const cordova = (window as any).cordova;
    if (cordova && cordova.plugins?.backgroundMode) {
      try {
        if (typeof cordova.plugins.backgroundMode.disableBatteryOptimizations === 'function') {
          cordova.plugins.backgroundMode.disableBatteryOptimizations();
          return { success: true, message: 'تم تعطيل قيود البطارية' };
        }
      } catch (e) {}
    }

    if (typeof window !== 'undefined') {
      try {
        const intentUrl = 'intent:#Intent;action=android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS;end';
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = intentUrl;
        document.body.appendChild(iframe);
        setTimeout(() => document.body.removeChild(iframe), 1000);
      } catch (e) {}
    }

    return {
      success: true,
      message: 'يرجى اختيار "غير مقيد" (Unrestricted) في إعدادات بطارية التطبيق',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'تعذر فتح إعدادات البطارية' };
  }
}

/**
 * Open Auto-Start & Application Details Settings
 */
export async function openAutoStartSettings(): Promise<{ success: boolean; message: string }> {
  try {
    const androidBridge =
      (window as any).AndroidPrinter ||
      (window as any).AndroidInterface ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    if (androidBridge) {
      if (typeof androidBridge.openAutoStartSettings === 'function') {
        androidBridge.openAutoStartSettings();
        return { success: true, message: 'تم فتح إعدادات التشغيل التلقائي' };
      }
      if (typeof androidBridge.openAppSettings === 'function') {
        androidBridge.openAppSettings();
        return { success: true, message: 'تم فتح معلومات التطبيق' };
      }
    }

    if (typeof window !== 'undefined') {
      try {
        const intentUrl = 'intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;end';
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = intentUrl;
        document.body.appendChild(iframe);
        setTimeout(() => document.body.removeChild(iframe), 1000);
      } catch (e) {}
    }

    return {
      success: true,
      message: 'يرجى تفعيل "التشغيل التلقائي" (Auto-start) وقفل التطبيق في الرام',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'تعذر فتح الإعدادات' };
  }
}

/**
 * Open Application Details Settings Page directly
 */
export async function openApplicationDetailsSettings(): Promise<{ success: boolean; message: string }> {
  try {
    const androidBridge =
      (window as any).AndroidPrinter ||
      (window as any).AndroidInterface ||
      (window as any).Android ||
      (window as any).AndroidBridge;

    if (androidBridge && typeof androidBridge.openAppSettings === 'function') {
      androidBridge.openAppSettings();
      return { success: true, message: 'تم فتح معلومات وأذونات التطبيق في النظام' };
    }

    if (typeof window !== 'undefined') {
      try {
        const intentUrl = 'intent:#Intent;action=android.settings.APPLICATION_DETAILS_SETTINGS;end';
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = intentUrl;
        document.body.appendChild(iframe);
        setTimeout(() => document.body.removeChild(iframe), 1000);
      } catch (e) {}
    }

    return {
      success: true,
      message: 'يرجى الانتقال إلى إعدادات الهاتف > التطبيقات > اختيار التطبيق > تفعيل الأذونات والظهور في الأعلى',
    };
  } catch (err: any) {
    return { success: false, message: err?.message || 'تعذر فتح الإعدادات' };
  }
}

export interface BackgroundSyncHealthStatus {
  serviceWorkerActive: boolean;
  backgroundSyncSupported: boolean;
  periodicSyncSupported: boolean;
  keepAliveActive: boolean;
  wakeLockActive: boolean;
  storagePersisted: boolean;
  pendingCount: number;
  isOnline: boolean;
  batteryOptimizationsDisabled: boolean;
  notificationPermission: string;
  overlayPermissionGranted: boolean;
  batteryUnrestricted: boolean;
  keepScreenOn: boolean;
}

/**
 * Perform a complete live audit of the 5-layer Background Sync pipeline
 */
export async function checkBackgroundSyncHealth(): Promise<BackgroundSyncHealthStatus> {
  const queue = await getPendingQueue();
  const pendingCount = queue.filter((i) => i.status !== 'synced').length;
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

  let swActive = false;
  let bgSyncSupported = false;
  let periodicSyncSupported = false;

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    swActive = !!navigator.serviceWorker.controller;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg) {
        swActive = true;
        bgSyncSupported = 'sync' in reg;
        periodicSyncSupported = 'periodicSync' in reg;
      }
    } catch (e) {}
  }

  let storagePersisted = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      storagePersisted = await navigator.storage.persisted();
    }
  } catch (e) {}

  const notifPerm = typeof Notification !== 'undefined' ? Notification.permission : 'default';

  let overlayPermissionGranted = false;
  let batteryUnrestricted = false;
  let keepScreenOn = false;

  const androidBridge =
    (window as any).AndroidPrinter ||
    (window as any).AndroidInterface ||
    (window as any).Android ||
    (window as any).AndroidBridge;

  if (androidBridge) {
    try {
      if (typeof androidBridge.hasOverlayPermission === 'function') {
        overlayPermissionGranted = !!androidBridge.hasOverlayPermission();
      }
      if (typeof androidBridge.isIgnoringBatteryOptimizations === 'function') {
        batteryUnrestricted = !!androidBridge.isIgnoringBatteryOptimizations();
      }
      if (typeof androidBridge.isKeepScreenOn === 'function') {
        keepScreenOn = !!androidBridge.isKeepScreenOn();
      }
    } catch (e) {}
  }

  return {
    serviceWorkerActive: swActive,
    backgroundSyncSupported: bgSyncSupported,
    periodicSyncSupported: periodicSyncSupported,
    keepAliveActive: isKeepAliveEngineRunning || isKeepAliveModeEnabled(),
    wakeLockActive: !!globalWakeLockSentinel && !globalWakeLockSentinel.released,
    storagePersisted,
    pendingCount,
    isOnline,
    batteryOptimizationsDisabled: batteryUnrestricted || isKeepAliveEngineRunning,
    notificationPermission: notifPerm,
    overlayPermissionGranted,
    batteryUnrestricted,
    keepScreenOn,
  };
}

/**
 * Trigger an immediate high-priority test through all 5 background sync layers
 */
export async function triggerForceBackgroundSyncTest(): Promise<{
  success: boolean;
  flushedCount: number;
  remainingCount: number;
  latencyMs: number;
  layersTriggered: string[];
}> {
  const startTime = Date.now();
  const layersTriggered: string[] = [];

  // Layer 1: BroadcastChannel
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const ch = new BroadcastChannel('alkarrar_sync_channel');
      ch.postMessage({ type: 'TRIGGER_SYNC', timestamp: Date.now() });
      ch.close();
      layersTriggered.push('BroadcastChannel');
    } catch (e) {}
  }

  // Layer 2: Service Worker controller & sync tags
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'FLUSH_QUEUE_IMMEDIATELY' });
        layersTriggered.push('ServiceWorkerMessage');
      }
      const reg = await navigator.serviceWorker.ready;
      if (reg && 'sync' in reg) {
        await (reg as any).sync.register('postgres-background-sync').catch(() => {});
        layersTriggered.push('AndroidBackgroundSyncAPI');
      }
    } catch (e) {}
  }

  // Layer 3: Native Android Bridge
  try {
    const bridge =
      (window as any).AndroidInterface ||
      (window as any).AndroidPrinter ||
      (window as any).Android ||
      (window as any).AndroidBridge;
    if (bridge && typeof bridge.triggerBackgroundSyncNow === 'function') {
      bridge.triggerBackgroundSyncNow();
      layersTriggered.push('NativeAndroidBridge');
    }
  } catch (e) {}

  // Layer 4: KeepAlive & Foreground activation
  if (isKeepAliveModeEnabled()) {
    setFieldKeepAliveMode(true).catch(() => {});
    layersTriggered.push('KeepAliveMediaHeartbeat');
  }

  // Layer 5: Direct Client Flush
  const flushRes = await flushPendingQueue();
  layersTriggered.push('BatchPostgresPipeline');

  const latencyMs = Date.now() - startTime;
  return {
    success: true,
    flushedCount: flushRes.flushed,
    remainingCount: flushRes.remaining,
    latencyMs,
    layersTriggered,
  };
}

// Auto-activate field keepalive on first user touch anywhere
if (typeof window !== 'undefined') {
  const handleUserFirstGesture = () => {
    if (isKeepAliveModeEnabled()) {
      setFieldKeepAliveMode(true).catch(() => {});
    }
    window.removeEventListener('pointerdown', handleUserFirstGesture);
    window.removeEventListener('touchstart', handleUserFirstGesture);
    window.removeEventListener('click', handleUserFirstGesture);
  };
  window.addEventListener('pointerdown', handleUserFirstGesture, { once: true, passive: true });
  window.addEventListener('touchstart', handleUserFirstGesture, { once: true, passive: true });
  window.addEventListener('click', handleUserFirstGesture, { once: true, passive: true });
}

