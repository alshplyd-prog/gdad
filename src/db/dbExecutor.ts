import { createPool, resetPool } from './index.ts';
import { fileDb } from './fileDb.ts';
import { initializeDatabaseSchema } from './init.ts';

export const isPgConfigured = () => {
  if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME) {
    return true;
  }
  if (process.env.SQL_HOST && process.env.SQL_USER && process.env.SQL_DB_NAME) {
    return true;
  }
  if (
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('supabase.co') &&
    !process.env.DATABASE_URL.includes('[YOUR-PASSWORD]') &&
    !process.env.DATABASE_URL.includes('YOUR-PASSWORD')
  ) {
    return true;
  }
  return false;
};

class AsyncSemaphore {
  private tasks: (() => void)[] = [];
  private count = 0;
  private max: number;
  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    await new Promise<void>((resolve) => this.tasks.push(resolve));
    this.count++;
  }

  release(): void {
    this.count--;
    if (this.tasks.length > 0) {
      const next = this.tasks.shift();
      if (next) next();
    }
  }
}

const pgSemaphore = new AsyncSemaphore(8);

const PG_CIRCUIT_COOLDOWN_MS = 15000;
let pgUnavailableUntil = 0;
let pgLastFailureMessage = 'PostgreSQL temporarily unavailable';
let pgLastWarnAt = 0;

function isNonTransientPgRejection(errStr: string): boolean {
  return (
    errStr.includes('pg_hba') ||
    errStr.includes('no encryption') ||
    errStr.includes('password authentication') ||
    errStr.includes('econnrefused') ||
    errStr.includes('enotfound') ||
    errStr.includes('eai_again') ||
    errStr.includes('does not exist') && errStr.includes('database')
  );
}

function isTransientConnError(errStr: string): boolean {
  if (isNonTransientPgRejection(errStr)) return false;
  return (
    errStr.includes('econnreset') ||
    errStr.includes('etimedout') ||
    errStr.includes('timeout') ||
    errStr.includes('terminated') ||
    errStr.includes('closed') ||
    errStr.includes('connection')
  );
}

function tripPgCircuit(message: string) {
  pgUnavailableUntil = Date.now() + PG_CIRCUIT_COOLDOWN_MS;
  pgLastFailureMessage = message || 'PostgreSQL unavailable';
  const now = Date.now();
  if (now - pgLastWarnAt > PG_CIRCUIT_COOLDOWN_MS) {
    pgLastWarnAt = now;
    console.warn(`PostgreSQL unavailable (${pgLastFailureMessage}); using local fileDb fallback for 15s.`);
  }
}

