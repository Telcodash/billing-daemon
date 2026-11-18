import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { UnrecoverableError } from "bullmq";
import IORedis from "ioredis";
import { openDatabase } from "../src/db";
import { OutboxPublisher } from "../src/events";
import { applyLineEvent } from "../src/subscriptions";
import { RATES, rateUsage, type Usage, type UsageRequest, type UsageSource } from "../src/usage";
import { BillingEngine, MAX_SCHEDULED_ATTEMPTS, PAYMENT_TERMS_DAYS, RETRY_INTERVAL_DAYS } from "../src/engine";
import { BillingRepository } from "../src/repository";
import { seedAccounts, type CustomerRef } from "../src/seed";
import { createTasks } from "../src/tasks";
import type { AccountRow, BillableLineRow, InvoiceRow, LineItem, PaymentRow } from "../src/types";
import { addDays, addMonths, chance, daysBetween, idPattern, newId, seededRandom } from "../src/util";

const TODAY = "2026-06-30";
const FROM = addDays(TODAY, -119); // 120 days of history

const customers: CustomerRef[] = Array.from({ length: 1_500 }, (_, i) => ({
  id: newId("cus" as never, Date.parse("2018-01-01") + i * 864e5, seededRandom(`c${i}`)),
  status: i % 40 === 0 ? "closed" : "active",
  created_at: new Date(Date.parse("2018-01-01") + i * 864e5).toISOString(),
}));

/** A few plans, as the subscription daemon would describe them on line.started. */
const PLANS = [
  { tariff_name: "Essentials 2GB", monthly_price_pence: 800, allowances: { minutes: 250, texts: 250, data_mb: 2_048, eu_roaming: false, international_roaming: false, five_g_plus: false } },
  { tariff_name: "Everyday 30GB", monthly_price_pence: 1_600, allowances: { minutes: null, texts: null, data_mb: 30_720, eu_roaming: true, international_roaming: false, five_g_plus: true } },
  { tariff_name: "Unlimited Max", monthly_price_pence: 4_200, allowances: { minutes: null, texts: null, data_mb: null, eu_roaming: true, international_roaming: true, five_g_plus: true } },
];

const NO_USAGE: Usage = { minutes: 0, texts: 0, data_mb: 0, eu_roaming_days: 0, world_roaming_days: 0, international_minutes: 0 };

/** Stands in for the usage daemon: a tenth of line-periods use 10GB, another tenth call abroad. */
const fakeUsage: UsageSource = {
  async totals(requests) {
    return new Map(
      requests.map((r) => {
        const roll = chance(`${r.msisdn}:${r.from}`);
        return [r.key, roll < 0.1 ? { ...NO_USAGE, data_mb: 10_240 } : roll < 0.2 ? { ...NO_USAGE, international_minutes: 5 } : NO_USAGE];
      }),
    );
  },
};

/**
 * Give every account 1–2 lines, as the subscription daemon's events would. Most start when the
 * account opened; some start within the simulated history, so part-month charges happen too.
 */
function seedLines(db: Database): void {
  const all = db.query<AccountRow, []>("SELECT * FROM billing_accounts ORDER BY id").all();

  all.forEach((account, i) => {
    for (let n = 0; n < 1 + (i % 3 === 0 ? 1 : 0); n++) {
      const opened = account.created_at.slice(0, 10);
      const late = n === 1 && i % 2 === 0 ? addDays(FROM, (i * 7) % 100) : null;
      const startedOn = late && late > opened ? late : opened;
      const lineId = `lin_${String(i).padStart(5, "0")}_${n}`;

      applyLineEvent(db, "line.started", {
        line_id: lineId,
        account_id: account.id,
        msisdn: `4477009${String(10_000 + i * 2 + n).padStart(5, "0")}`,
        ...PLANS[(i + n) % PLANS.length]!,
        started_on: startedOn,
      });
      if (account.closed_at) applyLineEvent(db, "line.ceased", { line_id: lineId, ceased_on: account.closed_at.slice(0, 10) });
    }
  });
}

async function simulate(): Promise<Database> {
  const db = openDatabase(":memory:");
  seedAccounts(db, customers, 7, TODAY);
  seedLines(db);
  await new BillingEngine(db, fakeUsage).runThrough(TODAY, { from: FROM });
  return db;
}

