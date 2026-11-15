import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
};

describe("call route gates", () => {
  it.each([undefined, false])(
    "rejects all call RPCs when disabled (%s)",
    async (phoneCallsEnabled) => {
      const query = vi.fn(() => {
        throw new Error("Unexpected database access");
      });
      const client = createRouterClient(
        createRouter({
          prisma: new Proxy({}, { get: () => query }),
          env: { phoneCallsEnabled },
        } as unknown as RouterDeps),
        { context: { actor } },
      );
      const input = { botId: "bot-1", callId: "call-1" };
      for (const call of [
        () => client.threads.answerCall(input),
        () => client.threads.declineCall({ ...input, outcome: "declined" }),
        () => client.threads.endCall(input),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("requires authentication even when enabled", async () => {
    const client = createRouterClient(
      createRouter({ env: { phoneCallsEnabled: true } } as unknown as RouterDeps),
      { context: { actor: null } },
    );
    const input = { botId: "bot-1", callId: "call-1" };
    await expect(client.threads.answerCall(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client.threads.declineCall({ ...input, outcome: "declined" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(client.threads.endCall(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("voice catalog", () => {
  it.each([false, true])(
    "advertises self-hosted speech only with custom endpoint access (%s)",
    async (mcpAllowPrivateEndpoint) => {
      vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "0");
      try {
        const client = createRouterClient(
          createRouter({
            env: { mcpAllowPrivateEndpoint },
            prisma: {
              userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
              userModelCredential: { findMany: vi.fn().mockResolvedValue([]) },
            },
          } as unknown as RouterDeps),
          { context: { actor } },
        );
        const catalog = await client.voice.catalog();
        expect(catalog.some((entry) => entry.id === "openai-compatible")).toBe(
          mcpAllowPrivateEndpoint,
        );
        expect(catalog.some((entry) => entry.id === "elevenlabs")).toBe(true);
        expect(catalog.find((entry) => entry.id === "xai")).toMatchObject({ transcribe: true });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe("locked-device declines", () => {
  const callId = "00000000-0000-4000-8000-000000000001";
  function fixture(
    found = true,
    status = "ringing",
    expiresAt = new Date(Date.now() + 45000).toISOString(),
  ) {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      message: {
        findFirst: vi.fn(async () => (found ? { threadId: "thread-1" } : null)),
        findUnique: vi.fn(async () => ({
          id: "message-1",
          botId: "bot-1",
          thread: { spaceId: "space-1", userId: actor.userId, bot: { name: "Caller" } },
          blocks: [
            { kind: "call_request", callId, status, reason: "Review", opening: "Hello", expiresAt },
          ],
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const incomingCall = vi.fn(async () => {});
    const client = createRouterClient(
      createRouter({
        prisma: { ...tx, $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) },
        env: { phoneCallsEnabled: true },
        events: { notify: vi.fn(async () => {}) },
        notifications: { incomingCall },
      } as unknown as RouterDeps),
      { context: { actor } },
    );
    return { client, tx, incomingCall };
  }
  it("finds a call only in the signed-in user's own one-to-one threads and settles it once", async () => {
    const { client, tx, incomingCall } = fixture();
    await expect(client.notifications.declineIncomingCall({ callId })).resolves.toEqual({
      ok: true,
    });
    expect(tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: { userId: actor.userId, groupId: null, bot: { userId: actor.userId } },
        }),
      }),
    );
    expect(tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { blocks: [expect.objectContaining({ status: "declined" })] },
      }),
    );
    expect(incomingCall).toHaveBeenCalledWith(
      actor.userId,
      expect.objectContaining({ callId, ended: true }),
    );
  });
  it("rejects another owner's call without changing it", async () => {
    const { client, tx } = fixture(false);
    await expect(client.notifications.declineIncomingCall({ callId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(tx.message.updateMany).not.toHaveBeenCalled();
  });
  it.each(["answered", "declined", "missed"])("rejects %s calls", async (status) => {
    await expect(
      fixture(true, status).client.notifications.declineIncomingCall({ callId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("rejects expired declines and records missed", async () => {
    const { client, tx } = fixture(true, "ringing", new Date(0).toISOString());
    await expect(client.notifications.declineIncomingCall({ callId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(tx.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { blocks: [expect.objectContaining({ status: "missed" })] },
      }),
    );
  });
});

describe("incoming-call account stream", () => {
  it("uses signals for snapshots, heartbeats for liveness, and rechecks authorization", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const findMany = vi.fn(async () => []);
    const stillAuthorized = vi.fn(async () => false);
    const followIncomingCalls = vi.fn(async function* (_userId: string, signal?: AbortSignal) {
      yield;
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    });
    try {
      const client = createRouterClient(
        createRouter({
          env: { phoneCallsEnabled: true },
          prisma: { message: { findMany } },
          events: { followIncomingCalls },
        } as unknown as RouterDeps),
        { context: { actor, signal: controller.signal, stillAuthorized } },
      );
      const stream = await client.notifications.subscribeCalls();
      const iterator = stream[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({
        type: "incoming.calls",
        payload: { calls: [] },
      });
      expect(followIncomingCalls).toHaveBeenCalledWith(actor.userId, expect.any(AbortSignal));
      const next = iterator.next();
      // The first liveness frame also reaches the existing session recheck boundary.
      const rejected = expect(next).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(findMany).toHaveBeenCalledOnce();
      expect(stillAuthorized).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });
});
