
const Database = require('better-sqlite3');
const db = new Database('invoices.db');

// Create invoice table
db.exec(`
  CREATE TABLE IF NOT EXISTS customers_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    amount_due REAL NOT NULL,
    due_date TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    promised_pay_date TEXT,
    dispute_reason TEXT,
    last_call_id TEXT,
    last_transcript TEXT,
    last_recording TEXT
  )
`);

// Store automatic follow-up attempts
db.exec(`
  CREATE TABLE IF NOT EXISTS followup_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    attempt_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    execution_id TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(invoice_id, attempt_date)
  )
`);

// Store failed Supabase writes for retry
db.exec(`
  CREATE TABLE IF NOT EXISTS supabase_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

// Safe database migrations
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();

  if (cols.some((c) => c.name === column)) {
    return false;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// Payment fields
const addedState = addColumn(
  'customers_invoices',
  'payment_state',
  "TEXT NOT NULL DEFAULT 'pending'"
);

addColumn('customers_invoices', 'payment_mode', 'TEXT');
addColumn('customers_invoices', 'last_call_at', 'TEXT');
addColumn('customers_invoices', 'invoice_number', 'TEXT');
addColumn('customers_invoices', 'payment_date', 'TEXT');

// Tally sync fields
addColumn('customers_invoices', 'source', 'TEXT');
addColumn(
  'customers_invoices',
  'tally_closed',
  'INTEGER NOT NULL DEFAULT 0'
);
addColumn('customers_invoices', 'tally_synced_at', 'TEXT');

// Generate invoice numbers for existing records
db.exec(`
  UPDATE customers_invoices
  SET invoice_number = 'INV-' || (1000 + id)
  WHERE invoice_number IS NULL OR invoice_number = ''
`);

// Normalize payment modes
db.exec(`
  UPDATE customers_invoices
  SET payment_mode = NULL
  WHERE payment_mode IS NOT NULL
    AND LOWER(TRIM(payment_mode))
    IN ('', 'not specified', 'unknown', 'none', 'null');

  UPDATE customers_invoices
  SET payment_mode = 'Bank transfer'
  WHERE payment_mode = 'Bank Transfer';
`);

if (addedState) {
  db.exec(`
    UPDATE customers_invoices
    SET payment_state = 'done'
    WHERE LOWER(payment_status)
    IN ('paid', 'paid_on_call', 'payment done', 'payment_done');

    UPDATE customers_invoices
    SET payment_state = 'unclear'
    WHERE LOWER(payment_status) = 'wrong_number';
  `);
}

// Migrate follow-up attempts to morning/evening slots
const attemptCols = db
  .prepare('PRAGMA table_info(followup_attempts)')
  .all();

if (!attemptCols.some((c) => c.name === 'slot')) {
  db.exec(`
    BEGIN;

    ALTER TABLE followup_attempts
    RENAME TO followup_attempts_old;

    CREATE TABLE followup_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      attempt_date TEXT NOT NULL,
      slot TEXT NOT NULL DEFAULT 'morning',
      status TEXT NOT NULL DEFAULT 'starting',
      execution_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(invoice_id, attempt_date, slot)
    );

    INSERT INTO followup_attempts (
      id,
      invoice_id,
      attempt_date,
      slot,
      status,
      execution_id,
      error_message,
      created_at
    )
    SELECT
      id,
      invoice_id,
      attempt_date,
      'morning',
      status,
      execution_id,
      error_message,
      created_at
    FROM followup_attempts_old;

    DROP TABLE followup_attempts_old;

    COMMIT;
  `);
}

module.exports = db;
