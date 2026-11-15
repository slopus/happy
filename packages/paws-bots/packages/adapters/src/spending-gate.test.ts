import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { fakeSpendingPrisma } from "./fake-spending.js";
import type { PurchaseApproval } from "./purchase-gate.js";
import { paysWithWallet, recordPagePayment } from "./spending-gate.js";

describe("recordPagePayment", () => {
  const run = { userId: "user-1", spaceId: "space-1", botId: "bot-1", threadId: "thread-1" };
  const purchase = (amount: string): PurchaseApproval => ({
    steps: [0],
    site: "shop.test",
    label: "Place order",
    amount,
    amountSource: "page",
  });

  // Under a limit of one unit, so reading the decimal part as whole units would refuse them.
  it.each([
    ["$.99", "usd", 99],
    [".99 USD", "usd", 99],
    ["€,50", "eur", 50],
  ] as const)("counts %s as %s %d", async (amount, currency, counted) => {
    const spending = fakeSpendingPrisma({ amount: 100, currency, period: "none" });
    const prisma = {
      ...spending.client,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(spending.client),
    } as unknown as PrismaClient;
    expect(await recordPagePayment(prisma, run, purchase(amount), "op-1")).toBeUndefined();
    expect(spending.state.payments.map((row) => row.amount)).toEqual([counted]);
  });
});

describe("paysWithWallet", () => {
  const click = { kind: "click", ref: "e9" };
  it.each([
    ["a wallet card", [{ kind: "fill_card", purchase: "p-1", field: "number" }, click], true],
    ["a wallet pay token", [{ kind: "fill_pay_token", purchase: "p-1" }, click], true],
    ["a saved card", [{ kind: "fill_card", card: "visa", site: "https://a.test" }, click], false],
    // Either card may be the one that pays, so the click still counts.
    [
      "a wallet card beside a saved card",
      [
        { kind: "fill_card", purchase: "p-1", field: "number" },
        { kind: "fill_card", card: "visa", site: "https://a.test", field: "cvc" },
        click,
      ],
      false,
    ],
    ["no card", [click], false],
  ])("pays with %s: %s", (_case, actions, expected) => {
    expect(paysWithWallet({ actions })).toBe(expected);
  });
});