let db: Database;
let accounts: AccountRow[];
let invoices: InvoiceRow[];
let payments: PaymentRow[];

beforeAll(async () => {
  db = await simulate();
  accounts = db.query<AccountRow, []>("SELECT * FROM billing_accounts").all();
  invoices = db.query<InvoiceRow, []>("SELECT * FROM invoices").all();
  payments = db.query<PaymentRow, []>("SELECT * FROM payments ORDER BY attempt").all();
});

const paymentsFor = (invoiceId: string) => payments.filter((p) => p.invoice_id === invoiceId);

describe("seeding", () => {
  test("every customer gets 1–3 accounts with unique 10-digit numbers", () => {
    const perCustomer = Map.groupBy(accounts, (a) => a.customer_id);

    expect(perCustomer.size).toBe(customers.length);
    expect([...perCustomer.values()].every((list) => list.length >= 1 && list.length <= 3)).toBe(true);
    expect(new Set(accounts.map((a) => a.account_number)).size).toBe(accounts.length);
    expect(accounts.every((a) => /^\d{10}$/.test(a.account_number) && idPattern("acc").test(a.id))).toBe(true);
  });

  test("closed customers only have closed accounts", () => {
    const closedCustomers = new Set(customers.filter((c) => c.status === "closed").map((c) => c.id));
    const theirs = accounts.filter((a) => closedCustomers.has(a.customer_id));

    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((a) => a.status === "closed" && a.closed_at !== null)).toBe(true);
  });

  test("stores payment details masked only", () => {
    for (const a of accounts) {
      if (a.payment_method === "direct_debit") expect(a.dd_sort_code_masked).toMatch(/^\*\*-\*\*-\d{2}$/);
      else expect(a.card_last4).toMatch(/^\d{4}$/);
    }
  });
});

describe("daily run: invoicing", () => {
  test("bills each live account once per period, on its billing day, with 14-day terms", () => {
    const byAccount = new Map(accounts.map((a) => [a.id, a]));
    const periods = new Set<string>();

    for (const invoice of invoices) {
      const account = byAccount.get(invoice.account_id)!;
      const items = JSON.parse(invoice.line_items) as LineItem[];

      expect(Number(invoice.issued_on.slice(8))).toBe(account.billing_day);
      expect(invoice.issued_on >= account.created_at.slice(0, 10)).toBe(true);
      if (account.closed_at) expect(invoice.issued_on < account.closed_at.slice(0, 10)).toBe(true);
      expect(invoice.due_on).toBe(addDays(invoice.issued_on, PAYMENT_TERMS_DAYS));
      expect(invoice.amount_pence).toBe(items.reduce((s, i) => s + i.amount_pence, 0));
      expect(items.every((i) => i.kind !== undefined && i.msisdn !== undefined && i.amount_pence > 0)).toBe(true);

      const key = `${invoice.account_id}:${invoice.period_start}`;
      expect(periods.has(key)).toBe(false);
      periods.add(key);
    }

    expect(invoices.length).toBeGreaterThan(accounts.length * 3); // ~4 months of bills
  });

  test("invoice numbers are sequential and unique", () => {
    const numbers = invoices.map((i) => i.invoice_number).sort();

    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers[0]).toBe("INV-00000001");
    expect(numbers.at(-1)).toBe(`INV-${String(numbers.length).padStart(8, "0")}`);
  });
});

