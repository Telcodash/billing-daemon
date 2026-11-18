import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import type { BillingEngine } from "./engine";
import type { BillingRepository } from "./repository";
import { idPattern, type IsoDate } from "./util";

const accountId = z.string().regex(idPattern("acc"));
const customerId = z.string().regex(idPattern("cus"));
const accountNumber = z.string().regex(/^\d{10}$/);

const AccountGetSchema = z
  .object({ id: accountId.optional(), account_number: accountNumber.optional() })
  .strict()
  .refine((a) => (a.id === undefined) !== (a.account_number === undefined), "Provide exactly one of id or account_number");

const ForCustomerSchema = z.object({ customer_id: customerId }).strict();
const ForCustomersSchema = z.object({ customer_ids: z.array(customerId).max(100) }).strict();
const InvoicesSchema = z
  .object({
    account_id: accountId,
    page: z.number().int().min(1).default(1),
    per_page: z.number().int().min(1).max(100).default(12),
  })
  .strict();
const RefsSchema = z.object({ after: z.string().optional(), limit: z.number().int().min(1).max(1_000).default(500) }).strict();
const RunsSchema = z.object({ limit: z.number().int().min(1).max(366).default(14) }).strict();
const RunSchema = z.object({ through: z.iso.date().optional() }).strict();

/** Invalid input will never succeed on retry, so fail it permanently. */
function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);

  if (!result.success) {
    throw new UnrecoverableError(`Invalid payload: ${z.prettifyError(result.error).replace(/\n/g, "; ")}`);
  }

  return result.data;
}

export type TaskHandler = (payload: unknown) => unknown;

/**
 * Tasks on the `billing` queue (allow-listed in ../queue/src/catalog.ts unless noted):
 *
 * - accounts.get            { id | account_number } → Account | null
 * - accounts.for_customer   { customer_id }         → Account[]
 * - accounts.for_customers  { customer_ids }        → { [customer_id]: AccountSummary[] }
 * - invoices.list           { account_id, page }    → Page<Invoice> (newest first, with payments)
 * - billing.runs            { limit }               → RunSummary[] (most recent first)
 * - billing.run             { through? }            → RunSummary[] (runs missed days; internal/ops)
 * - billing.daily_run       (scheduler only)        → RunSummary[]
 * - accounts.refs           { after?, limit }       → AccountRef[] keyset-paginated (internal: daemon-to-daemon)
 */
export function createTasks(repo: BillingRepository, engine: BillingEngine, today: () => IsoDate): Record<string, TaskHandler> {
  const runThrough = async (through: IsoDate) => {
    if (through > today()) throw new UnrecoverableError(`Can't run billing for a future date (${through})`);
    return engine.runThrough(through);
  };

  return {
    "accounts.get": (payload) => repo.findAccount(parse(AccountGetSchema, payload)),
    "accounts.for_customer": (payload) => repo.forCustomer(parse(ForCustomerSchema, payload).customer_id),
    "accounts.for_customers": (payload) => repo.forCustomers(parse(ForCustomersSchema, payload).customer_ids),
    "invoices.list": (payload) => {
      const { account_id, page, per_page } = parse(InvoicesSchema, payload);
      return repo.invoices(account_id, page, per_page);
    },
    "accounts.refs": (payload) => {
      const { after, limit } = parse(RefsSchema, payload);
      return repo.accountRefs(after, limit);
    },
    "billing.runs": (payload) => repo.runs(parse(RunsSchema, payload).limit),
    "billing.run": (payload) => runThrough(parse(RunSchema, payload).through ?? today()),
    "billing.daily_run": () => runThrough(today()),
  };
}
