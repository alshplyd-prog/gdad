import dotenv from 'dotenv';
dotenv.config({ override: true });
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
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
    newPool = new Pool({
      host: process.env.SQL_HOST,
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      database: process.env.SQL_DB_NAME,
      max: 10,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 20000,
      statement_timeout: 20000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5000,
    });
  } else if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME) {
    newPool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
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
    newPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
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