describe("daily run: collection", () => {
  test("the first scheduled attempt is on the due date and retries come every 3 days, at most 3 times", () => {
    for (const invoice of invoices) {
      const scheduled = paymentsFor(invoice.id).filter((p) => p.initiated_by === "scheduled");
      if (scheduled.length === 0) {
        expect(invoice.due_on > TODAY || invoice.status === "open").toBe(true);
        continue;
      }

      expect(scheduled[0]!.attempted_on).toBe(invoice.due_on);
      expect(scheduled.length).toBeLessThanOrEqual(MAX_SCHEDULED_ATTEMPTS);
      scheduled.slice(1).forEach((p, i) => expect(p.attempted_on).toBe(addDays(scheduled[i]!.attempted_on, RETRY_INTERVAL_DAYS)));
      // Nothing is attempted after a success.
      scheduled.slice(0, -1).forEach((p) => expect(p.status).toBe("failed"));
    }
  });

  test("invoice status matches its payments", () => {
    for (const invoice of invoices) {
      const list = paymentsFor(invoice.id);
      const succeeded = list.filter((p) => p.status === "succeeded");

      if (invoice.status === "paid") {
        expect(succeeded).toHaveLength(1);
        expect(invoice.paid_on).toBe(succeeded[0]!.attempted_on);
      } else {
        expect(succeeded).toHaveLength(0);
      }

      if (invoice.status === "overdue") {
        expect(list.filter((p) => p.initiated_by === "scheduled" && p.status === "failed")).toHaveLength(MAX_SCHEDULED_ATTEMPTS);
      }
    }
  });

  test("most payments succeed, but failures, suspensions and recoveries all happen", () => {
    const failed = payments.filter((p) => p.status === "failed");
    const codes = new Set(failed.map((p) => p.failure_code));

    expect(failed.length / payments.length).toBeGreaterThan(0.02);
    expect(failed.length / payments.length).toBeLessThan(0.2);
    expect(codes).toContain("insufficient_funds");
    expect(codes).toContain("expired_card");
    expect(payments.some((p) => p.initiated_by === "customer" && p.status === "succeeded")).toBe(true);

    const runs = db.query<{ s: number; r: number }, []>("SELECT SUM(accounts_suspended) s, SUM(accounts_reactivated) r FROM billing_runs").get()!;
    expect(runs.s).toBeGreaterThan(0);
    expect(runs.r).toBeGreaterThan(0);
  });

  test("an account is suspended for arrears exactly when it has an overdue invoice", () => {
    const overdue = new Set(invoices.filter((i) => i.status === "overdue").map((i) => i.account_id));

    for (const account of db.query<AccountRow, []>("SELECT * FROM billing_accounts").all()) {
      if (account.status === "closed") continue;
      expect(account.status === "suspended" && account.suspension_reason === "arrears").toBe(overdue.has(account.id));
    }
  });

  test("an expired card fails every scheduled attempt", () => {
    const expiredCardPayments = payments.filter((p) => {
      const account = accounts.find((a) => a.id === p.account_id)!;
      return p.initiated_by === "scheduled" && p.method === "card" && account.card_expiry! < p.attempted_on.slice(0, 7);
    });

    expect(expiredCardPayments.length).toBeGreaterThan(0);
    // Cards renewed after a customer payment get a new expiry, so check against the expiry at seed time
    // only for accounts that never paid by hand.
    for (const p of expiredCardPayments) expect(p.status).toBe("failed");
  });
});

describe("determinism and idempotency", () => {
  test("replaying the same history produces identical results", async () => {
    const other = await simulate();
    const snapshot = (d: Database) =>
      d.query<{ id: string; status: string }, []>("SELECT id, status FROM invoices UNION ALL SELECT id, status FROM payments ORDER BY id").all();

    expect(snapshot(other)).toEqual(snapshot(db));
  });

  test("re-running completed days changes nothing", async () => {
    const counts = () => db.query<{ i: number; p: number }, []>("SELECT (SELECT COUNT(*) FROM invoices) i, (SELECT COUNT(*) FROM payments) p").get();
    const before = counts();
    const engine = new BillingEngine(db, fakeUsage);

    expect(await engine.runThrough(TODAY)).toEqual([]);
    await engine.runDay(addDays(TODAY, -10));
    expect(counts()).toEqual(before);
  });

  test("catch-up runs every missed day in order, capped", async () => {
    const fresh = openDatabase(":memory:");
    seedAccounts(fresh, customers.slice(0, 50), 7, TODAY);
    const engine = new BillingEngine(fresh, fakeUsage);

    await engine.runThrough(addDays(TODAY, -5), { from: addDays(TODAY, -5) });
    const caughtUp = await engine.runThrough(TODAY);
    expect(caughtUp.map((r) => r.run_date)).toEqual([1, 2, 3, 4, 5].map((n) => addDays(TODAY, -5 + n)));

    const capped = openDatabase(":memory:");
    seedAccounts(capped, customers.slice(0, 50), 7, TODAY);
    const cappedRuns = await new BillingEngine(capped, fakeUsage).runThrough(TODAY, { from: addDays(TODAY, -100), maxDays: 3 });
    expect(cappedRuns.map((r) => r.run_date)).toEqual([addDays(TODAY, -2), addDays(TODAY, -1), TODAY]);
  });
});

