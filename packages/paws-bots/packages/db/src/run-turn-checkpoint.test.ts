import { describe, expect, it, vi } from "vitest";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { PrismaClient } from "./client.js";
import type { DataKey } from "./content-crypto.js";
import {
  dropRunTurnCheckpoint,
  loadRunTurnCheckpoint,
  saveRunTurnCheckpoint,
} from "./run-turn-checkpoint.js";

const run = { id: "fixture-run", spaceId: "fixture-space" };
const key: DataKey = {
  id: "fixture-key",
  spaceId: run.spaceId,
  version: 1,
  key: new Uint8Array(32).fill(7),
};
function fixture() {
  let stored: unknown;
  const upsert = vi.fn(async ({ create, update }) => {
    stored = stored ? update.result : create.result;
    return {};
  });
  const locked = vi.fn(async () => ({ count: 1 }));
  const client = {
    $contentEncryption: () => ({
      ring: { encryptWrites: true, current: async () => key, byId: async () => key },
    }),
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => action(client),
    run: {
      updateMany: locked,
      updateManyAndReturn: vi.fn(async () => [{ id: run.id }]),
      findMany: vi.fn(async () => []),
    },
    message: { findMany: vi.fn(async () => []) },
    externalEffect: {
      upsert,
      findMany: async () => (stored ? [{ result: stored }] : []),
      deleteMany: vi.fn(async () => {
        stored = undefined;
        return { count: 1 };
      }),
    },
    attempt: { updateMany: vi.fn() },
    task: { updateMany: vi.fn() },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { client: client as unknown as PrismaClient, upsert, locked, stored: () => stored };
}

describe("encrypted run turn checkpoint", () => {
  it("stores only the latest encrypted payload outside client events", async () => {
    const state = fixture();
    await saveRunTurnCheckpoint(
      state.client,
      run,
      "fixture-worker",
      1,
      "unique-checkpoint-payload",
    );
    expect(state.stored()).not.toContain("unique-checkpoint-payload");
    expect(state.stored()).toMatch(/^rkz1:/);
    expect(await loadRunTurnCheckpoint(state.client, run)).toBe("unique-checkpoint-payload");
    await saveRunTurnCheckpoint(state.client, run, "fixture-worker", 1, "replacement");
    expect(await loadRunTurnCheckpoint(state.client, run)).toBe("replacement");
    expect(state.upsert.mock.calls[0]![0].where).toEqual(state.upsert.mock.calls[1]![0].where);
  });
  it("rejects a checkpoint copied to another run", async () => {
    const state = fixture();
    await saveRunTurnCheckpoint(state.client, run, "fixture-worker", 1, "fixture");
    await expect(
      loadRunTurnCheckpoint(state.client, { ...run, id: "other-fixture" }),
    ).rejects.toThrow();
  });
  it("rejects stale writers before storing content", async () => {
    const state = fixture();
    state.locked.mockResolvedValue({ count: 0 });
    await expect(
      saveRunTurnCheckpoint(state.client, run, "fixture-worker", 1, "fixture"),
    ).rejects.toThrow("lease expired");
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it("drops a saved turn only for the worker that holds the lease", async () => {
    const state = fixture();
    await saveRunTurnCheckpoint(state.client, run, "fixture-worker", 1, "fixture");
    state.locked.mockResolvedValueOnce({ count: 0 });
    await expect(dropRunTurnCheckpoint(state.client, run, "stale-worker", 1)).rejects.toThrow(
      "lease expired",
    );
    expect(await loadRunTurnCheckpoint(state.client, run)).toBe("fixture");
    await dropRunTurnCheckpoint(state.client, run, "fixture-worker", 1);
    expect(await loadRunTurnCheckpoint(state.client, run)).toBeUndefined();
  });
  it("clears content in the same transaction as cancellation", async () => {
    const state = fixture();
    await saveRunTurnCheckpoint(state.client, run, "fixture-worker", 1, "fixture");
    await cancelRunsInTransaction(
      state.client,
      [{ id: run.id, taskId: "fixture-task", userId: "fixture-user", spaceId: run.spaceId }],
      new Date(0),
    );
    expect(await loadRunTurnCheckpoint(state.client, run)).toBeUndefined();
  });
});
