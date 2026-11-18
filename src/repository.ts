import type { Database } from "bun:sqlite";
import type { AccountRow, Address, InvoiceRow, LineItem, Page, PaymentRow, RunSummary } from "./types";
import { nextOccurrence, type IsoDate } from "./util";

export interface PaymentMethodView {
  type: "direct_debit" | "card";
  /** e.g. "Direct Debit ****1234" / "Visa ****4242" — safe to show to staff. */
  label: string;
  sort_code: string | null;
  account_last4: string | null;
  mandate_reference: string | null;
  brand: string | null;
  last4: string | null;
  expiry: string | null;
  expired: boolean;
}

export interface Account {
  id: string;
  customer_id: string;
  account_number: string;
  status: AccountRow["status"];
  suspension_reason: AccountRow["suspension_reason"];
  monthly_charge_pence: number;
  billing_day: number;
  /** Next date an invoice will be issued, or null for closed accounts. */
  next_bill_on: IsoDate | null;
  /** Unpaid (open + overdue) invoices. */
  balance_pence: number;
  overdue_pence: number;
  payment_method: PaymentMethodView;
  billing_address: Address | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type AccountRef = Pick<AccountRow, "id" | "customer_id" | "status" | "suspension_reason" | "created_at" | "closed_at">;

export interface AccountSummary {
  id: string;
  account_number: string;
  status: AccountRow["status"];
  balance_pence: number;
  overdue_pence: number;
}

export interface Invoice {
  id: string;
  account_id: string;
  invoice_number: string;
  period_start: IsoDate;
  period_end: IsoDate;
  issued_on: IsoDate;
  due_on: IsoDate;
  line_items: LineItem[];
  amount_pence: number;
  status: InvoiceRow["status"];
  paid_on: IsoDate | null;
  payments: Payment[];
}

export type Payment = Omit<PaymentRow, "account_id" | "created_at">;

/** Monthly charge: the sum of the account's live lines' plan prices, which is what each bill charges before extras. */
const MONTHLY_SQL = `
  COALESCE((SELECT SUM(monthly_price_pence) FROM billable_lines bl WHERE bl.account_id = a.id AND bl.ceased_on IS NULL), 0) AS effective_monthly_charge_pence`;

const BALANCE_SQL = `
  COALESCE((SELECT SUM(amount_pence) FROM invoices i WHERE i.account_id = a.id AND i.status IN ('open', 'overdue')), 0) AS balance_pence,
  COALESCE((SELECT SUM(amount_pence) FROM invoices i WHERE i.account_id = a.id AND i.status = 'overdue'), 0) AS overdue_pence,
  ${MONTHLY_SQL}`;

type AccountWithBalance = AccountRow & { balance_pence: number; overdue_pence: number; effective_monthly_charge_pence: number };

export class BillingRepository {
  constructor(
    private readonly db: Database,
    private readonly today: () => IsoDate,
  ) {}

  findAccount(by: { id?: string; account_number?: string }): Account | null {
    const [column, value] = by.id ? ["id", by.id] : ["account_number", by.account_number ?? ""];
    const row = this.db
      .query<AccountWithBalance, [string]>(`SELECT a.*, ${BALANCE_SQL} FROM billing_accounts a WHERE a.${column} = ?`)
      .get(value);

    return row ? this.toAccount(row) : null;
  }

  forCustomer(customerId: string): Account[] {
    return this.db
      .query<AccountWithBalance, [string]>(
        `SELECT a.*, ${BALANCE_SQL} FROM billing_accounts a WHERE a.customer_id = ?
         ORDER BY a.status = 'closed', a.created_at`,
      )
      .all(customerId)
      .map((row) => this.toAccount(row));
  }

