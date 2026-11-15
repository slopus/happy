import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { currentDbContext, runAsTenant } from "./row-security.js";
import { countUnreadInboxChats } from "./unread-inbox-chats.js";

describe("unread inbox chat query", () => {
  it("uses one bound query with an explicit system scope and restores the tenant", async () => {
    const tenant = { userId: "user-1", spaceId: "space-1" };
    const query = vi.fn(async (_sql: TemplateStringsArray, ...parameters: unknown[]) => {
      expect(currentDbContext()).toEqual({
        kind: "system",
        reason: "count unread inbox chats across the member's Spaces",
      });
      expect(parameters).toContain(tenant.userId);
      expect(parameters).toContain("org-1");
      return [{ count: 4 }];
    });
    const prisma = {
      $queryRaw: query,
      spaceMember: {
        findUnique: async () => ({ organizationId: "org-1", member: { role: "member" } }),
      },
    } as unknown as PrismaClient;
    await runAsTenant(tenant, async () => {
      expect(await countUnreadInboxChats(prisma, tenant)).toBe(4);
      expect(currentDbContext()).toEqual({ kind: "tenant", ...tenant });
    });
    expect(query).toHaveBeenCalledOnce();
  });
});
