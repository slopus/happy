import type { BillingProvider } from "@rakazo/adapter-kit";
import { BillingPaymentNotCompletedError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBillingService } from "./billing.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const price = { amount: 1000, currency: "usd", interval: "month" as const, intervalCount: 1 };

function service(getPrice: BillingProvider["getPrice"], role = "owner") {
  const prisma = {
    space: {
      findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    member: {
      findUnique: vi.fn().mockResolvedValue({ role }),
      count: vi.fn().mockResolvedValue(3),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([{ userId: "owner-1", role: "owner" }]),
    },
    billingAccount: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ billingTrialUsedAt: null }) },
  } as unknown as PrismaClient;
  const provider = {
    describe: () => ({ capabilities: { trials: true, portal: true } }),
    getPrice: vi.fn(getPrice),
    endTrial: vi.fn(),
  } as unknown as BillingProvider;
  return {
    provider,
    prisma,
    billing: createBillingService({ prisma, provider, webOrigin: "https://app.example.com" }),
  };
}

describe("billing status", () => {
  it("reads the price once and reuses it", async () => {
    const { billing, provider } = service(async () => price);
    await expect(billing.status(actor)).resolves.toMatchObject({ price, seats: 3 });
    await billing.status(actor);
    expect(provider.getPrice).toHaveBeenCalledTimes(1);
  });

  it("still answers when the price cannot be read", async () => {
    const { billing } = service(async () => {
      throw new Error("provider unavailable");
    });
    await expect(billing.status(actor)).resolves.toMatchObject({ price: null, access: false });
  });

  it("refuses checkout, portal, and ending the trial for non-owners", async () => {
    const { billing, provider } = service(async () => price, "member");
    await expect(billing.checkout(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(billing.portal(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(billing.endTrial(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(provider.endTrial).not.toHaveBeenCalled();
  });

  it("answers payment required when the card is not charged", async () => {
    const { billing, provider, prisma } = service(async () => price);
    vi.mocked(prisma.billingAccount.findUnique).mockResolvedValue({
      organizationId: "org-1",
      customerId: "cus-1",
    } as never);
    vi.mocked(provider.endTrial!).mockRejectedValue(new BillingPaymentNotCompletedError());
    await expect(billing.endTrial(actor)).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
      status: 402,
    });
  });
});

describe("model credit checkout", () => {
  it("calls the provider without holding a database transaction", async () => {
    let openTransactions = 0;
    const account = { organizationId: "org-1", customerId: "cus-1" };
    const prisma = {
      space: {
        findUnique: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      member: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      billingAccount: {
        findUnique: vi.fn().mockResolvedValue(account),
        findFirst: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      modelCreditAccount: {
        upsert: vi.fn().mockResolvedValue({ organizationId: "org-1" }),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
        openTransactions++;
        try {
          return await run(prisma);
        } finally {
          openTransactions--;
        }
      }),
    };
    const provider = {
      describe: () => ({ capabilities: { modelCredits: true } }),
      createCreditCheckout: vi.fn(async () => {
        expect(openTransactions).toBe(0);
        return { url: "https://checkout.example.com" };
      }),
    } as unknown as BillingProvider;
    const billing = createBillingService({
      prisma: prisma as unknown as PrismaClient,
      provider,
      webOrigin: "https://app.example.com",
    });
    for (const monthly of [true, false]) {
      await expect(billing.purchaseCredits(actor, { amountCents: 2000, monthly })).resolves.toEqual(
        { url: "https://checkout.example.com" },
      );
    }
    expect(provider.createCreditCheckout).toHaveBeenCalledTimes(2);
  });
});
