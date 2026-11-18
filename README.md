# billing-daemon

The Billing Daemon (Bun + TypeScript + `bun:sqlite`). It owns billing accounts, payment methods, invoices and payments, and runs billing every day like a real biller would, with a fake payment processor. It consumes the `billing` queue. Core reaches it through the gateway (`../queue`).

```
Core ──▶ gateway ──▶ Redis queue "billing" ──▶ billing-daemon ──▶ SQLite
                                                   │  ▲
                     daily 02:00 (BullMQ scheduler) ┘  ├── customers.refs (seeding only, straight over Redis) ── customer-daemon
                                                      └── usage.totals (each run, straight over Redis) ──────── usage-daemon
```

## Running

```bash
cp .env.example .env
bun install
bun run dev              # first boot: seeds accounts, then replays 90 days of billing once the lines have arrived
bun run billing:run      # run any missed days by hand (stop the daemon first)
bun run billing:rebill   # dev data only: delete all invoices/payments and replay history (see below)
bun test
bun run typecheck
```

On first boot it waits for the customer daemon if that isn't up yet, so the two can start in any order.

Bills are made of lines, and lines are seeded *downstream* of billing accounts: the MSISDN daemon assigns numbers to the accounts, then the subscription daemon puts each number on a tariff. So on first boot billing seeds its accounts and starts serving at once. It backfills its history only when it holds every active line the subscription daemon reports (internal task `lines.count`), with allowances. Billing runs wait for that backfill.

## Ownership

- **Billing accounts** (`acc_…`) reference customers by their customer daemon ID (`cus_…`). Because the two daemons have separate databases, that reference isn't a foreign key.
- **Payment details are stored masked only**: a Direct Debit sort code like `**-**-12` with the last 4 account digits and mandate reference, or a card's brand, last 4 digits and expiry.
- **Money** is integer pence (GBP).

## The daily run

The run fires at `DAILY_RUN_CRON` in `TIMEZONE` (02:00 UK time by default). It's a BullMQ job scheduler stored in Redis, so running several instances still produces one run per day. For each business date:

1. **Invoice:** every account that is open on that date and whose billing day it is gets an invoice, payable in 14 days. It's built line by line (see [What a bill contains](#what-a-bill-contains)). Suspended accounts still accrue charges. An account with nothing to charge gets no invoice.
2. **Collect:** each invoice is first charged on its due date. A failure is retried every 3 days, up to 3 attempts. After the third failure the invoice is `overdue` and the account is `suspended` with reason `arrears`.
3. **Customer payments:** each day, a customer with an overdue invoice has a 12% chance of paying it by card. That card replaces the expired or declined one on file.
4. **Reactivate:** accounts suspended for arrears become `active` again once nothing is overdue.

How the fake processor decides outcomes (`src/processor.ts`):
- About 98% of Direct Debits and 96% of card payments succeed.
- 8% of accounts are habitual bad payers and fail about half the time.
- Expired cards always fail.
- Failure messages follow BACS ARUDD codes and card decline responses.

**Every outcome is deterministic:** it's a hash of the account, invoice and attempt, so replaying a day always gives the same result.

**Safety:**
- Each day runs in one transaction.
- Unique constraints (one invoice per account per period, one row per payment attempt) make re-running a day a no-op.
- On boot, any days missed while the daemon was down are run in order, up to `MAX_CATCH_UP_DAYS`.

## What a bill contains

A bill is always **the account's monthly plan charge, plus any part month and extras**. Each line item has a `kind` and the `msisdn` it's for:

| Kind | What | Billed |
|---|---|---|
| `plan` | Each line live on the bill date, at its locked-in price, e.g. `07700 910123 · Plus 100GB · 2026-11-18 to 2026-12-17  £22.00`. These add up to the account's `monthly_charge_pence`. | In advance, for the coming period |
| `prorata` | A line that started part-way through the previous period missed that bill, so it pays for the days it was live: price × days ÷ days in the period. | In arrears |
| `extra` | Usage outside the line's allowances during the previous period. | In arrears |

**Usage comes from the usage daemon** (`../usage-daemon`, internal task `usage.totals`), the same records Core shows on a number's Usage page, so a bill's extras always match what the advisor sees. Before each day's transaction the engine asks for every billed line's totals over the part of the previous period it was live (`prepare`). It then rates them (`src/usage.ts`): usage inside an allowance, or on an unlimited one, is never charged. **If the usage daemon is unavailable, the day fails and nothing is billed.** Billing never silently skips extras. The scheduled job retries, and on boot catch-up retries until usage is back. Out-of-bundle rates (`RATES`):

