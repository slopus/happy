import { RPCHandler } from "@orpc/server/fetch";
import type { PaymentWalletProvider } from "@rakazo/adapter-kit";
import { createPaymentWalletProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// Offline boundary: a fake Prisma table and secret store drive the real router handlers and the
// real wallet service against the deterministic emulator wallet.

type Row = Record<string, unknown>;

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

function walletDeps(paymentWallet: PaymentWalletProvider | null) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      value instanceof Date
        ? row[key] instanceof Date && (row[key] as Date).getTime() === value.getTime()
        : row[key] === value,
    );
  const paymentWallet_ = {
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      const row = rows.find((entry) => matches(entry, where));
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const found = rows.filter((row) => matches(row, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const before = rows.length;
      for (let index = rows.length - 1; index >= 0; index -= 1)
        if (matches(rows[index]!, where)) rows.splice(index, 1);
      return { count: before - rows.length };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const row = rows.find((entry) => matches(entry, where));
      if (row) Object.assign(row, update);
      else rows.push({ id: "wallet-1", ...create });
      return {};
    }),
  };
  const prisma = {
    paymentWallet: paymentWallet_,
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const values = new Map<string, string>();
  const secrets = {
    put: vi.fn(async (plaintext: string, _context: unknown, options: { recordId: string }) => {
      const ref = `enc:${values.size + 1}`;
      values.set(ref, plaintext);
      return { id: options.recordId, ref, ciphertext: ref };
    }),
    load: vi.fn(async (ref: string) => values.get(ref) ?? ""),
    delete: vi.fn(async (ref: string) => {
      values.delete(ref);
    }),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets,
    paymentWallet,
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
  async function call(path: "status" | "connect" | "disconnect") {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/paymentWallet/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error("Procedure did not match");
    return { status: response.status, body: (await response.json()) as { json: unknown } };
  }
  return { rows, values, call };
}

describe("paymentWallet routes", () => {
  it("reads disconnected and refuses to connect without a provider", async () => {
    const { call } = walletDeps(null);
    expect((await call("status")).body.json).toEqual({ status: "disconnected" });
    expect((await call("connect")).status).toBe(404);
    expect((await call("disconnect")).body.json).toEqual({ status: "disconnected" });
  });

  it("connects, finishes the sign-in on a later status read, and disconnects", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { call, rows, values } = walletDeps(
        await createPaymentWalletProvider({ PAYMENT_WALLET_PROVIDER: "emulator" }),
      );
      const started = await call("connect");
      expect(started.status).toBe(200);
      expect(started.body.json).toMatchObject({
        status: "connecting",
        verificationUrl: expect.stringMatching(/^https:\/\//),
        userCode: "EMUL-ATOR",
      });
      expect(rows[0]).toMatchObject({ provider: "emulator", status: "connecting" });

      vi.setSystemTime(new Date(Date.now() + 2_000));
      const status = await call("status");
      expect(status.body.json).toMatchObject({ status: "connected" });
      expect(JSON.stringify(status.body)).not.toContain(String(values.values().next().value));

      expect((await call("disconnect")).body.json).toEqual({ status: "disconnected" });
      expect(rows).toHaveLength(0);
      expect(values.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