export async function executePg(sql: string, params: any[] = []): Promise<any[]> {
  if (Date.now() < pgUnavailableUntil) {
    throw new Error(pgLastFailureMessage);
  }
  await pgSemaphore.acquire();
  try {
    if (Date.now() < pgUnavailableUntil) {
      throw new Error(pgLastFailureMessage);
    }
    let attempts = 0;
    const maxAttempts = 2;
    while (attempts < maxAttempts) {
      try {
        const currentPool = createPool();
        const res = await currentPool.query(sql, params);
        pgUnavailableUntil = 0;
        return res.rows || [];
      } catch (e: any) {
        attempts++;
        const errMsg = e?.message || String(e || 'Unknown PG error');
        const errStr = errMsg.toLowerCase();

        if (isNonTransientPgRejection(errStr)) {
          resetPool();
          tripPgCircuit(errMsg);
          throw e;
        }

        const isConnErr = isTransientConnError(errStr);
        const isMaxConn =
          errStr.includes('emaxconnsession') ||
          errStr.includes('too many clients') ||
          errStr.includes('connection limit');

        if (isConnErr || isMaxConn) {
          resetPool();
          if (attempts < maxAttempts) {
            await new Promise((r) => setTimeout(r, 250 + Math.random() * 150));
            continue;
          }
          tripPgCircuit(errMsg);
          throw e;
        }

        if (errMsg.includes('does not exist')) {
          try {
            if (errMsg.includes('employee_name')) {
              const currentPool = createPool();
              await currentPool.query('ALTER TABLE employee_transactions ADD COLUMN IF NOT EXISTS employee_name TEXT;').catch(() => {});
              const resRetry = await currentPool.query(sql, params);
              return resRetry.rows || [];
            }
            if (errMsg.includes('avatar_url') && errMsg.includes('reps')) {
              const currentPool = createPool();
              await currentPool.query('ALTER TABLE reps ADD COLUMN IF NOT EXISTS avatar_url TEXT;').catch(() => {});
              const resRetry = await currentPool.query(sql, params);
              return resRetry.rows || [];
            }
            if (errMsg.includes('latitude') || errMsg.includes('longitude') || errMsg.includes('location_address') || errMsg.includes('location_updated_at') || errMsg.includes('location_cleared_at')) {
              const currentPool = createPool();
              await currentPool.query(`
                ALTER TABLE sales ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
                ALTER TABLE sales ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
                ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_address TEXT;
                ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_updated_at TEXT;
                ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_cleared_at TEXT;
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_address TEXT;
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_updated_at TEXT;
                ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_cleared_at TEXT;
                DROP VIEW IF EXISTS contracts CASCADE;
                CREATE VIEW contracts AS 
                SELECT 
                  id, customer_id, customer_name, customer_phone, customer_address,
                  latitude, longitude, location_address, location_updated_at, location_cleared_at,
                  item_id, item_name, item_quantity, purchase_price,
                  list_id, list_name, total_price, advance_payment,
                  remaining_balance, daily_installment, start_date, notes,
                  status, last_payment_date, total_paid, rep_name,
                  created_at, completed_at, updated_at, is_edited
                FROM sales;
              `).catch(() => {});
              const resRetry = await currentPool.query(sql, params);
              return resRetry.rows || [];
            }
            if (errMsg.includes('funds') && (errMsg.includes('relation') || errMsg.includes('table'))) {
              const currentPool = createPool();
              await currentPool.query('CREATE OR REPLACE VIEW funds AS SELECT * FROM cash_funds;').catch(() => {});
              const resRetry = await currentPool.query(sql, params);
              return resRetry.rows || [];
            }
            await initializeDatabaseSchema();
            const currentPool = createPool();
            const res2 = await currentPool.query(sql, params);
            return res2.rows || [];
          } catch (innerErr) {}
        }

        if (attempts >= maxAttempts) {
          console.warn('PostgreSQL query error after retries (falling back to local data):', errMsg);
          throw e;
        }
      }
    }
    return [];
  } finally {
    pgSemaphore.release();
  }
}

export interface PgSecurityContext {
  role?: 'admin' | 'supervisor' | 'rep' | 'anonymous' | 'system';
  repId?: string;
  repName?: string;
  canDelete?: boolean;
  canEdit?: boolean;
  canSell?: boolean;
}

export async function executePgWithContext(
  sql: string,
  params: any[] = [],
  ctx?: PgSecurityContext | null
): Promise<any[]> {
  if (!ctx) {
    return executePg(sql, params);
  }
  if (Date.now() < pgUnavailableUntil) {
    throw new Error(pgLastFailureMessage);
  }
  await pgSemaphore.acquire();
  try {
    if (Date.now() < pgUnavailableUntil) {
      throw new Error(pgLastFailureMessage);
    }
    const currentPool = createPool();
    const client = await currentPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT
           set_config('app.current_role', $1, true),
           set_config('app.current_rep_id', $2, true),
           set_config('app.current_rep_name', $3, true),
           set_config('app.can_delete', $4, true),
           set_config('app.can_edit', $5, true),
           set_config('app.can_sell', $6, true)`,
        [
          ctx.role || 'anonymous',
          ctx.repId || '',
          ctx.repName || '',
          ctx.canDelete ? 'true' : 'false',
          ctx.canEdit ? 'true' : 'false',
          ctx.canSell ? 'true' : 'false',
        ]
      );
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      pgUnavailableUntil = 0;
      return res.rows || [];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (outerErr: any) {
    const errMsg = outerErr?.message || String(outerErr || '');
    const errStr = errMsg.toLowerCase();
    if (isNonTransientPgRejection(errStr) || isTransientConnError(errStr)) {
      resetPool();
      tripPgCircuit(errMsg);
    }
    throw outerErr;
  } finally {
    pgSemaphore.release();
  }
}

export const dbStore = fileDb;
