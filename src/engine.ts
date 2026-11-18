import type { Database } from "bun:sqlite";
import { charge } from "./processor";
import type { AccountRow, BillableLineRow, InvoiceRow, LineItem, RunSummary } from "./types";
import { rateUsage, type LineAllowances, type Usage, type UsageRequest, type UsageSource } from "./usage";
import { addDays, addMonths, chance, createMutex, daysBetween, newId, seededRandom, toNational, type IsoDate } from "./util";

/** Days between an invoice being issued and payment being collected. */
export const PAYMENT_TERMS_DAYS = 14;
/** Scheduled collection attempts per invoice before it goes overdue and the account is suspended. */
export const MAX_SCHEDULED_ATTEMPTS = 3;
/** Days between scheduled retries. */
export const RETRY_INTERVAL_DAYS = 3;
/** Daily chance that a customer with an overdue bill pays it themselves. */
const SELF_SERVE_PAYMENT_CHANCE = 0.12;

/**
 * The part of the billing period before `date` (the previous one) that a line was live for,
 * as `[from, to)`, or null if it wasn't live then. Extras and part-month charges cover this.
 */
function usageWindow(line: Pick<BillableLineRow, "started_on" | "ceased_on">, date: IsoDate): { from: IsoDate; to: IsoDate } | null {
  const previousStart = addMonths(date, -1);
  const from = line.started_on > previousStart ? line.started_on : previousStart;
  const to = line.ceased_on !== null && line.ceased_on < date ? line.ceased_on : date;
  return from < to ? { from, to } : null;
}

/** Timestamps for run output: the run "happens" at 02:00 on its business date. */
const runTimestamp = (date: IsoDate) => `${date}T02:00:00.000Z`;

/**
 * The daily billing run. For a business date it:
 *
 *   1. issues invoices to every open account whose billing day it is;
 *   2. collects due invoices, retrying failures every few days, then suspends for arrears;
 *   3. takes customer-initiated payments on overdue invoices;
 *   4. reactivates accounts suspended for arrears once nothing is overdue.
 *
 * Every step is idempotent (unique constraints on invoice period and payment attempt), and each
 * day runs in one transaction, so a crash mid-run leaves nothing half-done. Days must be run in
 * order; `runThrough` replays any that were missed.
 *
 * Out-of-bundle extras need usage from the usage daemon, which is fetched before a day's
 * transaction (`prepare`) and then applied synchronously (`applyDay`). If usage is unavailable the
 * day fails and nothing is billed: billing never silently skips extras.
 */
export class BillingEngine {
  private readonly exclusive = createMutex();

  constructor(
    private readonly db: Database,
    private readonly usage: UsageSource,
  ) {}

  lastRunDate(): IsoDate | null {
    return this.db.query<{ d: string | null }, []>("SELECT MAX(run_date) AS d FROM billing_runs").get()!.d;
  }

  /**
   * Run every day after the last completed run, up to and including `through`.
   * With no previous runs, starts at `from` (used for the seed backfill).
   */
  runThrough(through: IsoDate, opts: { from?: IsoDate; maxDays?: number } = {}): Promise<RunSummary[]> {
    return this.exclusive(async () => {
      const last = this.lastRunDate();
      let date = last ? addDays(last, 1) : (opts.from ?? through);
      const summaries: RunSummary[] = [];

      if (opts.maxDays !== undefined && daysBetween(date, through) >= opts.maxDays) {
        date = addDays(through, -(opts.maxDays - 1));
      }

      for (; date <= through; date = addDays(date, 1)) summaries.push(await this.runDay(date));

      return summaries;
    });
  }

  /** Run a single business date. Already-run dates return their stored summary unchanged. */
  async runDay(date: IsoDate): Promise<RunSummary> {
    return this.storedRun(date) ?? this.applyDay(date, await this.prepare(date));
  }

  private storedRun(date: IsoDate): RunSummary | null {
    return this.db.query<RunSummary, [string]>("SELECT * FROM billing_runs WHERE run_date = ?").get(date);
  }

