/**
 * Rebuild billing history from the lines billing now knows: `bun run billing:rebill [--days=90] [--force]`.
 *
 * For development data only. It deletes every invoice, payment and run, then replays the last
 * --days of billing, so that past bills are made of lines (plan, part month, extras) exactly
 * like new ones. Use it after billing's model of a bill changes, e.g. on a database seeded
 * before per-line billing existed.
 *
 * Accounts currently suspended for arrears are reactivated first (with an event, so the MSISDN
 * daemon lifts the bar); the replay then suspends whichever accounts its history says should be.
 * The daemon publishes the resulting events within a few seconds if it's running, or on next start.
 * It all happens in one transaction, so a running daemon simply waits a few seconds for it.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { openDatabase } from "../db";
import { BillingEngine } from "../engine";
import { UsageDaemonClient } from "../rpc";
import type { Usage } from "../usage";
import { addDays, today as todayIn } from "../util";

const config = loadConfig();
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { days: { type: "string" }, force: { type: "boolean", default: false } },
});
const days = Number(values.days ?? config.BACKFILL_DAYS);
const today = todayIn(config.TIMEZONE);

if (!Number.isInteger(days) || days < 1) {
  console.error("--days must be a positive whole number.");
  process.exit(1);
}

const db = openDatabase(config.DATABASE_PATH);
const lines = db
  .query<{ total: number; known: number }, []>(
    "SELECT COUNT(*) AS total, COALESCE(SUM(allowances_known), 0) AS known FROM billable_lines WHERE ceased_on IS NULL",
  )
  .get()!;

if (lines.total === 0 || (lines.known < lines.total && !values.force)) {
  console.error(
    `Billing knows ${lines.total} live line(s), ${lines.known} with allowances. Wait for the subscription daemon's ` +
      "events to arrive (or pass --force to rebill without extras for lines missing allowances).",
  );
  process.exit(1);
}

const ts = `${today}T02:00:00.000Z`;
const usageClient = new UsageDaemonClient(config);
const engine = new BillingEngine(db, usageClient);
const started = performance.now();
const dates: string[] = [];
for (let date = addDays(today, -(days - 1)); date <= today; date = addDays(date, 1)) dates.push(date);

// Usage for every day's bills first (it depends only on accounts and lines), so the rebuild
// itself can be one synchronous transaction.
const usage = new Map<string, Map<string, Usage>>();
for (const date of dates) usage.set(date, await engine.prepare(date));
await usageClient.close();

// One transaction for clearing and replaying: history is either fully rebuilt or untouched, and a
// running daemon (which would otherwise catch up the same days concurrently) waits until it's done.
const { cleared, runs } = db.transaction(() => {
  const suspended = db
    .query<{ id: string; customer_id: string }, []>(
      "SELECT id, customer_id FROM billing_accounts WHERE status = 'suspended' AND suspension_reason = 'arrears' ORDER BY id",
    )
    .all();
  const event = db.prepare("INSERT INTO outbox (type, data, occurred_at) VALUES ('account.reactivated', ?, ?)");

  for (const account of suspended) {
    event.run(JSON.stringify({ account_id: account.id, customer_id: account.customer_id, effective_on: today, reason: "rebill" }), ts);
  }

  db.run("UPDATE billing_accounts SET status = 'active', suspension_reason = NULL, updated_at = ? WHERE status = 'suspended' AND suspension_reason = 'arrears'", [ts]);
  const invoices = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM invoices").get()!.n;
  db.run("DELETE FROM payments");
  db.run("DELETE FROM invoices");
  db.run("DELETE FROM billing_runs");
  db.run("UPDATE counters SET value = 0 WHERE name = 'invoice_number'");

  const runs = dates.map((date) => engine.applyDay(date, usage.get(date)!));

  return { cleared: { suspended: suspended.length, invoices }, runs };
}).immediate();

console.log(`Cleared ${cleared.invoices} invoices and lifted ${cleared.suspended} arrears suspension(s).`);
const total = (key: "invoices_issued" | "amount_invoiced_pence" | "accounts_suspended" | "accounts_reactivated") =>
  runs.reduce((sum, r) => sum + r[key], 0);

console.log(
  `Replayed ${runs.length} day(s) in ${Math.round(performance.now() - started)}ms: ${total("invoices_issued")} invoices ` +
    `(£${(total("amount_invoiced_pence") / 100).toFixed(2)}), ${total("accounts_suspended")} suspended, ` +
    `${total("accounts_reactivated")} reactivated.`,
);
db.close();
