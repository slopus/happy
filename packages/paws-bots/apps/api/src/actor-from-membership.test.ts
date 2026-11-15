import type { PrismaClient } from "@rakazo/db";
import { requireMembership } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { actorFromMembership } from "./app.js";

const actor = {
  userId: "user-1",
  spaceId: "space-support",
  email: "owner@example.test",
  isDeploymentOwner: false,
};

function prisma(options: { membership: boolean; failure?: Error }) {
  return {
    spaceMember: {
      findFirst: vi.fn(async () => {
        if (options.failure) throw options.failure;
        return options.membership
          ? {
              userId: actor.userId,
              spaceId: actor.spaceId,
              member: { user: { email: actor.email } },
            }
          : null;
      }),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => {
        throw new Error("Authorization must not read deployment owner settings");
      }),
    },
  } as unknown as PrismaClient;
}

describe("actorFromMembership", () => {
  it("returns no actor when the user is not a member of the requested Space", async () => {
    await expect(
      actorFromMembership(
        requireMembership(prisma({ membership: false }), "user-1", "space-other"),
      ),
    ).resolves.toBeNull();
  });

  it("returns the actor for a real membership without reading deployment owner settings", async () => {
    const db = prisma({ membership: true });
    await expect(
      actorFromMembership(requireMembership(db, "user-1", "space-support")),
    ).resolves.toEqual(actor);
    expect(db.deploymentSettings.findUnique).not.toHaveBeenCalled();
  });

  it("lets a membership query failure surface instead of looking signed out", async () => {
    const failure = new Error("database unavailable");
    await expect(
      actorFromMembership(
        requireMembership(
          prisma({
            membership: true,
            failure,
          }),
          "user-1",
          "space-support",
        ),
      ),
    ).rejects.toBe(failure);
  });
});
