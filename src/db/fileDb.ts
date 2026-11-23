import fs from 'fs';
import path from 'path';

const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

const DATA_DIR = isNode && typeof process.cwd === 'function' ? path.join(process.cwd(), 'data') : '';

if (isNode && fs.existsSync && !fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function getFilePath(tableName: string) {
  if (isNode && DATA_DIR) {
    return path.join(DATA_DIR, `${tableName}.json`);
  }
  return `${tableName}.json`;
}

// In-memory table cache + debounced async flush to prevent blocking the event loop
// when batch endpoints upsert/update dozens or hundreds of records sequentially.
const tableCache = new Map<string, any[]>();
const dirtyTables = new Set<string>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

function loadTable<T = any>(tableName: string): T[] {
  if (tableCache.has(tableName)) {
    return tableCache.get(tableName) as T[];
  }
  try {
    if (isNode && fs.existsSync) {
      const file = getFilePath(tableName);
      if (!fs.existsSync(file)) {
        const empty: T[] = [];
        tableCache.set(tableName, empty);
        return empty;
      }
      const content = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed) ? parsed : [];
      tableCache.set(tableName, arr);
      return arr as T[];
    } else if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(`filedb_${tableName}`);
      const parsed = stored ? JSON.parse(stored) : [];
      const arr = Array.isArray(parsed) ? parsed : [];
      tableCache.set(tableName, arr);
      return arr as T[];
    }
  } catch {
    return [];
  }
  return [];
}

async function flushTableToDisk(tableName: string): Promise<void> {
  if (!isNode || !fs.promises) return;
  if (!dirtyTables.has(tableName)) return;
  dirtyTables.delete(tableName);
  const data = tableCache.get(tableName) || [];
  try {
    const file = getFilePath(tableName);
    await fs.promises.writeFile(file, JSON.stringify(data), 'utf-8');
  } catch (e) {
    console.error(`Error async saving table ${tableName}:`, e);
  }
}

function flushTableSync(tableName: string): void {
  if (!dirtyTables.has(tableName)) return;
  dirtyTables.delete(tableName);
  const data = tableCache.get(tableName) || [];
  try {
    if (isNode && fs.writeFileSync) {
      const file = getFilePath(tableName);
      fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`filedb_${tableName}`, JSON.stringify(data));
    }
  } catch (e) {
    console.error(`Error saving table ${tableName}:`, e);
  }
}

function scheduleTableFlush(tableName: string) {
  dirtyTables.add(tableName);
  if (!isNode) {
    flushTableSync(tableName);
    return;
  }
  const existingTimer = flushTimers.get(tableName);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    flushTimers.delete(tableName);
    flushTableToDisk(tableName).catch(() => {});
  }, 120);
  if (typeof (timer as any).unref === 'function') {
    (timer as any).unref();
  }
  flushTimers.set(tableName, timer);
}

export function flushAllFileDbSync(): void {
  for (const timer of flushTimers.values()) {
    clearTimeout(timer);
  }
  flushTimers.clear();
  for (const tableName of Array.from(dirtyTables)) {
    flushTableSync(tableName);
  }
}

if (isNode && typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('beforeExit', flushAllFileDbSync);
}

export const fileDb = {
  get: <T = any>(tableName: string): T[] => {
    return [...loadTable<T>(tableName)];
  },

  upsert: <T extends { id: string }>(tableName: string, record: T): T => {
    const records = loadTable<T>(tableName);
    const index = records.findIndex((r) => r && r.id === record.id);
    let saved: T;
    if (index >= 0) {
      saved = { ...records[index], ...record };
      records[index] = saved;
    } else {
      saved = { ...record };
      records.push(saved);
    }
    tableCache.set(tableName, records);
    scheduleTableFlush(tableName);
    return saved;
  },

  update: <T extends { id: string }>(tableName: string, id: string, updates: Partial<T>): boolean => {
    const records = loadTable<T>(tableName);
    const index = records.findIndex((r) => r && r.id === id);
    if (index >= 0) {
      records[index] = { ...records[index], ...updates };
      tableCache.set(tableName, records);
      scheduleTableFlush(tableName);
      return true;
    }
    return false;
  },

  delete: (tableName: string, id: string): boolean => {
    const records = loadTable<{ id: string }>(tableName);
    const filtered = records.filter((r) => r && r.id !== id);
    if (filtered.length !== records.length) {
      tableCache.set(tableName, filtered);
      scheduleTableFlush(tableName);
    }
    return true;
  },

  setAll: <T = any>(tableName: string, data: T[]): void => {
    tableCache.set(tableName, Array.isArray(data) ? [...data] : []);
    scheduleTableFlush(tableName);
  },

  flushAll: flushAllFileDbSync,
};