describe("tasks", () => {
  test("account views include balance, masked payment method and next bill date", () => {
    const tasks = createTasks(new BillingRepository(db, () => TODAY), new BillingEngine(db, fakeUsage), () => TODAY);
    const withOverdue = invoices.find((i) => i.status === "overdue")!;
    const account = tasks["accounts.get"]!({ id: withOverdue.account_id }) as {
      balance_pence: number;
      overdue_pence: number;
      next_bill_on: string | null;
      payment_method: { label: string };
      customer_id: string;
    };

    const unpaid = invoices.filter((i) => i.account_id === withOverdue.account_id && i.status !== "paid");
    expect(account.balance_pence).toBe(unpaid.reduce((s, i) => s + i.amount_pence, 0));
    expect(account.overdue_pence).toBeGreaterThan(0);
    expect(account.payment_method.label).toMatch(/\*\*\*\*\d{4}$/);

    const byCustomer = tasks["accounts.for_customers"]!({ customer_ids: [account.customer_id] }) as Record<string, { id: string }[]>;
    expect(byCustomer[account.customer_id]!.map((a) => a.id)).toContain(withOverdue.account_id);

    const page = tasks["invoices.list"]!({ account_id: withOverdue.account_id }) as { data: { issued_on: string; payments: unknown[] }[] };
    expect(page.data.map((i) => i.issued_on)).toEqual([...page.data.map((i) => i.issued_on)].sort().reverse());
    expect(page.data.some((i) => i.payments.length > 0)).toBe(true);
  });

  test("validates input and refuses future runs", async () => {
    const tasks = createTasks(new BillingRepository(db, () => TODAY), new BillingEngine(db, fakeUsage), () => TODAY);

    expect(() => tasks["accounts.get"]!({})).toThrow(UnrecoverableError);
    expect(() => tasks["accounts.get"]!({ id: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV" })).toThrow(UnrecoverableError);
    expect(tasks["accounts.get"]!({ account_number: "0000000000" })).toBeNull();
    expect(Promise.resolve(tasks["billing.run"]!({ through: addDays(TODAY, 1) }))).rejects.toThrow(UnrecoverableError);
  });
});

describe("domain events (outbox)", () => {
  test("every suspension and reactivation writes exactly one event, in the same transaction", () => {
    const totals = db
      .query<{ s: number; r: number }, []>("SELECT SUM(accounts_suspended) s, SUM(accounts_reactivated) r FROM billing_runs")
      .get()!;
    const events = db.query<{ type: string; n: number }, []>("SELECT type, COUNT(*) n FROM outbox GROUP BY type").all();
    const count = (type: string) => events.find((e) => e.type === type)?.n ?? 0;

    expect(count("account.suspended")).toBe(totals.s);
    expect(count("account.reactivated")).toBe(totals.r);

    const sample = JSON.parse(db.query<{ data: string }, []>("SELECT data FROM outbox WHERE type = 'account.suspended' LIMIT 1").get()!.data);
    expect(sample).toMatchObject({ reason: "arrears" });
    expect(sample.account_id).toMatch(idPattern("acc"));
    expect(sample.customer_id).toMatch(idPattern("cus"));
  });

  test("replaying a day emits nothing new", async () => {
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM outbox").get()!.n;
    await new BillingEngine(db, fakeUsage).runDay(addDays(TODAY, -30));
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM outbox").get()!.n).toBe(before);
  });

  test("the publisher moves the outbox to a Redis stream exactly once", async () => {
    const redis = new IORedis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
    const stream = `billing-test-${crypto.randomUUID()}:events:billing`;
    const fresh = openDatabase(":memory:");
    seedAccounts(fresh, customers.slice(0, 400), 7, TODAY);
    seedLines(fresh);
    await new BillingEngine(fresh, fakeUsage).runThrough(TODAY, { from: FROM });
    const publisher = new OutboxPublisher(fresh, redis, stream);

    try {
      const expected = fresh.query<{ n: number }, []>("SELECT COUNT(*) n FROM outbox").get()!.n;
      expect(expected).toBeGreaterThan(0);
      expect(await publisher.flush()).toBe(expected);
      expect(await publisher.flush()).toBe(0);
      expect(publisher.pending()).toBe(0);
      expect(await redis.xlen(stream)).toBe(expected);

      const [first] = await redis.xrange(stream, "-", "+", "COUNT", 1);
      const fields = first![1];
      const entry = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]));
      expect(entry.id).toBe("billing:1");
      expect(["account.suspended", "account.reactivated"]).toContain(entry.type);
      expect(JSON.parse(entry.data!).account_id).toMatch(idPattern("acc"));
    } finally {
      await redis.del(stream);
      redis.disconnect();
    }
  });
});

