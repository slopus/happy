import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-a",
  userId: "user-a",
  email: "actor@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
const routine = (botId: string, id: string) => ({
  id,
  botId,
  userId: actor.userId,
  name: id,
  prompt: "Test",
  crons: ["0 9 * * *"],
  timezone: "UTC",
  active: false,
  notify: true,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: null,
  watchState: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});
function harness() {
  const findBots = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => id !== "excluded").map((id) => ({ id })),
  );
  const findRoutines = vi.fn(async ({ where }: { where: { botId: { in: string[] } } }) =>
    where.botId.in
      .filter((botId) => botId !== "empty")
      .flatMap((botId) => [routine(botId, `${botId}-2`), routine(botId, `${botId}-1`)]),
  );
  const deps = {
    prisma: {
      bot: { findMany: findBots },
      routine: { findMany: findRoutines },
    } as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-routine-mentions-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function request(botIds: string[], requestActor: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/routines/listForMentions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botIds } }),
      }),
      { prefix: "/rpc", context: { actor: requestActor } },
    );
    return response!;
  }
  return { findBots, findRoutines, request };
}

describe("routine mention batch endpoint", () => {
  it("reads the space's bots and their routines in two queries", async () => {
    const h = harness();
    const ids = Array.from({ length: 100 }, (_, index) => `bot-${index}`);
    const response = await h.request(ids);
    expect(response.status).toBe(200);
    const body = (await response.json()).json;
    expect(body).toHaveLength(100);
    expect(body[0].botId).toBe("bot-0");
    expect(body[0].routines.map((row: { id: string }) => row.id)).toEqual(["bot-0-2", "bot-0-1"]);
    expect(h.findBots).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ids }, spaceId: actor.spaceId, archivedAt: null },
      select: { id: true },
    });
    expect(h.findRoutines).toHaveBeenCalledExactlyOnceWith({
      where: { botId: { in: ids }, spaceId: actor.spaceId },
    });
  });

  it("omits unowned bots and keeps owned bots without routines", async () => {
    const h = harness();
    const response = await h.request(["bot-1", "excluded", "empty"]);
    expect((await response.json()).json).toEqual([
      expect.objectContaining({ botId: "bot-1" }),
      { botId: "empty", routines: [] },
    ]);
    expect(h.findRoutines.mock.calls[0]![0].where.botId.in).toEqual(["bot-1", "empty"]);
  });

  it("rejects unauthenticated or oversized batches before reading data", async () => {
    const h = harness();
    expect((await h.request(["bot-1"], null)).status).toBe(401);
    expect(
      (await h.request(Array.from({ length: 101 }, (_, index) => `bot-${index}`))).status,
    ).toBe(400);
    expect(h.findBots).not.toHaveBeenCalled();
  });
});
