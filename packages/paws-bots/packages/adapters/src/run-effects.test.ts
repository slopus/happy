import { RunHistoryWriteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { legacyPiToolCallId, recordEffect, runScopedToolExecutionId } from "./run-effects.js";

type Effect = {
  id: string;
  runId: string;
  spaceId: string;
  idempotencyKey: string;
  kind: string;
  request: unknown;
  status: string;
  result?: unknown;
};
function fixture(initial: Effect[] = []) {
  const stored = new Map(initial.map((effect) => [effect.idempotencyKey, effect]));
  const create = vi.fn(async ({ data }: { data: Omit<Effect, "id"> }) => {
    if (stored.has(data.idempotencyKey)) throw new Error("Duplicate key");
    const effect = { ...data, id: `effect-${stored.size}` };
    stored.set(effect.idempotencyKey, effect);
    return effect;
  });
  const append = vi.fn();
  const deps = {
    prisma: {
      externalEffect: {
        findUnique: vi.fn(
          async ({ where }: { where: { idempotencyKey: string } }) =>
            stored.get(where.idempotencyKey) ?? null,
        ),
        findMany: vi.fn(
          async ({ where }: { where: { runId: string; spaceId: string; kind: string } }) =>
            [...stored.values()].filter(
              (row) =>
                row.runId === where.runId &&
                row.spaceId === where.spaceId &&
                row.kind === where.kind,
            ),
        ),
        create,
      },
    },
    events: { append },
  } as unknown as Parameters<typeof recordEffect>[0];
  return { deps, create, append, stored };
}
const run = (id: string, spaceId = "space-a") => ({
  id,
  spaceId,
  threadId: `thread-${id}`,
  botId: `bot-${id}`,
});
const effect = (idempotencyKey: string, runId: string, spaceId = "space-a"): Effect => ({
  id: "existing",
  idempotencyKey,
  kind: "write_fixture",
  request: {},
  runId,
  spaceId,
  status: "completed",
  result: { privateResult: "synthetic foreign result" },
});

describe("executor tool effect ownership", () => {
  it("refuses a new effect from an attempt a newer claim superseded", async () => {
    const f = fixture();
    const tx = {
      $queryRaw: vi.fn(async () => []),
      run: {
        findUnique: vi.fn(async () => ({
          status: "running",
          leaseOwner: "worker-2",
          leaseFence: 2,
        })),
      },
      externalEffect: { create: f.create },
    };
    const prisma = Object.assign(f.deps.prisma, {
      $transaction: vi.fn(async (write: (client: typeof tx) => unknown) => write(tx)),
    });
    const stale = {
      ...f.deps,
      prisma,
      runLease: { runId: "one", owner: "worker-1", fence: 1 },
    } as unknown as Parameters<typeof recordEffect>[0];
    await expect(
      recordEffect(stale, run("one"), "write_fixture", "fixture-key", {}),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("rejects the reserved checkpoint kind before reading or recording effects", async () => {
    const f = fixture();
    await expect(
      recordEffect(f.deps, run("fixture"), "runtime_checkpoint", "fixture-key", {}),
    ).rejects.toThrow();
    expect(f.deps.prisma.externalEffect.findMany).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });
  it("never reconciles a checkpoint through an exact effect key", async () => {
    const f = fixture([
      {
        ...effect("fixture-key", "fixture"),
        kind: "runtime_checkpoint",
        status: "runtime_checkpoint",
        result: "opaque-fixture",
      },
    ]);
    await expect(
      recordEffect(f.deps, run("fixture"), "write_fixture", "fixture-key", {}),
    ).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
  });
  it("keeps identical provider tool IDs distinct across runs and spaces", async () => {
    const f = fixture();
    const runs = [run("one"), run("two"), run("three", "space-b")];
    for (const current of runs) {
      const result = await recordEffect(
        f.deps,
        current,
        "write_fixture",
        runScopedToolExecutionId(current.id, "call_1"),
        {},
        "call_1",
      );
      expect(result.duplicate).toBe(false);
      expect(result.effect.runId).toBe(current.id);
      expect(result.effect.spaceId).toBe(current.spaceId);
      expect(result.effect.result).toBeUndefined();
    }
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(f.append).not.toHaveBeenCalled();
  });
  it("reconciles a same-run retry without recording another effect", async () => {
    const f = fixture();
    const key = runScopedToolExecutionId("one", "call_1");
    const first = await recordEffect(f.deps, run("one"), "write_fixture", key, {}, "call_1");
    first.effect.status = "completed";
    first.effect.result = { ok: true };
    const second = await recordEffect(f.deps, run("one"), "write_fixture", key, {}, "call_1");
    expect(second).toEqual({ duplicate: true, effect: first.effect });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledTimes(1);
  });
  it.each([run("foreign"), run("one", "foreign-space")])(
    "ignores foreign legacy collisions without replaying results",
    async (foreign) => {
      const f = fixture([effect("call_1", foreign.id, foreign.spaceId)]);
      const result = await recordEffect(
        f.deps,
        run("one"),
        "write_fixture",
        runScopedToolExecutionId("one", "call_1"),
        {},
        "call_1",
      );
      expect(result.duplicate).toBe(false);
      expect(result.effect.result).toBeUndefined();
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.append).not.toHaveBeenCalled();
    },
  );
  it("retains same-run legacy replay without creating an extra effect", async () => {
    const old = effect("call_1", "one");
    const f = fixture([old]);
    expect(
      await recordEffect(
        f.deps,
        run("one"),
        "write_fixture",
        runScopedToolExecutionId("one", "call_1"),
        {},
        "call_1",
      ),
    ).toEqual({ duplicate: true, effect: old });
    expect(f.create).not.toHaveBeenCalled();
  });
  it.each([run("foreign"), run("one", "foreign-space")])(
    "rejects a scoped record with mismatched ownership",
    async (foreign) => {
      const key = runScopedToolExecutionId("one", "call_1");
      const f = fixture([effect(key, foreign.id, foreign.spaceId)]);
      await expect(recordEffect(f.deps, run("one"), "write_fixture", key, {})).rejects.toThrow(
        "does not belong",
      );
      expect(f.create).not.toHaveBeenCalled();
      expect(f.append).not.toHaveBeenCalled();
    },
  );
  it("does not confuse separator-containing model IDs or run IDs", () => {
    expect(runScopedToolExecutionId("a:b", "c")).not.toBe(runScopedToolExecutionId("a", "b:c"));
  });
  it.each(["main", JSON.stringify(["pi-tool", "main", "delegate-a"])])(
    "stops an upgraded Pi retry when old raw IDs cannot prove agent ownership",
    async (namespace) => {
      const f = fixture([effect("call_1", "one")]);
      const id = JSON.stringify(["pi-tool", namespace, "call_1"]);
      await expect(
        recordEffect(
          f.deps,
          run("one"),
          "write_fixture",
          runScopedToolExecutionId("one", id),
          {},
          id,
        ),
      ).rejects.toThrow("verify the destination");
      expect(f.create).not.toHaveBeenCalled();
      expect(f.append).not.toHaveBeenCalled();
    },
  );
  it.each([run("foreign"), run("one", "foreign-space")])(
    "ignores foreign pre-upgrade raw Pi records",
    async (foreign) => {
      const f = fixture([effect("call_1", foreign.id, foreign.spaceId)]);
      const id = JSON.stringify(["pi-tool", "main", "call_1"]);
      const own = await recordEffect(
        f.deps,
        run("one"),
        "write_fixture",
        runScopedToolExecutionId("one", id),
        {},
        id,
      );
      expect(own.duplicate).toBe(false);
      expect(own.effect.result).toBeUndefined();
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.append).not.toHaveBeenCalled();
    },
  );
  it("decodes only the exact Pi backend tuple shape", () => {
    expect(legacyPiToolCallId(JSON.stringify(["pi-tool", "main", "call_1"]))).toBe("call_1");
    for (const invalid of [
      "call_1",
      ["other", "main", "call_1"],
      ["pi-tool", "main", "call_1", "extra"],
      ["pi-tool", "", "call_1"],
      ["pi-tool", "main", 1],
    ]) {
      expect(
        legacyPiToolCallId(typeof invalid === "string" ? invalid : JSON.stringify(invalid)),
      ).toBeUndefined();
    }
  });
});
