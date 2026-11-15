import { routineWakeupJob } from "@rakazo/adapter-kit";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import { Prisma } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelScheduleFromTool,
  changeUserTimezone,
  commandWatchFromTool,
  compactScheduleInput,
  createScheduleFromTool,
  filterBuiltinToolsForRun,
  filterBuiltinToolsForThread,
  isOneShotRoutineCron,
  listSchedulesFromTool,
  MAX_ACTIVE_ROUTINES_PER_BOT,
  resolveScheduleTiming,
  SCHEDULE_TOOL_NAMES,
  scheduleCreateError,
  scheduleCreateFields,
  updateScheduleFromTool,
} from "./schedule-tools.js";

const noRoutines = async () => [];
const impossibleOffsetDates = ["2030-02-30T10:00Z", "2030-04-31T10:00+05:30"];

/**
 * A prisma fake whose account zone answers the share lock a creation takes inside its
 * insert transaction. `timezone` is the saved account zone, or null for none.
 */
function accountZonePrisma(prisma: Record<string, unknown>, timezone: string | null) {
  const client = {
    ...prisma,
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(client),
    $queryRaw: async (strings: TemplateStringsArray) =>
      strings.join("?").includes("FOR SHARE") ? [{ timezone }] : [],
  };
  return client;
}

