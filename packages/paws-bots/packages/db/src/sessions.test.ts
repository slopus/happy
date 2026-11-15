import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { pushSessionExpiresAt } from "./sessions.js";

describe("pushSessionExpiresAt", () => {
  it("returns null only when the session row is gone", async () => {
    let row: { expiresAt: Date } | null = null;
    const prisma = {
      session: { findUnique: vi.fn(async () => row) },
    } as unknown as Pick<PrismaClient, "session">;

    await expect(pushSessionExpiresAt(prisma, "session-1")).resolves.toBeNull();

    const expired = new Date(Date.now() - 1_000);
    row = { expiresAt: expired };
    await expect(pushSessionExpiresAt(prisma, "session-1")).resolves.toBe(expired);

    const expiresAt = new Date(Date.now() + 60_000);
    row = { expiresAt };
    await expect(pushSessionExpiresAt(prisma, "session-1")).resolves.toBe(expiresAt);
  });
});
