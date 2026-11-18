import type { AccountRow, PaymentMethodType } from "./types";
import { chance, reference, type IsoDate } from "./util";

/**
 * A fake payment processor (think BACS for Direct Debit, a card acquirer for cards).
 *
 * Outcomes are deterministic: they depend only on the account, invoice and attempt, so replaying
 * a day reproduces the same results. Most payments succeed; a small share of accounts are
 * habitual bad payers, and cards past their expiry always fail, which drives the retry and
 * suspension paths in the billing engine just as real-world failures would.
 */
export interface ChargeRequest {
  account: AccountRow;
  invoiceId: string;
  amountPence: number;
  attempt: number;
  date: IsoDate;
  initiatedBy: "scheduled" | "customer";
}

export type ChargeResult =
  | { status: "succeeded"; method: PaymentMethodType; reference: string }
  | { status: "failed"; method: PaymentMethodType; reference: string; code: string; message: string };

/** Share of accounts that are habitual bad payers. */
const HABITUAL_SHARE = 0.08;

const FAILURE_RATE: Record<PaymentMethodType, { normal: number; habitual: number }> = {
  direct_debit: { normal: 0.02, habitual: 0.55 },
  card: { normal: 0.04, habitual: 0.6 },
};

/** Failure reasons, modelled on BACS ARUDD reason codes and card decline responses. */
const FAILURES: Record<PaymentMethodType, { weight: number; code: string; message: string }[]> = {
  direct_debit: [
    { weight: 0.85, code: "insufficient_funds", message: "ARUDD 0: Refer to payer" },
    { weight: 0.15, code: "mandate_cancelled", message: "ARUDD 1: Instruction cancelled by payer" },
  ],
  card: [
    { weight: 0.7, code: "card_declined", message: "Declined: do not honour" },
    { weight: 0.3, code: "insufficient_funds", message: "Declined: insufficient funds" },
  ],
};

export function isHabitualBadPayer(accountId: string): boolean {
  return chance(`risk:${accountId}`) < HABITUAL_SHARE;
}

export function charge(req: ChargeRequest): ChargeResult {
  // A customer paying by hand uses a card they have just entered, and it goes through.
  const method: PaymentMethodType = req.initiatedBy === "customer" ? "card" : req.account.payment_method;
  const key = `pay:${req.invoiceId}:${req.attempt}`;
  const ref = method === "direct_debit" ? `DD${reference(key, 10)}` : `ch_${reference(key, 14).toLowerCase()}`;

  if (req.initiatedBy === "customer") return { status: "succeeded", method, reference: ref };

  if (method === "card" && req.account.card_expiry && req.account.card_expiry < req.date.slice(0, 7)) {
    return { status: "failed", method, reference: ref, code: "expired_card", message: "Declined: expired card" };
  }

  const rates = FAILURE_RATE[method];
  const failureRate = isHabitualBadPayer(req.account.id) ? rates.habitual : rates.normal;

  if (chance(key) >= failureRate) return { status: "succeeded", method, reference: ref };

  const pick = chance(`${key}:reason`);
  let cumulative = 0;
  const failure = FAILURES[method].find((f) => (cumulative += f.weight) > pick) ?? FAILURES[method][0]!;

  return { status: "failed", method, reference: ref, code: failure.code, message: failure.message };
}
