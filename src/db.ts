import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Schema migrations, applied in order and tracked with SQLite's `user_version` pragma.
 * Append new entries; never edit an applied one. Money is integer pence (GBP).
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE billing_accounts (
    id TEXT PRIMARY KEY,
    -- Reference into the customer daemon (cus_…). Not a foreign key: different database.
    customer_id TEXT NOT NULL,
    account_number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
    suspension_reason TEXT CHECK (suspension_reason IN ('arrears')),
    monthly_charge_pence INTEGER NOT NULL CHECK (monthly_charge_pence >= 0),
    billing_day INTEGER NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
    payment_method TEXT NOT NULL CHECK (payment_method IN ('direct_debit', 'card')),
    -- Payment details are stored masked only, as a real biller's own systems would after tokenising.
    dd_sort_code_masked TEXT,
    dd_account_last4 TEXT,
    dd_mandate_reference TEXT,
    card_brand TEXT,
    card_last4 TEXT,
    card_expiry TEXT, -- YYYY-MM
    billing_address_line_1 TEXT,
    billing_address_line_2 TEXT,
    billing_town TEXT,
    billing_county TEXT,
    billing_postcode TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX billing_accounts_customer ON billing_accounts (customer_id);
  CREATE INDEX billing_accounts_billing_day ON billing_accounts (billing_day, status);

  CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES billing_accounts (id),
    invoice_number TEXT NOT NULL UNIQUE,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    issued_on TEXT NOT NULL,
    due_on TEXT NOT NULL,
    line_items TEXT NOT NULL, -- JSON [{ description, amount_pence }]
    amount_pence INTEGER NOT NULL CHECK (amount_pence >= 0),
    status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'overdue')),
    paid_on TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- One invoice per account per billing period: re-running a day can't double-bill.
    UNIQUE (account_id, period_start)
  );
  CREATE INDEX invoices_account ON invoices (account_id, issued_on);
  CREATE INDEX invoices_collectable ON invoices (status, due_on);

  CREATE TABLE payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices (id),
    account_id TEXT NOT NULL REFERENCES billing_accounts (id),
    attempt INTEGER NOT NULL,
    initiated_by TEXT NOT NULL CHECK (initiated_by IN ('scheduled', 'customer')),
    method TEXT NOT NULL CHECK (method IN ('direct_debit', 'card')),
    amount_pence INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
    failure_code TEXT,
    failure_message TEXT,
    processor_reference TEXT NOT NULL,
    attempted_on TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- Each attempt happens once, however many times the day is replayed.
    UNIQUE (invoice_id, attempt)
  );
  CREATE INDEX payments_account ON payments (account_id, attempted_on);

  CREATE TABLE billing_runs (
    run_date TEXT PRIMARY KEY,
    invoices_issued INTEGER NOT NULL,
    amount_invoiced_pence INTEGER NOT NULL,
    payments_attempted INTEGER NOT NULL,
    payments_succeeded INTEGER NOT NULL,
    payments_failed INTEGER NOT NULL,
    amount_collected_pence INTEGER NOT NULL,
    accounts_suspended INTEGER NOT NULL,
    accounts_reactivated INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );

  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO counters VALUES ('invoice_number', 0);
  `,
  // Transactional outbox: domain events are written in the same transaction as the change they
  // describe, then published to the Redis stream by src/events.ts. Nothing is lost or invented.
  `
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
  `,
  // Billing's own copy of each account's lines, kept current from the subscription daemon's
  // events (src/subscriptions.ts). Invoices charge one item per line from these.
  `
  CREATE TABLE billable_lines (
    line_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    msisdn TEXT NOT NULL,
    tariff_name TEXT NOT NULL,
    monthly_price_pence INTEGER NOT NULL,
    started_on TEXT NOT NULL,
    ceased_on TEXT
  );
  CREATE INDEX billable_lines_account ON billable_lines (account_id);
  `,
  // Each line's allowances (carried on line.started / line.restated), so usage can be rated
  // against them. allowances_known = 0 until an event with allowances arrives: such lines are
  // charged their plan price but never out-of-bundle extras. NULL quantities are unlimited.
  `
  ALTER TABLE billable_lines ADD COLUMN tariff_id TEXT;
  ALTER TABLE billable_lines ADD COLUMN allowances_known INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE billable_lines ADD COLUMN minutes INTEGER;
  ALTER TABLE billable_lines ADD COLUMN texts INTEGER;
  ALTER TABLE billable_lines ADD COLUMN data_mb INTEGER;
  ALTER TABLE billable_lines ADD COLUMN eu_roaming INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE billable_lines ADD COLUMN international_roaming INTEGER NOT NULL DEFAULT 0;
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { strict: true, create: true });

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");

  const { user_version: current } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.run(MIGRATIONS[version]!);
      db.run(`PRAGMA user_version = ${version + 1}`);
    })();
  }

  return db;
}
