import dotenv from 'dotenv';
dotenv.config({ override: true });
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

const SAME_SERVER_PUBLIC_IP = '72.62.158.128';

export function resolveLocalDbHost(rawHost?: string | null): string {
  const host = (rawHost || '').trim();
  if (!host || host === SAME_SERVER_PUBLIC_IP) {
    return '127.0.0.1';
  }
  return host;
}

export function isLocalDbHost(host?: string | null): boolean {
  const h = (host || '').trim().toLowerCase();
  return (
    !h ||
    h === '127.0.0.1' ||
    h === 'localhost' ||
    h === '::1' ||
    h.startsWith('/')
  );
}

export function resolveDbSsl(host?: string | null): false | { rejectUnauthorized: false } {
  if (process.env.DB_SSL === 'false') return false;
  if (isLocalDbHost(host)) return false;
  return process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
}

function normalizeLocalConnectionString(rawUrl: string): { connectionString: string; host: string; ssl: false | { rejectUnauthorized: false } } {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === SAME_SERVER_PUBLIC_IP) {
      parsed.hostname = '127.0.0.1';
    }
    const host = parsed.hostname || '127.0.0.1';
    const ssl = resolveDbSsl(host);
    if (ssl === false) {
      parsed.searchParams.delete('sslmode');
      parsed.searchParams.delete('ssl');
    }
    return { connectionString: parsed.toString(), host, ssl };
  } catch (_e) {
    const replaced = rawUrl.replace(SAME_SERVER_PUBLIC_IP, '127.0.0.1');
    return { connectionString: replaced, host: '127.0.0.1', ssl: false };
  }
}

export function getResolvedDbTargetInfo(): { host: string; port: number; ssl: boolean; database: string } | null {
  if (process.env.SQL_HOST && process.env.SQL_USER && process.env.SQL_DB_NAME) {
    const host = resolveLocalDbHost(process.env.SQL_HOST);
    return {
      host,
      port: Number(process.env.SQL_PORT || process.env.DB_PORT || 5432),
      ssl: Boolean(resolveDbSsl(host)),
      database: process.env.SQL_DB_NAME,
    };
  }
  if ((process.env.DB_HOST || (process.env.DB_USER && process.env.DB_PASSWORD)) && process.env.DB_NAME) {
    const host = resolveLocalDbHost(process.env.DB_HOST || '127.0.0.1');
    return {
      host,
      port: Number(process.env.DB_PORT || 5432),
      ssl: Boolean(resolveDbSsl(host)),
      database: process.env.DB_NAME,
    };
  }
  if (
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('supabase.co') &&
    !process.env.DATABASE_URL.includes('[YOUR-PASSWORD]') &&
    !process.env.DATABASE_URL.includes('YOUR-PASSWORD')
  ) {
    const norm = normalizeLocalConnectionString(process.env.DATABASE_URL);
    let parsedDbName = 'app_database';
    let parsedPort = Number(process.env.DB_PORT || 5432);
    try {
      const u = new URL(norm.connectionString);
      if (u.pathname && u.pathname.length > 1) {
        parsedDbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
      }
      if (u.port) {
        parsedPort = Number(u.port);
      }
    } catch (_e) {}
    return {
      host: norm.host,
      port: parsedPort,
      ssl: Boolean(norm.ssl),
      database: parsedDbName,
    };
  }
  return null;
}

export const resetPool = () => {
  if (global._postgresPool) {
    try {
      global._postgresPool.end().catch(() => {});
    } catch (e) {}
    global._postgresPool = undefined;
  }
};

export const createPool = (): Pool => {
  if (global._postgresPool) {
    return global._postgresPool;
  }

  let newPool: Pool;

  if (process.env.SQL_HOST && process.env.SQL_USER && process.env.SQL_DB_NAME) {
    const sqlHost = resolveLocalDbHost(process.env.SQL_HOST);
    newPool = new Pool({
      host: sqlHost,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      ssl: resolveDbSsl(sqlHost),
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 20000,
      statement_timeout: 20000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
    });
  } else if (
    (process.env.DB_HOST || (process.env.DB_USER && process.env.DB_PASSWORD)) &&
    process.env.DB_USER &&
    process.env.DB_PASSWORD &&
    process.env.DB_NAME
  ) {
    // Always connect via 127.0.0.1 with ssl=false when app and PostgreSQL share the same server
    const dbHost = resolveLocalDbHost(process.env.DB_HOST || '127.0.0.1');
    newPool = new Pool({
      host: dbHost,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: resolveDbSsl(dbHost),
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      statement_timeout: 20000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
    });
  } else if (
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('supabase.co') &&
    !process.env.DATABASE_URL.includes('[YOUR-PASSWORD]') &&
    !process.env.DATABASE_URL.includes('YOUR-PASSWORD')
  ) {
    const norm = normalizeLocalConnectionString(process.env.DATABASE_URL);
    newPool = new Pool({
      connectionString: norm.connectionString,
      ssl: norm.ssl,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 15000,
      statement_timeout: 20000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
    });
  } else {
    throw new Error('PostgreSQL environment variables (SQL_HOST/SQL_USER/SQL_DB_NAME or DB_HOST) are not configured.');
  }

  newPool.on('error', (err) => {
    console.warn('PostgreSQL pool client connection warning:', err?.message || err);
    resetPool();
  });

  global._postgresPool = newPool;
  return global._postgresPool;
};

export const db = (() => {
  try {
    return drizzle(createPool(), { schema });
  } catch {
    return undefined as any;
  }
})();
