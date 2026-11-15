import { ModelAccountError, ModelOutputError, TransientModelError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  backOffRoutineAfterAccountError,
  clearRoutineBackoff,
  modelAccountRefusal,
  routineAccountBackoffMs,
} from "./routine-backoff.js";

const NOW = new Date("2026-03-02T09:00:30.000Z");
const MINUTE = 60_000;

interface Row {
  active: boolean;
  crons: string[];
  timezone: string;
  watch: unknown;
  nextRunAt: Date | null;
  accountFailures: number;
  userId?: string;
}

function fakeRoutine(overrides: Partial<Row> = {}) {
  const row: Row = {
    active: true,
    crons: ["*/1 * * * *"],
    timezone: "UTC",
    watch: null,
    nextRunAt: new Date("2026-03-02T09:01:00.000Z"),
    accountFailures: 0,
    userId: "owner",
    ...overrides,
  };
  const routine = {
    count: vi.fn(async () => (row.accountFailures > 0 ? 1 : 0)),
    findUnique: vi.fn(async () => ({ ...row })),
    update: vi.fn(async ({ data }: { data: Partial<Row> }) => Object.assign(row, data)),
  };
  const lock = vi.fn(async () => []);
  const prisma = {
    routine,
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ routine, $queryRaw: lock }),
    ),
  };
  const enqueue = vi.fn(async () => undefined);
  const jobs = { enqueue, enqueueIn: vi.fn(), cancelIn: vi.fn(), cancel: vi.fn(), close: vi.fn() };
  const deps = { prisma: prisma as unknown as PrismaClient, jobs };
  return { row, deps, enqueue, lock };
}

describe("modelAccountRefusal", () => {
  it.each([
    [
      "a rejected key",
      'OpenAI API error (401): {"error":{"message":"Incorrect API key provided"}}',
    ],
    [
      "a forbidden key",
      '403: {"error":{"message":"Invalid API key","type":"authentication_error"}}',
    ],
    ["payment required", '402: {"error":{"message":"Insufficient credits. Add more credits."}}'],
    ["an exhausted balance", "Your credit balance is too low to access the API."],
    ["a model the provider no longer serves", "404: model not found"],
  ])("counts %s", (_label, message) => {
    expect(modelAccountRefusal(new ModelAccountError(message))).toEqual({});
  });

  it("holds until a quota's named reset", () => {
    const reset = Date.now() + 10 * 60 * MINUTE;
    const message = `429 ${JSON.stringify({
      error: {
        message: "Rate limit exceeded: free-models-per-day",
        code: 429,
        metadata: { headers: { "X-RateLimit-Reset": String(reset) } },
      },
    })}`;
    expect(modelAccountRefusal(new ModelAccountError(message))).toEqual({
      resetAt: new Date(reset),
    });
  });

  it.each([
    ["a rate limit", new ModelAccountError('429: {"error":{"message":"Rate limit reached"}}')],
    ["a daily limit that resets", new ModelAccountError("Key hit its daily limit.")],
    ["a timeout", new TransientModelError("Request timed out")],
    ["an output limit", new ModelOutputError("The model hit its output limit")],
    ["a plain server error", new Error("401 Unauthorized")],
  ])("does not count %s", (_label, error) => {
    expect(modelAccountRefusal(error)).toBeUndefined();
  });
});

describe("routineAccountBackoffMs", () => {
  it("doubles from five minutes and stops at a day", () => {
    expect([1, 2, 3, 4].map(routineAccountBackoffMs)).toEqual([
      5 * MINUTE,
      10 * MINUTE,
      20 * MINUTE,
      40 * MINUTE,
    ]);
    expect(routineAccountBackoffMs(12)).toBe(24 * 60 * MINUTE);
  });
});

