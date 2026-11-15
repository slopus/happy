import { routineWakeupJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { preferenceTools } from "./run-tools-preferences.js";

function fakeAccount(ownerStartedRun = true, tainted = false, nextApprovedTool?: string) {
  const users = {
    starter: { timezone: "UTC" as string | null, marketingEmailOptOutAt: null as Date | null },
    other: { timezone: "UTC" as string | null, marketingEmailOptOutAt: null as Date | null },
  };
  type Id = keyof typeof users;
  const routines: Record<string, unknown>[] = [];
  const enqueue = vi.fn(async () => undefined);
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "in" in value
        ? (value.in as unknown[]).includes(row[key])
        : row[key] === value,
    );
  const userUpdate = vi.fn(async ({ where, data }: { where: { id: Id }; data: object }) => {
    const defined = Object.entries(data).filter(([, value]) => value !== undefined);
    Object.assign(users[where.id], Object.fromEntries(defined));
    return { ...users[where.id] };
  });
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: Id } }) => ({
        timezone: users[where.id].timezone,
      }),
      findUniqueOrThrow: async ({ where }: { where: { id: Id } }) => ({ ...users[where.id] }),
      update: userUpdate,
    },
    routine: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        routines.filter((row) => matches(row, where)),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const [index, row] of routines.entries()) {
          if (!matches(row, where)) continue;
          routines[index] = { ...row, ...data };
          count += 1;
        }
        return { count };
      },
    },
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(prisma),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("FOR SHARE")) return [{ timezone: users.starter.timezone }];
      if (sql.includes('"routines"')) {
        return routines
          .filter((row) => matches(row, { userId: values[0], timezone: values[1] }))
          .map((row) => ({ id: row.id }));
      }
      return [];
    },
  };
  const ctx = {
    deps: {
      prisma,
      jobs: { enqueue, cancel: async () => undefined },
    },
    run: { userId: "starter" },
    source: { ownerStartedRun },
    runId: "run-1",
    state: { tainted, earlierAttempt: Promise.resolve(false) },
    trust: { receivedOutsideMessage: async () => false },
  };
  const call = (args: Record<string, unknown>) =>
    preferenceTools.update_preferences!(
      ctx as never,
      {
        name: "update_preferences",
        args,
        executionId: "call-1",
        nextApprovedTool,
        finish: async (result: unknown) => result,
      } as never,
    );
  return { users, routines, enqueue, userUpdate, call };
}

