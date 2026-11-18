import type { Database } from "bun:sqlite";
import { fakerEN_GB as f } from "@faker-js/faker";
import type { Address, AccountStatus, PaymentMethodType } from "./types";
import { addMonths, newId, type IsoDate } from "./util";

/** A customer as the customer daemon describes it to other daemons: no personal data. */
export interface CustomerRef {
  id: string;
  status: "active" | "closed";
  created_at: string;
}

/** Monthly plan prices in pence, roughly the spread of UK SIM-only and handset plans. */
const TARIFFS = [800, 1000, 1200, 1500, 1800, 2200, 2500, 3000, 3600, 4500, 5200, 6000];

/** A few real post towns for the occasional separate billing address. */
const BILLING_TOWNS: [string, string | null, string][] = [
  ["London", null, "EC1"],
  ["Manchester", "Greater Manchester", "M2"],
  ["Leeds", "West Yorkshire", "LS1"],
  ["Bristol", "Bristol", "BS1"],
  ["Glasgow", "Lanarkshire", "G2"],
  ["Cardiff", "South Glamorgan", "CF10"],
  ["Birmingham", "West Midlands", "B3"],
];

const UNIT_LETTERS = "ABDEFGHJLNPQRSTUWXYZ";

function billingAddress(): Address {
  const [town, county, outward] = f.helpers.arrayElement(BILLING_TOWNS);
  const unit = f.helpers.arrayElement([...UNIT_LETTERS]) + f.helpers.arrayElement([...UNIT_LETTERS]);

  return {
    line_1: `${f.helpers.arrayElement(["Suite", "Unit", "Floor"])} ${f.number.int({ min: 1, max: 30 })}`,
    line_2: `${f.number.int({ min: 1, max: 200 })} ${f.helpers.arrayElement(["King Street", "Queen Street", "Albert Square", "Park Row"])}`,
    town,
    county,
    postcode: `${outward} ${f.number.int({ min: 1, max: 9 })}${unit}`,
    country: "GB",
  };
}

/**
 * Create 1–3 billing accounts per customer. Deterministic for a given seed and customer list.
 * Accounts of closed customers are closed; a few others are closed too.
 */
export function seedAccounts(db: Database, customers: CustomerRef[], seedValue: number, today: IsoDate): number {
  f.seed(seedValue);

  const now = new Date(`${today}T00:00:00Z`);
  const used = new Set(db.query<{ n: string }, []>("SELECT account_number AS n FROM billing_accounts").all().map((r) => r.n));

  const insert = db.prepare(`
    INSERT INTO billing_accounts (id, customer_id, account_number, status, suspension_reason, monthly_charge_pence,
      billing_day, payment_method, dd_sort_code_masked, dd_account_last4, dd_mandate_reference, card_brand, card_last4,
      card_expiry, billing_address_line_1, billing_address_line_2, billing_town, billing_county, billing_postcode,
      created_at, updated_at, closed_at)
    VALUES ($id, $customer_id, $account_number, $status, NULL, $monthly_charge_pence,
      $billing_day, $payment_method, $dd_sort_code_masked, $dd_account_last4, $dd_mandate_reference, $card_brand, $card_last4,
      $card_expiry, $b_line_1, $b_line_2, $b_town, $b_county, $b_postcode, $created_at, $created_at, $closed_at)
  `);

  let count = 0;

  db.transaction(() => {
    for (const customer of customers) {
      const accounts = f.helpers.weightedArrayElement([
        { weight: 85, value: 1 },
        { weight: 13, value: 2 },
        { weight: 2, value: 3 },
      ]);

      for (let i = 0; i < accounts; i++) {
        let accountNumber: string;
        do accountNumber = f.string.numeric({ length: 10, allowLeadingZeros: false });
        while (used.has(accountNumber));
        used.add(accountNumber);

        const createdAt = f.date.between({ from: new Date(customer.created_at), to: now });
        const status: AccountStatus = customer.status === "closed" || f.datatype.boolean({ probability: 0.03 }) ? "closed" : "active";
        const method: PaymentMethodType = f.datatype.boolean({ probability: 0.8 }) ? "direct_debit" : "card";
        // Card expiries from 6 months ago to 5 years out: some are already expired and will decline.
        const expiry = addMonths(today, f.number.int({ min: -6, max: 60 })).slice(0, 7);
        const address = f.datatype.boolean({ probability: 0.05 }) ? billingAddress() : null;

        insert.run({
          id: newId("acc", createdAt.getTime(), () => f.number.float({ min: 0, max: 0.999999 })),
          customer_id: customer.id,
          account_number: accountNumber,
          status,
          monthly_charge_pence: f.helpers.arrayElement(TARIFFS),
          billing_day: f.number.int({ min: 1, max: 28 }),
          payment_method: method,
          dd_sort_code_masked: method === "direct_debit" ? `**-**-${f.string.numeric(2)}` : null,
          dd_account_last4: method === "direct_debit" ? f.string.numeric(4) : null,
          dd_mandate_reference: method === "direct_debit" ? `MNDT-${f.string.alphanumeric({ length: 10, casing: "upper" })}` : null,
          card_brand: method === "card" ? f.helpers.weightedArrayElement([
            { weight: 60, value: "Visa" },
            { weight: 35, value: "Mastercard" },
            { weight: 5, value: "American Express" },
          ]) : null,
          card_last4: method === "card" ? f.string.numeric(4) : null,
          card_expiry: method === "card" ? expiry : null,
          b_line_1: address?.line_1 ?? null,
          b_line_2: address?.line_2 ?? null,
          b_town: address?.town ?? null,
          b_county: address?.county ?? null,
          b_postcode: address?.postcode ?? null,
          created_at: createdAt.toISOString(),
          closed_at: status === "closed" ? f.date.between({ from: createdAt, to: now }).toISOString() : null,
        });
        count++;
      }
    }
  })();

  return count;
}

export function isEmpty(db: Database): boolean {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM billing_accounts").get()!.n === 0;
}
