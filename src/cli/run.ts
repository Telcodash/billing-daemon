/**
 * Run the billing engine by hand: `bun run billing:run [--through=YYYY-MM-DD]`.
 * Runs every day since the last completed run, up to --through (default: today).
 * Safe to repeat: completed days are skipped. Stop the daemon first (SQLite is single-writer).
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config";
import { openDatabase } from "../db";
import { BillingEngine } from "../engine";
import { UsageDaemonClient } from "../rpc";
import { today } from "../util";

const config = loadConfig();
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { through: { type: "string" } } });
const through = values.through ?? today(config.TIMEZONE);

if (through > today(config.TIMEZONE)) {
  console.error(`Refusing to run billing for a future date (${through}).`);
  process.exit(1);
}

const db = openDatabase(config.DATABASE_PATH);
const usage = new UsageDaemonClient(config);
const runs = await new BillingEngine(db, usage).runThrough(through);
await usage.close();

for (const r of runs) {
  console.log(
    `${r.run_date}  invoices ${r.invoices_issued} (£${(r.amount_invoiced_pence / 100).toFixed(2)})  ` +
      `payments ${r.payments_succeeded}/${r.payments_attempted} ok (£${(r.amount_collected_pence / 100).toFixed(2)})  ` +
      `suspended ${r.accounts_suspended}  reactivated ${r.accounts_reactivated}`,
  );
}
console.log(runs.length ? `Ran ${runs.length} day(s).` : "Nothing to run: already up to date.");
db.close();
