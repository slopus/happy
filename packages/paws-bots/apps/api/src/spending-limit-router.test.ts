import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// Offline boundary: fake tables drive the real router handlers and spending ledger.

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

const paid = {
  id: "payment-1",
  site: "shop.example.test",
  amount: 1_250,
  currency: "usd",
  botId: "bot-1",
  createdAt: new Date("2026-11-05T09:30:00Z"),
};

function spendingDeps({ card = false, payments = [] as Array<typeof paid> } = {}) {
  let limit: Record<string, unknown> | null = null;
  // The fake runs a transaction on itself.
  let self: unknown;
  const prisma = {
    spendingLimit: {
      findUnique: vi.fn(async () => limit),
      upsert: vi.fn(async ({ create, update }: { create: object; update: object }) => {
        limit = limit
          ? { ...limit, ...update }
          : { ...create, startsAt: new Date(), updatedAt: new Date() };
        return limit;
      }),
      deleteMany: vi.fn(async () => {
        const count = limit ? 1 : 0;
        limit = null;
        return { count };
      }),
    },
    payment: {
      aggregate: vi.fn(async () => ({ _sum: { amount: 1_250 } })),
      findFirst: vi.fn(async () => payments[0] ?? null),
      findMany: vi.fn(async () => payments),
    },
    bot: { findMany: vi.fn(async () => [{ id: "bot-1", name: "Shopper" }]) },
    user: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
    vaultCredential: { findFirst: vi.fn(async () => (card ? { id: "card" } : null)) },
    paymentWallet: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(self)),
  };
  self = prisma;
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(path: "get" | "set" | "payments", json: unknown = {}) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/spendingLimit/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error("Procedure did not match");
    return { status: response.status, body: (await response.json()) as { json: unknown } };
  }
  return { prisma, call };
}

describe("spendingLimit routes", () => {
  it("hides the setting until the user can pay", async () => {
    expect((await spendingDeps().call("get")).body.json).toEqual({
      limit: null,
      spent: 0,
      shown: false,
    });
    expect((await spendingDeps({ card: true }).call("get")).body.json).toEqual({
      limit: null,
      spent: 0,
      shown: true,
    });
  });

  it("shows the setting once a bot has paid, and lists the user's payments", async () => {
    const { call, prisma } = spendingDeps({
      payments: [paid, { ...paid, id: "payment-2", botId: "gone" }],
    });
    expect((await call("get")).body.json).toMatchObject({ shown: true });
    expect((await call("payments")).body.json).toEqual([
      {
        id: "payment-1",
        site: "shop.example.test",
        amount: 1_250,
        currency: "usd",
        botName: "Shopper",
        createdAt: "2026-11-05T09:30:00.000Z",
      },
      expect.objectContaining({ id: "payment-2", botName: null }),
    ]);
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1", releasedAt: null } }),
    );
  });

  it("sets, reads and removes the user's own limit", async () => {
    const { call, prisma } = spendingDeps();
    const limit = { amount: 20_000, currency: "usd", period: "month" };
    expect((await call("set", { limit })).body.json).toEqual({ limit, spent: 1_250, shown: true });
    expect(prisma.spendingLimit.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect((await call("set", { limit: null })).body.json).toEqual({
      limit: null,
      spent: 0,
      shown: false,
    });
  });

  it.each([
    { amount: 0, currency: "usd", period: "month" },
    { amount: 1.5, currency: "usd", period: "month" },
    { amount: 100, currency: "jpy", period: "month" },
    { amount: 100, currency: "usd", period: "year" },
  ])("refuses %j", async (limit) => {
    const { call, prisma } = spendingDeps();
    expect((await call("set", { limit })).status).toBe(400);
    expect(prisma.spendingLimit.upsert).not.toHaveBeenCalled();
  });
});