describe("accounts.refs (internal)", () => {
  test("pages through every account without payment details", () => {
    const repo = new BillingRepository(db, () => TODAY);
    const seen: string[] = [];
    let after: string | undefined;

    for (;;) {
      const page = repo.accountRefs(after, 700);
      if (page.length === 0) break;
      expect(Object.keys(page[0]!).sort()).toEqual(["closed_at", "created_at", "customer_id", "id", "status", "suspension_reason"]);
      seen.push(...page.map((r) => r.id));
      after = page.at(-1)!.id;
    }

    expect(seen.length).toBe(accounts.length);
  });
});

describe("per-line billing (subscription events)", () => {
  test("line events maintain billable_lines idempotently", () => {
    const fresh = openDatabase(":memory:");
    const started = { line_id: "lin_1", account_id: "acc_x", msisdn: "447700910123", tariff_name: "Unlimited", monthly_price_pence: 3000, started_on: "2026-01-05" };

    expect(applyLineEvent(fresh, "line.started", started)).toBe(true);
    expect(applyLineEvent(fresh, "line.started", started)).toBe(false); // redelivery
    expect(applyLineEvent(fresh, "line.ceased", { line_id: "lin_1", ceased_on: "2026-03-01" })).toBe(true);
    expect(applyLineEvent(fresh, "line.ceased", { line_id: "lin_1", ceased_on: "2026-03-09" })).toBe(false);
    expect(applyLineEvent(fresh, "line.started", { line_id: "lin_2" })).toBe(false); // malformed
    expect(fresh.query("SELECT ceased_on FROM billable_lines WHERE line_id = 'lin_1'").get()).toEqual({ ceased_on: "2026-03-01" });
  });

  test("line.started fills in allowances it lacked; line.restated upserts the full state but never revives a ceased line", () => {
    const fresh = openDatabase(":memory:");
    const base = { line_id: "lin_1", account_id: "acc_x", msisdn: "447700910123", tariff_name: "Unlimited", monthly_price_pence: 3000, started_on: "2026-01-05" };
    const row = () => fresh.query<BillableLineRow, []>("SELECT * FROM billable_lines WHERE line_id = 'lin_1'").get()!;

    applyLineEvent(fresh, "line.started", base); // an old event, without allowances
    expect(row().allowances_known).toBe(0);

    expect(applyLineEvent(fresh, "line.started", { ...base, allowances: PLANS[0]!.allowances })).toBe(true);
    expect(row()).toMatchObject({ allowances_known: 1, minutes: 250, data_mb: 2048, eu_roaming: 0 });
    expect(applyLineEvent(fresh, "line.started", { ...base, allowances: PLANS[0]!.allowances })).toBe(false);

    applyLineEvent(fresh, "line.ceased", { line_id: "lin_1", ceased_on: "2026-03-01" });
    applyLineEvent(fresh, "line.restated", { ...base, tariff_id: "trf_1", ceased_on: null, allowances: PLANS[2]!.allowances });
    expect(row()).toMatchObject({ tariff_id: "trf_1", ceased_on: "2026-03-01", data_mb: null, international_roaming: 1 });

    applyLineEvent(fresh, "line.restated", { ...base, line_id: "lin_2", ceased_on: "2026-02-01", allowances: PLANS[1]!.allowances });
    expect(fresh.query("SELECT ceased_on, allowances_known FROM billable_lines WHERE line_id = 'lin_2'").get()).toEqual({ ceased_on: "2026-02-01", allowances_known: 1 });
    expect(applyLineEvent(fresh, "line.restated", { ...base, line_id: "lin_3" })).toBe(false); // restated must carry allowances
  });

  test("a bill is the account's monthly plan charge, plus any part month and extras", async () => {
    const fresh = openDatabase(":memory:");
    seedAccounts(fresh, customers.slice(0, 30), 7, TODAY);
    const account = fresh.query<AccountRow, []>("SELECT * FROM billing_accounts WHERE status = 'active' ORDER BY id LIMIT 1").get()!;
    const day = `2026-06-${String(account.billing_day).padStart(2, "0")}`;
    const previous = addMonths(day, -1);
    const line = (id: string, msisdn: string, price: number, started: string, allowances?: object) =>
      applyLineEvent(fresh, "line.started", { line_id: id, account_id: account.id, msisdn, tariff_name: `Plan ${id}`, monthly_price_pence: price, started_on: started, allowances });

    line("lin_a", "447700910001", 1600, "2026-01-01", PLANS[2]!.allowances); // unlimited everything: never any extras
    line("lin_b", "447700910002", 3000, "2026-01-01"); // allowances unknown: never any extras
    line("lin_c", "447700910004", 1500, addDays(previous, 10), PLANS[2]!.allowances); // started 10 days into the last period
    line("lin_later", "447700910003", 999, addDays(day, 1)); // starts after the bill date: not on this bill
    applyLineEvent(fresh, "line.ceased", { line_id: "lin_b", ceased_on: addDays(day, 10) }); // ceases later: still billed

    const asked: UsageRequest[] = [];
    const usage: UsageSource = {
      async totals(requests) {
        asked.push(...requests);
        const heavy: Usage = { minutes: 5_000, texts: 900, data_mb: 500_000, eu_roaming_days: 5, world_roaming_days: 3, international_minutes: 0 };
        return new Map(requests.map((r) => [r.key, r.key === "lin_c" ? { ...NO_USAGE, international_minutes: 10 } : heavy]));
      },
    };
    await new BillingEngine(fresh, usage).runDay(day);
    const invoice = fresh.query<InvoiceRow, [string, string]>("SELECT * FROM invoices WHERE account_id = ? AND issued_on = ?").get(account.id, day)!;
    const items = JSON.parse(invoice.line_items) as LineItem[];
    const periodDays = daysBetween(previous, day);
    const partDays = periodDays - 10;
    const prorata = Math.round((1500 * partDays) / periodDays);

    expect(items.filter((i) => i.kind !== "extra").map((i) => [i.kind, i.msisdn, i.description.slice(0, 26), i.amount_pence])).toEqual([
      ["plan", "447700910001", "07700 910001 · Plan lin_a ", 1600],
      ["plan", "447700910002", "07700 910002 · Plan lin_b ", 3000],
      ["plan", "447700910004", "07700 910004 · Plan lin_c ", 1500],
      ["prorata", "447700910004", "07700 910004 · Plan lin_c ", prorata],
    ]);
    expect(items.find((i) => i.kind === "prorata")!.description).toContain(`(${partDays} of ${periodDays} days)`);
    // Usage is asked for each line with known allowances, over the part of the last period it was live.
    expect(asked).toEqual([
      { key: "lin_a", msisdn: "447700910001", from: previous, to: day },
      { key: "lin_c", msisdn: "447700910004", from: addDays(previous, 10), to: day },
    ]);
    // lin_a used a lot, but all of it is inside its unlimited allowances; lin_c called abroad.
    expect(items.filter((i) => i.kind === "extra").map((i) => [i.msisdn, i.amount_pence])).toEqual([["447700910004", 10 * RATES.international_minute]]);

    const extras = items.filter((i) => i.kind === "extra").reduce((s, i) => s + i.amount_pence, 0);
    expect(invoice.amount_pence).toBe(1600 + 3000 + 1500 + prorata + extras);

    const view = new BillingRepository(fresh, () => TODAY).findAccount({ id: account.id })!;
    expect(view.monthly_charge_pence).toBe(1600 + 1500 + 999); // lin_b has ceased; lin_later is live
  });

  test("if usage is unavailable the day fails and nothing is billed; it runs once usage is back", async () => {
    const fresh = openDatabase(":memory:");
    seedAccounts(fresh, customers.slice(0, 200), 7, TODAY);
    seedLines(fresh);
    const down: UsageSource = { totals: () => Promise.reject(new Error("The usage daemon is not running")) };
    const { billing_day } = fresh.query<AccountRow, []>("SELECT * FROM billing_accounts WHERE status = 'active' LIMIT 1").get()!;
    const day = `2026-06-${String(billing_day).padStart(2, "0")}`;

    await expect(new BillingEngine(fresh, down).runThrough(day, { from: day })).rejects.toThrow("usage daemon is not running");
    expect(fresh.query("SELECT (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM billing_runs) AS n").get()).toEqual({ n: 0 });

    expect((await new BillingEngine(fresh, fakeUsage).runThrough(day, { from: day }))[0]!.invoices_issued).toBeGreaterThan(0);
  });

  test("an account with no lines has no monthly charge and gets no bill", async () => {
    const fresh = openDatabase(":memory:");
    seedAccounts(fresh, customers.slice(0, 5), 7, TODAY);
    const account = fresh.query<AccountRow, []>("SELECT * FROM billing_accounts WHERE status = 'active' LIMIT 1").get()!;

    await new BillingEngine(fresh, fakeUsage).runDay(`2026-06-${String(account.billing_day).padStart(2, "0")}`);

    expect(new BillingRepository(fresh, () => TODAY).findAccount({ id: account.id })!.monthly_charge_pence).toBe(0);
    expect(fresh.query("SELECT COUNT(*) AS n FROM invoices").get()).toEqual({ n: 0 });
  });

  test("across the simulation, every bill's plan charges equal the account's lines, and extras stay occasional", () => {
    const lines = db.query<BillableLineRow, []>("SELECT * FROM billable_lines").all();
    const byAccount = Map.groupBy(lines, (l) => l.account_id);
    let extras = 0;

    for (const invoice of invoices) {
      const items = JSON.parse(invoice.line_items) as LineItem[];
      const live = (byAccount.get(invoice.account_id) ?? []).filter(
        (l) => l.started_on <= invoice.issued_on && (l.ceased_on === null || l.ceased_on > invoice.issued_on),
      );

      expect(items.filter((i) => i.kind === "plan").reduce((s, i) => s + i.amount_pence, 0)).toBe(live.reduce((s, l) => s + l.monthly_price_pence, 0));
      if (items.some((i) => i.kind === "extra")) extras++;
    }

    expect(invoices.some((i) => i.line_items.includes('"prorata"'))).toBe(true);
    expect(extras / invoices.length).toBeGreaterThan(0.05);
    expect(extras / invoices.length).toBeLessThan(0.35);
  });
});

describe("usage and out-of-bundle rating", () => {
  const capped = PLANS[0]!.allowances;
  const unlimited = PLANS[2]!.allowances;

  test("only usage outside the allowance is charged, at the published rates", () => {
    const usage = { minutes: 280, texts: 251, data_mb: 2_048 + 1_500, eu_roaming_days: 3, world_roaming_days: 2, international_minutes: 10 };

    expect(rateUsage(usage, capped).map((e) => [e.kind, e.amount_pence])).toEqual([
      ["minutes", 30 * RATES.minute],
      ["texts", 1 * RATES.text],
      ["data", 2 * RATES.data_gb], // 1.5GB over: two 1GB top-ups
      ["eu_roaming", 3 * RATES.eu_roaming_day],
      ["world_roaming", 2 * RATES.world_roaming_day],
      ["international_calls", 10 * RATES.international_minute],
    ]);
    expect(rateUsage(usage, unlimited).map((e) => e.kind)).toEqual(["international_calls"]);
    expect(rateUsage({ ...usage, minutes: 250, texts: 0, data_mb: 2_048, eu_roaming_days: 0, world_roaming_days: 0, international_minutes: 0 }, capped)).toEqual([]);
  });
});