  /**
   * Fetch the usage the bills issued on `date` will rate: each line with known allowances, over the
   * part of the previous period it was live. Depends only on accounts and lines, not on earlier
   * runs, so several days can be prepared before any of them is applied.
   */
  async prepare(date: IsoDate): Promise<Map<string, Usage>> {
    const requests: UsageRequest[] = [];

    for (const account of this.accountsBilledOn(date)) {
      for (const line of this.linesForBill(account.id, date)) {
        const window = usageWindow(line, date);
        if (window && line.allowances_known === 1) requests.push({ key: line.line_id, msisdn: line.msisdn, ...window });
      }
    }

    return requests.length === 0 ? new Map() : this.usage.totals(requests);
  }

  /** Run a business date with usage from `prepare(date)`. Already-run dates return their stored summary. */
  applyDay(date: IsoDate, usage: Map<string, Usage>): RunSummary {
    const existing = this.storedRun(date);
    if (existing) return existing;

    const startedAt = new Date().toISOString();

    return this.db.transaction(() => {
      const summary: RunSummary = {
        run_date: date,
        invoices_issued: 0,
        amount_invoiced_pence: 0,
        payments_attempted: 0,
        payments_succeeded: 0,
        payments_failed: 0,
        amount_collected_pence: 0,
        accounts_suspended: 0,
        accounts_reactivated: 0,
        started_at: startedAt,
        finished_at: "",
      };

      this.issueInvoices(date, summary, usage);
      this.collectScheduled(date, summary);
      this.collectCustomerInitiated(date, summary);
      this.reactivate(date, summary);

      summary.finished_at = new Date().toISOString();
      this.db
        .query(
          `INSERT INTO billing_runs VALUES ($run_date, $invoices_issued, $amount_invoiced_pence, $payments_attempted,
            $payments_succeeded, $payments_failed, $amount_collected_pence, $accounts_suspended, $accounts_reactivated,
            $started_at, $finished_at)`,
        )
        .run({ ...summary });

      return summary;
    })();
  }

  // ── 1. Invoicing ──

  /** Accounts that existed on the date, weren't yet closed, and bill that day. Suspended accounts still accrue charges. */
  private accountsBilledOn(date: IsoDate): AccountRow[] {
    return this.db
      .query<AccountRow, [number, string, string]>(
        `SELECT * FROM billing_accounts
         WHERE billing_day = ? AND substr(created_at, 1, 10) <= ?
           AND (closed_at IS NULL OR substr(closed_at, 1, 10) > ?)`,
      )
      .all(Number(date.slice(8, 10)), date, date);
  }

  /** An account's lines relevant to a bill on `date`: live on it, or at some point in the previous period. */
  private linesForBill(accountId: string, date: IsoDate): BillableLineRow[] {
    return this.db
      .query<BillableLineRow, [string, string, string]>(
        `SELECT * FROM billable_lines
         WHERE account_id = ? AND started_on <= ? AND (ceased_on IS NULL OR ceased_on > ?)
         ORDER BY started_on, line_id`,
      )
      .all(accountId, date, addMonths(date, -1));
  }