describe("backOffRoutineAfterAccountError", () => {
  it("moves a frequent routine's next run past the gap, on its cadence", async () => {
    const { row, deps, enqueue, lock } = fakeRoutine({ accountFailures: 2 });

    await backOffRoutineAfterAccountError(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(lock).toHaveBeenCalledOnce();
    expect(row.accountFailures).toBe(3);
    // 20 minutes after 09:00:30, the next whole minute.
    const resume = new Date("2026-03-02T09:21:00.000Z");
    expect(row.nextRunAt).toEqual(resume);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "routine.wakeup", availableAt: resume }),
    );
  });

  it("leaves a routine whose next run is already past the gap", async () => {
    const tomorrow = new Date("2026-03-03T09:00:00.000Z");
    const { row, deps, enqueue } = fakeRoutine({ crons: ["0 9 * * *"], nextRunAt: tomorrow });

    await backOffRoutineAfterAccountError(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(row.accountFailures).toBe(1);
    expect(row.nextRunAt).toEqual(tomorrow);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("delays a change trigger's next check by the gap", async () => {
    const { row, deps } = fakeRoutine({ crons: [], watch: { kind: "files" } });

    await backOffRoutineAfterAccountError(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(row.nextRunAt).toEqual(new Date(NOW.getTime() + 5 * MINUTE));
  });

  it("holds a frequent routine until the provider's reset, at most a day", async () => {
    const { row, deps, enqueue } = fakeRoutine();
    const reset = new Date("2026-03-03T00:00:00.000Z");

    await backOffRoutineAfterAccountError(
      deps,
      { routineId: "routine-1", userId: "owner" },
      NOW,
      reset,
    );

    expect(row.accountFailures).toBe(1);
    // The routine's first minute after the reset.
    const resume = new Date("2026-03-03T00:01:00.000Z");
    expect(row.nextRunAt).toEqual(resume);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "routine.wakeup", availableAt: resume }),
    );

    const monthly = fakeRoutine({ crons: [], watch: { kind: "files" } });
    await backOffRoutineAfterAccountError(
      monthly.deps,
      { routineId: "routine-1", userId: "owner" },
      NOW,
      new Date("2026-04-01T00:00:00.000Z"),
    );
    expect(monthly.row.nextRunAt).toEqual(new Date(NOW.getTime() + 24 * 60 * MINUTE));
  });

  it("does not schedule a paused routine", async () => {
    const { row, deps, enqueue } = fakeRoutine({ active: false });

    await backOffRoutineAfterAccountError(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(row.nextRunAt).toEqual(new Date("2026-03-02T09:01:00.000Z"));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("leaves the owner's schedule alone when another member's test run fails", async () => {
    const { row, deps, enqueue } = fakeRoutine({ userId: "owner" });

    await backOffRoutineAfterAccountError(deps, { routineId: "routine-1", userId: "tester" }, NOW);
    expect(row).toMatchObject({
      accountFailures: 0,
      nextRunAt: new Date("2026-03-02T09:01:00.000Z"),
    });
    expect(enqueue).not.toHaveBeenCalled();

    await backOffRoutineAfterAccountError(deps, { routineId: "routine-1", userId: "owner" }, NOW);
    expect(row.accountFailures).toBe(1);
  });
});

describe("clearRoutineBackoff", () => {
  it("resets the count and brings a held schedule back to its cadence", async () => {
    const { row, deps, enqueue } = fakeRoutine({
      accountFailures: 9,
      nextRunAt: new Date("2026-03-02T15:00:00.000Z"),
    });

    await clearRoutineBackoff(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(row.accountFailures).toBe(0);
    expect(row.nextRunAt).toEqual(new Date("2026-03-02T09:01:00.000Z"));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("restarts an uneven interval where turning the routine back on would", async () => {
    const { row, deps } = fakeRoutine({
      crons: ["*/7 * * * *"],
      accountFailures: 4,
      nextRunAt: new Date("2026-03-02T10:03:00.000Z"),
    });

    await clearRoutineBackoff(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(row.nextRunAt).toEqual(new Date("2026-03-02T09:07:00.000Z"));
  });

  it("does nothing for a routine that was not backed off", async () => {
    const { deps, enqueue } = fakeRoutine();

    await clearRoutineBackoff(deps, { routineId: "routine-1", userId: "owner" }, NOW);

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("clearRoutineBackoff when the database is unavailable", () => {
  it("logs instead of throwing into the completed run", async () => {
    const { deps } = fakeRoutine();
    vi.mocked(deps.prisma.routine.count).mockRejectedValueOnce(new Error("connection lost"));

    await expect(
      clearRoutineBackoff(deps, { routineId: "routine-1", userId: "owner" }, NOW),
    ).resolves.toBeUndefined();
  });
});