describe("resolveScheduleTiming", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-20T00:11:59.999Z") }));
  afterEach(() => vi.useRealTimers());

  it("rejects repeating intervals under one minute", () => {
    expect(resolveScheduleTiming({ every: 2, unit: "seconds" })).toEqual({
      ok: false,
      error: "minimum interval is 1 minute",
    });
  });

  it("accepts every 1 minute", () => {
    const result = resolveScheduleTiming({ every: 1, unit: "minutes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts cron every minute", () => {
    const result = resolveScheduleTiming({ cron: "*/1 * * * *" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
  });

  it("creates one-shot schedules with @once cron", () => {
    const result = resolveScheduleTiming({ delayMinutes: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.oneShot).toBe(true);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("allows sub-minute one-shot delays via delaySeconds", () => {
    const result = resolveScheduleTiming({ delaySeconds: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("rejects one-shot schedules in the past", () => {
    expect(resolveScheduleTiming({ runAt: new Date(Date.now() - 60_000).toISOString() })).toEqual({
      ok: false,
      error:
        "One-shot schedules must run in the future. It is now Tuesday, 2026-10-20 00:11 (UTC+00:00) in UTC.",
    });
  });

  it("reads a runAt without an offset in the routine's timezone", () => {
    const at = (runAt: string, timezone: string) => {
      const result = resolveScheduleTiming({ runAt }, timezone);
      return result.ok ? result.nextRunAt.toISOString() : result.error;
    };
    expect(at("2026-11-02T10:00", "Europe/Berlin")).toBe("2026-11-02T09:00:00.000Z");
    expect(at("2026-11-02T10:00", "America/New_York")).toBe("2026-11-02T15:00:00.000Z");
    expect(at("2026-11-02T10:00:00Z", "America/New_York")).toBe("2026-11-02T10:00:00.000Z");
    expect(at("2026-02-30T10:00", "UTC")).toBe("runAt must be a valid ISO datetime.");
    // 00:30 in Berlin on the 20th already passed (it is 02:11 there).
    expect(at("2026-10-20T00:30", "Europe/Berlin")).toMatch(/^One-shot schedules must run/);
  });

  it.each(impossibleOffsetDates)(
    "rejects impossible offset dates in schedule timing: %s",
    (date) => {
      expect.soft(resolveScheduleTiming({ runAt: date })).toEqual({
        ok: false,
        error: "runAt must be a valid ISO datetime.",
      });
      expect.soft(resolveScheduleTiming({ cron: "0 9 * * *", startAt: date })).toEqual({
        ok: false,
        error: "startAt must be an ISO date or datetime.",
      });
    },
  );

  it("starts a repeat at the first occurrence at or after startAt", () => {
    const first = (input: Record<string, unknown>, timezone: string) => {
      const result = resolveScheduleTiming(input, timezone);
      return result.ok ? result.nextRunAt.toISOString() : result.error;
    };
    // Weekly on Monday at 10:00 in Berlin: without startAt the first run is this coming Monday.
    expect(first({ cron: "0 10 * * 1" }, "Europe/Berlin")).toBe("2026-10-26T09:00:00.000Z");
    expect(first({ cron: "0 10 * * 1", startAt: "2026-11-02" }, "Europe/Berlin")).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    // A startAt that is itself an occurrence is the first run.
    expect(first({ cron: "0 10 * * 1", startAt: "2026-11-02T10:00" }, "Europe/Berlin")).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    expect(first({ cron: "0 10 * * 1", startAt: "2026-11-02T09:00:00Z" }, "Europe/Berlin")).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    expect(first({ cron: "0 10 * * 1", startAt: "2026-11-02T10:00:00.5" }, "Europe/Berlin")).toBe(
      "2026-11-09T09:00:00.000Z",
    );
    // Across New York's fall-back change: 09:00 is EDT on the 31st and EST on 1 November.
    expect(first({ cron: "0 9 * * *", startAt: "2026-10-31" }, "America/New_York")).toBe(
      "2026-10-31T13:00:00.000Z",
    );
    expect(first({ cron: "0 9 * * *", startAt: "2026-11-01" }, "America/New_York")).toBe(
      "2026-11-01T14:00:00.000Z",
    );
    expect(first({ every: 6, unit: "hours", startAt: "2026-11-02T07:00" }, "UTC")).toBe(
      "2026-11-02T12:00:00.000Z",
    );
  });

  it("rejects a startAt that is past, invalid, or on a one-shot", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", startAt: "2026-10-19" })).toEqual({
      ok: false,
      error:
        "startAt is in the past; omit it to start now. It is now Tuesday, 2026-10-20 00:11 (UTC+00:00) in UTC.",
    });
    expect(resolveScheduleTiming({ cron: "0 9 * * *", startAt: "next week" })).toEqual({
      ok: false,
      error: "startAt must be an ISO date or datetime.",
    });
    expect(resolveScheduleTiming({ runAt: "2026-11-02T10:00", startAt: "2026-11-02" })).toEqual({
      ok: false,
      error: "startAt is only for repeating schedules.",
    });
  });

  it("rejects fractional repeat intervals", () => {
    expect(resolveScheduleTiming({ every: 1.5, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
  });

  it("rejects malformed cron expressions", () => {
    expect(resolveScheduleTiming({ cron: "*/5 *" })).toEqual({
      ok: false,
      error: "cron must be a 5-field cron expression.",
    });
    expect(resolveScheduleTiming({ cron: "foo * * * *" })).toEqual({
      ok: false,
      error: "cron must be a valid 5-field cron expression.",
    });
  });

  it("rejects mixing repeat and one-shot fields", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", delayMinutes: 5 })).toEqual({
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    });
  });

  it("rejects two repeating timing methods", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", every: 1, unit: "hours" })).toEqual({
      ok: false,
      error: "Provide exactly one timing method: cron, or every and unit, not both.",
    });
  });

  it("ignores null and empty optional fields from model serializers", () => {
    const repeating = resolveScheduleTiming({
      cron: "0 9 * * *",
      every: null,
      unit: "",
      delayMinutes: null,
      runAt: "",
    });
    expect(repeating.ok).toBe(true);
    if (!repeating.ok) return;
    expect(repeating.oneShot).toBe(false);

    const oneShot = resolveScheduleTiming({
      cron: null,
      every: null,
      unit: "",
      delayMinutes: 10,
      delaySeconds: null,
    });
    expect(oneShot.ok).toBe(true);
    if (!oneShot.ok) return;
    expect(oneShot.oneShot).toBe(true);
  });

  it("keeps zero values for normal validation instead of treating them as absent", () => {
    expect(resolveScheduleTiming({ every: 0, unit: "minutes" })).toEqual({
      ok: false,
      error: "every must be a positive whole number.",
    });
    expect(compactScheduleInput({ every: 0, unit: "minutes", cron: null, runAt: "" })).toEqual({
      every: 0,
      unit: "minutes",
    });
  });
});

describe("filterBuiltinToolsForThread", () => {
  const tools = [
    { name: "handoff_to_bot" },
    { name: "message_bot" },
    { name: "schedule_create" },
    { name: "schedule_list" },
    { name: "schedule_cancel" },
    { name: "remember" },
  ];

  it("keeps handoff and schedule tools in groups", () => {
    expect(filterBuiltinToolsForThread(tools, "group-1").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(filterBuiltinToolsForThread(tools, null).map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "message_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
  });

  it("allows schedule creation in routine runs but hides schedule updates", () => {
    expect(filterBuiltinToolsForRun(tools, "routine").map((tool) => tool.name)).toEqual([
      "handoff_to_bot",
      "message_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    const withUpdate = [...tools, { name: "schedule_update" }];
    expect(filterBuiltinToolsForRun(withUpdate, "routine").map((tool) => tool.name)).not.toContain(
      "schedule_update",
    );
    expect(filterBuiltinToolsForRun(withUpdate, "user").map((tool) => tool.name)).toEqual(
      withUpdate.map((tool) => tool.name),
    );
  });

  it("composes thread then run filters without dropping group schedule tools", () => {
    const groupTools = filterBuiltinToolsForRun(
      filterBuiltinToolsForThread(tools, "group-1"),
      "routine",
    ).map((tool) => tool.name);
    expect(groupTools).toEqual([
      "handoff_to_bot",
      "schedule_create",
      "schedule_list",
      "schedule_cancel",
      "remember",
    ]);
    expect(
      filterBuiltinToolsForRun(filterBuiltinToolsForThread(tools, "group-1"), "user").map(
        (tool) => tool.name,
      ),
    ).toContain("schedule_create");
  });

  it("covers every schedule tool name", () => {
    for (const name of SCHEDULE_TOOL_NAMES) {
      expect(filterBuiltinToolsForThread([{ name }, { name: "remember" }], "group-1")).toEqual([
        { name },
        { name: "remember" },
      ]);
    }
  });
});

describe("isOneShotRoutineCron", () => {
  it("detects the one-shot sentinel", () => {
    expect(isOneShotRoutineCron(ONCE_ROUTINE_CRON)).toBe(true);
    expect(isOneShotRoutineCron("0 9 * * *")).toBe(false);
  });
});

describe("schedule tool persistence", () => {
  const noTimezone = { findUnique: vi.fn(async () => null) };
  it.each(impossibleOffsetDates)("does not persist an impossible offset date: %s", async (date) => {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
    }));
    const enqueue = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const deps = {
      prisma: { routine: { create, findMany: noRoutines } },
      events: { append },
      jobs: { enqueue },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    for (const [schedule, error] of [
      [{ runAt: date }, "runAt must be a valid ISO datetime."],
      [{ cron: "0 9 * * *", startAt: date }, "startAt must be an ISO date or datetime."],
    ] as const) {
      expect
        .soft(
          await createScheduleFromTool(deps, {
            spaceId: "ws-1",
            botId: "bot-1",
            userId: "user-1",
            threadId: "thread-1",
            name: "Daily",
            prompt: "Check",
            timezone: "UTC",
            schedule,
          }),
        )
        .toEqual({ error });
    }
    expect(create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it.each([{ cron: "0 9 * * *" }, { watch: { kind: "files", paths: ["inbox"] } }])(
    "rejects an invalid timezone before persisting %j",
    async (schedule) => {
      const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: "routine-1",
        ...args.data,
      }));
      const enqueue = vi.fn(async () => undefined);
      const deps = {
        prisma: {
          routine: { create, findMany: noRoutines },
          bot: { findFirst: vi.fn(async () => ({ computer: null })) },
        },
        events: { append: vi.fn() },
        jobs: { enqueue },
      } as unknown as Parameters<typeof createScheduleFromTool>[0];
      const result = await createScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        name: "Daily",
        prompt: "Check",
        timezone: "Mars/Olympus_Mons",
        schedule,
      });
      expect(result).toEqual({ error: "Unknown timezone" });
      expect(create).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it("refuses a name already active in the thread, not one in another thread", async () => {
    const findMany = vi.fn(async () => [
      { id: "routine-1", name: "Morning joke", threadId: "thread-1" },
      { id: "routine-2", name: "Evening joke", threadId: "thread-2" },
    ]);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-3",
      ...args.data,
    }));
    const deps = {
      prisma: accountZonePrisma({ routine: { create, findMany } }, null),
      events: { append: vi.fn() },
      jobs: { enqueue: vi.fn() },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: " morning joke ",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({
      error:
        'An active routine named "Morning joke" already exists (routine-1). Update or cancel it instead.',
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "ws-1", botId: "bot-1", active: true },
      select: { id: true, name: true, threadId: true },
    });
    expect(create).not.toHaveBeenCalled();

    const other = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Evening joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });
    expect(other).toMatchObject({ ok: true, routineId: "routine-3" });
  });

  it("refuses a new routine once the bot has the maximum active", async () => {
    const create = vi.fn();
    const deps = {
      prisma: {
        user: noTimezone,
        routine: {
          create,
          findMany: vi.fn(async () =>
            Array.from({ length: MAX_ACTIVE_ROUTINES_PER_BOT }, (_, i) => ({
              id: `routine-${i}`,
              name: `Check ${i}`,
              threadId: "thread-1",
            })),
          ),
        },
      },
      events: { append: vi.fn() },
      jobs: { enqueue: vi.fn() },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "One more",
      prompt: "Check",
      schedule: { watch: { kind: "files", paths: ["inbox"] } },
    });

    expect(result).toEqual({
      error: `This bot already has ${MAX_ACTIVE_ROUTINES_PER_BOT} active routines. Cancel one before adding another.`,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates routines with routine.created and enqueues wakeup", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
      nextRunAt: args.data.nextRunAt,
    }));
    const deps = {
      prisma: accountZonePrisma(
        {
          bot: { findFirst: vi.fn(async () => ({ computer: null })) },
          routine: { create, findMany: noRoutines },
        },
        null,
      ),
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1", cron: "*/1 * * * *" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          spaceId: "ws-1",
          userId: "user-1",
          threadId: "thread-1",
          crons: ["*/1 * * * *"],
          active: true,
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.created", payload: { name: "Morning joke" } }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    { saved: "Europe/Paris", timezone: "Europe/Paris", nextRunAt: "2026-10-19T07:00:00.000Z" },
    { saved: "Mars/Olympus_Mons", timezone: "UTC", nextRunAt: "2026-10-19T09:00:00.000Z" },
  ])("defaults to the user's saved timezone $saved", async ({ saved, timezone, nextRunAt }) => {
    vi.useFakeTimers({ now: new Date("2026-10-18T12:00:00Z") });
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
    }));
    const deps = {
      prisma: accountZonePrisma({ routine: { create, findMany: noRoutines } }, saved),
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    try {
      await createScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        name: "Morning brief",
        prompt: "Summarize the news",
        schedule: { cron: "0 9 * * *" },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timezone, nextRunAt: new Date(nextRunAt) }),
      }),
    );
  });

  it("createScheduleFromTool creates the routine for the target bot and thread", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
    }));
    const deps = {
      prisma: accountZonePrisma({ routine: { create, findMany: noRoutines } }, null),
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      target: { botId: "child-1", threadId: "child-thread-1" },
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ botId: "child-1", threadId: "child-thread-1" }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "routine.created",
        botId: "child-1",
        threadId: "child-thread-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("keeps the routine when event append fails after enqueue", async () => {
    const cancel = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: accountZonePrisma(
        {
          routine: {
            findMany: noRoutines,
            create: vi.fn(async () => ({
              id: "routine-1",
              name: "Morning joke",
              crons: ["*/1 * * * *"],
              nextRunAt: new Date(),
            })),
            delete: remove,
          },
        },
        null,
      ),
      events: {
        append: vi.fn(async () => {
          throw new Error("event failed");
        }),
      },
      jobs: { enqueue: vi.fn(async () => undefined), cancel },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1" });
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rolls back routine when enqueue fails", async () => {
    const remove = vi.fn(async () => undefined);
    const deps = {
      prisma: accountZonePrisma(
        {
          routine: {
            findMany: noRoutines,
            create: vi.fn(async () => ({
              id: "routine-1",
              name: "Morning joke",
              crons: ["*/1 * * * *"],
              nextRunAt: new Date(),
            })),
            delete: remove,
          },
        },
        null,
      ),
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(remove).toHaveBeenCalledWith({ where: { id: "routine-1" } });
  });

  it("deactivates when enqueue fails and delete also fails", async () => {
    const update = vi.fn(async () => undefined);
    const deps = {
      prisma: accountZonePrisma(
        {
          routine: {
            findMany: noRoutines,
            create: vi.fn(async () => ({
              id: "routine-1",
              name: "Morning joke",
              crons: ["*/1 * * * *"],
              nextRunAt: new Date(),
            })),
            delete: vi.fn(async () => {
              throw new Error("delete failed");
            }),
            update,
          },
        },
        null,
      ),
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toEqual({ error: "Could not schedule the reminder. Try again." });
    expect(update).toHaveBeenCalledWith({
      where: { id: "routine-1" },
      data: { active: false, nextRunAt: null },
    });
  });

  it("propagates when enqueue rollback cannot deactivate", async () => {
    const deps = {
      prisma: accountZonePrisma(
        {
          routine: {
            findMany: noRoutines,
            create: vi.fn(async () => ({
              id: "routine-1",
              name: "Morning joke",
              crons: ["*/1 * * * *"],
              nextRunAt: new Date(),
            })),
            delete: vi.fn(async () => {
              throw new Error("delete failed");
            }),
            update: vi.fn(async () => {
              throw new Error("deactivate failed");
            }),
          },
        },
        null,
      ),
      events: { append: vi.fn(async () => undefined) },
      jobs: {
        enqueue: vi.fn(async () => {
          throw new Error("enqueue failed");
        }),
        cancel: vi.fn(async () => undefined),
      },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    await expect(
      createScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        name: "Morning joke",
        prompt: "Tell a joke",
        schedule: { every: 1, unit: "minutes" },
      }),
    ).rejects.toThrow("deactivate failed");
  });

  it("lists a group's routines from every chat but cancels only the group's own", async () => {
    const findMany = vi.fn(async () => [
      { id: "routine-dm", name: "Daily check", crons: ["0 8 * * *"], threadId: "dm-thread-1" },
      { id: "routine-group", name: "Digest", crons: ["0 9 * * *"], threadId: "group-thread-1" },
      { id: "routine-default", name: "Weekly", crons: ["0 9 * * 1"], threadId: null },
    ]);
    const findFirst = vi.fn(async () => null);
    const deps = {
      prisma: {
        user: noTimezone,
        routine: { findMany, findFirst, deleteMany: vi.fn(async () => ({ count: 1 })) },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];

    const listed = await listSchedulesFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      groupThreadId: "group-thread-1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: "ws-1", botId: "bot-1" } }),
    );
    expect(listed.routines.map(({ routineId, inThisChat }) => [routineId, inThisChat])).toEqual([
      ["routine-dm", false],
      ["routine-group", true],
      ["routine-default", false],
    ]);
    expect(listed.note).toBe(
      "inThisChat marks the routines this group chat can change; change the others from the bot's own chat.",
    );

    const cancelled = await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      threadId: "group-thread-1",
      routineId: "routine-1",
    });
    expect(cancelled).toEqual({ error: "Schedule not found." });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "ws-1",
          botId: "bot-1",
          threadId: "group-thread-1",
          id: "routine-1",
        },
      }),
    );

    findMany.mockClear();
    const direct = await listSchedulesFromTool(deps, { spaceId: "ws-1", botId: "bot-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1" },
      }),
    );
    expect(direct.routines[0]).not.toHaveProperty("inThisChat");
    expect(direct).not.toHaveProperty("note");

    findFirst.mockClear();
    await cancelScheduleFromTool(deps, {
      spaceId: "ws-1",
      botId: "bot-1",
      routineId: "routine-1",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "ws-1", botId: "bot-1", id: "routine-1" },
      }),
    );
  });
});

