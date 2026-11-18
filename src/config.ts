import { z } from "zod";

const EnvSchema = z.object({
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  /** Must match the gateway's QUEUE_PREFIX so all services see the same BullMQ keys. */
  QUEUE_PREFIX: z.string().default("queue"),
  /** The BullMQ queue this daemon consumes. */
  QUEUE_NAME: z.string().default("billing"),
  /** The customer daemon's queue, used to fetch customer references when seeding. */
  CUSTOMERS_QUEUE: z.string().default("customers"),
  /** The subscription daemon's queue: on first boot, history is backfilled once its lines have arrived. */
  SUBSCRIPTIONS_QUEUE: z.string().default("subscriptions"),
  /** The usage daemon's queue: billing rates its usage totals for out-of-bundle extras. */
  USAGE_QUEUE: z.string().default("usage"),
  CONCURRENCY: z.coerce.number().int().positive().default(10),

  DATABASE_PATH: z.string().default("data/billing.sqlite"),
  /** Business time zone: decides what "today" is and when the daily run fires. */
  TIMEZONE: z.string().default("Europe/London"),
  /** Cron pattern for the daily billing run (in TIMEZONE). */
  DAILY_RUN_CRON: z.string().default("0 2 * * *"),
  /** On boot, run any days missed while the daemon was down (up to this many). */
  MAX_CATCH_UP_DAYS: z.coerce.number().int().nonnegative().default(400),

  /** Seed accounts for every customer when the database is empty. */
  SEED_ON_EMPTY: z.stringbool().default(true),
  SEED: z.coerce.number().int().default(1),
  /** After seeding, replay this many days of billing so accounts have invoice/payment history. */
  BACKFILL_DAYS: z.coerce.number().int().nonnegative().default(90),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}
