import fs from 'fs';
import path from 'path';
import { createPool } from './index.ts';

export async function initializeDatabaseSchema() {
  if (
    !process.env.DATABASE_URL &&
    !process.env.DB_HOST &&
    !(process.env.DB_USER && process.env.DB_NAME) &&
    (!process.env.SQL_HOST || !process.env.SQL_DB_NAME)
  ) {
    console.log('PostgreSQL connection details not provided, skipping schema initialization.');
    return;
  }

  try {
    const pool = createPool();
    const client = await pool.connect();
    try {
      await client.query(`
        -- 1. Drop conflicting views if any exist before creating or altering tables
        DO $$ 
        DECLARE
          r RECORD;
        BEGIN
          FOR r IN 
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_name IN (
                'sales', 'customers', 'funds', 'inventory', 'payments', 'reps',
                'installment_contracts', 'payment_records', 'sales_representatives',
                'contracts', 'invoices', 'cash_registers', 'representatives', 'cash_operations'
              )
              AND table_type = 'VIEW'
          LOOP
            EXECUTE 'DROP VIEW IF EXISTS ' || quote_ident(r.table_name) || ' CASCADE';
          END LOOP;
        END $$;

        -- Migrate old contracts table into sales if contracts exists, then drop contracts
        DO $$ 
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'contracts' AND table_type = 'BASE TABLE') THEN
            -- Create sales table if not exists first
            CREATE TABLE IF NOT EXISTS sales (
              id TEXT PRIMARY KEY,
              customer_id TEXT,
              customer_name TEXT NOT NULL,
              customer_phone TEXT NOT NULL,
              customer_address TEXT,
              item_id TEXT,
              item_name TEXT NOT NULL,
              item_quantity INTEGER DEFAULT 1,
              purchase_price DOUBLE PRECISION DEFAULT 0,
              list_id TEXT,
              list_name TEXT,
              total_price DOUBLE PRECISION NOT NULL,
              advance_payment DOUBLE PRECISION DEFAULT 0,
              remaining_balance DOUBLE PRECISION NOT NULL,
              daily_installment DOUBLE PRECISION NOT NULL,
              start_date TEXT NOT NULL,
              notes TEXT,
              status TEXT NOT NULL DEFAULT 'active',
              last_payment_date TEXT,
              total_paid DOUBLE PRECISION DEFAULT 0,
              rep_name TEXT,
              created_at TEXT NOT NULL,
              completed_at TEXT,
              updated_at TEXT,
              is_edited BOOLEAN DEFAULT FALSE
            );

            INSERT INTO sales (id, customer_name, customer_phone, customer_address, item_id, item_name, item_quantity, purchase_price, list_id, list_name, total_price, advance_payment, remaining_balance, daily_installment, start_date, notes, status, last_payment_date, total_paid, rep_name, created_at, completed_at, updated_at, is_edited)
            SELECT id, customer_name, customer_phone, customer_address, item_id, item_name, COALESCE(item_quantity, 1), COALESCE(purchase_price, 0), list_id, list_name, total_price, COALESCE(advance_payment, 0), remaining_balance, daily_installment, start_date, notes, COALESCE(status, 'active'), last_payment_date, COALESCE(total_paid, 0), rep_name, created_at, completed_at, updated_at, COALESCE(is_edited, false)
            FROM contracts
            ON CONFLICT (id) DO NOTHING;

            DROP TABLE IF EXISTS contracts CASCADE;
          END IF;
        EXCEPTION WHEN others THEN
          NULL;
        END $$;

        -- 2. CREATE CORE UNIFIED TABLES IF NOT EXIST
        CREATE TABLE IF NOT EXISTS inventory_items (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          price DOUBLE PRECISION NOT NULL DEFAULT 0,
          purchase_price DOUBLE PRECISION DEFAULT 0,
          quantity INTEGER NOT NULL DEFAULT 0,
          daily_installment DOUBLE PRECISION DEFAULT 0,
          category TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS system_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS shared_pdfs (
          filename TEXT PRIMARY KEY,
          data_base64 TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE IF EXISTS shared_pdfs DISABLE ROW LEVEL SECURITY;

        INSERT INTO system_settings (key, value)
        VALUES ('welcome_message', '{"title":"أهلاً بك في نظام مبيعات الأقساط","subtitle":"اختر القسم الذي تريد الدخول إليه:"}')
        ON CONFLICT (key) DO NOTHING;

        CREATE TABLE IF NOT EXISTS deleted_records (
          record_id TEXT PRIMARY KEY,
          table_name TEXT NOT NULL,
          deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );


        CREATE TABLE IF NOT EXISTS customer_lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          fund_id TEXT,
          description TEXT,
          color TEXT DEFAULT '#3b82f6',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        DO $$ BEGIN
          ALTER TABLE customer_lists ALTER COLUMN fund_id DROP NOT NULL;
        EXCEPTION WHEN others THEN NULL; END $$;
        ALTER TABLE customer_lists ADD COLUMN IF NOT EXISTS order_index INTEGER DEFAULT 0;
        ALTER TABLE customer_lists ADD COLUMN IF NOT EXISTS receipt_template TEXT DEFAULT 'template_1';

        CREATE TABLE IF NOT EXISTS cash_funds (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          balance DOUBLE PRECISION NOT NULL DEFAULT 0,
          description TEXT,
          initial_capital DOUBLE PRECISION DEFAULT 0,
          remaining_capital DOUBLE PRECISION DEFAULT 0,
          total_spent DOUBLE PRECISION DEFAULT 0,
          total_collected DOUBLE PRECISION DEFAULT 0,
          notes TEXT,
          rep_names TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- جدول الزبائن (customers)
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT,
          address TEXT,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          location_address TEXT,
          location_updated_at TEXT,
          location_cleared_at TEXT,
          list_id TEXT,
          list_name TEXT,
          notes TEXT,
          total_purchases DOUBLE PRECISION DEFAULT 0,
          total_paid DOUBLE PRECISION DEFAULT 0,
          remaining_balance DOUBLE PRECISION DEFAULT 0,
          status TEXT DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- جدول المبيعات (sales)
        CREATE TABLE IF NOT EXISTS sales (
          id TEXT PRIMARY KEY,
          sale_number TEXT,
          customer_id TEXT,
          customer_name TEXT NOT NULL,
          customer_phone TEXT NOT NULL,
          customer_address TEXT,
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          location_address TEXT,
          location_updated_at TEXT,
          location_cleared_at TEXT,
          item_id TEXT,
          item_name TEXT NOT NULL,
          item_quantity INTEGER DEFAULT 1,
          purchase_price DOUBLE PRECISION DEFAULT 0,
          list_id TEXT,
          list_name TEXT,
          total_price DOUBLE PRECISION NOT NULL,
          advance_payment DOUBLE PRECISION DEFAULT 0,
          remaining_balance DOUBLE PRECISION NOT NULL,
          daily_installment DOUBLE PRECISION NOT NULL,
          start_date TEXT NOT NULL,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          last_payment_date TEXT,
          total_paid DOUBLE PRECISION DEFAULT 0,
          rep_name TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          updated_at TEXT,
          is_edited BOOLEAN DEFAULT FALSE
        );

        -- Ensure location columns exist on sales and customers
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

        -- Create compatibility view contracts -> sales so that any legacy/external calls never fail
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

        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          amount DOUBLE PRECISION DEFAULT 0,
          amount_paid DOUBLE PRECISION DEFAULT 0,
          payment_date TEXT NOT NULL,
          rep_name TEXT,
          note TEXT,
          fund_id TEXT,
          updated_at TEXT,
          created_at TEXT,
          is_edited BOOLEAN DEFAULT FALSE
        );

        CREATE TABLE IF NOT EXISTS fund_transactions (
          id TEXT PRIMARY KEY,
          fund_id TEXT NOT NULL,
          target_fund_id TEXT,
          type TEXT NOT NULL,
          amount DOUBLE PRECISION NOT NULL,
          note TEXT,
          description TEXT,
          rep_name TEXT,
          created_at TEXT NOT NULL
        );
        ALTER TABLE fund_transactions ADD COLUMN IF NOT EXISTS target_fund_id TEXT;
        ALTER TABLE fund_transactions ADD COLUMN IF NOT EXISTS note TEXT;
        ALTER TABLE fund_transactions ADD COLUMN IF NOT EXISTS description TEXT;

        CREATE TABLE IF NOT EXISTS employees (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT,
          job_title TEXT,
          position TEXT,
          salary DOUBLE PRECISION DEFAULT 0,
          debt_balance DOUBLE PRECISION DEFAULT 0,
          total_debt DOUBLE PRECISION DEFAULT 0,
          is_rep BOOLEAN DEFAULT FALSE,
          rep_id TEXT,
          created_at TEXT
        );
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_title TEXT;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS position TEXT;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS debt_balance DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS total_debt DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_rep BOOLEAN DEFAULT FALSE;
        ALTER TABLE employees ADD COLUMN IF NOT EXISTS rep_id TEXT;

        CREATE TABLE IF NOT EXISTS employee_transactions (
          id TEXT PRIMARY KEY,
          employee_id TEXT NOT NULL,
          fund_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount DOUBLE PRECISION NOT NULL,
          notes TEXT,
          note TEXT,
          date TEXT,
          rep_name TEXT,
          employee_name TEXT,
          created_at TEXT NOT NULL
        );
        ALTER TABLE employee_transactions ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE employee_transactions ADD COLUMN IF NOT EXISTS note TEXT;
        ALTER TABLE employee_transactions ADD COLUMN IF NOT EXISTS date TEXT;
        ALTER TABLE employee_transactions ADD COLUMN IF NOT EXISTS employee_name TEXT;

        CREATE TABLE IF NOT EXISTS reps (
          id TEXT PRIMARY KEY,
          name TEXT,
          phone TEXT,
          code TEXT,
          role TEXT DEFAULT 'rep',
          can_edit BOOLEAN DEFAULT TRUE,
          can_delete BOOLEAN DEFAULT FALSE,
          can_move_customer BOOLEAN DEFAULT TRUE,
          can_sell BOOLEAN DEFAULT TRUE,
          allowed_list_ids TEXT,
          avatar_url TEXT
        );

        -- Ensure avatar_url, pin_hash, pin_version, and offline_verifier columns exist on reps table
        ALTER TABLE reps ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        ALTER TABLE reps ADD COLUMN IF NOT EXISTS pin_hash TEXT;
        ALTER TABLE reps ADD COLUMN IF NOT EXISTS pin_version TEXT;
        ALTER TABLE reps ADD COLUMN IF NOT EXISTS offline_verifier TEXT;

        -- Anti-replay nonce ledger (blocks offline replay & duplicate payment attacks)
        CREATE TABLE IF NOT EXISTS used_nonces (
          nonce TEXT PRIMARY KEY,
          route TEXT,
          action_type TEXT,
          rep_id TEXT,
          amount DOUBLE PRECISION,
          contract_id TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_used_nonces_created_at ON used_nonces (created_at);

        -- Ensure order_index column exists on customer_lists and cash_funds
        ALTER TABLE customer_lists ADD COLUMN IF NOT EXISTS order_index INTEGER DEFAULT 0;
        ALTER TABLE cash_funds ADD COLUMN IF NOT EXISTS order_index INTEGER DEFAULT 0;

        CREATE TABLE IF NOT EXISTS appointments (
          id TEXT PRIMARY KEY,
          contract_id TEXT,
          customer_name TEXT,
          customer_phone TEXT,
          customer_address TEXT,
          list_id TEXT,
          list_name TEXT,
          appointment_type TEXT DEFAULT 'specific_date',
          recurring_day INTEGER,
          recurring_day_name TEXT,
          recurring_day_of_month INTEGER,
          recurring_month_day_name TEXT,
          appointment_date TEXT,
          appointment_time TEXT,
          due_date TEXT,
          due_time TEXT,
          title TEXT,
          notes TEXT,
          note TEXT,
          status TEXT DEFAULT 'pending',
          created_by_name TEXT,
          created_by_rep_name TEXT,
          created_by_rep_id TEXT,
          last_notified_at TEXT,
          updated_at TEXT,
          created_at TEXT
        );

        ALTER TABLE appointments ADD COLUMN IF NOT EXISTS last_notified_at TEXT;
        ALTER TABLE appointments ADD COLUMN IF NOT EXISTS updated_at TEXT;

        CREATE TABLE IF NOT EXISTS payment_conflicts (
          id TEXT PRIMARY KEY,
          contract_id TEXT,
          customer_name TEXT,
          attempted_amount DOUBLE PRECISION DEFAULT 0,
          actual_remaining_balance DOUBLE PRECISION DEFAULT 0,
          excess_amount DOUBLE PRECISION DEFAULT 0,
          rep_name TEXT,
          note TEXT,
          payment_date TEXT,
          created_at TEXT,
          status TEXT DEFAULT 'pending_review',
          resolved_by TEXT,
          resolved_at TEXT,
          resolution_note TEXT,
          accepted_amount DOUBLE PRECISION DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS rep_locations (
          rep_id TEXT PRIMARY KEY,
          rep_name TEXT,
          latitude DOUBLE PRECISION NOT NULL,
          longitude DOUBLE PRECISION NOT NULL,
          accuracy DOUBLE PRECISION,
          speed DOUBLE PRECISION,
          battery INTEGER,
          address TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rep_location_logs (
          id TEXT PRIMARY KEY,
          rep_id TEXT NOT NULL,
          rep_name TEXT,
          latitude DOUBLE PRECISION NOT NULL,
          longitude DOUBLE PRECISION NOT NULL,
          accuracy DOUBLE PRECISION,
          speed DOUBLE PRECISION,
          battery INTEGER,
          created_at TEXT NOT NULL
        );

        -- Enforce PostgreSQL Row-Level Security (RLS) on core financial & customer tables
        -- Context variables are set transaction-locally via executePgWithContext()
        ALTER TABLE IF EXISTS sales ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS sales FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS customers ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS customers FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS payments ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS payments FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS cash_funds ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS cash_funds FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS fund_transactions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS fund_transactions FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS appointments ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS appointments FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS reps ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS reps FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS employees ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS employees FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS employee_transactions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS employee_transactions FORCE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS used_nonces ENABLE ROW LEVEL SECURITY;

        -- Drop legacy permissive policies if any and create strict RBAC RLS policies
        DROP POLICY IF EXISTS rls_sales_select ON sales;
        DROP POLICY IF EXISTS rls_sales_insert ON sales;
        DROP POLICY IF EXISTS rls_sales_update ON sales;
        DROP POLICY IF EXISTS rls_sales_delete ON sales;
        CREATE POLICY rls_sales_select ON sales FOR SELECT USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_sales_insert ON sales FOR INSERT WITH CHECK (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_sales_update ON sales FOR UPDATE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_sales_delete ON sales FOR DELETE USING (
          COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'system')
          OR (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('supervisor', 'rep') AND current_setting('app.can_delete', true) = 'true')
        );

        DROP POLICY IF EXISTS rls_customers_select ON customers;
        DROP POLICY IF EXISTS rls_customers_insert ON customers;
        DROP POLICY IF EXISTS rls_customers_update ON customers;
        DROP POLICY IF EXISTS rls_customers_delete ON customers;
        CREATE POLICY rls_customers_select ON customers FOR SELECT USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_customers_insert ON customers FOR INSERT WITH CHECK (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_customers_update ON customers FOR UPDATE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_customers_delete ON customers FOR DELETE USING (
          COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'system')
          OR (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('supervisor', 'rep') AND current_setting('app.can_delete', true) = 'true')
        );

        DROP POLICY IF EXISTS rls_payments_select ON payments;
        DROP POLICY IF EXISTS rls_payments_insert ON payments;
        DROP POLICY IF EXISTS rls_payments_update ON payments;
        DROP POLICY IF EXISTS rls_payments_delete ON payments;
        CREATE POLICY rls_payments_select ON payments FOR SELECT USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_payments_insert ON payments FOR INSERT WITH CHECK (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_payments_update ON payments FOR UPDATE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_payments_delete ON payments FOR DELETE USING (
          COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'system')
          OR (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('supervisor', 'rep') AND current_setting('app.can_delete', true) = 'true')
        );

        DROP POLICY IF EXISTS rls_funds_select ON cash_funds;
        DROP POLICY IF EXISTS rls_funds_write ON cash_funds;
        DROP POLICY IF EXISTS rls_funds_update ON cash_funds;
        DROP POLICY IF EXISTS rls_funds_delete ON cash_funds;
        CREATE POLICY rls_funds_select ON cash_funds FOR SELECT USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_funds_write ON cash_funds FOR INSERT WITH CHECK (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'system'));
        CREATE POLICY rls_funds_update ON cash_funds FOR UPDATE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'system'));
        CREATE POLICY rls_funds_delete ON cash_funds FOR DELETE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'system'));

        DROP POLICY IF EXISTS rls_ft_select ON fund_transactions;
        DROP POLICY IF EXISTS rls_ft_insert ON fund_transactions;
        DROP POLICY IF EXISTS rls_ft_update ON fund_transactions;
        DROP POLICY IF EXISTS rls_ft_delete ON fund_transactions;
        CREATE POLICY rls_ft_select ON fund_transactions FOR SELECT USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_ft_insert ON fund_transactions FOR INSERT WITH CHECK (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_ft_update ON fund_transactions FOR UPDATE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'system'));
        CREATE POLICY rls_ft_delete ON fund_transactions FOR DELETE USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'system'));

        DROP POLICY IF EXISTS rls_appts_all ON appointments;
        CREATE POLICY rls_appts_all ON appointments FOR ALL USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));

        DROP POLICY IF EXISTS rls_reps_select ON reps;
        DROP POLICY IF EXISTS rls_reps_write ON reps;
        CREATE POLICY rls_reps_select ON reps FOR SELECT USING (true);
        CREATE POLICY rls_reps_write ON reps FOR ALL USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'system'));

        DROP POLICY IF EXISTS rls_employees_select ON employees;
        DROP POLICY IF EXISTS rls_employees_write ON employees;
        CREATE POLICY rls_employees_select ON employees FOR SELECT USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));
        CREATE POLICY rls_employees_write ON employees FOR ALL USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'system'));

        DROP POLICY IF EXISTS rls_emp_tx_all ON employee_transactions;
        CREATE POLICY rls_emp_tx_all ON employee_transactions FOR ALL USING (COALESCE(NULLIF(current_setting('app.current_role', true), ''), 'system') IN ('admin', 'supervisor', 'rep', 'system'));

        DROP POLICY IF EXISTS rls_used_nonces_all ON used_nonces;
        CREATE POLICY rls_used_nonces_all ON used_nonces FOR ALL USING (true);

        ALTER TABLE IF EXISTS inventory_items DISABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS customer_lists DISABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS payment_conflicts DISABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS deleted_records DISABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS system_settings DISABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS rep_locations DISABLE ROW LEVEL SECURITY;
        ALTER TABLE IF EXISTS rep_location_logs DISABLE ROW LEVEL SECURITY;

        -- Create High-Performance Indexes for Ultra-Fast Synchronization and Calculations
        CREATE INDEX IF NOT EXISTS idx_payments_contract_id ON payments (contract_id);
        CREATE INDEX IF NOT EXISTS idx_payments_customer_name ON payments (customer_name);
        CREATE INDEX IF NOT EXISTS idx_payments_payment_date ON payments (payment_date);
        CREATE INDEX IF NOT EXISTS idx_sales_customer_name ON sales (customer_name);
        CREATE INDEX IF NOT EXISTS idx_sales_list_id ON sales (list_id);
        CREATE INDEX IF NOT EXISTS idx_sales_status ON sales (status);
        CREATE INDEX IF NOT EXISTS idx_deleted_records_lookup ON deleted_records (record_id, table_name);

        -- 3. MIGRATE & DEDUPLICATE FROM OLD/REDUNDANT TABLES, THEN DROP OLD TABLES

        -- A. sales_representatives -> reps (دمج المندوبين ومندوبين المبيعات وحذف الزائد)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='sales_representatives') THEN
            INSERT INTO reps (id, name, phone, code, role, can_edit, can_delete, can_move_customer, can_sell, allowed_list_ids)
            SELECT id, name, COALESCE(phone, ''), COALESCE(code, '0000'), COALESCE(role, 'rep'), COALESCE(can_edit, true), COALESCE(can_delete, false), COALESCE(can_move_customer, true), COALESCE(can_sell, true), allowed_list_ids
            FROM sales_representatives
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              phone = EXCLUDED.phone,
              code = EXCLUDED.code,
              role = EXCLUDED.role;
            DROP TABLE sales_representatives CASCADE;
          END IF;
        EXCEPTION WHEN others THEN NULL; END $$;

        -- B. inventory -> inventory_items (المخزن والجرد متكررات - حذف جدول الجرد الزائد)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='inventory') THEN
            INSERT INTO inventory_items (id, name, price, purchase_price, quantity, daily_installment, category, created_at)
            SELECT id, name, price, COALESCE(purchase_price, 0), COALESCE(quantity, 0), COALESCE(daily_installment, 0), category, created_at
            FROM inventory
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              price = EXCLUDED.price,
              quantity = EXCLUDED.quantity;
            DROP TABLE inventory CASCADE;
          END IF;
        EXCEPTION WHEN others THEN NULL; END $$;

        -- C. payment_records -> payments (الدفعات وسجل الدفعات - حذف سجل الدفعات الزائد)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='payment_records') THEN
            INSERT INTO payments (id, contract_id, customer_name, amount, amount_paid, payment_date, rep_name, note, fund_id, created_at, updated_at, is_edited)
            SELECT id, contract_id, customer_name, COALESCE(amount_paid, 0), COALESCE(amount_paid, 0), payment_date, rep_name, note, fund_id, created_at, updated_at, COALESCE(is_edited, false)
            FROM payment_records
            ON CONFLICT (id) DO NOTHING;
            DROP TABLE payment_records CASCADE;
          END IF;
        EXCEPTION WHEN others THEN NULL; END $$;

        -- D. installment_contracts -> sales (المبيعات والأقساط)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='installment_contracts') THEN
            INSERT INTO sales (id, customer_name, customer_phone, customer_address, item_id, item_name, item_quantity, purchase_price, list_id, list_name, total_price, advance_payment, remaining_balance, daily_installment, start_date, notes, status, last_payment_date, total_paid, rep_name, created_at, completed_at, updated_at, is_edited)
            SELECT id, customer_name, customer_phone, customer_address, item_id, item_name, COALESCE(item_quantity, 1), COALESCE(purchase_price, 0), list_id, list_name, total_price, COALESCE(advance_payment, 0), remaining_balance, daily_installment, start_date, notes, COALESCE(status, 'active'), last_payment_date, COALESCE(total_paid, 0), rep_name, created_at, completed_at, updated_at, COALESCE(is_edited, false)
            FROM installment_contracts
            ON CONFLICT (id) DO NOTHING;
            DROP TABLE installment_contracts CASCADE;
          END IF;
        EXCEPTION WHEN others THEN NULL; END $$;

        -- E. funds -> cash_funds (دمج الصناديق في جدول الصندوق المالي الموحد وحذف الجدول الزائد مع إنشاء View للتوافق)
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='funds' AND table_type='BASE TABLE') THEN
            INSERT INTO cash_funds (id, name, balance, description, created_at)
            SELECT id, name, COALESCE(balance, 0), description, created_at
            FROM funds
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              balance = EXCLUDED.balance,
              description = EXCLUDED.description;
            DROP TABLE funds CASCADE;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='funds') THEN
            CREATE OR REPLACE VIEW funds AS SELECT * FROM cash_funds;
          END IF;
        EXCEPTION WHEN others THEN NULL; END $$;

        -- 4. ENSURE ALL COLUMNS AND CONSTRAINTS ARE CONSISTENT FOR SALES & CUSTOMERS
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_address TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_id TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_name TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_quantity INTEGER DEFAULT 1;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS purchase_price DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS list_id TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS list_name TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_price DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS advance_payment DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS remaining_balance DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS daily_installment DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS start_date TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS last_payment_date TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_paid DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS rep_name TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS created_at TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS completed_at TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS updated_at TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE;

        -- Ensure compatibility views are clean and match latest table columns
        DROP VIEW IF EXISTS invoices CASCADE;
        CREATE VIEW invoices AS SELECT * FROM sales;

        DROP VIEW IF EXISTS cash_registers CASCADE;
        CREATE VIEW cash_registers AS SELECT * FROM cash_funds;

        DROP VIEW IF EXISTS representatives CASCADE;
        CREATE VIEW representatives AS SELECT * FROM reps;

        DROP VIEW IF EXISTS cash_operations CASCADE;
        CREATE VIEW cash_operations AS SELECT * FROM fund_transactions;

        DROP VIEW IF EXISTS funds CASCADE;
        CREATE VIEW funds AS SELECT * FROM cash_funds;

        ALTER TABLE customers ADD COLUMN IF NOT EXISTS name TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS list_id TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS list_name TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_purchases DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_paid DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS remaining_balance DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_updated_at TEXT;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS location_cleared_at TEXT;
        ALTER TABLE sales ADD COLUMN IF NOT EXISTS location_cleared_at TEXT;

        ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_paid DOUBLE PRECISION DEFAULT 0;
        ALTER TABLE payments ALTER COLUMN amount_paid DROP NOT NULL;
        ALTER TABLE payments ALTER COLUMN amount DROP NOT NULL;
        ALTER TABLE payments ALTER COLUMN amount_paid SET DEFAULT 0;
        ALTER TABLE payments ALTER COLUMN amount SET DEFAULT 0;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TEXT;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
        ALTER TABLE payments ADD COLUMN IF NOT EXISTS nonce TEXT;
        UPDATE payments SET amount = COALESCE(amount, amount_paid, 0) WHERE amount IS NULL OR amount = 0;
        UPDATE payments SET amount_paid = COALESCE(amount_paid, amount, 0) WHERE amount_paid IS NULL OR amount_paid = 0;

        -- 5. FUNCTION AND TRIGGERS ON PAYMENTS & SALES
        CREATE OR REPLACE FUNCTION recalc_contract_balance_on_payment_change()
        RETURNS TRIGGER AS $$
        DECLARE
          v_cid_old TEXT := NULL;
          v_cname_old TEXT := NULL;
          v_cid_new TEXT := NULL;
          v_cname_new TEXT := NULL;
        BEGIN
          IF TG_OP = 'DELETE' THEN
            v_cid_old := OLD.contract_id;
            v_cname_old := OLD.customer_name;
          ELSIF TG_OP = 'UPDATE' THEN
            v_cid_old := OLD.contract_id;
            v_cname_old := OLD.customer_name;
            v_cid_new := NEW.contract_id;
            v_cname_new := NEW.customer_name;
          ELSE
            v_cid_new := NEW.contract_id;
            v_cname_new := NEW.customer_name;
          END IF;

          -- Update sales for all affected sales
          UPDATE sales c
          SET 
            total_paid = CASE
              WHEN EXISTS (SELECT 1 FROM payments p WHERE p.contract_id = c.id OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name)))
              THEN COALESCE((
                SELECT SUM(COALESCE(p.amount_paid, p.amount, 0))
                FROM payments p
                WHERE (p.contract_id = c.id) OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name))
              ), 0)
              ELSE COALESCE(c.total_paid, 0)
            END,
            remaining_balance = GREATEST(0, (COALESCE(c.total_price, 0) - COALESCE(c.advance_payment, 0)) - CASE
              WHEN EXISTS (SELECT 1 FROM payments p WHERE p.contract_id = c.id OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name)))
              THEN COALESCE((
                SELECT SUM(COALESCE(p.amount_paid, p.amount, 0))
                FROM payments p
                WHERE (p.contract_id = c.id) OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name))
              ), 0)
              ELSE COALESCE(c.total_paid, 0)
            END),
            last_payment_date = COALESCE(
              (
                SELECT MAX(p.payment_date)
                FROM payments p
                WHERE (p.contract_id = c.id) OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name))
              ),
              c.last_payment_date
            ),
            status = CASE 
              WHEN GREATEST(0, (COALESCE(c.total_price, 0) - COALESCE(c.advance_payment, 0)) - CASE
                WHEN EXISTS (SELECT 1 FROM payments p WHERE p.contract_id = c.id OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name)))
                THEN COALESCE((
                  SELECT SUM(COALESCE(p.amount_paid, p.amount, 0))
                  FROM payments p
                  WHERE (p.contract_id = c.id) OR ((p.contract_id IS NULL OR p.contract_id = '') AND (TRIM(LOWER(p.customer_name)) = TRIM(LOWER(c.customer_name)) OR p.customer_name = c.customer_name))
                ), 0)
                ELSE COALESCE(c.total_paid, 0)
              END) = 0 THEN 'completed'
              ELSE 'active'
            END
          WHERE (v_cid_old IS NOT NULL AND v_cid_old != '' AND c.id = v_cid_old)
             OR ((v_cid_old IS NULL OR v_cid_old = '') AND v_cname_old IS NOT NULL AND (TRIM(LOWER(c.customer_name)) = TRIM(LOWER(v_cname_old)) OR c.customer_name = v_cname_old))
             OR (v_cid_new IS NOT NULL AND v_cid_new != '' AND c.id = v_cid_new)
             OR ((v_cid_new IS NULL OR v_cid_new = '') AND v_cname_new IS NOT NULL AND (TRIM(LOWER(c.customer_name)) = TRIM(LOWER(v_cname_new)) OR c.customer_name = v_cname_new));

          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_payments_change ON payments;
        CREATE TRIGGER trg_payments_change
        AFTER INSERT OR UPDATE OR DELETE ON payments
        FOR EACH ROW EXECUTE FUNCTION recalc_contract_balance_on_payment_change();

        CREATE OR REPLACE FUNCTION recalc_contract_on_contract_change()
        RETURNS TRIGGER AS $$
        DECLARE
          v_paid DOUBLE PRECISION := 0;
          v_last_d TEXT := NULL;
        BEGIN
          SELECT COALESCE(SUM(amount), 0), MAX(payment_date)
          INTO v_paid, v_last_d
          FROM payments
          WHERE (contract_id = NEW.id) OR ((contract_id IS NULL OR contract_id = '') AND customer_name = NEW.customer_name);

          IF v_paid > 0 OR NEW.total_paid IS NULL THEN
            NEW.total_paid := v_paid;
          END IF;

          NEW.remaining_balance := GREATEST(0, (COALESCE(NEW.total_price, 0) - COALESCE(NEW.advance_payment, 0)) - COALESCE(NEW.total_paid, 0));
          
          IF v_last_d IS NOT NULL AND v_last_d != '' THEN
            NEW.last_payment_date := v_last_d;
          END IF;

          IF NEW.remaining_balance <= 0 THEN
            NEW.status := 'completed';
          ELSE
            NEW.status := 'active';
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_sales_recalc ON sales;
        CREATE TRIGGER trg_sales_recalc
        BEFORE INSERT OR UPDATE OF total_price, advance_payment ON sales
        FOR EACH ROW EXECUTE FUNCTION recalc_contract_on_contract_change();
      `);
      console.log('PostgreSQL Database schema initialized & verified (cleaned duplicate tables)!');

      // Migrate existing local FileDB data into PostgreSQL only once on very first system initialization
      const initCheck = await client.query(`SELECT value FROM system_settings WHERE key = 'schema_init_completed' LIMIT 1`).catch(() => ({ rows: [] }));
      if (initCheck.rows.length === 0) {
        await migrateFileDbToPostgres(client);
        await client.query(`INSERT INTO system_settings (key, value) VALUES ('schema_init_completed', 'true') ON CONFLICT (key) DO NOTHING`).catch(() => {});
      }

      // Clean up any invalid sales records that originated from payments/transactions/etc.
      await client.query(
        `DELETE FROM sales WHERE id LIKE 'pay_%' OR id LIKE 'ft_%' OR id LIKE 'emptx_%' OR id LIKE 'conflict_%'`
      ).catch(() => {});

      // Clean up any historic 'unknown' deleted_records to prevent accidental customer/contract deletions
      await client.query(
        `DELETE FROM deleted_records WHERE table_name = 'unknown'`
      ).catch(() => {});

      // Sync customers table from real sales records only
      await client.query(`
        INSERT INTO customers (id, name, phone, address, list_id, list_name, remaining_balance, total_paid, total_purchases, status)
        SELECT 
          COALESCE(c.customer_id, 'cust-' || md5(TRIM(c.customer_name))) as id,
          c.customer_name as name,
          MAX(c.customer_phone) as phone,
          MAX(c.customer_address) as address,
          MAX(c.list_id) as list_id,
          MAX(c.list_name) as list_name,
          SUM(COALESCE(c.remaining_balance, 0)) as remaining_balance,
          SUM(COALESCE(c.total_paid, 0)) as total_paid,
          SUM(COALESCE(c.total_price, 0)) as total_purchases,
          'active' as status
        FROM sales c
        WHERE c.customer_name IS NOT NULL 
          AND TRIM(c.customer_name) != ''
          AND c.id NOT LIKE 'pay_%'
          AND c.id NOT LIKE 'ft_%'
          AND c.id NOT LIKE 'emptx_%'
          AND c.id NOT LIKE 'conflict_%'
        GROUP BY COALESCE(c.customer_id, 'cust-' || md5(TRIM(c.customer_name))), c.customer_name
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          phone = COALESCE(EXCLUDED.phone, customers.phone),
          address = COALESCE(EXCLUDED.address, customers.address),
          list_id = COALESCE(EXCLUDED.list_id, customers.list_id),
          list_name = COALESCE(EXCLUDED.list_name, customers.list_name),
          remaining_balance = EXCLUDED.remaining_balance,
          total_paid = EXCLUDED.total_paid,
          total_purchases = EXCLUDED.total_purchases;
      `).catch(() => {});

    } finally {
      client.release();
    }
  } catch (err) {
    console.warn('PostgreSQL Schema Initialization warning:', err);
  }
}