describe("schedule_create with a watch", () => {
  function deps() {
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-w",
      ...args.data,
    }));
    const enqueue = vi.fn(async () => undefined);
    return {
      create,
      enqueue,
      deps: {
        prisma: accountZonePrisma(
          {
            connection: { findMany: vi.fn(async () => []) },
            bot: { findFirst: vi.fn(async () => ({ computer: null })) },
            routine: { create, findMany: noRoutines },
          },
          null,
        ),
        events: { append: vi.fn(async () => undefined) },
        jobs: { enqueue, cancel: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof createScheduleFromTool>[0],
    };
  }
  const base = {
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    name: "Brain check",
    prompt: "Summarize what changed",
  };

  it("creates an active routine with no schedule that checks right away", async () => {
    const { deps: d, create, enqueue } = deps();
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "tool", tool: "brain_changed", args: { limit: 1 } } },
    });
    expect(result).toMatchObject({ ok: true, routineId: "routine-w" });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        crons: [],
        active: true,
        watch: expect.objectContaining({ kind: "tool", everyMinutes: 15, loud: false }),
      }),
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects a team path escape before persisting", async () => {
    const { deps: d, create } = deps();
    vi.mocked(d.prisma.bot.findFirst).mockResolvedValue({ computer: { scope: "team" } } as never);
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "files", paths: ["/etc"] } },
    });
    expect(result).toMatchObject({ error: expect.stringContaining("inside the bot's folder") });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a write tool before persisting", async () => {
    const { deps: d, create } = deps();
    d.connector = {
      discoverTools: vi.fn(async () => [
        { name: "send", readOnly: false, description: "Send", inputSchema: {} },
      ]),
    } as unknown as typeof d.connector;
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "tool", tool: "send" } },
    });
    expect(result).toMatchObject({ error: expect.stringContaining("can change data") });
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a caller outside the bot owner boundary", async () => {
    const { deps: d, create } = deps();
    vi.mocked(d.prisma.bot.findFirst).mockResolvedValue(null);
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: { kind: "command", command: "echo changed" } },
    });
    expect(result).toMatchObject({ error: "Bot not found." });
    expect(d.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: base.botId, spaceId: base.spaceId, archivedAt: null },
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts the watch sent as JSON text", async () => {
    const { deps: d, create } = deps();
    const result = await createScheduleFromTool(d, {
      ...base,
      schedule: { watch: '{"kind":"files","paths":["inbox/"]}' },
    });
    expect(result).toMatchObject({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a watch combined with a schedule, or an invalid watch", async () => {
    const { deps: d, create } = deps();
    expect(
      await createScheduleFromTool(d, {
        ...base,
        schedule: { cron: "0 9 * * *", watch: { kind: "files", paths: ["inbox"] } },
      }),
    ).toEqual({
      error:
        "A watch takes no schedule: it checks every watch.everyMinutes minutes (5 to 1440). Call again without cron.",
    });
    expect(
      await createScheduleFromTool(d, { ...base, schedule: { watch: { kind: "files" } } }),
    ).toHaveProperty("error");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("cancelScheduleFromTool", () => {
  it("deletes with the caller's scope and does not cancel the job when the row moved", async () => {
    const findFirst = vi.fn(async () => ({ id: "routine-1", name: "Daily" }));
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const cancel = vi.fn(async () => undefined);
    const deps = {
      prisma: { routine: { findFirst, deleteMany } },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel },
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];
    const input = {
      spaceId: "ws-1",
      botId: "bot-1",
      threadId: "group-thread-1",
      name: "Daily",
    };

    await expect(cancelScheduleFromTool(deps, input)).resolves.toEqual({
      ok: true,
      routineId: "routine-1",
      name: "Daily",
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        spaceId: "ws-1",
        botId: "bot-1",
        threadId: "group-thread-1",
        id: "routine-1",
      },
    });
    expect(cancel).toHaveBeenCalledOnce();

    deleteMany.mockResolvedValueOnce({ count: 0 });
    cancel.mockClear();
    await expect(cancelScheduleFromTool(deps, input)).resolves.toEqual({
      error: "Schedule not found.",
    });
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("scheduleCreateError", () => {
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ timezone: "America/Denver" })) },
    routine: {
      findMany: vi.fn(async () => [
        { id: "routine-1", name: "Daily digest", threadId: "thread-1" },
      ]),
    },
  } as unknown as Parameters<typeof scheduleCreateError>[0];
  const check = (args: Record<string, unknown>) =>
    scheduleCreateError(prisma, {
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      ...scheduleCreateFields(args),
    });
  const named = { name: "Inbox check", prompt: "Summarize what changed" };
  const watch = { kind: "command", command: "ls inbox", everyMinutes: 15 };

  it("names the timing a watch was sent with and where its interval goes", async () => {
    await expect(check({ ...named, every: 15, watch })).resolves.toBe(
      "A watch takes no schedule: it checks every watch.everyMinutes minutes (5 to 1440). Call again without every.",
    );
    await expect(
      check({ ...named, every: 1440, unit: "minutes", startAt: "2030-01-01", watch }),
    ).resolves.toMatch(/Call again without every, unit or startAt\.$/);
  });

  it("refuses what the handler refuses before it reads or writes a routine", async () => {
    await expect(check({ ...named, name: " ", watch })).resolves.toBe("name is required.");
    await expect(check({ ...named, prompt: "", watch })).resolves.toBe("prompt is required.");
    await expect(check({ ...named, name: "daily digest", watch })).resolves.toBe(
      'An active routine named "Daily digest" already exists (routine-1). Update or cancel it instead.',
    );
    await expect(check({ ...named, timezone: "Mars/Base", watch })).resolves.toBe(
      "Unknown timezone",
    );
    await expect(check({ ...named, watch: "{kind" })).resolves.toMatch(/^watch must be an object/);
    await expect(check({ ...named, watch: { ...watch, everyMinutes: 1 } })).resolves.toMatch(/5/);
    await expect(
      check({ ...named, every: 1, unit: "days", runAt: "2030-01-01T09:00" }),
    ).resolves.toBe("Provide either a repeating schedule or a one-shot time, not both.");
  });

  it("accepts a valid watch or schedule, ignoring blank leftovers", async () => {
    await expect(check({ ...named, watch, every: null, startAt: "" })).resolves.toBeUndefined();
    await expect(check({ ...named, watch: JSON.stringify(watch) })).resolves.toBeUndefined();
    await expect(check({ ...named, every: 1, unit: "days" })).resolves.toBeUndefined();
  });
});

