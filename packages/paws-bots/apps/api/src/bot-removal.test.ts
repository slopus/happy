import type { createRepos } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createBotRemoval } from "./bot-removal.js";
import type { RouterDeps } from "./router.js";

const { destroyBot } = vi.hoisted(() => ({ destroyBot: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({ destroyBot }));
vi.mock("@rakazo/db", () => ({ requireSpaceOwner: vi.fn() }));

it("returns the transaction's removed group IDs without consulting a preview", async () => {
  const actor = {
    userId: "user-fixture",
    spaceId: "space-fixture",
    email: "fixture@example.test",
    isDeploymentOwner: false,
  };
  const bot = { id: "bot-fixture", ...actor };
  const result = { removedGroupIds: ["group-fixture"] };
  destroyBot.mockResolvedValueOnce(result);
  const repos = { getBot: vi.fn().mockResolvedValue(bot) };
  const remove = createBotRemoval(
    {} as RouterDeps,
    repos as unknown as ReturnType<typeof createRepos>,
  );
  await expect(remove(actor, bot.id, { deleteMemories: false })).resolves.toBe(result);
  expect(repos.getBot).toHaveBeenCalledWith(actor, bot.id, { includeArchived: true });
  expect(destroyBot).toHaveBeenCalledWith(
    expect.anything(),
    bot,
    expect.objectContaining({ userId: actor.userId, spaceId: actor.spaceId }),
    {
      deleteMemories: false,
    },
  );
});
