import { randomUUID } from "node:crypto";
import type {
  PaymentWalletConnectResult,
  PaymentWalletCredential,
  PaymentWalletProvider,
} from "@rakazo/adapter-kit";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PaymentWalletDeps } from "./payment-wallets.js";
import {
  connectPaymentWallet,
  paymentWalletConnected,
  paymentWalletStatus,
  withPaymentWalletCredential,
} from "./payment-wallets.js";
import { EncryptedSecretStore } from "./secrets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/** A wallet whose sign-in completes at once with a credential already due for refresh. */
function testWallet(): PaymentWalletProvider & { refresh: ReturnType<typeof vi.fn> } {
  return {
    displayName: "Test Wallet",
    describe: () => ({
      id: "test-wallet",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { offline: true, credentials: ["card"] },
    }),
    beginConnect: async () => ({
      state: "device-state",
      verificationUrl: "https://wallet.example.test/verify",
      userCode: "ABCD-EFGH",
      expiresAt: new Date(Date.now() + 15 * 60_000),
      intervalMs: 1_000,
    }),
    pollConnect: async (): Promise<PaymentWalletConnectResult> => ({
      status: "connected",
      credential: { secret: "credential-0", refreshAt: new Date(Date.now() - 1_000) },
    }),
    refresh: vi.fn(async (credential: PaymentWalletCredential) => {
      // Long enough for concurrent callers to queue on the lock.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { secret: `${credential.secret}-next`, refreshAt: new Date(Date.now() + 3_600_000) };
    }),
    disconnect: async () => undefined,
    createPurchase: async () => {
      throw new Error("unused");
    },
    getPurchase: async () => {
      throw new Error("unused");
    },
    revealCard: async () => {
      throw new Error("unused");
    },
    revealPayToken: async () => {
      throw new Error("unused");
    },
    readHttpPaymentChallenge: async () => null,
    authorizeHttpPayment: async () => {
      throw new Error("unused");
    },
  };
}

describePostgres("payment wallets (PostgreSQL contract)", () => {
  const db = databaseUrl ? createDb(databaseUrl, { poolMax: 6 }) : undefined;
  const users: string[] = [];
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");

  afterAll(async () => {
    if (!db) return;
    const prisma = asSystem(db.prisma);
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function seedUser() {
    const prisma = asSystem(db!.prisma);
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Wallet test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Wallet test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Wallet test", isDefault: true },
    });
    return { userId: id, spaceId: id };
  }

  it("connects, keeps the wallet to its user, and refreshes a rotating credential once", async () => {
    const actor = await seedUser();
    const other = await seedUser();
    const provider = testWallet();
    const deps: PaymentWalletDeps = { prisma: db!.prisma, secretStore, paymentWallet: provider };

    await runAsTenant(actor, () => connectPaymentWallet(deps, actor));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await runAsTenant(actor, () => paymentWalletStatus(deps, actor))).toMatchObject({
      status: "connected",
    });
    expect(await runAsTenant(other, () => paymentWalletConnected(deps, actor.userId))).toBe(false);

    const seen = await Promise.all(
      Array.from({ length: 4 }, () =>
        runAsTenant(actor, () =>
          withPaymentWalletCredential(deps, actor, async (credential) => credential.secret),
        ),
      ),
    );
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(new Set(seen)).toEqual(new Set(["credential-0-next"]));
    const row = await asSystem(db!.prisma).paymentWallet.findUniqueOrThrow({
      where: { userId: actor.userId },
    });
    expect(row.ciphertext).not.toContain("credential");
    expect(row.refreshAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