| Extra | When | Rate |
|---|---|---|
| Calls over allowance | Minutes used beyond a capped allowance | 55p/min |
| Texts over allowance | Texts beyond a capped allowance | 20p/text |
| Data top-up | Data beyond a capped allowance | £3 per 1GB or part of one |
| EU roaming | Days in the EU, on a tariff without EU roaming | £2.49/day |
| Roaming outside the EU | Days abroad, on a tariff without international roaming | £6.99/day |
| Calls to international numbers | Always; no tariff includes them | £1.20/min |

About a fifth of bills carry extras, averaging around £19. The usage daemon keeps overspends modest (a few GB, ≤120 mins or 80 texts over), so a large allowance doesn't produce a huge bill. Lines whose allowances billing doesn't know yet (from older events) pay their plan price but no extras.

### Rebuilding history (`billing:rebill`)

For development data only. It deletes every invoice, payment and run, then replays the last `--days` (default `BACKFILL_DAYS`):
- Accounts suspended for arrears are reactivated first, with an event so the MSISDN daemon lifts the bar. The replay then suspends whichever accounts its history says should be.
- It's one transaction, so a running daemon just waits a few seconds for it.
- It refuses to run until every live line has its allowances (unless you pass `--force`).
- It needs the usage daemon, and fetches all the usage first, then rebuilds in about 10 seconds.

Use it when the model of a bill changes. It was last needed when history seeded before per-line billing was replaced.

## Lines (from the subscription daemon)

Billing keeps its own copy of each account's lines in `billable_lines`, including each line's price and allowances. It builds that copy by reading `<QUEUE_PREFIX>:events:subscriptions` as consumer group `billing-daemon`:

| Event | Effect |
|---|---|
| `line.started` | Add the line, at its locked-in price and with its allowances. A redelivered start can fill in allowances that an older event lacked. |
| `line.restated` | Upsert the line's full state, but never revive a ceased line. The subscription daemon re-sends every line this way when its events gain fields, as it did when allowances were added. |
| `line.ceased` | Stop charging the line from that date. |

- **Catching up:** the group starts at the beginning of the stream, so lines created before billing first listened are still picked up.
- **Delivery:** at-least-once. Handlers are idempotent on state.
- **Monthly charge:** an account's `monthly_charge_pence` is the sum of its live lines' prices, or 0 with none. The account-level column of the same name is a leftover from before per-line billing, and nothing charges it.

## Domain events

Status changes are published to the Redis stream **`<QUEUE_PREFIX>:events:billing`**, which other daemons follow with their own consumer group (the MSISDN daemon uses this to bar numbers).

| Type | Data |
|---|---|
| `account.suspended` | `account_id`, `customer_id`, `reason` (`arrears`), `effective_on` |
| `account.reactivated` | `account_id`, `customer_id`, `effective_on` |

Each stream entry has the fields `id`, `type`, `occurred_at` and `data` (JSON).

**How publishing works (transactional outbox):**
- Events are written to an `outbox` table in the *same transaction* as the change they describe, so a rolled-back run emits nothing.
- `src/events.ts` publishes them after commit, then retries every 5 seconds until Redis accepts them.
- **Delivery is at-least-once:** consumers must be idempotent on state.

## Tasks (`billing` queue)

| Task | Payload | Result | In gateway catalog |
|---|---|---|---|
| `accounts.get` | `{ id }` or `{ account_number }` | Account with balance, overdue amount, next bill date and masked payment method, or `null` | yes |
| `accounts.for_customer` | `{ customer_id }` | `Account[]` | yes |
| `accounts.for_customers` | `{ customer_ids }` (≤100) | `{ [customer_id]: AccountSummary[] }`, used for search results | yes |
| `invoices.list` | `{ account_id, page, per_page }` | Invoices newest first, with line items and payment attempts | yes |
| `billing.runs` | `{ limit }` | Summaries of recent daily runs | yes |
| `billing.run` | `{ through? }` | Runs missed days up to a date. Future dates are refused. | no (ops only) |
| `billing.daily_run` | — | Fired by the scheduler | no |
| `accounts.refs` | `{ after?, limit }` | `{ id, customer_id, status, suspension_reason, created_at, closed_at }[]` paged by ID | no: internal, used by the MSISDN daemon to seed |

## Not modelled yet (deliberately)

- **BACS timing:** a real Direct Debit takes about 3 working days, and failures (ARUDD reports) arrive later. Here each attempt settles the same day.
- **Partial payments, refunds, credit notes and VAT breakdown:** not included.
- **Account closures:** accounts are only closed at seed time, so `account.closed` isn't emitted yet.
