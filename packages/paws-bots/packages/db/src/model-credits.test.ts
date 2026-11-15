import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./generated/prisma/client.js";
import { creditAccount } from "./model-credits.js";

describe("creditAccount", () => {
  const organizationId = "credit-race-fixture";
  const account = { organizationId, balanceMicros: 0n, mode: null };

  function fixture(error?: Error) {
    const upsert = error
      ? vi.fn().mockRejectedValueOnce(error)
      : vi.fn().mockResolvedValue(account);
    const findUniqueOrThrow = vi.fn().mockResolvedValue(account);
    const prisma = {
      modelCreditAccount: { upsert, findUniqueOrThrow },
    } as unknown as PrismaClient;
    return { prisma, upsert, findUniqueOrThrow };
  }

  it("returns the winning account after a concurrent first create conflicts", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { modelName: "ModelCreditAccount", target: ["organizationId"] },
    });
    const { prisma, upsert, findUniqueOrThrow } = fixture(conflict);

    await expect(creditAccount(prisma, organizationId)).resolves.toBe(account);
    expect(upsert).toHaveBeenCalledOnce();
    expect(findUniqueOrThrow).toHaveBeenCalledExactlyOnceWith({ where: { organizationId } });
  });

  it("returns the account without another read when the upsert succeeds", async () => {
    const { prisma, findUniqueOrThrow } = fixture();

    await expect(creditAccount(prisma, organizationId)).resolves.toBe(account);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it.each([
    new Error("Connection failed"),
    new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
      code: "P2003",
      clientVersion: "test",
    }),
  ])("propagates other failures without reading an account: %s", async (error) => {
    const { prisma, findUniqueOrThrow } = fixture(error);

    await expect(creditAccount(prisma, organizationId)).rejects.toBe(error);
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
