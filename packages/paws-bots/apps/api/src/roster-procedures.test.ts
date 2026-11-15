import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { appContract } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { ROSTER_PROCEDURES, rosterChangeFor } from "./roster-procedures.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("rosterChangeFor", () => {
  it("names only real procedures", () => {
    for (const procedure of Object.keys(ROSTER_PROCEDURES)) {
      const found = procedure
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown> | undefined)?.[key],
          appContract,
        );
      expect(found, procedure).toBeDefined();
    }
  });

  it("tells the Space about shared roster changes and the person about their own", () => {
    expect(rosterChangeFor(["bots", "reorder"], actor, { botIds: [] }, undefined)).toEqual({
      spaceIds: ["space-1"],
    });
    expect(rosterChangeFor(["threads", "markRead"], actor, { botId: "bot-1" }, undefined)).toEqual({
      userIds: ["user-1"],
    });
  });

  it("tells a named Space and the people it removes or admits", () => {
    expect(
      rosterChangeFor(
        ["spaces", "members", "remove"],
        actor,
        { spaceId: "space-2", userId: "user-2" },
        undefined,
      ),
    ).toEqual({ spaceIds: ["space-2"], userIds: ["user-1", "user-2"] });
    expect(
      rosterChangeFor(
        ["spaces", "invites", "accept"],
        actor,
        { token: "t" },
        { spaceId: "space-3" },
      ),
    ).toEqual({ spaceIds: ["space-3"], userIds: ["user-1"] });
  });

  it("ignores procedures that leave the roster alone", () => {
    expect(rosterChangeFor(["spaces", "list"], actor, undefined, undefined)).toBeUndefined();
    expect(rosterChangeFor(["bots", "get"], actor, { botId: "bot-1" }, undefined)).toBeUndefined();
  });
});

describe("roster change signals", () => {
  function clientWith(publishRosterChange: () => Promise<void>, failing = false) {
    const tx = {
      bot: {
        findMany: async () => (failing ? [] : [{ id: "bot-1" }]),
        update: async () => ({}),
      },
    };
    const prisma = { $transaction: (run: (client: typeof tx) => unknown) => run(tx) };
    return createRouterClient(
      createRouter({ prisma, events: { publishRosterChange } } as unknown as RouterDeps),
      { context: { actor } },
    );
  }

  it("publishes once a roster procedure succeeds", async () => {
    const publishRosterChange = vi.fn(async () => undefined);
    await clientWith(publishRosterChange).bots.reorder({ botIds: ["bot-1"] });
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1"] });
  });

  it("publishes nothing when the procedure fails", async () => {
    const publishRosterChange = vi.fn(async () => undefined);
    await expect(
      clientWith(publishRosterChange, true).bots.reorder({ botIds: ["bot-1"] }),
    ).rejects.toThrow();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });
});
