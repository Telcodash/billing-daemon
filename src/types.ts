import type { IsoDate } from "./util";

export type AccountStatus = "active" | "suspended" | "closed";
export type PaymentMethodType = "direct_debit" | "card";
export type InvoiceStatus = "open" | "paid" | "overdue";

export interface Address {
  line_1: string;
  line_2: string | null;
  town: string;
  county: string | null;
  postcode: string;
  country: "GB";
}

/** Row shape of `billing_accounts`. */
export interface AccountRow {
  id: string;
  customer_id: string;
  account_number: string;
  status: AccountStatus;
  suspension_reason: "arrears" | null;
  /** Legacy, from before per-line billing: not charged. An account's plan charge is the sum of its lines. */
  monthly_charge_pence: number;
  billing_day: number;
  payment_method: PaymentMethodType;
  dd_sort_code_masked: string | null;
  dd_account_last4: string | null;
  dd_mandate_reference: string | null;
  card_brand: string | null;
  card_last4: string | null;
  card_expiry: string | null;
  billing_address_line_1: string | null;
  billing_address_line_2: string | null;
  billing_town: string | null;
  billing_county: string | null;
  billing_postcode: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

/** Row shape of `billable_lines`: billing's copy of a line from the subscription daemon. */
export interface BillableLineRow {
  line_id: string;
  account_id: string;
  msisdn: string;
  tariff_id: string | null;
  tariff_name: string;
  monthly_price_pence: number;
  started_on: IsoDate;
  ceased_on: IsoDate | null;
  allowances_known: 0 | 1;
  minutes: number | null;
  texts: number | null;
  data_mb: number | null;
  eu_roaming: 0 | 1;
  international_roaming: 0 | 1;
}

/**
 * One charge on an invoice:
 *   plan     the line's monthly price, for the period the invoice covers (billed in advance);
 *   prorata  the part of the previous period a new line was live for before its first full bill;
 *   extra    out-of-bundle usage in the previous period (billed in arrears).
 * Old invoices (before per-line billing) have no `kind` or `msisdn`.
 */
export interface LineItem {
  description: string;
  amount_pence: number;
  kind?: "plan" | "prorata" | "extra";
  /** E.164 digits of the line the charge is for. */
  msisdn?: string;
}

export interface InvoiceRow {
  id: string;
  account_id: string;
  invoice_number: string;
  period_start: IsoDate;
  period_end: IsoDate;
  issued_on: IsoDate;
  due_on: IsoDate;
  line_items: string;
  amount_pence: number;
  status: InvoiceStatus;
  paid_on: IsoDate | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  account_id: string;
  attempt: number;
  initiated_by: "scheduled" | "customer";
  method: PaymentMethodType;
  amount_pence: number;
  status: "succeeded" | "failed";
  failure_code: string | null;
  failure_message: string | null;
  processor_reference: string;
  attempted_on: IsoDate;
  created_at: string;
}

export interface RunSummary {
  run_date: IsoDate;
  invoices_issued: number;
  amount_invoiced_pence: number;
  payments_attempted: number;
  payments_succeeded: number;
  payments_failed: number;
  amount_collected_pence: number;
  accounts_suspended: number;
  accounts_reactivated: number;
  started_at: string;
  finished_at: string;
}

export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
}
