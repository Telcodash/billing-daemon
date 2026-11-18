import type { Database } from "bun:sqlite";
import type IORedis from "ioredis";

/**
 * Follows the subscription daemon's event stream (`<prefix>:events:subscriptions`) and keeps
 * `billable_lines` (billing's copy of each account's lines) current:
 *
 *   line.started  → add the line at its locked-in price, with its allowances
 *   line.restated → the line's full current state (upsert): the subscription daemon re-sends
 *                   every line this way when its event schema gains fields, e.g. allowances
 *   line.ceased   → stop charging it from that date
 *
 * The group starts at the beginning of the stream, so lines created before billing first
 * listened are still picked up. Delivery is at-least-once; handlers are idempotent on state.
 */
export const subscriptionStreamKey = (prefix: string) => `${prefix}:events:subscriptions`;

export function applyLineEvent(db: Database, type: string, data: Record<string, unknown>): boolean {
  const str = (key: string) => (typeof data[key] === "string" ? (data[key] as string) : null);
  const lineId = str("line_id");
  if (!lineId) return false;

  if (type === "line.started" || type === "line.restated") {
    const accountId = str("account_id");
    const msisdn = str("msisdn");
    const startedOn = str("started_on");
    const price = data.monthly_price_pence;
    if (!accountId || !msisdn || !startedOn || typeof price !== "number") return false;

    const allowances = readAllowances(data.allowances);
    const row = {
      line_id: lineId,
      account_id: accountId,
      msisdn,
      tariff_id: str("tariff_id"),
      tariff_name: str("tariff_name") ?? "Mobile plan",
      monthly_price_pence: price,
      started_on: startedOn,
      ceased_on: str("ceased_on"),
      allowances_known: allowances ? 1 : 0,
      minutes: allowances?.minutes ?? null,
      texts: allowances?.texts ?? null,
      data_mb: allowances?.data_mb ?? null,
      eu_roaming: allowances?.eu_roaming ? 1 : 0,
      international_roaming: allowances?.international_roaming ? 1 : 0,
    };

    const insert = `INSERT INTO billable_lines (line_id, account_id, msisdn, tariff_id, tariff_name, monthly_price_pence, started_on,
        ceased_on, allowances_known, minutes, texts, data_mb, eu_roaming, international_roaming)
      VALUES ($line_id, $account_id, $msisdn, $tariff_id, $tariff_name, $monthly_price_pence, $started_on,
        $ceased_on, $allowances_known, $minutes, $texts, $data_mb, $eu_roaming, $international_roaming)`;

    if (type === "line.started") {
      // A redelivered start never overwrites anything, but it can fill in allowances we lack.
      const inserted = db.query(`${insert} ON CONFLICT (line_id) DO NOTHING`).run(row).changes > 0;
      if (inserted || !allowances) return inserted;
      return fillAllowances(db, row);
    }

    // Restated: the full state wins, except that a ceased line is never revived.
    if (!allowances) return false;
    return (
      db
        .query(
          `${insert} ON CONFLICT (line_id) DO UPDATE SET
             account_id = excluded.account_id, msisdn = excluded.msisdn, tariff_id = excluded.tariff_id,
             tariff_name = excluded.tariff_name, monthly_price_pence = excluded.monthly_price_pence,
             started_on = excluded.started_on, ceased_on = COALESCE(billable_lines.ceased_on, excluded.ceased_on),
             allowances_known = excluded.allowances_known, minutes = excluded.minutes, texts = excluded.texts,
             data_mb = excluded.data_mb, eu_roaming = excluded.eu_roaming, international_roaming = excluded.international_roaming`,
        )
        .run(row).changes > 0
    );
  }

  if (type === "line.ceased") {
    const ceasedOn = str("ceased_on");
    if (!ceasedOn) return false;

    return db.query("UPDATE billable_lines SET ceased_on = ? WHERE line_id = ? AND ceased_on IS NULL").run(ceasedOn, lineId).changes > 0;
  }

  return false;
}