describe("update_preferences", () => {
  it("reads the current values when called with no fields", async () => {
    const { call } = fakeAccount();
    await expect(call({})).resolves.toEqual({ timezone: "UTC", marketingEmails: true });
  });

  it("patches only the starter's own timezone and marketing emails", async () => {
    const { users, call } = fakeAccount();
    await expect(call({ timezone: "Europe/Berlin", marketingEmails: false })).resolves.toEqual({
      timezone: "Europe/Berlin",
      marketingEmails: false,
    });
    expect(users.starter.marketingEmailOptOutAt).toBeInstanceOf(Date);
    expect(users.other).toEqual({ timezone: "UTC", marketingEmailOptOutAt: null });
    await expect(call({ marketingEmails: true })).resolves.toEqual({
      timezone: "Europe/Berlin",
      marketingEmails: true,
    });
  });

  it("saves the timezone and the email preference in one write", async () => {
    const { users, userUpdate, call } = fakeAccount();
    await expect(call({ timezone: "Europe/Berlin", marketingEmails: false })).resolves.toEqual({
      timezone: "Europe/Berlin",
      marketingEmails: false,
    });
    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "starter" },
      data: { timezone: "Europe/Berlin", marketingEmailOptOutAt: expect.any(Date) },
    });
    expect(users.other).toEqual({ timezone: "UTC", marketingEmailOptOutAt: null });
  });

  it("moves routines that took the account zone to the new one", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-04T12:00:00.000Z") });
    try {
      const { users, routines, enqueue, call } = fakeAccount();
      users.starter.timezone = "Africa/Cairo";
      routines.push(
        {
          id: "routine-1",
          userId: "starter",
          crons: ["0 9 * * 1"],
          timezone: "Africa/Cairo",
          active: true,
          watch: null,
          nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
        },
        {
          id: "routine-2",
          userId: "starter",
          crons: ["0 9 * * 1"],
          timezone: "Asia/Tokyo",
          active: true,
          watch: null,
          nextRunAt: new Date("2026-11-09T00:00:00.000Z"),
        },
        {
          id: "routine-3",
          userId: "other",
          crons: ["0 9 * * 1"],
          timezone: "Africa/Cairo",
          active: true,
          watch: null,
          nextRunAt: new Date("2026-11-09T07:00:00.000Z"),
        },
      );

      await expect(call({ timezone: "Europe/London" })).resolves.toEqual({
        timezone: "Europe/London",
        marketingEmails: true,
      });

      // The starter's routine keeps Monday 09:00 in London; pinned and foreign routines stay.
      expect(routines[0]).toMatchObject({
        timezone: "Europe/London",
        nextRunAt: new Date("2026-11-09T09:00:00.000Z"),
      });
      expect(routines[1]).toMatchObject({ timezone: "Asia/Tokyo" });
      expect(routines[2]).toMatchObject({ timezone: "Africa/Cairo" });
      expect(users.other.timezone).toBe("UTC");
      expect(enqueue).toHaveBeenCalledWith(
        routineWakeupJob("routine-1", new Date("2026-11-09T09:00:00.000Z")),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unknown timezone and leaves the account as it was", async () => {
    const { users, call } = fakeAccount();
    await expect(call({ timezone: "Mars/Olympus" })).resolves.toEqual({
      error: "timezone: Unknown timezone",
    });
    await expect(call({ timezone: "+05:00" })).resolves.toHaveProperty("error");
    expect(users.starter.timezone).toBe("UTC");
  });

  it.each([
    { email: "new-address@example.test" },
    { password: "hunter2" },
    { deleteAccount: true },
    { autoReview: false },
  ])("refuses fields that stay in the app's settings: %o", async (args) => {
    const { users, call } = fakeAccount();
    const result = await call({ ...args, timezone: "Asia/Tokyo" });
    expect(result).toEqual({ error: expect.stringContaining(Object.keys(args)[0]!) });
    expect(users.starter.timezone).toBe("UTC");
  });

  it("refuses a run the user did not start", async () => {
    const { users, call } = fakeAccount(false);
    await expect(call({ timezone: "Asia/Tokyo" })).resolves.toHaveProperty("error");
    expect(users.starter.timezone).toBe("UTC");
  });

  it("reads but no longer writes once outside content entered the run", async () => {
    const { users, call } = fakeAccount(true, true);
    await expect(call({ marketingEmails: false })).resolves.toEqual({
      error: expect.stringContaining("outside content"),
    });
    expect(users.starter.marketingEmailOptOutAt).toBeNull();
    await expect(call({})).resolves.toEqual({ timezone: "UTC", marketingEmails: true });
  });

  it("ends the turn instead of repeating the outside-content refusal", async () => {
    const { users, call } = fakeAccount(true, true);
    await expect(call({ marketingEmails: false })).resolves.toEqual({
      error: expect.stringContaining("outside content"),
    });
    const repeat = await call({ marketingEmails: false });
    expect(repeat).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Settings"),
        },
      ],
    });
    expect(JSON.stringify(repeat)).not.toContain("outside content");
    expect(users.starter.marketingEmailOptOutAt).toBeNull();
  });

  it("applies a change the owner approved after outside content", async () => {
    const { users, call } = fakeAccount(true, true, "update_preferences");
    await expect(call({ timezone: "Asia/Tokyo" })).resolves.toMatchObject({
      timezone: "Asia/Tokyo",
    });
    expect(users.starter.timezone).toBe("Asia/Tokyo");
  });

  it("is offered only on runs the account owner started", () => {
    const offered = (trigger: string, followUpFromUser = false) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: trigger === "messaging",
        followUpFromUser,
      }).some((tool) => tool.name === "update_preferences");
    expect(offered("user")).toBe(true);
    expect(offered("call_end")).toBe(true);
    expect(offered("follow_up", true)).toBe(true);
    for (const trigger of [
      "follow_up",
      "routine",
      "bot_message",
      "messaging",
      "webhook",
      "spawn",
      "tickets",
      "created",
    ])
      expect(offered(trigger), trigger).toBe(false);
  });
});