  /** Lightweight summaries keyed by customer id, for search results. Customers with no accounts map to []. */
  forCustomers(customerIds: string[]): Record<string, AccountSummary[]> {
    const result: Record<string, AccountSummary[]> = Object.fromEntries(customerIds.map((id) => [id, []]));
    if (customerIds.length === 0) return result;

    const rows = this.db
      .query<AccountWithBalance, string[]>(
        `SELECT a.*, ${BALANCE_SQL} FROM billing_accounts a
         WHERE a.customer_id IN (${customerIds.map(() => "?").join(",")})
         ORDER BY a.status = 'closed', a.created_at`,
      )
      .all(...customerIds);

    for (const row of rows) {
      result[row.customer_id]?.push({
        id: row.id,
        account_number: row.account_number,
        status: row.status,
        balance_pence: row.balance_pence,
        overdue_pence: row.overdue_pence,
      });
    }

    return result;
  }

  /** Invoices newest first, each with its payment attempts. */
  invoices(accountId: string, page: number, perPage: number): Page<Invoice> {
    const total = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM invoices WHERE account_id = ?").get(accountId)!.n;
    const rows = this.db
      .query<InvoiceRow, [string, number, number]>(
        "SELECT * FROM invoices WHERE account_id = ? ORDER BY issued_on DESC, id DESC LIMIT ? OFFSET ?",
      )
      .all(accountId, perPage, (page - 1) * perPage);

    const payments = rows.length
      ? this.db
          .query<PaymentRow, string[]>(
            `SELECT * FROM payments WHERE invoice_id IN (${rows.map(() => "?").join(",")}) ORDER BY attempt`,
          )
          .all(...rows.map((r) => r.id))
      : [];
    const byInvoice = Map.groupBy(payments, (p) => p.invoice_id);

    return {
      data: rows.map((row) => ({
        id: row.id,
        account_id: row.account_id,
        invoice_number: row.invoice_number,
        period_start: row.period_start,
        period_end: row.period_end,
        issued_on: row.issued_on,
        due_on: row.due_on,
        line_items: JSON.parse(row.line_items) as LineItem[],
        amount_pence: row.amount_pence,
        status: row.status,
        paid_on: row.paid_on,
        payments: (byInvoice.get(row.id) ?? []).map(({ account_id: _a, created_at: _c, ...payment }) => payment),
      })),
      total,
      page,
      per_page: perPage,
    };
  }

  /** Keyset-paginated account references for other daemons (e.g. MSISDN seeding). No payment data. */
  accountRefs(after: string | undefined, limit: number): AccountRef[] {
    return this.db
      .query<AccountRef, [string, number]>(
        `SELECT id, customer_id, status, suspension_reason, created_at, closed_at FROM billing_accounts
         WHERE id > ? ORDER BY id LIMIT ?`,
      )
      .all(after ?? "", limit);
  }

  runs(limit: number): RunSummary[] {
    return this.db.query<RunSummary, [number]>("SELECT * FROM billing_runs ORDER BY run_date DESC LIMIT ?").all(limit);
  }

  private toAccount(row: AccountWithBalance): Account {
    const today = this.today();
    const isCard = row.payment_method === "card";

    return {
      id: row.id,
      customer_id: row.customer_id,
      account_number: row.account_number,
      status: row.status,
      suspension_reason: row.suspension_reason,
      monthly_charge_pence: row.effective_monthly_charge_pence,
      billing_day: row.billing_day,
      next_bill_on: row.status === "closed" ? null : nextOccurrence(today, row.billing_day),
      balance_pence: row.balance_pence,
      overdue_pence: row.overdue_pence,
      payment_method: {
        type: row.payment_method,
        label: isCard ? `${row.card_brand} ****${row.card_last4}` : `Direct Debit ****${row.dd_account_last4}`,
        sort_code: row.dd_sort_code_masked,
        account_last4: row.dd_account_last4,
        mandate_reference: row.dd_mandate_reference,
        brand: row.card_brand,
        last4: row.card_last4,
        expiry: row.card_expiry,
        expired: isCard && row.card_expiry !== null && row.card_expiry < today.slice(0, 7),
      },
      billing_address:
        row.billing_address_line_1 && row.billing_town && row.billing_postcode
          ? {
              line_1: row.billing_address_line_1,
              line_2: row.billing_address_line_2,
              town: row.billing_town,
              county: row.billing_county,
              postcode: row.billing_postcode,
              country: "GB",
            }
          : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      closed_at: row.closed_at,
    };
  }
}
