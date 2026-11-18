import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import type { Config } from "./config";
import type { CustomerRef } from "./seed";
import type { Usage, UsageRequest, UsageSource } from "./usage";

/**
 * Daemon-to-daemon calls go straight through Redis/BullMQ rather than the HTTP gateway:
 * they're internal (e.g. `customers.refs` isn't exposed to Core) and need no token.
 */
class DaemonClient {
  private readonly queue: Queue;
  private readonly events: QueueEvents;
  /** BullMQ doesn't close connections it's given, so they're closed here (or a CLI never exits). */
  private readonly connections: IORedis[] = [];

  constructor(
    config: Config,
    queueName: string,
    private readonly label: string,
  ) {
    const connection = () => {
      const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
      this.connections.push(redis);
      return redis;
    };
    this.queue = new Queue(queueName, { connection: connection(), prefix: config.QUEUE_PREFIX });
    this.events = new QueueEvents(queueName, { connection: connection(), prefix: config.QUEUE_PREFIX });
  }

  protected async call<T>(name: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    await this.events.waitUntilReady();

    if ((await this.queue.getWorkersCount()) === 0) {
      throw new Error(`The ${this.label} is not running (no workers on [${this.queue.name}])`);
    }

    const job = await this.queue.add(name, { payload }, { attempts: 1, removeOnComplete: true, removeOnFail: { age: 600 } });

    return (await job.waitUntilFinished(this.events, timeoutMs)) as T;
  }

  async close(): Promise<void> {
    await this.events.close();
    await this.queue.close();
    for (const redis of this.connections) redis.disconnect();
  }
}

export class CustomerDaemonClient extends DaemonClient {
  constructor(config: Config) {
    super(config, config.CUSTOMERS_QUEUE, "customer daemon");
  }

  /** Every customer reference, paged through the customer daemon. */
  async allCustomerRefs(): Promise<CustomerRef[]> {
    const refs: CustomerRef[] = [];
    let after: string | undefined;

    for (;;) {
      const page = await this.call<CustomerRef[]>("customers.refs", { after, limit: 1_000 });
      if (page.length === 0) return refs;
      refs.push(...page);
      after = page.at(-1)!.id;
    }
  }

  /** Wait for the customer daemon to come up, so the two can be started in any order. */
  async allCustomerRefsWhenAvailable(log: (message: string) => void): Promise<CustomerRef[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.allCustomerRefs();
      } catch (error) {
        if (attempt === 1 || attempt % 6 === 0) log(`${(error as Error).message}; retrying…`);
        await Bun.sleep(Math.min(1_000 * attempt, 10_000));
      }
    }
  }
}

export class SubscriptionDaemonClient extends DaemonClient {
  constructor(config: Config) {
    super(config, config.SUBSCRIPTIONS_QUEUE, "subscription daemon");
  }

  /** How many active lines the subscription daemon has (internal task `lines.count`). */
  async activeLines(): Promise<number> {
    return (await this.call<{ active: number }>("lines.count", {})).active;
  }
}

export class UsageDaemonClient extends DaemonClient implements UsageSource {
  /** Requests per call: a day's bills fit in one, a backfill takes a few dozen. */
  private static readonly BATCH = 500;

  constructor(config: Config) {
    super(config, config.USAGE_QUEUE, "usage daemon");
  }

  /** Usage totals per line (internal task `usage.totals`), batched. */
  async totals(requests: UsageRequest[]): Promise<Map<string, Usage>> {
    const result = new Map<string, Usage>();

    for (let i = 0; i < requests.length; i += UsageDaemonClient.BATCH) {
      const batch = requests.slice(i, i + UsageDaemonClient.BATCH);
      const page = await this.call<Record<string, Usage>>("usage.totals", { requests: batch }, 30_000);
      for (const [key, usage] of Object.entries(page)) result.set(key, usage);
    }

    return result;
  }
}
