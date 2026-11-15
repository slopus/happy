import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function fixture() {
  const actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "fixture@example.test",
    isDeploymentOwner: false,
  } satisfies Actor;
  const bot = {
    id: "bot-1",
    userId: actor.userId,
    spaceId: actor.spaceId,
    archivedAt: new Date(),
    thread: { id: "thread-1" },
    computer: null,
  };
  const findBot = vi.fn(
    async ({ where }: { where: { id: string; spaceId: string; archivedAt?: null } }) => {
      return where.id === bot.id && where.spaceId === bot.spaceId && where.archivedAt === undefined
        ? bot
        : null;
    },
  );
  const findMessages = vi.fn(async () => [
    {
      id: "message-1",
      seq: 1,
      threadId: "thread-1",
      role: "user",
      botId: "bot-1",
      blocks: [{ kind: "text", text: "Saved conversation" }],
      createdAt: new Date(),
      runId: null,
    },
  ]);
  const prisma = {
    bot: { findFirst: findBot },
    userModelPreference: { findFirst: vi.fn(async () => null) },
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: { findMany: vi.fn(async () => []) },
    deploymentSettings: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => []),
    spaceMember: { count: vi.fn(async () => 1) },
    message: { findMany: findMessages },
    event: { findFirst: vi.fn(async () => null) },
    run: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    env: { webOrigin: "http://127.0.0.1", sandboxProvider: "fake", agentRuntime: "scripted" },
  } as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(proc: string, input: unknown, requestActor = actor) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${proc}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: requestActor } },
    );
    if (!response) throw new Error("no response");
    return { status: response.status, body: await response.json() };
  }
  return { actor, call, findBot, findMessages };
}

// IsolationError is opaque at the RPC boundary. Access is denied before any history reads or writes.
describe("archived thread read authorization", () => {
  it.each(["threads/get", "threads/messages"])(
    "%s reads the owned archived history",
    async (proc) => {
      const { call, findBot } = fixture();
      const result = await call(proc, { botId: "bot-1" });
      expect(result.status).toBe(200);
      expect(result.body.json.messages).toEqual([expect.objectContaining({ id: "message-1" })]);
      expect(findBot).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "bot-1", spaceId: "space-1" } }),
      );
    },
  );
  it.each(["threads/get", "threads/messages"])("%s keeps space isolation", async (proc) => {
    const { actor, call, findMessages } = fixture();
    expect(
      (await call(proc, { botId: "bot-1" }, { ...actor, spaceId: "other-space" })).status,
    ).toBe(500);
    expect(findMessages).not.toHaveBeenCalled();
  });
  it.each([
    ["threads/send", { botId: "bot-1", text: "Cannot send" }],
    [
      "threads/react",
      { botId: "bot-1", messageId: "message-1", reaction: "👍", clientNonce: "fixture" },
    ],
    [
      "threads/answer",
      { botId: "bot-1", runId: "run-1", messageId: "message-1", answer: "Cannot answer" },
    ],
    ["threads/clear", { botId: "bot-1" }],
    ["threads/stop", { botId: "bot-1" }],
    ["threads/followUp", { botId: "bot-1", text: "Cannot run" }],
    ["threads/markRead", { botId: "bot-1" }],
    ["computer/boot", { botId: "bot-1" }],
  ])("%s still rejects an archived bot", async (proc, input) => {
    const { call, findBot } = fixture();
    expect((await call(proc as string, input)).status).toBe(500);
    expect(findBot).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ archivedAt: null }) }),
    );
  });
});