describe("command watch approval classification", () => {
  it("recognizes object and JSON command watches only", () => {
    const watch = { kind: "command", command: "echo changed" };
    expect(commandWatchFromTool(watch)).toBe("echo changed");
    expect(commandWatchFromTool(JSON.stringify(watch))).toBe("echo changed");
    expect(commandWatchFromTool({ kind: "files", paths: ["inbox"] })).toBeUndefined();
  });
});

describe("updateScheduleFromTool", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-20T00:11:59.999Z") }));
  afterEach(() => vi.useRealTimers());

  const weekly = {
    id: "routine-1",
    spaceId: "ws-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    name: "Groceries",
    prompt: "Order the usual groceries",
    crons: ["0 10 * * 1"],
    timezone: "Europe/Berlin",
    active: true,
    watch: null,
    lastRunAt: null,
    nextRunAt: new Date("2026-10-26T09:00:00.000Z"),
  };

  function setup(row: Record<string, unknown> | null = weekly) {
    const findFirst = vi.fn(async () => row);
    const updateMany = vi.fn(async () => ({ count: row ? 1 : 0 }));
    const enqueue = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const deps = {
      prisma: {
        routine: { findFirst, updateMany, count: vi.fn(async () => 0) },
        run: { updateManyAndReturn: vi.fn(async () => []) },
      },
      events: { append },
      jobs: { enqueue, cancel },
    } as unknown as Parameters<typeof updateScheduleFromTool>[0];
    const update = (patch: Partial<Parameters<typeof updateScheduleFromTool>[1]>) =>
      updateScheduleFromTool(deps, {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        threadId: "thread-1",
        routineId: "routine-1",
        schedule: {},
        ...patch,
      });
    return { findFirst, updateMany, enqueue, cancel, append, update };
  }

  it.each(impossibleOffsetDates)(
    "does not update to an impossible offset date: %s",
    async (date) => {
      const { updateMany, enqueue, cancel, append, update } = setup();
      expect.soft(await update({ schedule: { runAt: date } })).toEqual({
        error: "runAt must be a valid ISO datetime.",
      });
      expect.soft(await update({ schedule: { startAt: date } })).toEqual({
        error: "startAt must be an ISO date or datetime.",
      });
      expect(updateMany).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it("takes over another member's schedule and restarts its watch baseline", async () => {
    const { findFirst, updateMany, update } = setup();
    await expect(update({ userId: "user-2", prompt: "Order less" })).resolves.toMatchObject({
      ok: true,
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: { spaceId: "ws-1", botId: "bot-1", id: "routine-1", bot: { archivedAt: null } },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        id: "routine-1",
        bot: { archivedAt: null },
      },
      data: { userId: "user-2", watchState: Prisma.DbNull, prompt: "Order less" },
    });
  });

  it("edits the prompt in place and keeps the timing", async () => {
    const { updateMany, enqueue, append, update } = setup();
    const prompt = "Order the usual; if cheddar is out of stock, skip it";
    await expect(update({ prompt })).resolves.toEqual({
      ok: true,
      routineId: "routine-1",
      name: "Groceries",
      prompt,
      active: true,
      crons: ["0 10 * * 1"],
      nextRunAt: "2026-10-26T09:00:00.000Z",
      oneShot: false,
      timezone: "Europe/Berlin",
      schedule: "Every Monday at 10:00 AM",
      nextRun: "Monday, 2026-10-26 10:00 (UTC+01:00)",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: "ws-1",
        botId: "bot-1",
        userId: "user-1",
        id: "routine-1",
        bot: { archivedAt: null },
      },
      // Only the prompt, so a run claimed meanwhile keeps its advance.
      data: { prompt },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.updated", threadId: "thread-1" }),
    );
  });

  it("moves the first run of the current repeat with startAt alone", async () => {
    const { updateMany, enqueue, update } = setup();
    const first = new Date("2026-11-02T09:00:00.000Z");
    await expect(update({ schedule: { startAt: "2026-11-02" } })).resolves.toMatchObject({
      ok: true,
      nextRunAt: first.toISOString(),
      nextRun: "Monday, 2026-11-02 10:00 (UTC+01:00)",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ crons: ["0 10 * * 1"], nextRunAt: first }),
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ availableAt: first }));
  });

  it.each([
    [
      "0 10 * * 1",
      "Europe/Berlin",
      "2026-11-16T09:00:00.000Z",
      "Europe/London",
      "2026-11-16T10:00:00.000Z",
    ],
    [
      "0 10 * * 1",
      "Europe/London",
      "2026-11-16T10:00:00.000Z",
      "Europe/Berlin",
      "2026-11-16T09:00:00.000Z",
    ],
    ["30 2 * * 0", "UTC", "2027-03-28T02:30:00.000Z", "Europe/Berlin", "2027-03-28T01:30:00.000Z"],
    [
      "0 * * * *",
      "Asia/Kolkata",
      "2026-11-02T00:30:00.000Z",
      "Europe/Berlin",
      "2026-11-02T01:00:00.000Z",
    ],
    [
      "0 * * * *",
      "Europe/Berlin",
      "2026-11-02T01:00:00.000Z",
      "Asia/Kolkata",
      "2026-11-01T20:30:00.000Z",
    ],
    [
      "0 */7 * * *",
      "Europe/Berlin",
      "2026-10-20T03:00:00.000Z",
      "Europe/London",
      "2026-10-20T03:00:00.000Z",
    ],
    [
      "0 0 */3 * *",
      "Europe/Berlin",
      "2026-11-02T23:00:00.000Z",
      "America/New_York",
      "2026-11-03T05:00:00.000Z",
    ],
  ])(
    "keeps the next run (%s) when only the timezone changes from %s",
    async (cron, from, next, to, moved) => {
      const { update } = setup({
        ...weekly,
        crons: [cron],
        timezone: from,
        nextRunAt: new Date(next),
      });
      await expect(update({ timezone: to })).resolves.toMatchObject({ ok: true, nextRunAt: moved });
    },
  );

  it("applies a timing change only if no run advanced the routine since the read", async () => {
    const { updateMany, enqueue, update } = setup();
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(update({ schedule: { startAt: "2026-11-02" } })).resolves.toEqual({
      error: "The schedule changed while saving. Call schedule_list and try again.",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true, nextRunAt: weekly.nextRunAt }),
      }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("replaces the timing, turning a one-shot into a weekly routine", async () => {
    const { update } = setup({
      ...weekly,
      crons: [ONCE_ROUTINE_CRON],
      nextRunAt: new Date("2026-11-02T09:00:00.000Z"),
    });
    await expect(
      update({ schedule: { cron: "0 9 * * 1", startAt: "2026-11-02" }, timezone: "UTC" }),
    ).resolves.toMatchObject({
      ok: true,
      crons: ["0 9 * * 1"],
      oneShot: false,
      timezone: "UTC",
      nextRunAt: "2026-11-02T09:00:00.000Z",
    });
  });

  it("pauses with active false and cancels the wakeup", async () => {
    const { updateMany, cancel, enqueue, update } = setup();
    await expect(update({ active: false })).resolves.toMatchObject({
      ok: true,
      active: false,
      nextRunAt: null,
      nextRun: null,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("resumes a paused repeat from now", async () => {
    const { enqueue, update } = setup({ ...weekly, active: false, nextRunAt: null });
    await expect(update({ active: true })).resolves.toMatchObject({
      nextRunAt: "2026-10-26T09:00:00.000Z",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("does not touch another bot's or thread's routine", async () => {
    const { findFirst, updateMany, update } = setup(null);
    await expect(update({ prompt: "x", scopeThreadId: "group-thread-1" })).resolves.toEqual({
      error: "Schedule not found.",
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        spaceId: "ws-1",
        botId: "bot-1",
        threadId: "group-thread-1",
        id: "routine-1",
        bot: { archivedAt: null },
      },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("tells a group run that a routine from another chat is changed there", async () => {
    const { findFirst, updateMany, update } = setup(null);
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "routine-1" } as never);
    await expect(update({ prompt: "x", scopeThreadId: "group-thread-1" })).resolves.toEqual({
      error: "That routine is not this group chat's. Change it from the bot's own chat.",
    });
    expect(findFirst).toHaveBeenLastCalledWith({
      where: { spaceId: "ws-1", botId: "bot-1", id: "routine-1", bot: { archivedAt: null } },
      select: { id: true },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns timing errors without writing", async () => {
    const { updateMany, update } = setup();
    expect(await update({ schedule: { startAt: "2026-10-01" } })).toEqual({
      error: expect.stringMatching(/^startAt is in the past/),
    });
    expect(await update({ schedule: { runAt: "2026-10-19T10:00" } })).toEqual({
      error: expect.stringMatching(/^One-shot schedules must run in the future/),
    });
    expect(await update({})).toEqual({ error: "Nothing to update." });
    expect(await update({ prompt: "  " })).toEqual({ error: "prompt cannot be empty." });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps a watch's own interval", async () => {
    const { update } = setup({
      ...weekly,
      crons: [],
      watch: { kind: "files", paths: ["inbox"], everyMinutes: 15 },
    });
    await expect(update({ schedule: { cron: "0 9 * * *" } })).resolves.toEqual({
      error:
        "This routine is a watch: it checks every watch.everyMinutes minutes and has no schedule, so schedule_update can only change its name, prompt or active. The user can change how often it checks in the routine's settings on the web. Do not cancel and recreate it for this.",
    });
    await expect(update({ name: "Inbox" })).resolves.toMatchObject({ ok: true, name: "Inbox" });
  });
});

describe("changeUserTimezone", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  /** A user on Africa/Cairo whose routines live in an in-memory table. */
  function account(seeded: Record<string, unknown>[] = []) {
    const user = { id: "user-1", timezone: "Africa/Cairo" as string | null };
    const rows: Record<string, unknown>[] = seeded.map((row, index) => ({
      id: `routine-${index + 1}`,
      ...row,
    }));
    const enqueue = vi.fn(async () => undefined);
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) =>
        value && typeof value === "object" && "in" in value
          ? (value.in as unknown[]).includes(row[key])
          : row[key] === value,
      );
    const userUpdate = vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id !== user.id) throw new Error("unknown user");
        Object.assign(user, data);
        return { ...user };
      },
    );
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === user.id ? { timezone: user.timezone } : null,
        update: userUpdate,
      },
      bot: { findFirst: async () => ({ computer: null }) },
      connection: { findMany: async () => [] },
      routine: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `routine-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        },
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          rows.filter((row) => matches(row, where)),
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const [index, row] of rows.entries()) {
            if (!matches(row, where)) continue;
            rows[index] = { ...row, ...data };
            count += 1;
          }
          return { count };
        },
      },
      // The row locks of changeUserTimezone and the share lock of a creation: answer each
      // with what the real database would return, bound parameters included.
      $transaction: async (run: (client: unknown) => Promise<unknown>) => run(prisma),
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("FOR SHARE")) return [{ timezone: user.timezone }];
        if (sql.includes('"routines"')) {
          return rows
            .filter((row) => matches(row, { userId: values[0], timezone: values[1] }))
            .map((row) => ({ id: row.id }));
        }
        return [];
      },
    };
    const deps = {
      prisma,
      events: { append: async () => undefined },
      jobs: { enqueue, cancel: async () => undefined },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];
    return { deps, rows, user, userUpdate, enqueue };
  }
  const base = {
    spaceId: "ws-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    prompt: "Check",
  };

  it("moves a routine that took the account zone, keeping its local schedule", async () => {
    const { deps, rows, user, enqueue } = account();
    const created = await createScheduleFromTool(deps, {
      ...base,
      name: "Weekly",
      schedule: { cron: "0 9 * * 1" },
    });
    expect(created).toMatchObject({ ok: true, timezone: "Africa/Cairo" });
    const pinned = await createScheduleFromTool(deps, {
      ...base,
      name: "Pinned",
      timezone: "Asia/Tokyo",
      schedule: { cron: "0 9 * * 1" },
    });
    expect(pinned).toMatchObject({ ok: true, timezone: "Asia/Tokyo" });

    await changeUserTimezone(deps, "user-1", "Europe/London");

    // Monday 09:00 held in London, not Cairo's 07:00 UTC; the pinned routine stays.
    expect(rows.find((row) => row.name === "Weekly")).toMatchObject({
      timezone: "Europe/London",
      nextRunAt: new Date("2026-11-09T09:00:00.000Z"),
    });
    expect(rows.find((row) => row.name === "Pinned")).toMatchObject({
      timezone: "Asia/Tokyo",
      nextRunAt: new Date("2026-11-09T00:00:00.000Z"),
    });
    expect(user.timezone).toBe("Europe/London");
    expect(enqueue).toHaveBeenCalledWith(
      routineWakeupJob("routine-1", new Date("2026-11-09T09:00:00.000Z")),
    );
  });

  it("keeps the pending run's local time when moving to a zone ahead", async () => {
    const { deps, rows } = account();
    await createScheduleFromTool(deps, {
      ...base,
      name: "Weekly",
      schedule: { cron: "0 9 * * 1" },
    });

    await changeUserTimezone(deps, "user-1", "Asia/Tokyo");

    expect(rows[0]).toMatchObject({
      timezone: "Asia/Tokyo",
      nextRunAt: new Date("2026-11-09T00:00:00.000Z"),
    });
  });

  it("keeps a one-shot's saved instant; only its zone label moves", async () => {
    const { deps, rows } = account();
    await createScheduleFromTool(deps, {
      ...base,
      name: "Once",
      schedule: { runAt: "2026-11-09T09:00" },
    });
    expect(rows[0]!.nextRunAt).toEqual(new Date("2026-11-09T07:00:00.000Z"));

    await changeUserTimezone(deps, "user-1", "Europe/London");

    expect(rows[0]).toMatchObject({
      timezone: "Europe/London",
      nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
    });
  });

  it("keeps a watch on its own rhythm; only its zone label moves", async () => {
    const { deps, rows } = account();
    await createScheduleFromTool(deps, {
      ...base,
      name: "Watch",
      schedule: { watch: { kind: "files", paths: ["inbox"] } },
    });
    const nextRunAt = rows[0]!.nextRunAt;

    await changeUserTimezone(deps, "user-1", "Europe/London");

    expect(rows[0]).toMatchObject({ timezone: "Europe/London", nextRunAt });
  });

  it.each([
    {
      case: "several crons, zone behind",
      crons: ["0 9 * * 1", "0 12 * * 1"],
      nextRunAt: "2026-11-09T07:00:00.000Z",
      to: "Europe/London",
      moved: "2026-11-09T09:00:00.000Z",
    },
    {
      case: "several crons, zone ahead",
      crons: ["0 9 * * 1", "0 12 * * 1"],
      nextRunAt: "2026-11-09T07:00:00.000Z",
      to: "Asia/Tokyo",
      moved: "2026-11-09T00:00:00.000Z",
    },
  ])(
    "retimes the pending run of an active routine with $case",
    async ({ crons, nextRunAt, to, moved }) => {
      const { deps, rows } = account([
        {
          spaceId: base.spaceId,
          botId: base.botId,
          userId: base.userId,
          name: "Weekly",
          crons,
          timezone: "Africa/Cairo",
          active: true,
          watch: null,
          nextRunAt: new Date(nextRunAt),
        },
      ]);

      await changeUserTimezone(deps, "user-1", to);

      expect(rows[0]).toMatchObject({ timezone: to, crons, nextRunAt: new Date(moved) });
    },
  );

  it("moves only the zone label of an inactive routine", async () => {
    const { deps, rows } = account([
      {
        spaceId: base.spaceId,
        botId: base.botId,
        userId: base.userId,
        name: "Weekly",
        crons: ["0 9 * * 1"],
        timezone: "Africa/Cairo",
        active: false,
        watch: null,
        nextRunAt: null,
      },
    ]);

    await changeUserTimezone(deps, "user-1", "Europe/London");

    expect(rows[0]).toMatchObject({
      timezone: "Europe/London",
      crons: ["0 9 * * 1"],
      nextRunAt: null,
    });
  });

  it("moves nothing when the account had no saved zone", async () => {
    const { deps, rows, user } = account([
      {
        spaceId: base.spaceId,
        botId: base.botId,
        userId: base.userId,
        name: "Weekly",
        crons: ["0 9 * * 1"],
        timezone: "UTC",
        active: true,
        watch: null,
        nextRunAt: new Date("2026-11-09T09:00:00.000Z"),
      },
    ]);
    user.timezone = null;

    await changeUserTimezone(deps, "user-1", "Europe/London");

    expect(user.timezone).toBe("Europe/London");
    expect(rows[0]).toMatchObject({ timezone: "UTC" });
  });

  it("leaves the account as it was when the zone does not change", async () => {
    const { deps, rows, user } = account();
    await createScheduleFromTool(deps, {
      ...base,
      name: "Weekly",
      schedule: { cron: "0 9 * * 1" },
    });

    await changeUserTimezone(deps, "user-1", "Africa/Cairo");

    expect(user.timezone).toBe("Africa/Cairo");
    expect(rows[0]).toMatchObject({ timezone: "Africa/Cairo" });
  });

  it("writes the accompanying preference fields in the same save as the zone", async () => {
    const { deps, userUpdate } = account();
    await changeUserTimezone(deps, "user-1", "Europe/London", { locale: "pt-BR" });
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timezone: "Europe/London", locale: "pt-BR" },
    });
  });

  it("still writes accompanying fields when the zone itself does not change", async () => {
    const { deps, rows, userUpdate } = account();
    await changeUserTimezone(deps, "user-1", "Africa/Cairo", { locale: "pt-BR" });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { timezone: "Africa/Cairo", locale: "pt-BR" },
    });
    expect(rows).toHaveLength(0);
  });

  it("keeps the committed save when a wakeup enqueue fails, and tries the rest", async () => {
    const { deps, rows } = account([
      {
        spaceId: base.spaceId,
        botId: base.botId,
        userId: base.userId,
        name: "One",
        crons: ["0 9 * * 1"],
        timezone: "Africa/Cairo",
        active: true,
        watch: null,
        nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
      },
      {
        spaceId: base.spaceId,
        botId: base.botId,
        userId: base.userId,
        name: "Two",
        crons: ["0 9 * * 1"],
        timezone: "Africa/Cairo",
        active: true,
        watch: null,
        nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
      },
    ]);
    const jobs = deps.jobs as unknown as { enqueue: ReturnType<typeof vi.fn> };
    jobs.enqueue.mockImplementation(async (job: { payload: { routineId: string } }) => {
      if (job.payload.routineId === "routine-1") throw new Error("queue down");
    });

    await expect(changeUserTimezone(deps, "user-1", "Europe/London")).resolves.toBeUndefined();

    // Both wakeups were attempted and the move itself stands.
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    for (const row of rows) expect(row.timezone).toBe("Europe/London");
  });

  it("only clears the account when the zone is cleared; routines cannot hold no zone", async () => {
    const { deps, rows, user } = account();
    await createScheduleFromTool(deps, {
      ...base,
      name: "Weekly",
      schedule: { cron: "0 9 * * 1" },
    });

    await changeUserTimezone(deps, "user-1", null);

    expect(user.timezone).toBeNull();
    expect(rows[0]).toMatchObject({ timezone: "Africa/Cairo" });
  });
});