interface EventAllowances {
  minutes: number | null;
  texts: number | null;
  data_mb: number | null;
  eu_roaming: boolean;
  international_roaming: boolean;
}

/** Allowances from an event, or null if absent or malformed (older events don't carry them). */
function readAllowances(value: unknown): EventAllowances | null {
  if (typeof value !== "object" || value === null) return null;
  const a = value as Record<string, unknown>;
  const quantity = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);

  if (!quantity(a.minutes) || !quantity(a.texts) || !quantity(a.data_mb)) return null;
  if (typeof a.eu_roaming !== "boolean" || typeof a.international_roaming !== "boolean") return null;

  return {
    minutes: a.minutes as number | null,
    texts: a.texts as number | null,
    data_mb: a.data_mb as number | null,
    eu_roaming: a.eu_roaming,
    international_roaming: a.international_roaming,
  };
}

function fillAllowances(db: Database, row: Record<string, unknown>): boolean {
  return (
    db
      .query(
        `UPDATE billable_lines SET allowances_known = 1, tariff_id = COALESCE(tariff_id, $tariff_id), minutes = $minutes,
           texts = $texts, data_mb = $data_mb, eu_roaming = $eu_roaming, international_roaming = $international_roaming
         WHERE line_id = $line_id AND allowances_known = 0`,
      )
      .run({
        line_id: row.line_id as string,
        tariff_id: row.tariff_id as string | null,
        minutes: row.minutes as number | null,
        texts: row.texts as number | null,
        data_mb: row.data_mb as number | null,
        eu_roaming: row.eu_roaming as number,
        international_roaming: row.international_roaming as number,
      }).changes > 0
  );
}

export class SubscriptionEventConsumer {
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly db: Database,
    /** A dedicated connection: XREADGROUP BLOCK holds it. */
    private readonly redis: IORedis,
    private readonly stream: string,
    private readonly group: string,
    private readonly consumer: string,
    private readonly log: (message: string) => void,
  ) {}

  /** Create the group at the start of the stream (if it doesn't exist), to include every past line. */
  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", this.stream, this.group, "0", "MKSTREAM");
    } catch (error) {
      if (!(error as Error).message.includes("BUSYGROUP")) throw error;
    }
  }

  async poll(from: "0" | ">", blockMs: number): Promise<number> {
    const args = ["GROUP", this.group, this.consumer, "COUNT", "500"] as const;
    const reply = (blockMs > 0
      ? await this.redis.xreadgroup(...args, "BLOCK", blockMs, "STREAMS", this.stream, from)
      : await this.redis.xreadgroup(...args, "STREAMS", this.stream, from)) as [string, [string, string[] | null][]][] | null;

    const entries = reply?.[0]?.[1] ?? [];
    if (entries.length === 0) return 0;

    let changed = 0;
    this.db.transaction(() => {
      for (const [, fields] of entries) {
        if (!fields) continue;
        const map: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
        try {
          if (applyLineEvent(this.db, map.type ?? "", JSON.parse(map.data ?? "{}"))) changed++;
        } catch {
          // Malformed payloads are skipped (and acknowledged) rather than blocking the stream.
        }
      }
    })();

    await this.redis.xack(this.stream, this.group, ...entries.map(([id]) => id));
    if (changed > 0) this.log(`applied ${changed} line event(s) from ${this.stream}`);

    return entries.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.loop = (async () => {
      while (this.running && (await this.poll("0", 0)) > 0);
      while (this.running) {
        try {
          await this.poll(">", 5_000);
        } catch (error) {
          if (!this.running) break;
          console.error(`[billing] subscription events: ${(error as Error).message}; retrying`);
          await Bun.sleep(2_000);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.redis.disconnect();
    await this.loop?.catch(() => undefined);
  }
}
