import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { isAdmin } from "./admins.js";

describe("isAdmin", () => {
  const users = [
    { id: "verified", email: "Admin@Example.test", emailVerified: true },
    { id: "unverified", email: "admin@example.test", emailVerified: false },
  ];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
    },
  } as unknown as PrismaClient;

  it("requires a listed, verified email", async () => {
    const deps = { prisma, env: { adminEmails: ["admin@example.test"] } as never };
    expect(await isAdmin(deps, "verified")).toBe(true);
    expect(await isAdmin(deps, "unverified")).toBe(false);
    expect(await isAdmin({ prisma, env: {} as never }, "verified")).toBe(false);
  });
});
