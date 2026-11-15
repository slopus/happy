import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-current",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

type TargetSpace = {
  organizationId: string;
  role: string;
  deletingAt: Date | null;
} | null;

function renameHarness(target: TargetSpace, currentOrganizationId: string | null = "org-1") {
  const update = vi.fn(async () => ({ id: "space-target" }));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    spaceMember: {
      findUnique: vi.fn(async (args: { where: { spaceId_userId: { spaceId: string } } }) => {
        const spaceId = args.where.spaceId_userId.spaceId;
        if (spaceId === actor.spaceId) {
          return currentOrganizationId ? { organizationId: currentOrganizationId } : null;
        }
        if (!target) return null;
        return {
          organizationId: target.organizationId,
          role: target.role,
          space: { isDefault: false, deletingAt: target.deletingAt },
        };
      }),
    },
    space: { update },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const prisma = {
    $transaction: transaction,
    // The router checks membership before scoping the database to the target Space.
    spaceMember: {
      findFirst: vi.fn(async (args: { where: { spaceId: string } }) =>
        tx.spaceMember.findUnique({ where: { spaceId_userId: { spaceId: args.where.spaceId } } }),
      ),
    },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-space-rename-test",
  } as unknown as RouterDeps;
  return { update, transaction, handler: new RPCHandler(createRouter(deps)) };
}

function renameRequest(name: string, spaceId = "space-target") {
  return new Request("http://127.0.0.1/rpc/spaces/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ json: { spaceId, name } }),
  });
}

async function rename(handler: ReturnType<typeof renameHarness>["handler"], name: string) {
  const { response } = await handler.handle(renameRequest(name), {
    prefix: "/rpc",
    context: { actor },
  });
  if (!response) throw new Error("no response");
  return response;
}

describe("spaces.rename", () => {
  it("lets the owner rename a space with the same name rules as create", async () => {
    const { update, handler } = renameHarness({
      organizationId: "org-1",
      role: "owner",
      deletingAt: null,
    });

    const response = await rename(handler, "  Customer support  ");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: { id: "space-target", name: "Customer support" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "space-target" },
      data: { name: "Customer support" },
    });
  });

  it("rejects a member who does not own the space", async () => {
    const { update, handler } = renameHarness({
      organizationId: "org-1",
      role: "member",
      deletingAt: null,
    });

    const response = await rename(handler, "Stolen");

    expect(response.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a caller who is not a member of the space", async () => {
    const { update, handler } = renameHarness(null);

    const response = await rename(handler, "Stolen");

    expect(response.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a space in another organization", async () => {
    const { update, handler } = renameHarness({
      organizationId: "org-other",
      role: "owner",
      deletingAt: null,
    });

    const response = await rename(handler, "Stolen");

    expect(response.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["   ", "x".repeat(61)])(
    "rejects an invalid name before touching the space",
    async (name) => {
      const { transaction, handler } = renameHarness({
        organizationId: "org-1",
        role: "owner",
        deletingAt: null,
      });

      const response = await rename(handler, name);

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects rename while deletion is in progress", async () => {
    const { update, handler } = renameHarness({
      organizationId: "org-1",
      role: "owner",
      deletingAt: new Date(),
    });

    const response = await rename(handler, "Still here");

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects rename after the deletion claim goes stale", async () => {
    const { update, handler } = renameHarness({
      organizationId: "org-1",
      role: "owner",
      deletingAt: new Date(Date.now() - 6 * 60_000),
    });

    const response = await rename(handler, "Still here");

    expect(response.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });
});
