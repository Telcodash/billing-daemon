import type { Database } from "bun:sqlite";
import type IORedis from "ioredis";

/**
 * Publishes the outbox to the billing daemon's public event stream, `<prefix>:events:billing`.
 *
 * Each stream entry has the fields: id, type, occurred_at, data (JSON). Event types:
 *   - account.suspended    { account_id, customer_id, reason: "arrears", effective_on }
 *   - account.reactivated  { account_id, customer_id, effective_on }
 *
 * Delivery is at-least-once: if the process dies between XADD and marking the row published,
 * the event is published again on restart. Consumers must be idempotent on state (e.g. barring an
 * already-barred number is a no-op). Don't de-duplicate on `id`: it's the outbox row id, which
 * restarts if the billing database is re-seeded.
 */
export const eventStreamKey = (prefix: string) => `${prefix}:events:billing`;

/** Keep roughly this many events in the stream; consumers are expected to keep up. */
const STREAM_MAX_LEN = 100_000;

interface OutboxRow {
  id: number;
  type: string;
  data: string;
  occurred_at: string;
}

export class OutboxPublisher {
  private flushing: Promise<number> | null = null;

  constructor(
    private readonly db: Database,
    private readonly redis: IORedis,
    private readonly stream: string,
  ) {}

  /** Publish everything pending. Concurrent calls share one flush. Returns how many were published. */
  flush(): Promise<number> {
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  pending(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL").get()!.n;
  }

  private async drain(): Promise<number> {
    let published = 0;

    for (;;) {
      const batch = this.db
        .query<OutboxRow, []>("SELECT id, type, data, occurred_at FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 500")
        .all();
      if (batch.length === 0) return published;

      const pipeline = this.redis.pipeline();
      for (const event of batch) {
        pipeline.xadd(
          this.stream, "MAXLEN", "~", String(STREAM_MAX_LEN), "*",
          "id", `billing:${event.id}`, "type", event.type, "occurred_at", event.occurred_at, "data", event.data,
        );
      }

      const results = await pipeline.exec();
      const failed = results?.find(([error]) => error);
      if (failed) throw failed[0];

      const ids = batch.map((e) => e.id);
      this.db
        .query(`UPDATE outbox SET published_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
        .run(new Date().toISOString(), ...ids);
      published += batch.length;
    }
  }
}
