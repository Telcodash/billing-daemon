import { Queue, UnrecoverableError, Worker } from "bullmq";
import IORedis from "ioredis";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { BillingEngine } from "./engine";
import { eventStreamKey, OutboxPublisher } from "./events";
import { SubscriptionEventConsumer, subscriptionStreamKey } from "./subscriptions";
import { hostname } from "node:os";
import { BillingRepository } from "./repository";
import { CustomerDaemonClient, SubscriptionDaemonClient, UsageDaemonClient } from "./rpc";
import { isEmpty, seedAccounts } from "./seed";
import { createTasks } from "./tasks";
import type { RunSummary } from "./types";
import { addDays, today as todayIn } from "./util";

const config = loadConfig();
const log = (message: string) => console.log(`[billing] ${message}`);
const today = () => todayIn(config.TIMEZONE);

const db = openDatabase(config.DATABASE_PATH);
const usage = new UsageDaemonClient(config);
const engine = new BillingEngine(db, usage);
const repo = new BillingRepository(db, today);

const describe = (runs: RunSummary[]) => {
  const total = (key: keyof RunSummary) => runs.reduce((sum, r) => sum + (r[key] as number), 0);
  return `${runs.length} day(s): ${total("invoices_issued")} invoices, ${total("payments_succeeded")} paid / ${total("payments_failed")} failed, ${total("accounts_suspended")} suspended, ${total("accounts_reactivated")} reactivated`;
};

const connection = () => new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
const publisher = new OutboxPublisher(db, connection(), eventStreamKey(config.QUEUE_PREFIX));
const publish = () =>
  publisher
    .flush()
    .then((n) => n > 0 && log(`published ${n} event(s) to ${eventStreamKey(config.QUEUE_PREFIX)}`))
    .catch((error: Error) => console.error(`[billing] event publish failed (will retry): ${error.message}`));

// Keep billing's copy of each account's lines current, from before the first run onwards.
const lineEvents = new SubscriptionEventConsumer(
  db, connection(), subscriptionStreamKey(config.QUEUE_PREFIX), "billing-daemon", `billing@${hostname()}`, log,
);
await lineEvents.ensureGroup();
lineEvents.start();

// ── Seed or catch up ──

/** Resolves once billing history exists. Billing runs wait for it. */
let history: Promise<unknown>;

if (config.SEED_ON_EMPTY && isEmpty(db)) {
  log("empty database: fetching customers from the customer daemon to seed accounts…");
  const customers = new CustomerDaemonClient(config);
  const refs = await customers.allCustomerRefsWhenAvailable(log);
  await customers.close();

  const created = seedAccounts(db, refs, config.SEED, today());
  log(`seeded ${created} billing accounts for ${refs.length} customers`);

  // Bills are made of lines, and lines are seeded downstream of these accounts (MSISDN daemon,
  // then subscription daemon), so serve tasks now and backfill once the lines have arrived.
  history = waitForLines().then(() =>
    untilItWorks("backfilling history", async () => {
      const started = performance.now();
      const runs = await engine.runThrough(today(), { from: addDays(today(), -config.BACKFILL_DAYS) });
      log(`backfilled ${describe(runs)} in ${Math.round(performance.now() - started)}ms`);
      await publish();
    }),
  );
} else {
  // Catching up needs the usage daemon (for extras), so it happens in the background too.
  history = untilItWorks("catching up missed days", async () => {
    const runs = await engine.runThrough(today(), { maxDays: config.MAX_CATCH_UP_DAYS });
    if (runs.length) log(`caught up ${describe(runs)}`);
    await publish();
  });
}

/** Retry `work` with backoff until it succeeds, e.g. while the usage daemon is down. Completed days stay done. */
async function untilItWorks(what: string, work: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      log(`${what} failed: ${(error as Error).message}; retrying…`);
      await Bun.sleep(Math.min(2_000 * attempt, 30_000));
    }
  }
}

/** Wait until billing holds every active line the subscription daemon has, with its allowances. */
async function waitForLines(): Promise<void> {
  const subscriptions = new SubscriptionDaemonClient(config);
  const known = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM billable_lines WHERE ceased_on IS NULL AND allowances_known = 1");

  for (let attempt = 1; ; attempt++) {
    try {
      const expected = await subscriptions.activeLines();
      const have = known.get()!.n;
      if (have >= expected) break;
      if (attempt % 10 === 1) log(`waiting for lines before backfilling history: ${have}/${expected} received`);
    } catch (error) {
      if (attempt % 10 === 1) log(`${(error as Error).message}; waiting for it before backfilling history…`);
    }
    await Bun.sleep(2_000);
  }

  await subscriptions.close();
}

// ── Serve tasks ──

await publish();
// Retry anything left unpublished (e.g. Redis was briefly down when a run committed).
const publishTimer = setInterval(() => publisher.pending() > 0 && void publish(), 5_000);

const tasks = createTasks(repo, engine, today);

const worker = new Worker(
  config.QUEUE_NAME,
  async (job) => {
    const handler = tasks[job.name];

    if (!handler) throw new UnrecoverableError(`Billing daemon has no task [${job.name}]`);

    const isRun = job.name === "billing.daily_run" || job.name === "billing.run";
    if (isRun) await history;

    const result = await handler(job.data?.payload ?? {});

    if (isRun) {
      log(`run complete: ${describe(result as RunSummary[])}`);
      await publish();
    }

    return result;
  },
  { connection: connection(), prefix: config.QUEUE_PREFIX, concurrency: config.CONCURRENCY },
);

worker.on("failed", (job, error) => console.warn(`[billing] ${job?.name} ${job?.id} failed: ${error.message}`));
worker.on("error", (error) => console.error(`[billing] ${error.message}`));
worker.on("ready", () => log(`consuming [${config.QUEUE_NAME}] (concurrency ${config.CONCURRENCY})`));

// BullMQ job schedulers are stored in Redis, so several daemon instances still produce one run per day.
const scheduler = new Queue(config.QUEUE_NAME, { connection: connection(), prefix: config.QUEUE_PREFIX });
await scheduler.upsertJobScheduler(
  "daily-billing-run",
  { pattern: config.DAILY_RUN_CRON, tz: config.TIMEZONE },
  { name: "billing.daily_run", data: { payload: {} }, opts: { attempts: 3, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: { count: 30 } } },
);
log(`daily run scheduled: "${config.DAILY_RUN_CRON}" ${config.TIMEZONE}; last run ${engine.lastRunDate() ?? "never"}`);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, finishing active jobs...`);
  clearInterval(publishTimer);
  await lineEvents.stop();
  await worker.close();
  await usage.close();
  await publish();
  await scheduler.close();
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