  private issueInvoices(date: IsoDate, summary: RunSummary, usage: Map<string, Usage>): void {
    const accounts = this.accountsBilledOn(date);

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO invoices (id, account_id, invoice_number, period_start, period_end, issued_on, due_on,
         line_items, amount_pence, status, created_at, updated_at)
       VALUES ($id, $account_id, $invoice_number, $period_start, $period_end, $issued_on, $due_on,
         $line_items, $amount_pence, 'open', $ts, $ts)`,
    );

    for (const account of accounts) {
      const periodEnd = addDays(addMonths(date, 1), -1);
      const items = this.invoiceItems(account.id, date, periodEnd, usage);
      // Nothing to charge (no lines this period or last): no bill.
      if (items.length === 0) continue;

      const amount = items.reduce((sum, item) => sum + item.amount_pence, 0);
      const result = insert.run({
        id: newId("inv", new Date(runTimestamp(date)).getTime(), seededRandom(`inv:${account.id}:${date}`)),
        account_id: account.id,
        invoice_number: this.nextInvoiceNumber(),
        period_start: date,
        period_end: periodEnd,
        issued_on: date,
        due_on: addDays(date, PAYMENT_TERMS_DAYS),
        line_items: JSON.stringify(items),
        amount_pence: amount,
        ts: runTimestamp(date),
      });

      if (result.changes > 0) {
        summary.invoices_issued++;
        summary.amount_invoiced_pence += amount;
      }
    }
  }

  /**
   * The charges on an account's bill issued on `date`, line by line:
   *
   *   plan     each line live on `date`, at its locked-in price, for `date`–`periodEnd` (in advance);
   *   prorata  a line that started part-way through the previous period, for the days before this
   *            bill (it missed the previous bill, which was issued before it started);
   *   extra    out-of-bundle usage over the previous period (in arrears), rated against the line's
   *            allowances. Lines whose allowances billing doesn't know yet are never charged extras.
   *
   * So a bill is always exactly the account's monthly plan charge, plus any part-month and extras.
   */
  private invoiceItems(accountId: string, date: IsoDate, periodEnd: IsoDate, usage: Map<string, Usage>): LineItem[] {
    const previousStart = addMonths(date, -1);
    const previousDays = daysBetween(previousStart, date);
    const items: LineItem[] = [];

    for (const line of this.linesForBill(accountId, date)) {
      const number = toNational(line.msisdn);
      const ceased = line.ceased_on;
      const item = (kind: NonNullable<LineItem["kind"]>, description: string, amount_pence: number) =>
        items.push({ description: `${number} · ${description}`, amount_pence, kind, msisdn: line.msisdn });

      if (ceased === null || ceased > date) {
        item("plan", `${line.tariff_name} · ${date} to ${periodEnd}`, line.monthly_price_pence);
      }

      const window = usageWindow(line, date);
      if (!window) continue;
      const { from, to } = window;

      if (line.started_on > previousStart) {
        const days = daysBetween(from, to);
        const amount = Math.round((line.monthly_price_pence * days) / previousDays);
        if (amount > 0) item("prorata", `${line.tariff_name} · part month ${from} to ${addDays(to, -1)} (${days} of ${previousDays} days)`, amount);
      }

      if (line.allowances_known === 1) {
        const allowances: LineAllowances = {
          minutes: line.minutes,
          texts: line.texts,
          data_mb: line.data_mb,
          eu_roaming: line.eu_roaming === 1,
          international_roaming: line.international_roaming === 1,
        };

        const used = usage.get(line.line_id);
        if (!used) throw new Error(`No usage for line ${line.line_id} on the ${date} bill: prepare(${date}) must run first`);

        for (const extra of rateUsage(used, allowances)) {
          item("extra", extra.description, extra.amount_pence);
        }
      }
    }

    return items;
  }

  private nextInvoiceNumber(): string {
    const { value } = this.db
      .query<{ value: number }, []>("UPDATE counters SET value = value + 1 WHERE name = 'invoice_number' RETURNING value")
      .get()!;

    return `INV-${String(value).padStart(8, "0")}`;
  }

  // ── 2. Scheduled collection with retries ──

  private collectScheduled(date: IsoDate, summary: RunSummary): void {
    const due = this.db
      .query<InvoiceRow & { scheduled_attempts: number; last_attempt: string | null }, [string]>(
        `SELECT i.*,
           (SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id AND p.initiated_by = 'scheduled') AS scheduled_attempts,
           (SELECT MAX(attempted_on) FROM payments p WHERE p.invoice_id = i.id AND p.initiated_by = 'scheduled') AS last_attempt
         FROM invoices i
         WHERE i.status = 'open' AND i.due_on <= ?
         ORDER BY i.due_on, i.id`,
      )
      .all(date);

    for (const invoice of due) {
      const attemptToday =
        invoice.scheduled_attempts === 0 ||
        (invoice.scheduled_attempts < MAX_SCHEDULED_ATTEMPTS &&
          invoice.last_attempt !== null &&
          addDays(invoice.last_attempt, RETRY_INTERVAL_DAYS) <= date);

      if (!attemptToday) continue;

      const account = this.account(invoice.account_id);
      const succeeded = this.attempt(account, invoice, date, "scheduled", summary);

      if (!succeeded && invoice.scheduled_attempts + 1 >= MAX_SCHEDULED_ATTEMPTS) {
        this.db.query("UPDATE invoices SET status = 'overdue', updated_at = ? WHERE id = ?").run(runTimestamp(date), invoice.id);

        // Dunning: bar service until the arrears are cleared. Closed accounts stay closed.
        const suspended = this.db
          .query(
            `UPDATE billing_accounts SET status = 'suspended', suspension_reason = 'arrears', updated_at = ?
             WHERE id = ? AND status = 'active'`,
          )
          .run(runTimestamp(date), account.id);

        if (suspended.changes > 0) {
          summary.accounts_suspended++;
          this.emit("account.suspended", date, { account_id: account.id, customer_id: account.customer_id, reason: "arrears" });
        }
      }
    }
  }

  // ── 3. Customers paying overdue bills themselves ──

  private collectCustomerInitiated(date: IsoDate, summary: RunSummary): void {
    const overdue = this.db.query<InvoiceRow, []>("SELECT * FROM invoices WHERE status = 'overdue' ORDER BY id").all();

    for (const invoice of overdue) {
      if (chance(`self:${invoice.id}:${date}`) >= SELF_SERVE_PAYMENT_CHANCE) continue;

      const account = this.account(invoice.account_id);

      if (this.attempt(account, invoice, date, "customer", summary) && account.payment_method === "card") {
        // They paid with a fresh card, which replaces the expired/declined one on file.
        const [year, month] = date.split("-");
        this.db
          .query("UPDATE billing_accounts SET card_expiry = ?, card_last4 = ?, updated_at = ? WHERE id = ?")
          .run(`${Number(year) + 3}-${month}`, String(Math.floor(chance(`card:${invoice.id}`) * 9000) + 1000), runTimestamp(date), account.id);
      }
    }
  }

  // ── 4. Reactivation ──

  private reactivate(date: IsoDate, summary: RunSummary): void {
    const cleared = this.db
      .query<Pick<AccountRow, "id" | "customer_id">, []>(
        `SELECT id, customer_id FROM billing_accounts
         WHERE status = 'suspended' AND suspension_reason = 'arrears'
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.account_id = billing_accounts.id AND i.status = 'overdue')
         ORDER BY id`,
      )
      .all();

    for (const account of cleared) {
      this.db
        .query("UPDATE billing_accounts SET status = 'active', suspension_reason = NULL, updated_at = ? WHERE id = ?")
        .run(runTimestamp(date), account.id);
      summary.accounts_reactivated++;
      this.emit("account.reactivated", date, { account_id: account.id, customer_id: account.customer_id });
    }
  }

  /** Record a domain event in the outbox, inside the current transaction. */
  private emit(type: string, date: IsoDate, data: Record<string, unknown>): void {
    this.db
      .query("INSERT INTO outbox (type, data, occurred_at) VALUES (?, ?, ?)")
      .run(type, JSON.stringify({ ...data, effective_on: date }), runTimestamp(date));
  }

  // ── helpers ──

  private account(id: string): AccountRow {
    return this.db.query<AccountRow, [string]>("SELECT * FROM billing_accounts WHERE id = ?").get(id)!;
  }

  /** Charge an invoice once and record the attempt. Returns whether it succeeded. */
  private attempt(account: AccountRow, invoice: InvoiceRow, date: IsoDate, initiatedBy: "scheduled" | "customer", summary: RunSummary): boolean {
    const attempt =
      this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?").get(invoice.id)!.n + 1;

    const result = charge({ account, invoiceId: invoice.id, amountPence: invoice.amount_pence, attempt, date, initiatedBy });
    const ts = runTimestamp(date);

    this.db
      .query(
        `INSERT INTO payments (id, invoice_id, account_id, attempt, initiated_by, method, amount_pence, status,
           failure_code, failure_message, processor_reference, attempted_on, created_at)
         VALUES ($id, $invoice_id, $account_id, $attempt, $initiated_by, $method, $amount_pence, $status,
           $failure_code, $failure_message, $reference, $date, $ts)`,
      )
      .run({
        id: newId("pay", new Date(ts).getTime(), seededRandom(`pay:${invoice.id}:${attempt}`)),
        invoice_id: invoice.id,
        account_id: account.id,
        attempt,
        initiated_by: initiatedBy,
        method: result.method,
        amount_pence: invoice.amount_pence,
        status: result.status,
        failure_code: result.status === "failed" ? result.code : null,
        failure_message: result.status === "failed" ? result.message : null,
        reference: result.reference,
        date,
        ts,
      });

    summary.payments_attempted++;

    if (result.status === "succeeded") {
      this.db.query("UPDATE invoices SET status = 'paid', paid_on = ?, updated_at = ? WHERE id = ?").run(date, ts, invoice.id);
      summary.payments_succeeded++;
      summary.amount_collected_pence += invoice.amount_pence;
      return true;
    }

    summary.payments_failed++;
    return false;
  }
}
