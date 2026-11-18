import type { IsoDate } from "./util";

/**
 * Out-of-bundle rating.
 *
 * Usage comes from the usage daemon (`usage.totals`), the same records Core shows on a number's
 * Usage page. Billing's job is rating: whatever falls outside a line's allowances is charged at
 * these rates; everything inside them is already paid for by the plan.
 */

/** What a line's tariff includes each month. `null` quantities are unlimited. */
export interface LineAllowances {
  minutes: number | null;
  texts: number | null;
  data_mb: number | null;
  eu_roaming: boolean;
  international_roaming: boolean;
}

/** Out-of-bundle prices, in pence. Roughly what UK networks charge. */
export const RATES = {
  /** UK calls beyond the minutes allowance, per minute. */
  minute: 55,
  /** UK texts beyond the texts allowance, per text. */
  text: 20,
  /** Data beyond the allowance: an automatic 1GB top-up, per GB or part of one. */
  data_gb: 300,
  /** A day using the phone in the EU when the tariff doesn't include EU roaming. */
  eu_roaming_day: 249,
  /** A day using the phone outside the EU when the tariff doesn't include worldwide roaming. */
  world_roaming_day: 699,
  /** Calls from the UK to international numbers, per minute. No tariff includes these. */
  international_minute: 120,
} as const;

export interface Usage {
  minutes: number;
  texts: number;
  data_mb: number;
  eu_roaming_days: number;
  world_roaming_days: number;
  international_minutes: number;
}

export type ExtraKind = "minutes" | "texts" | "data" | "eu_roaming" | "world_roaming" | "international_calls";

export interface Extra {
  kind: ExtraKind;
  /** e.g. "Calls over allowance: 37 mins at 55p" */
  description: string;
  amount_pence: number;
}

const pence = (p: number) => (p % 100 === 0 ? `£${p / 100}` : p < 100 ? `${p}p` : `£${(p / 100).toFixed(2)}`);
const gb = (mb: number) => {
  const g = mb / 1024;
  return g >= 10 || Number.isInteger(g) ? `${Math.round(g)}GB` : `${g.toFixed(1)}GB`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Usage totals for one line over `[from, to)`, requested by `key`. */
export interface UsageRequest {
  key: string;
  msisdn: string;
  from: IsoDate;
  to: IsoDate;
}

/** Where billing gets usage from: the usage daemon in production, a fake in tests. */
export interface UsageSource {
  totals(requests: UsageRequest[]): Promise<Map<string, Usage>>;
}

/** Rate usage against allowances. Anything inside the allowance is free; only extras are returned. */
export function rateUsage(usage: Usage, allowances: LineAllowances): Extra[] {
  const extras: Extra[] = [];

  if (allowances.minutes !== null && usage.minutes > allowances.minutes) {
    const over = usage.minutes - allowances.minutes;
    extras.push({ kind: "minutes", description: `Calls over allowance: ${over} mins at ${pence(RATES.minute)}`, amount_pence: over * RATES.minute });
  }

  if (allowances.texts !== null && usage.texts > allowances.texts) {
    const over = usage.texts - allowances.texts;
    extras.push({ kind: "texts", description: `Texts over allowance: ${plural(over, "text")} at ${pence(RATES.text)}`, amount_pence: over * RATES.text });
  }

  if (allowances.data_mb !== null && usage.data_mb > allowances.data_mb) {
    const topUps = Math.ceil((usage.data_mb - allowances.data_mb) / 1024);
    extras.push({
      kind: "data",
      description: `Data top-up: ${gb(usage.data_mb)} used of ${gb(allowances.data_mb)}, ${topUps} × 1GB at ${pence(RATES.data_gb)}`,
      amount_pence: topUps * RATES.data_gb,
    });
  }

  if (!allowances.eu_roaming && usage.eu_roaming_days > 0) {
    extras.push({
      kind: "eu_roaming",
      description: `EU roaming: ${plural(usage.eu_roaming_days, "day")} at ${pence(RATES.eu_roaming_day)}`,
      amount_pence: usage.eu_roaming_days * RATES.eu_roaming_day,
    });
  }

  if (!allowances.international_roaming && usage.world_roaming_days > 0) {
    extras.push({
      kind: "world_roaming",
      description: `Roaming outside the EU: ${plural(usage.world_roaming_days, "day")} at ${pence(RATES.world_roaming_day)}`,
      amount_pence: usage.world_roaming_days * RATES.world_roaming_day,
    });
  }

  if (usage.international_minutes > 0) {
    extras.push({
      kind: "international_calls",
      description: `Calls to international numbers: ${usage.international_minutes} mins at ${pence(RATES.international_minute)}`,
      amount_pence: usage.international_minutes * RATES.international_minute,
    });
  }

  return extras;
}