async function migrateFileDbToPostgres(client: any) {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) return;

  const readJson = (filename: string): any[] => {
    try {
      const p = path.join(dataDir, filename);
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      // ignore
    }
    return [];
  };

  const customerLists = readJson('customer_lists.json');
  const inventoryItems = readJson('inventory_items.json');
  const cashFunds = readJson('cash_funds.json');
  const reps = readJson('reps.json');
  const employees = readJson('employees.json');
  const employeeTransactions = readJson('employee_transactions.json');
  const appointments = readJson('appointments.json');
  const paymentConflicts = readJson('payment_conflicts.json');
  const fundTransactions = readJson('fund_transactions.json');
  const payments = readJson('payments.json');
  const contracts = readJson('contracts.json');
  const deletedRecords = readJson('deleted_records.json');

  const hasAuthoritativeFileData =
    contracts.length > 0 ||
    payments.length > 0 ||
    fundTransactions.length > 0 ||
    cashFunds.length > 0 ||
    reps.length > 0;

  if (!hasAuthoritativeFileData) {
    return;
  }

  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(987654321)`);
    await client.query(`SELECT set_config('app.current_role', 'system', true)`);

    // Re-check inside lock so concurrent startups never duplicate or truncate twice
    const alreadyDone = await client.query(`SELECT value FROM system_settings WHERE key = 'schema_init_completed' LIMIT 1`);
    if (alreadyDone.rows.length > 0) {
      await client.query('COMMIT');
      return;
    }

    // Clear stale prototype seed records before loading the authoritative FileDB dataset
    await client.query(`
      TRUNCATE TABLE
        sales,
        payments,
        fund_transactions,
        cash_funds,
        customer_lists,
        inventory_items,
        reps,
        employees,
        employee_transactions,
        appointments,
        payment_conflicts,
        customers
      CASCADE
    `);

    for (const l of customerLists) {
      if (!l?.id) continue;
      await client.query(
        `INSERT INTO customer_lists (id, name, fund_id, description, order_index, receipt_template, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           fund_id = EXCLUDED.fund_id,
           description = EXCLUDED.description,
           order_index = EXCLUDED.order_index,
           receipt_template = EXCLUDED.receipt_template`,
        [
          String(l.id),
          l.name || '',
          l.fundId || null,
          l.description || '',
          Number(l.orderIndex ?? l.order_index ?? 0) || 0,
          l.receiptTemplate || l.receipt_template || 'template_1',
          l.createdAt || new Date().toISOString(),
        ]
      );
    }

    for (const item of inventoryItems) {
      if (!item?.id) continue;
      await client.query(
        `INSERT INTO inventory_items (id, name, price, purchase_price, quantity, daily_installment, category)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           price = EXCLUDED.price,
           purchase_price = EXCLUDED.purchase_price,
           quantity = EXCLUDED.quantity,
           daily_installment = EXCLUDED.daily_installment,
           category = EXCLUDED.category`,
        [
          String(item.id),
          item.name || '',
          Number(item.price ?? item.sellingPrice) || 0,
          Number(item.purchasePrice) || 0,
          Number(item.quantity) || 0,
          Number(item.dailyInstallment) || 0,
          item.category || '',
        ]
      );
    }

    for (const f of cashFunds) {
      if (!f?.id) continue;
      await client.query(
        `INSERT INTO cash_funds (id, name, balance, description, order_index)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           balance = EXCLUDED.balance,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           order_index = EXCLUDED.order_index`,
        [
          String(f.id),
          f.name || '',
          Number(f.balance) || 0,
          f.description || '',
          Number(f.orderIndex ?? f.order_index ?? 0) || 0,
        ]
      );
    }

    for (const r of reps) {
      if (!r?.id) continue;
      const allowed = Array.isArray(r.allowedListIds)
        ? JSON.stringify(r.allowedListIds)
        : (typeof r.allowedListIds === 'string' ? r.allowedListIds : JSON.stringify(['all']));
      await client.query(
        `INSERT INTO reps (id, name, phone, code, pin_version, offline_verifier, role, can_edit, can_delete, can_move_customer, can_sell, allowed_list_ids, avatar_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           code = EXCLUDED.code,
           pin_version = COALESCE(EXCLUDED.pin_version, reps.pin_version),
           offline_verifier = COALESCE(EXCLUDED.offline_verifier, reps.offline_verifier),
           role = EXCLUDED.role,
           can_edit = EXCLUDED.can_edit,
           can_delete = EXCLUDED.can_delete,
           can_move_customer = EXCLUDED.can_move_customer,
           can_sell = EXCLUDED.can_sell,
           allowed_list_ids = EXCLUDED.allowed_list_ids,
           avatar_url = COALESCE(EXCLUDED.avatar_url, reps.avatar_url)`,
        [
          String(r.id),
          r.name || '',
          r.phone || '',
          r.code || '',
          r.pinVersion || r.pin_version || null,
          r.offlineVerifier || r.offline_verifier || null,
          r.role || 'rep',
          r.canEdit !== false,
          Boolean(r.canDelete),
          r.canMoveCustomer !== false,
          r.canSell !== false,
          allowed,
          r.avatarUrl || r.avatar_url || null,
        ]
      );
    }

    for (const emp of employees) {
      if (!emp?.id) continue;
      await client.query(
        `INSERT INTO employees (id, name, phone, job_title, position, salary, debt_balance, total_debt, is_rep, rep_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           job_title = EXCLUDED.job_title,
           position = EXCLUDED.position,
           salary = EXCLUDED.salary,
           debt_balance = EXCLUDED.debt_balance,
           total_debt = EXCLUDED.total_debt`,
        [
          String(emp.id),
          emp.name || '',
          emp.phone || '',
          emp.jobTitle || emp.job_title || '',
          emp.position || '',
          Number(emp.salary) || 0,
          Number(emp.debtBalance ?? emp.debt_balance) || 0,
          Number(emp.totalDebt ?? emp.total_debt) || 0,
          Boolean(emp.isRep ?? emp.is_rep),
          emp.repId || emp.rep_id || null,
          emp.createdAt || emp.created_at || new Date().toISOString(),
        ]
      );
    }

    for (const tx of employeeTransactions) {
      if (!tx?.id) continue;
      await client.query(
        `INSERT INTO employee_transactions (id, employee_id, fund_id, type, amount, notes, note, date, rep_name, employee_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          String(tx.id),
          String(tx.employeeId || tx.employee_id || ''),
          String(tx.fundId || tx.fund_id || ''),
          tx.type || 'advance',
          Number(tx.amount) || 0,
          tx.notes || '',
          tx.note || tx.notes || '',
          tx.date || '',
          tx.repName || tx.rep_name || '',
          tx.employeeName || tx.employee_name || '',
          tx.createdAt || tx.created_at || new Date().toISOString(),
        ]
      );
    }

    for (const a of appointments) {
      if (!a?.id) continue;
      await client.query(
        `INSERT INTO appointments (id, contract_id, customer_name, customer_phone, customer_address, list_id, list_name, appointment_type, recurring_day, recurring_day_name, recurring_day_of_month, recurring_month_day_name, appointment_date, appointment_time, due_date, due_time, title, notes, note, status, created_by_name, created_by_rep_name, created_by_rep_id, last_notified_at, updated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (id) DO NOTHING`,
        [
          String(a.id),
          a.contractId || a.contract_id || null,
          a.customerName || a.customer_name || '',
          a.customerPhone || a.customer_phone || '',
          a.customerAddress || a.customer_address || '',
          a.listId || a.list_id || null,
          a.listName || a.list_name || null,
          a.appointmentType || a.appointment_type || 'specific_date',
          a.recurringDay ?? a.recurring_day ?? null,
          a.recurringDayName || a.recurring_day_name || null,
          a.recurringDayOfMonth ?? a.recurring_day_of_month ?? null,
          a.recurringMonthDayName || a.recurring_month_day_name || null,
          a.appointmentDate || a.appointment_date || null,
          a.appointmentTime || a.appointment_time || null,
          a.dueDate || a.due_date || null,
          a.dueTime || a.due_time || null,
          a.title || '',
          a.notes || '',
          a.note || a.notes || '',
          a.status || 'pending',
          a.createdByName || a.created_by_name || '',
          a.createdByRepName || a.created_by_rep_name || '',
          a.createdByRepId || a.created_by_rep_id || '',
          a.lastNotifiedAt || a.last_notified_at || null,
          a.updatedAt || a.updated_at || null,
          a.createdAt || a.created_at || new Date().toISOString(),
        ]
      );
    }

    for (const pc of paymentConflicts) {
      if (!pc?.id) continue;
      await client.query(
        `INSERT INTO payment_conflicts (id, contract_id, customer_name, attempted_amount, actual_remaining_balance, excess_amount, rep_name, note, payment_date, created_at, status, resolved_by, resolved_at, resolution_note, accepted_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          String(pc.id),
          pc.contractId || pc.contract_id || null,
          pc.customerName || pc.customer_name || '',
          Number(pc.attemptedAmount ?? pc.attempted_amount) || 0,
          Number(pc.actualRemainingBalance ?? pc.actual_remaining_balance) || 0,
          Number(pc.excessAmount ?? pc.excess_amount) || 0,
          pc.repName || pc.rep_name || '',
          pc.note || '',
          pc.paymentDate || pc.payment_date || '',
          pc.createdAt || pc.created_at || new Date().toISOString(),
          pc.status || 'pending_review',
          pc.resolvedBy || pc.resolved_by || null,
          pc.resolvedAt || pc.resolved_at || null,
          pc.resolutionNote || pc.resolution_note || null,
          Number(pc.acceptedAmount ?? pc.accepted_amount) || 0,
        ]
      );
    }

    const validFt = fundTransactions.filter((ft) => ft?.id);
    if (validFt.length > 0) {
      await client.query(
        `INSERT INTO fund_transactions (id, fund_id, target_fund_id, type, amount, note, description, rep_name, created_at)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::double precision[], $6::text[], $7::text[], $8::text[], $9::text[])
         ON CONFLICT (id) DO NOTHING`,
        [
          validFt.map((ft) => String(ft.id)),
          validFt.map((ft) => String(ft.fundId || ft.fund_id || '')),
          validFt.map((ft) => ft.targetFundId || ft.target_fund_id || null),
          validFt.map((ft) => ft.type || 'deposit'),
          validFt.map((ft) => Number(ft.amount) || 0),
          validFt.map((ft) => ft.note || ''),
          validFt.map((ft) => ft.description || ft.note || ''),
          validFt.map((ft) => ft.repName || ft.rep_name || ''),
          validFt.map((ft) => ft.createdAt || ft.created_at || new Date().toISOString()),
        ]
      );
    }

    // Batch insert payments before sales so trg_sales_recalc runs only once per contract
    const validPayments = payments.filter((p) => p?.id);
    if (validPayments.length > 0) {
      await client.query(
        `INSERT INTO payments (id, contract_id, customer_name, amount, amount_paid, payment_date, rep_name, note, fund_id, latitude, longitude, updated_at, created_at, is_edited)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::double precision[], $5::double precision[], $6::text[], $7::text[], $8::text[], $9::text[], $10::double precision[], $11::double precision[], $12::text[], $13::text[], $14::boolean[])
         ON CONFLICT (id) DO NOTHING`,
        [
          validPayments.map((p) => String(p.id)),
          validPayments.map((p) => String(p.contractId || p.contract_id || '')),
          validPayments.map((p) => p.customerName || p.customer_name || ''),
          validPayments.map((p) => Number(p.amountPaid ?? p.amount_paid ?? p.amount) || 0),
          validPayments.map((p) => Number(p.amountPaid ?? p.amount_paid ?? p.amount) || 0),
          validPayments.map((p) => p.paymentDate || p.payment_date || new Date().toISOString().split('T')[0]),
          validPayments.map((p) => p.repName || p.rep_name || ''),
          validPayments.map((p) => p.note || ''),
          validPayments.map((p) => p.fundId || p.fund_id || null),
          validPayments.map((p) => (p.latitude != null ? Number(p.latitude) : null)),
          validPayments.map((p) => (p.longitude != null ? Number(p.longitude) : null)),
          validPayments.map((p) => p.updatedAt || p.updated_at || null),
          validPayments.map((p) => p.createdAt || p.created_at || new Date().toISOString()),
          validPayments.map((p) => Boolean(p.isEdited ?? p.is_edited)),
        ]
      );
    }

    const validContracts = contracts.filter((c) => c?.id);
    if (validContracts.length > 0) {
      await client.query(
        `INSERT INTO sales (
           id, customer_id, customer_name, customer_phone, customer_address,
           latitude, longitude, location_address, location_updated_at, location_cleared_at,
           item_id, item_name, item_quantity, purchase_price,
           list_id, list_name, total_price, advance_payment,
           remaining_balance, daily_installment, start_date, notes,
           status, last_payment_date, total_paid, rep_name,
           created_at, completed_at, updated_at, is_edited
         )
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
           $6::double precision[], $7::double precision[], $8::text[], $9::text[], $10::text[],
           $11::text[], $12::text[], $13::integer[], $14::double precision[],
           $15::text[], $16::text[], $17::double precision[], $18::double precision[],
           $19::double precision[], $20::double precision[], $21::text[], $22::text[],
           $23::text[], $24::text[], $25::double precision[], $26::text[],
           $27::text[], $28::text[], $29::text[], $30::boolean[]
         )
         ON CONFLICT (id) DO UPDATE SET
           customer_name = EXCLUDED.customer_name,
           customer_phone = EXCLUDED.customer_phone,
           customer_address = EXCLUDED.customer_address,
           list_id = EXCLUDED.list_id,
           list_name = EXCLUDED.list_name,
           total_price = EXCLUDED.total_price,
           advance_payment = EXCLUDED.advance_payment,
           remaining_balance = EXCLUDED.remaining_balance,
           total_paid = EXCLUDED.total_paid,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [
          validContracts.map((c) => String(c.id)),
          validContracts.map((c) => c.customerId || c.customer_id || null),
          validContracts.map((c) => c.customerName || c.customer_name || ''),
          validContracts.map((c) => c.customerPhone || c.customer_phone || ''),
          validContracts.map((c) => c.customerAddress || c.customer_address || ''),
          validContracts.map((c) => (c.latitude != null ? Number(c.latitude) : null)),
          validContracts.map((c) => (c.longitude != null ? Number(c.longitude) : null)),
          validContracts.map((c) => c.locationAddress || c.location_address || ''),
          validContracts.map((c) => c.locationUpdatedAt || c.location_updated_at || null),
          validContracts.map((c) => c.locationClearedAt || c.location_cleared_at || null),
          validContracts.map((c) => c.itemId || c.item_id || null),
          validContracts.map((c) => c.itemName || c.item_name || ''),
          validContracts.map((c) => Number(c.itemQuantity ?? c.item_quantity ?? 1) || 1),
          validContracts.map((c) => Number(c.purchasePrice ?? c.purchase_price) || 0),
          validContracts.map((c) => c.listId || c.list_id || null),
          validContracts.map((c) => c.listName || c.list_name || null),
          validContracts.map((c) => Number(c.totalPrice ?? c.total_price) || 0),
          validContracts.map((c) => Number(c.advancePayment ?? c.advance_payment) || 0),
          validContracts.map((c) => Number(c.remainingBalance ?? c.remaining_balance) || 0),
          validContracts.map((c) => Number(c.dailyInstallment ?? c.daily_installment) || 0),
          validContracts.map((c) => c.startDate || c.start_date || new Date().toISOString().split('T')[0]),
          validContracts.map((c) => c.notes || ''),
          validContracts.map((c) => c.status || 'active'),
          validContracts.map((c) => c.lastPaymentDate || c.last_payment_date || null),
          validContracts.map((c) => Number(c.totalPaid ?? c.total_paid) || 0),
          validContracts.map((c) => c.repName || c.rep_name || ''),
          validContracts.map((c) => c.createdAt || c.created_at || new Date().toISOString()),
          validContracts.map((c) => c.completedAt || c.completed_at || null),
          validContracts.map((c) => c.updatedAt || c.updated_at || null),
          validContracts.map((c) => Boolean(c.isEdited ?? c.is_edited)),
        ]
      );
    }

    for (const d of deletedRecords) {
      if (!d?.recordId && !d?.record_id) continue;
      const recId = String(d.recordId || d.record_id);
      const tbl = String(d.tableName || d.table_name || '');
      if (!tbl || tbl === 'unknown') continue;
      await client.query(
        `INSERT INTO deleted_records (record_id, table_name) VALUES ($1, $2) ON CONFLICT (record_id) DO NOTHING`,
        [recId, tbl]
      );
    }

    await client.query('COMMIT');
    console.log(`Migrated authoritative FileDB records into PostgreSQL (${validContracts.length} sales, ${validPayments.length} payments, ${validFt.length} fund_transactions, ${reps.length} reps).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
