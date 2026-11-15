import type * as Adapters from "@rakazo/adapters";
import { destroyBot } from "@rakazo/adapters";
import type * as Db from "@rakazo/db";
import {
  claimOrganizationForDeletion,
  deleteClaimedSpace,
  recordAuditEvent,
  setOrganizationDeletionLease,
} from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteOrganization } from "./account-deletion.js";

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  destroyBot: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  claimOrganizationForDeletion: vi.fn(),
  keepOrganizationTrialUse: vi.fn(async () => undefined),
  setOrganizationDeletionLease: vi.fn(),
  deleteClaimedSpace: vi.fn(),
  deleteEmptyOrganization: vi.fn(async () => undefined),
  releaseOrganizationDeletionClaim: vi.fn(async () => undefined),
  recordAuditEvent: vi.fn(async () => undefined),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("deleteOrganization lease", () => {
  let spacesLeft: number;
  const prisma = {
    organization: { findUnique: vi.fn(async () => ({ name: "Work" })) },
    artifact: { findMany: vi.fn(async () => []) },
    bot: { findMany: vi.fn(async () => []) },
    computer: { findMany: vi.fn(async () => []) },
    space: { count: vi.fn(async () => spacesLeft) },
  };
  const deps = (overrides: Record<string, unknown> = {}) =>
    ({
      prisma,
      artifacts: { remove: vi.fn(async () => undefined) },
      ...overrides,
    }) as unknown as Parameters<typeof deleteOrganization>[0];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    spacesLeft = 1;
    vi.mocked(claimOrganizationForDeletion).mockResolvedValue({
      claimId: "organization-deletion:org-1:attempt",
      spaceIds: ["space-1"],
      fresh: true,
    });
    vi.mocked(setOrganizationDeletionLease).mockImplementation(async () => spacesLeft > 0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes and records a deletion whose last file cleanup outlasts the lease", async () => {
    const cleanup = deferred();
    vi.mocked(deleteClaimedSpace).mockImplementation(async () => {
      spacesLeft = 0;
      return { artifactKeys: ["blob-1"], pageShareSecrets: [] };
    });
    const remove = vi.fn(() => cleanup.promise);

    const deleting = deleteOrganization(deps({ artifacts: { remove } }), "user-1", "org-1");
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    cleanup.resolve();

    await expect(deleting).resolves.toBeUndefined();
    expect(recordAuditEvent).toHaveBeenCalledOnce();
  });

  it("passes memory resolution into bot teardown before deleting the Space configuration", async () => {
    let configured = true;
    const resolve = vi.fn(async () => {
      expect(configured).toBe(true);
      return null;
    });
    const memoryProviders = { resolve };
    vi.mocked(prisma.bot.findMany).mockResolvedValueOnce([
      { id: "bot-1", spaceId: "space-1", userId: "user-1", name: "Bot", archivedAt: null },
    ] as never);
    vi.mocked(destroyBot).mockImplementationOnce(async (teardown, bot, _context, options) => {
      expect(teardown.memoryProviders).toBe(memoryProviders);
      expect(options.deleteMemories).toBe(true);
      await teardown.memoryProviders!.resolve(bot.spaceId);
      return { removedGroupIds: [] };
    });
    vi.mocked(deleteClaimedSpace).mockImplementation(async () => {
      expect(resolve).toHaveBeenCalledWith("space-1");
      configured = false;
      spacesLeft = 0;
      return { artifactKeys: [], pageShareSecrets: [] };
    });

    await deleteOrganization(deps({ memoryProviders }), "user-1", "org-1");
    expect(destroyBot).toHaveBeenCalledOnce();
    expect(configured).toBe(false);
  });

  it("stops before teardown once renewals fail for most of the lease", async () => {
    const billing = deferred();
    let billingCalled = false;
    vi.mocked(setOrganizationDeletionLease).mockRejectedValue(new Error("database unavailable"));

    const deleting = deleteOrganization(
      deps({
        billing: {
          cancelForDeletedOrganization: () => {
            billingCalled = true;
            return billing.promise;
          },
        },
      }),
      "user-1",
      "org-1",
    );
    deleting.catch(() => undefined);
    await vi.waitFor(() => expect(billingCalled).toBe(true));
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    await expect(deleting).rejects.toThrow("lost its claim");
    billing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.artifact.findMany).not.toHaveBeenCalled();
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });
});
