import { describe, expect, it, vi } from "vitest";
import { retryConversationMemoryPurge } from "./conversation-memory-cleanup.js";
import type { MemoryProviderResolver } from "./memory-provider-factory.js";

const payload = {
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "deleted-thread",
  generations: [2, 3],
  connectionIdentity: "original-connection",
};

function fixture(connectionIdentity = payload.connectionIdentity) {
  const purgeHistory = vi.fn(async (_request: unknown, _context: unknown) => ({
    ok: true as boolean,
    error: "provider unavailable",
  }));
  const resolve = vi.fn(async () => ({ provider: { connectionIdentity, purgeHistory } }));
  const deps = { memoryProviders: { resolve } as unknown as MemoryProviderResolver };
  return { deps, purgeHistory, resolve };
}

describe("retryConversationMemoryPurge", () => {
  it("purges captured generations after deletion without looking up the old thread or run", async () => {
    const { deps, purgeHistory, resolve } = fixture();
    await retryConversationMemoryPurge(deps, payload);
    expect(resolve).toHaveBeenCalledWith(payload.spaceId);
    expect(purgeHistory).toHaveBeenCalledWith(
      { botId: payload.botId, threadId: payload.threadId, generations: [2, 3] },
      expect.objectContaining({
        spaceId: payload.spaceId,
        userId: payload.userId,
        botId: payload.botId,
      }),
    );
  });

  it("never sends the old purge through a replacement connection", async () => {
    const { deps, purgeHistory } = fixture("replacement-connection");
    await retryConversationMemoryPurge(deps, payload);
    expect(purgeHistory).not.toHaveBeenCalled();
  });

  it("throws incomplete cleanup so the native queue retries it", async () => {
    const { deps, purgeHistory } = fixture();
    purgeHistory.mockResolvedValueOnce({ ok: false, error: "provider unavailable" });
    await expect(retryConversationMemoryPurge(deps, payload)).rejects.toThrow(
      "provider unavailable",
    );
    await expect(retryConversationMemoryPurge(deps, payload)).resolves.toBeUndefined();
    expect(purgeHistory).toHaveBeenCalledTimes(2);
  });
});
