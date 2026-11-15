import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLoginSecret, RoutineWatchSchema } from "@rakazo/contracts";
import { installAuditEventStore } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountVault, fakeAuditLog, fakeDatabase } from "./bot-secrets.test-support.js";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import { protectedComputerLifecycleRefusal } from "./desktop-command-guard.js";
import type { RoutineWatchTickDeps } from "./routine-watch.js";
import {
  checkRoutineWatch,
  compareReading,
  describeEntryChanges,
  FILES_SCRIPT,
  parseRoutineWatch,
  readItems,
  resolveWatchPath,
  stableStringify,
  tickRoutineWatch,
  toolResultText,
  validateRoutineWatch,
  watchFolder,
} from "./routine-watch.js";

vi.mock("./computer-lifecycle.js", async (original) => ({
  ...(await original()),
  provisionComputer: vi.fn(),
}));
vi.mock("./computer-idle.js", () => ({ scheduleComputerSleep: vi.fn() }));

const NOW = new Date("2026-10-16T12:00:00.000Z");

describe("RoutineWatchSchema", () => {
  it("defaults to every 15 minutes, quiet", () => {
    const watch = RoutineWatchSchema.parse({ kind: "files", paths: ["inbox"] });
    expect(watch).toMatchObject({ everyMinutes: 15, loud: false });
  });

  it("needs the field its kind uses", () => {
    expect(RoutineWatchSchema.safeParse({ kind: "files" }).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ kind: "command" }).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ kind: "tool" }).success).toBe(false);
  });

  it("keeps integration checks to at most every 5 minutes", () => {
    const fast = { kind: "tool", tool: "brain_changed", everyMinutes: 1 };
    expect(RoutineWatchSchema.safeParse(fast).success).toBe(false);
    expect(RoutineWatchSchema.safeParse({ ...fast, everyMinutes: 5 }).success).toBe(true);
  });

  it("tracks items by up to five fields, identity first", () => {
    const tool = { kind: "tool", tool: "list_tasks", track: ["id", "date_updated"] };
    expect(RoutineWatchSchema.parse(tool).track).toEqual(["id", "date_updated"]);
    expect(RoutineWatchSchema.safeParse({ ...tool, track: [] }).success).toBe(false);
    expect(
      RoutineWatchSchema.safeParse({ kind: "files", paths: ["a"], track: ["id"] }).success,
    ).toBe(false);
  });

  it("reads an invalid stored watch as none rather than throwing", () => {
    expect(parseRoutineWatch({ kind: "nope" })).toBeNull();
    expect(parseRoutineWatch(null)).toBeNull();
  });
});

describe("compareReading", () => {
  const reading = { fingerprint: "b", detail: "new output" };

  it("records the first reading as a baseline and does not run", () => {
    expect(compareReading(null, reading, NOW)).toMatchObject({
      changed: false,
      state: { outcome: "baseline", fingerprint: "b" },
    });
  });

  it("does not run when the fingerprint is the same", () => {
    const previous = {
      checkedAt: "x",
      outcome: "unchanged" as const,
      fingerprint: "b",
      detail: null,
    };
    expect(compareReading(previous, reading, NOW)).toMatchObject({
      changed: false,
      state: { outcome: "unchanged" },
    });
  });

  it("runs, with the reading's detail, when it differs", () => {
    const previous = {
      checkedAt: "x",
      outcome: "unchanged" as const,
      fingerprint: "a",
      detail: null,
    };
    expect(compareReading(previous, reading, NOW)).toMatchObject({
      changed: true,
      state: { outcome: "changed", detail: "new output" },
    });
  });

  it("compares against the last good fingerprint after a failed check", () => {
    const failed = { checkedAt: "x", outcome: "failed" as const, fingerprint: "b", detail: "boom" };
    expect(compareReading(failed, reading, NOW).changed).toBe(false);
  });
});

describe("describeEntryChanges", () => {
  it("names what was added, edited and removed", () => {
    const text = describeEntryChanges(
      { "a.txt": "1:1", "b.txt": "1:1", "c.txt": "1:1" },
      { "a.txt": "1:1", "b.txt": "2:2", "d.txt": "1:1" },
    );
    expect(text).toBe("New: d.txt\nEdited: b.txt\nRemoved: c.txt");
  });
});

describe("stableStringify", () => {
  it("ignores key order", () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});

describe("tickRoutineWatch", () => {
  const scheduledAt = new Date(Date.now() - 1_000);
  const target = { threadId: "thread-1", botId: "bot-1" };

  function setup(result: { data?: unknown; error?: string }, watch: Record<string, unknown> = {}) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const messages: Array<{ role: string; blocks: unknown }> = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      thread: { update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })) },
      message: {
        create: vi.fn(async ({ data }: { data: { role: string; blocks: unknown } }) => {
          messages.push(data);
          return { id: "m1", ...data };
        }),
      },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const deps = {
      prisma: {
        routine: { updateMany },
        connection: { findMany: vi.fn(async () => []) },
        spaceSettingOverride: { findUnique: vi.fn(async () => null) },
        actionApprovalRule: { findMany: vi.fn(async () => []) },
        userActionApprovalRule: { findMany: vi.fn(async () => []) },
        bot: {
          findUnique: vi.fn(async () => ({
            id: "bot-1",
            computer: { id: "computer-1", scope: "team", kind: "vm" },
          })),
        },
        $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      connector: {
        discoverTools: vi.fn(async () => [
          { name: "brain_changed", readOnly: true, route: { connectorId: "installed" } },
        ]),
        execute: vi.fn(async function* () {
          if (result.error) yield { type: "error", message: result.error };
          else yield { type: "result", data: result.data };
        }),
      },
    } as unknown as RoutineWatchTickDeps;
    const routine = {
      id: "routine-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      name: "Brain check",
      watch: { kind: "tool", tool: "brain_changed", args: { limit: 1 }, ...watch },
      watchState: {
        checkedAt: "x",
        outcome: "unchanged",
        fingerprint: null as string | null,
        detail: null,
      },
    };
    return { deps, routine, updateMany, messages };
  }

  it("reschedules temporary HTTP failures at the watch interval without disabling it", async () => {
    const { deps, routine, updateMany, messages } = setup(
      {},
      { kind: "http", url: "https://example.com/status", everyMinutes: 5 },
    );
    deps.http = {
      fetch: async () => new Response("temporary outage", { status: 503 }),
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    };
    routine.watchState.fingerprint = "last-known";
    const before = Date.now();
    expect(await tickRoutineWatch(deps, routine, target, scheduledAt)).toEqual({ run: false });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: routine.id, userId: routine.userId, active: true, nextRunAt: scheduledAt },
      data: {
        nextRunAt: expect.any(Date),
        watchState: {
          checkedAt: expect.any(String),
          outcome: "failed",
          retrying: true,
          fingerprint: "last-known",
          detail: "HTTPS check returned status 503.",
        },
      },
    });
    const saved = (
      updateMany.mock.calls[0] as unknown as [
        {
          data: {
            nextRunAt: Date;
            watchState: {
              checkedAt: string;
              outcome: "failed";
              fingerprint: string;
              detail: string;
            };
          };
        },
      ]
    )[0].data;
    const retry = saved.nextRunAt;
    expect(retry.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(retry.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("HTTPS check returned status 503.");
    expect(messages[0]?.role).toBe("system");
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ availableAt: retry }));
    expect(new Date(saved.watchState.checkedAt).getTime()).toBeGreaterThanOrEqual(before);
    // A continuing outage refreshes failure state without another thread notice.
    await tickRoutineWatch(deps, { ...routine, watchState: saved.watchState }, target, new Date());
    expect(messages).toHaveLength(1);
    deps.http.fetch = async () => new Response("ready");
    const recovered = await tickRoutineWatch(
      deps,
      { ...routine, watchState: saved.watchState },
      target,
      new Date(),
    );
    expect(recovered).toMatchObject({ run: true, state: { outcome: "changed", detail: null } });
    if (recovered.run) expect(recovered.state).not.toHaveProperty("retrying");
  });

  it("announces an HTTP outage after a permanently paused watch is resumed", async () => {
    const { deps, routine, updateMany, messages } = setup(
      {},
      {
        kind: "http",
        url: "https://example.com/status",
        everyMinutes: 5,
      },
    );
    deps.http = {
      fetch: async () => new Response("not found", { status: 404 }),
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
    };
    routine.watchState.fingerprint = "last-known";
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    const paused = (
      updateMany.mock.calls[0] as unknown as [
        {
          data: { active: boolean; watchState: unknown };
        },
      ]
    )[0].data;
    expect(paused.active).toBe(false);
    expect(paused.watchState).not.toHaveProperty("retrying");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("bot");
    // Resuming retains the previous state. A new temporary outage still needs a notice.
    deps.http.fetch = async () => new Response("temporary outage", { status: 503 });
    await tickRoutineWatch(deps, { ...routine, watchState: paused.watchState }, target, new Date());
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("system");
    expect(JSON.stringify(messages[1])).toContain("HTTPS check returned status 503.");
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          watchState: expect.objectContaining({
            outcome: "failed",
            retrying: true,
            fingerprint: "last-known",
          }),
        }),
      }),
    );
  });

  it("records a quiet no-change check without a message and schedules the next", async () => {
    const { deps, routine, updateMany, messages } = setup({ data: { changes: [] } });
    // First reading is the baseline.
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    const baseline = (
      updateMany.mock.calls[0] as unknown as [
        { data: { watchState: { checkedAt: string; fingerprint: string } } },
      ]
    )[0].data.watchState;
    routine.watchState = { ...baseline, outcome: "unchanged", detail: null };

    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick).toEqual({ run: false });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          watchState: expect.objectContaining({ outcome: "unchanged" }),
        }),
      }),
    );
    expect(deps.jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(0);
  });

  it("saves a check only for the owner it started with", async () => {
    const { deps, routine, updateMany } = setup({ data: { changes: [] } });
    // Someone else taking the routine over mid-check makes this write miss.
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(tickRoutineWatch(deps, routine, target, scheduledAt)).resolves.toEqual({
      run: false,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: routine.id, userId: "user-1", active: true, nextRunAt: scheduledAt },
      }),
    );
  });

  it("posts 'no changes' when loud", async () => {
    const { deps, routine, updateMany, messages } = setup(
      { data: { changes: [] } },
      { loud: true },
    );
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    const baseline = (
      updateMany.mock.calls[0] as unknown as [
        { data: { watchState: { checkedAt: string; fingerprint: string } } },
      ]
    )[0].data.watchState;
    routine.watchState = { ...baseline, outcome: "unchanged", detail: null };
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(messages.at(-1)).toMatchObject({
      role: "system",
      blocks: [{ kind: "meta", text: "Brain check routine: no changes" }],
    });
  });

  it.each([false, undefined])(
    "refuses a tool with readOnly %s without executing it",
    async (readOnly) => {
      const { deps, routine } = setup({ data: "ok" });
      vi.mocked(deps.connector!.discoverTools).mockResolvedValue([
        { name: "brain_changed", readOnly, description: "Read changes", inputSchema: {} },
      ]);
      await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("can change data");
      expect(deps.connector!.execute).not.toHaveBeenCalled();
      await expect(
        validateRoutineWatch(deps, RoutineWatchSchema.parse(routine.watch), routine),
      ).rejects.toThrow("can change data");
    },
  );

  it("refuses a batch tool even when it is declared read-only", async () => {
    const { deps, routine } = setup({ data: "ok" });
    vi.mocked(deps.connector!.discoverTools).mockResolvedValue([
      {
        name: "brain_changed",
        readOnly: true,
        batch: { items: "tools", action: "tool_slug", arguments: "arguments" },
        description: "Run actions",
        inputSchema: {},
      },
    ]);
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("can change data");
    expect(deps.connector!.execute).not.toHaveBeenCalled();
    await expect(
      validateRoutineWatch(deps, RoutineWatchSchema.parse(routine.watch), routine),
    ).rejects.toThrow("can change data");
  });

  it.each([false, undefined, true])("checks lazy tool readOnly %s", async (readOnly) => {
    const { deps, routine } = setup({ data: "ok" });
    vi.mocked(deps.connector!.discoverTools).mockResolvedValue([]);
    deps.connector!.resolveCall = vi.fn(async (call) => ({
      call,
      tool: { name: call.tool, readOnly, description: "Read changes", inputSchema: {} },
    }));
    if (readOnly)
      await expect(checkRoutineWatch(deps, routine)).resolves.toMatchObject({ changed: false });
    else await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("can change data");
    expect(deps.connector!.execute).toHaveBeenCalledTimes(readOnly ? 1 : 0);
  });

  it("runs the tool call on a fresh time budget when discovery used up its own", async () => {
    const { deps, routine } = setup({ data: "ok" });
    const budgets: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const budget = new AbortController();
      budgets.push(budget);
      return budget.signal;
    });
    try {
      vi.mocked(deps.connector!.discoverTools).mockImplementation(async (ctx) => {
        budgets.find((budget) => budget.signal === ctx.signal)!.abort();
        return [{ name: "brain_changed", readOnly: true, description: "Read", inputSchema: {} }];
      });
      let callSignal: AbortSignal | undefined;
      vi.mocked(deps.connector!.execute).mockImplementation(async function* (_call, ctx) {
        callSignal = ctx.signal;
        yield { type: "result", data: "ok" };
      });
      await expect(checkRoutineWatch(deps, routine)).resolves.toMatchObject({ changed: false });
      expect(callSignal?.aborted).toBe(false);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([{ isError: true, content: [{ type: "text", text: "failed" }] }, { error: "failed" }])(
    "rejects error result envelopes",
    async (data) => {
      const { deps, routine } = setup({ data });
      await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("failed");
    },
  );

  it("keeps the structured data in a change note beside supplemental text", async () => {
    // The duplicate text was dropped on the way in, so the reader must not let
    // the leftover note replace the data that triggered the routine.
    const { deps, routine } = setup({
      data: {
        content: [{ type: "text", text: "Query completed." }],
        structuredContent: { changes: [{ what: "add test note", at: "2026-11-01T09:30:00Z" }] },
        isError: false,
      },
    });
    routine.watchState = { checkedAt: "x", outcome: "unchanged", fingerprint: "old", detail: null };
    const result = await checkRoutineWatch(deps, routine);
    expect(result.state.detail).toContain("Query completed.");
    expect(result.state.detail).toContain("add test note");
  });

  it.each([new ComputerBusyError(), new DOMException("timed out", "TimeoutError")])(
    "retries temporary provisioning conflicts without losing the baseline",
    async (error) => {
      const { deps, routine, updateMany, messages } = setup({});
      routine.watch = { kind: "files", paths: ["inbox"] } as unknown as typeof routine.watch;
      vi.mocked(provisionComputer).mockRejectedValueOnce(error);
      await tickRoutineWatch(deps, routine, target, scheduledAt);
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { nextRunAt: expect.any(Date) } }),
      );
      expect(deps.jobs.enqueue).toHaveBeenCalledOnce();
      expect(deps.jobs.cancel).not.toHaveBeenCalled();
      expect(messages).toEqual([]);
    },
  );

  it("applies approval rules to the real tool behind a lazy catalog call", async () => {
    const { deps, routine } = setup({ data: "ok" });
    vi.mocked(deps.connector!.discoverTools).mockResolvedValue([]);
    deps.connector!.resolveCall = vi.fn(async (call) => ({
      call,
      tool: { name: "actual_read", readOnly: true, description: "Read", inputSchema: {} },
    }));
    vi.mocked(deps.prisma.userActionApprovalRule.findMany).mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "actual_read" },
    ] as never);
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("needs approval");
    expect(deps.connector!.execute).not.toHaveBeenCalled();
  });

  it("refuses under the Space's own rules when it overrides the account's", async () => {
    const { deps, routine } = setup({ data: "ok" });
    vi.mocked(deps.connector!.discoverTools).mockResolvedValue([]);
    deps.connector!.resolveCall = vi.fn(async (call) => ({
      call,
      tool: { name: "actual_read", readOnly: true, description: "Read", inputSchema: {} },
    }));
    vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
      setting: "confirmations",
    } as never);
    vi.mocked(deps.prisma.actionApprovalRule.findMany).mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "actual_read" },
    ] as never);
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("needs approval");
    expect(deps.prisma.userActionApprovalRule.findMany).not.toHaveBeenCalled();
  });

  it("keeps sub-second modification times in file signatures", async () => {
    const { deps, routine } = setup({});
    routine.watch = { kind: "files", paths: ["inbox"] } as unknown as typeof routine.watch;
    vi.mocked(provisionComputer).mockResolvedValue({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    let mtime = "1.123";
    deps.sandbox = {
      execute: vi.fn(async function* () {
        yield { type: "stdout", data: `inbox/note.txt\t3\t${mtime}\n` };
        yield { type: "exit", code: 0 };
      }),
    } as unknown as typeof deps.sandbox;
    const baseline = await checkRoutineWatch(deps, routine);
    routine.watchState = baseline.state as typeof routine.watchState;
    mtime = "1.456";
    expect((await checkRoutineWatch(deps, routine)).changed).toBe(true);
  });

  it("runs with a note of what changed", async () => {
    const { deps, routine } = setup({ data: { changes: [{ path: "Facts/new.md" }] } });
    routine.watchState.fingerprint = "old";
    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick.run).toBe(true);
    if (!tick.run) return;
    expect(tick.note).toContain("What changed since the last check");
    expect(tick.note).toContain("Facts/new.md");
    expect(tick.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("pauses the routine and has the bot say why when the check fails", async () => {
    const { deps, routine, updateMany, messages } = setup({ error: "401 unauthorized" });
    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick).toEqual({ run: false });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ active: false, nextRunAt: null }),
      }),
    );
    expect(deps.jobs.cancel).toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "bot" });
    expect(JSON.stringify(messages[0]?.blocks)).toContain("401 unauthorized");
  });
});

describe("tool results", () => {
  it.each([
    [
      "its text",
      { content: [{ type: "text", text: "limit must be a number" }], isError: true },
      /limit must be a number/,
    ],
    [
      "structured diagnostics when the text is blank",
      {
        content: [{ type: "text", text: "" }],
        structuredContent: { error: "Permission denied" },
        isError: true,
      },
      /Permission denied/,
    ],
    [
      "structured diagnostics the short text does not repeat",
      {
        content: [{ type: "text", text: "Request failed" }],
        structuredContent: { error: "Permission denied", requiredScope: "reports:read" },
        isError: true,
      },
      /Request failed[\s\S]*reports:read/,
    ],
    [
      "a numeric diagnostic whose digits happen to appear in the text",
      {
        content: [{ type: "text", text: "Service returned HTTP 503" }],
        structuredContent: { error: "Service returned HTTP 503", retryAfterSeconds: 3 },
        isError: true,
      },
      /retryAfterSeconds/,
    ],
    [
      "a text diagnostic whose value happens to appear in the text",
      {
        content: [{ type: "text", text: "Permission denied while reading repository" }],
        structuredContent: {
          error: "Permission denied while reading repository",
          requiredScope: "repo",
        },
        isError: true,
      },
      /requiredScope/,
    ],
  ])(
    "treats an MCP error result as a failed check that reports %s",
    async (_case, data, reported) => {
      const deps = {
        prisma: {
          connection: { findMany: vi.fn(async () => []) },
          spaceSettingOverride: { findUnique: vi.fn(async () => null) },
          actionApprovalRule: { findMany: vi.fn(async () => []) },
          userActionApprovalRule: { findMany: vi.fn(async () => []) },
        },
        connector: {
          discoverTools: vi.fn(async () => [
            { name: "brain_changed", readOnly: true, route: { connectorId: "installed" } },
          ]),
          execute: vi.fn(async function* () {
            yield { type: "result", data };
          }),
        },
      } as unknown as RoutineWatchTickDeps;
      const routine = {
        id: "r",
        spaceId: "s",
        userId: "u",
        botId: "b",
        watch: { kind: "tool", tool: "brain_changed", args: {} },
        watchState: null,
      };
      await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(reported);
    },
  );
});

describe("tickRoutineWatch on a computer", () => {
  const scheduledAt = new Date(Date.now() - 1_000);
  const target = { threadId: "thread-1", botId: "bot-1" };

  function setupComputer(
    watch: Record<string, unknown>,
    exec: { stdout?: string; stderr?: string; code?: number } = {},
    computer = { id: "computer-1", scope: "team", kind: "vm" },
    options?: {
      vault?: ReturnType<typeof fakeDatabase>;
      secretStore?: { load(ciphertext: string, recordId: string): Promise<string> };
      shell?: { platform: string; shell: string; home: string };
    },
  ) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const messages: unknown[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
      thread: { update: vi.fn(async () => ({ nextMessageSeq: 1, nextEventSeq: 1 })) },
      message: {
        create: vi.fn(async ({ data }: { data: unknown }) => {
          messages.push(data);
          return { id: "m1", ...(data as object) };
        }),
      },
      event: { create: vi.fn(async () => ({ seq: 1 })) },
    };
    const execute = vi.fn(async function* () {
      if (exec.stdout) yield { type: "stdout", data: exec.stdout };
      if (exec.stderr) yield { type: "stderr", data: exec.stderr };
      yield { type: "exit", code: exec.code ?? 0 };
    });
    const environment = options?.shell ? vi.fn(async () => options.shell) : undefined;
    const deps = {
      prisma: {
        routine: { updateMany },
        bot: {
          findUnique: vi.fn(async () => ({
            id: "bot-1",
            computer,
          })),
        },
        $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
        ...(options?.vault
          ? {
              vaultCredential: options.vault.prisma.vaultCredential,
              spaceSettingOverride: options.vault.prisma.spaceSettingOverride,
            }
          : {}),
      },
      ...(options?.secretStore ? { secretStore: options.secretStore } : {}),
      sandbox: {
        execute,
        describe: () => ({ capabilities: { graphical: true } }),
        ...(environment ? { environment } : {}),
      },
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
      commandRefusal: (command: string) =>
        command.includes("pkill") ? "protected command pkill" : undefined,
    } as unknown as RoutineWatchTickDeps;
    const routine = {
      id: "routine-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      name: "Inbox watch",
      watch,
      watchState: { checkedAt: "x", outcome: "unchanged", fingerprint: "old", detail: null },
    };
    return { deps, routine, updateMany, messages, execute, environment };
  }

  it.each(["team", "dedicated"])("checks files in a %s desktop workspace", async (scope) => {
    const computer = {
      id: "desktop-computer-1",
      botId: "computer-home",
      kind: "desktop" as const,
      providerRef: "/tmp/watch-fixture/desktop-computers/computer-home",
    };
    vi.mocked(provisionComputer).mockResolvedValueOnce(computer);
    const { deps, routine, execute } = setupComputer(
      { kind: "files", paths: ["inbox/"] },
      { stdout: "inbox/note.txt\t3\t1.25\n" },
      { id: "computer-1", scope, kind: "desktop" },
    );
    const result = await checkRoutineWatch(deps, routine);
    expect(result.state.entries).toEqual({ "inbox/note.txt": "3:1.25" });
    expect(execute).toHaveBeenCalledWith(
      computer,
      {
        argv: ["sh", "-c", FILES_SCRIPT, "watch", scope === "team" ? "." : "", "./inbox"],
        cwd: scope === "team" ? "bots/bot-1" : undefined,
        timeoutMs: 60_000,
      },
      expect.anything(),
    );
  });

  it("passes a folder named like an option as a path", async () => {
    const { deps, routine, execute } = setupComputer(
      { kind: "files", paths: ["-reports"] },
      { stdout: "./-reports/q3.md\t3\t1.25\n" },
    );
    const result = await checkRoutineWatch(deps, routine);
    expect(result.state.entries).toEqual({ "-reports/q3.md": "3:1.25" });
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ argv: expect.arrayContaining(["./-reports"]) }),
      expect.anything(),
    );
  });

  it("runs a team desktop command in the provider-relative bot folder", async () => {
    const computer = {
      id: "desktop-computer-1",
      botId: "computer-home",
      kind: "desktop" as const,
      providerRef: "/tmp/watch-fixture/desktop-computers/computer-home",
    };
    vi.mocked(provisionComputer).mockResolvedValueOnce(computer);
    const { deps, routine, execute } = setupComputer(
      { kind: "command", command: "ls inbox" },
      { stdout: "note.txt\n" },
      { id: "computer-1", scope: "team", kind: "desktop" },
    );
    expect((await checkRoutineWatch(deps, routine)).state.detail).toBe("note.txt");
    expect(execute).toHaveBeenCalledWith(
      computer,
      { argv: ["sh", "-lc", "ls inbox"], cwd: "bots/bot-1", timeoutMs: 60_000 },
      expect.anything(),
    );
  });

  it("gives a command watch the vault's command credentials", async () => {
    const secret = "ghp_fakefakeRoutineWatchToken";
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "gh-token",
        ...accountVault,
        name: "gh-token",
        origin: "",
        auth: { type: "command" },
        ciphertext: "cipher-gh",
      },
    });
    await vault.prisma.vaultCredential.create({
      data: {
        id: "stripe-api-key",
        ...accountVault,
        name: "stripe-api-key",
        origin: "",
        auth: { type: "command" },
        ciphertext: "cipher-stripe",
      },
    });
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine, execute, environment } = setupComputer(
      { kind: "command", command: "gh api user" },
      { stdout: "ok\n" },
      { id: "computer-1", scope: "team", kind: "vm" },
      {
        vault,
        secretStore: {
          async load(ciphertext) {
            if (ciphertext === "cipher-gh") return secret;
            throw new Error("unreadable");
          },
        },
        // Present on purpose: a vm must not switch to this shell.
        shell: { platform: "win32", shell: "powershell.exe", home: "C:\\Users\\rakazo" },
      },
    );
    await checkRoutineWatch(deps, routine);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      {
        argv: ["sh", "-lc", "gh api user"],
        cwd: "bots/bot-1",
        timeoutMs: 60_000,
        env: { GH_TOKEN: secret },
        unsetEnv: ["STRIPE_API_KEY"],
      },
      expect.anything(),
    );
    expect(environment).not.toHaveBeenCalled();
  });

  it("does not read the vault when watching files", async () => {
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "gh-token",
        ...accountVault,
        name: "gh-token",
        origin: "",
        auth: { type: "command" },
        ciphertext: "cipher-gh",
      },
    });
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine, execute } = setupComputer(
      { kind: "files", paths: ["inbox"] },
      { stdout: "inbox/note.txt\t3\t1.25\n" },
      { id: "computer-1", scope: "team", kind: "vm" },
      {
        vault,
        secretStore: {
          async load() {
            return "ghp_fakefakeRoutineWatchToken";
          },
        },
      },
    );
    const result = await checkRoutineWatch(deps, routine);
    expect(result.state.entries).toEqual({ "inbox/note.txt": "3:1.25" });
    expect(vault.prisma.vaultCredential.findMany).not.toHaveBeenCalled();
    expect(vault.prisma.spaceSettingOverride.findUnique).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ env: expect.anything() }),
      expect.anything(),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ unsetEnv: expect.anything() }),
      expect.anything(),
    );
  });

  it("scrubs vault secrets from command output before the routine can see them", async () => {
    const secret = "ghp_fakefakeRoutineWatchToken";
    const encoded = Buffer.from(secret).toString("base64");
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "gh-token",
        ...accountVault,
        name: "gh-token",
        origin: "",
        auth: { type: "command" },
        ciphertext: "cipher-gh",
      },
    });
    const secretStore = {
      async load(ciphertext: string) {
        if (ciphertext === "cipher-gh") return secret;
        throw new Error("unreadable");
      },
    };
    const line = `[{"id":"1","title":"Issue ${secret}","state":"${encoded}"}]`;
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const watched = setupComputer(
      { kind: "command", command: "gh issue list", track: ["id", "state"] },
      { stdout: `${line}\n` },
      undefined,
      { vault, secretStore },
    );
    watched.routine.watchState = {
      checkedAt: "x",
      outcome: "unchanged",
      fingerprint: "old",
      entries: {},
      detail: null,
    } as never;
    const result = await checkRoutineWatch(watched.deps, watched.routine);
    const scrubbed = `${line.replaceAll(secret, "[redacted]").replaceAll(encoded, "[redacted]")}\n`;
    expect(result.state.detail).toBe("New: Issue [redacted]");
    expect(result.state.fingerprint).toBe(readItems(scrubbed, ["id", "state"]).fingerprint);
    expect(JSON.stringify(result.state)).not.toContain(secret);
    expect(JSON.stringify(result.state)).not.toContain(encoded);
    expect(result.state.entries?.["1"]).toContain("[redacted]");

    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const failed = setupComputer(
      { kind: "command", command: "gh issue list" },
      { stderr: `auth failed: ${secret}`, code: 1 },
      undefined,
      { vault, secretStore },
    );
    await tickRoutineWatch(failed.deps, failed.routine, target, scheduledAt);
    const saved = (
      failed.updateMany.mock.calls[0] as unknown as [{ data: { watchState: { detail: string } } }]
    )[0].data.watchState.detail;
    expect(saved).toBe("The check command exited with 1: auth failed: [redacted]");
    expect(JSON.stringify(failed.messages)).toContain("auth failed: [redacted]");
    expect(JSON.stringify(failed.messages)).not.toContain(secret);
    expect(saved).not.toContain(secret);
  });

  it("hides saved logins' hidden fields and recent card numbers in command output, as runs do", async () => {
    const password = "fake-watch-password-1";
    const card = "4242 4242 4242 4242";
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "site-login",
        ...accountVault,
        name: "site_login",
        origin: "https://login.example.test",
        auth: { type: "login" },
        ciphertext: "cipher-login",
      },
    });
    const secretStore = {
      async load(ciphertext: string) {
        if (ciphertext === "cipher-card") return card;
        if (ciphertext !== "cipher-login") throw new Error("unreadable");
        return encodeLoginSecret({
          fields: [
            { label: "Username", value: "watcher@example.test", hidden: false },
            { label: "Password", value: password, hidden: true },
          ],
        });
      },
    };
    const withPurchases = (deps: RoutineWatchTickDeps) => {
      Object.assign(deps, { paymentWallet: {} });
      Object.assign(deps.prisma, {
        purchase: {
          // Only this bot's own purchases, as for its runs.
          findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
            where.spaceId === "space-1" && where.userId === "user-1" && where.botId === "bot-1"
              ? [{ id: "purchase-1", cardCiphertext: "cipher-card", tokenCiphertext: null }]
              : [],
          ),
        },
      });
    };
    const output = `Signed in as watcher@example.test with ${password}, paid with ${card.replaceAll(" ", "")} and ${card.replaceAll(" ", "-")}`;

    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const changed = setupComputer(
      { kind: "command", command: "check-order" },
      { stdout: output },
      undefined,
      { vault, secretStore },
    );
    withPurchases(changed.deps);
    const tick = await tickRoutineWatch(changed.deps, changed.routine, target, scheduledAt);
    if (!tick.run) throw new Error("expected a run");
    expect(tick.note).toContain(
      "Signed in as watcher@example.test with [redacted], paid with [redacted] and [redacted]",
    );
    expect(tick.note).not.toContain(password);
    expect(tick.note).not.toContain("4242424242424242");
    expect(tick.note).not.toContain("4242-4242-4242-4242");

    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const failed = setupComputer(
      { kind: "command", command: "check-order" },
      { stderr: output, code: 1 },
      undefined,
      { vault, secretStore },
    );
    withPurchases(failed.deps);
    await tickRoutineWatch(failed.deps, failed.routine, target, scheduledAt);
    const posted = JSON.stringify(failed.messages);
    expect(posted).toContain(
      "Signed in as watcher@example.test with [redacted], paid with [redacted] and [redacted]",
    );
    expect(posted).not.toContain(password);
    expect(posted).not.toContain("4242424242424242");
    expect(posted).not.toContain("4242-4242-4242-4242");

    // An item saved before its value was hidden is named from the last reading when it goes.
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const tracked = setupComputer(
      { kind: "command", command: "list-orders", track: ["id"] },
      { stdout: '[{"id":"8","title":"Order 8"}]' },
      undefined,
      { vault, secretStore },
    );
    withPurchases(tracked.deps);
    tracked.routine.watchState = {
      checkedAt: "x",
      outcome: "unchanged",
      fingerprint: "old",
      entries: readItems([{ id: "7", title: `Reset ${password}` }], ["id"]).entries,
      detail: null,
    } as never;
    const gone = await tickRoutineWatch(tracked.deps, tracked.routine, target, scheduledAt);
    if (!gone.run) throw new Error("expected a run");
    expect(gone.note).toContain("New: Order 8\nGone: Reset [redacted]");
    expect(gone.note).not.toContain(password);
  });

  it("retries a command check, not pauses it, while the key manager is down", async () => {
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "site-login",
        ...accountVault,
        name: "site_login",
        origin: "https://login.example.test",
        auth: { type: "login" },
        ciphertext: "rkz1:vault-key:sealed",
      },
    });
    vi.mocked(provisionComputer).mockClear();
    const { deps, routine, updateMany, messages, execute } = setupComputer(
      { kind: "command", command: "check-order" },
      { stdout: "ok" },
      undefined,
      { vault, secretStore: { load: async () => "unused" } },
    );
    // The login is under a vault key the key manager can't unwrap right now.
    const outage = () => Promise.reject(new Error("fake key manager outage"));
    Object.assign(deps.prisma, {
      $contentEncryption: () => ({ ring: { byId: outage, all: outage } }),
      spaceKey: { findUnique: async () => ({ id: "key" }) },
    });
    const warn = vi.spyOn(Logging.getLogger(), "warn");
    try {
      expect(await tickRoutineWatch(deps, routine, target, scheduledAt)).toEqual({ run: false });
      // Said in the log each time, naming the routine and the key manager's reason, but no value.
      expect(warn).toHaveBeenCalledWith("routine.watch_deferred", {
        "routine.id": "routine-1",
        error: expect.any(Error),
      });
      expect(Logging.serializeError(warn.mock.calls[0]![1]!.error)).toMatchObject({
        name: "VaultKeyUnavailableError",
        cause: { name: "Error", message: "fake key manager outage" },
      });
    } finally {
      warn.mockRestore();
    }
    expect(execute).not.toHaveBeenCalled();
    // Deferred before the computer is woken for it.
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "routine-1", userId: "user-1", active: true, nextRunAt: scheduledAt },
      data: { nextRunAt: expect.any(Date) },
    });
    expect(deps.jobs.enqueue).toHaveBeenCalled();
  });

  it("retries a command check whose command variable can't be loaded while the key manager is down", async () => {
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "gh-token",
        ...accountVault,
        name: "gh_token",
        origin: "",
        auth: { type: "command" },
        ciphertext: "rkz1:vault-key:sealed",
      },
    });
    vi.mocked(provisionComputer).mockClear();
    const { deps, routine, updateMany, messages, execute } = setupComputer(
      { kind: "command", command: "check-order" },
      { stdout: "ok" },
      undefined,
      { vault, secretStore: { load: async () => "unused" } },
    );
    // The variable is under a vault key the key manager can't unwrap right now.
    const outage = () => Promise.reject(new Error("fake key manager outage"));
    Object.assign(deps.prisma, {
      $contentEncryption: () => ({ ring: { byId: outage, all: outage } }),
      spaceKey: { findUnique: async () => ({ id: "key" }) },
    });
    const warn = vi.spyOn(Logging.getLogger(), "warn");
    try {
      expect(await tickRoutineWatch(deps, routine, target, scheduledAt)).toEqual({ run: false });
      // Deferred for the outage itself, not for some other error on the way.
      expect(warn).toHaveBeenCalledWith("routine.watch_deferred", {
        "routine.id": "routine-1",
        error: expect.any(Error),
      });
      expect(
        Logging.serializeError(
          warn.mock.calls.find(([event]) => event === "routine.watch_deferred")![1]!.error,
        ),
      ).toMatchObject({
        name: "VaultKeyUnavailableError",
        cause: { name: "Error", message: "fake key manager outage" },
      });
    } finally {
      warn.mockRestore();
    }
    expect(execute).not.toHaveBeenCalled();
    // Deferred before the computer is woken for it.
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "routine-1", userId: "user-1", active: true, nextRunAt: scheduledAt },
      data: { nextRunAt: expect.any(Date) },
    });
    expect(deps.jobs.enqueue).toHaveBeenCalled();
  });

  it("scrubs a quote and backslash inside tracked command JSON", async () => {
    const secret = 'ghp_quote"slash\\secretToken';
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "gh-token",
        ...accountVault,
        name: "gh-token",
        origin: "",
        auth: { type: "command" },
        ciphertext: "cipher-gh",
      },
    });
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine } = setupComputer(
      { kind: "command", command: "gh issue list --json", track: ["id", "status"] },
      {
        stdout: JSON.stringify([{ id: "1", title: `Issue ${secret}`, status: secret }]),
      },
      undefined,
      {
        vault,
        secretStore: {
          async load(ciphertext: string) {
            if (ciphertext === "cipher-gh") return secret;
            throw new Error("unreadable");
          },
        },
      },
    );
    routine.watchState = {
      checkedAt: "x",
      outcome: "unchanged",
      fingerprint: "old",
      entries: {},
      detail: null,
    } as never;
    const result = await checkRoutineWatch(deps, routine);
    expect(result.state.detail).toBe("New: Issue [redacted]");
    const entry = result.state.entries?.["1"];
    expect(entry).toContain("[redacted]");
    expect(entry).not.toContain("ghp_quote");
    expect(result.state.detail).not.toContain(secret);
    expect(JSON.stringify(result.state)).not.toContain("ghp_quote");
  });

  it("tracks command JSON that contains a content array", async () => {
    const secret = 'ghp_quote"slash\\secretToken';
    const vault = fakeDatabase();
    await vault.prisma.vaultCredential.create({
      data: {
        id: "gh-token",
        ...accountVault,
        name: "gh-token",
        origin: "",
        auth: { type: "command" },
        ciphertext: "cipher-gh",
      },
    });
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine, updateMany, messages } = setupComputer(
      { kind: "command", command: "cat doc.json", track: ["id"] },
      {
        stdout: JSON.stringify({
          id: "doc-1",
          title: `Note ${secret}`,
          content: [{ type: "text", text: "Hello" }],
        }),
      },
      undefined,
      {
        vault,
        secretStore: {
          async load(ciphertext: string) {
            if (ciphertext === "cipher-gh") return secret;
            throw new Error("unreadable");
          },
        },
      },
    );
    routine.watchState = {
      checkedAt: "x",
      outcome: "unchanged",
      fingerprint: "old",
      entries: {},
      detail: null,
    } as never;
    const tick = await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(tick.run).toBe(true);
    if (!tick.run) return;
    expect(tick.state.entries).toHaveProperty("doc-1");
    expect(tick.state.detail).toBe("New: Note [redacted]");
    expect(tick.state.detail).not.toContain(secret);
    expect(JSON.stringify(tick.state)).not.toContain("ghp_quote");
    expect(updateMany).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).not.toContain("paused");
  });

  it("runs a desktop command with the computer's shell", async () => {
    const command = "gh api user";
    const shells = [
      {
        shell: { platform: "win32", shell: "powershell.exe", home: "C:\\Users\\rakazo" },
        argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      },
      {
        shell: { platform: "linux", shell: "/bin/bash", home: "/home/rakazo" },
        argv: ["/bin/bash", "-lc", command],
      },
    ];
    for (const { shell, argv } of shells) {
      const computer = {
        id: "desktop-computer-1",
        botId: "computer-home",
        kind: "desktop" as const,
        providerRef: "/tmp/watch-fixture/desktop-computers/computer-home",
      };
      vi.mocked(provisionComputer).mockResolvedValueOnce(computer);
      const { deps, routine, execute } = setupComputer(
        { kind: "command", command },
        { stdout: "ok\n" },
        { id: "computer-1", scope: "team", kind: "desktop" },
        { shell },
      );
      await checkRoutineWatch(deps, routine);
      expect(execute).toHaveBeenCalledWith(
        computer,
        expect.objectContaining({ argv, cwd: "bots/bot-1" }),
        expect.anything(),
      );
    }
  });

  it("runs a Windows check in PowerShell without the bash desktop guard", async () => {
    const computer = {
      id: "computer-1",
      botId: "bot-1",
      kind: "desktop" as const,
      providerRef: "ecd-1",
    };
    vi.mocked(provisionComputer).mockResolvedValueOnce(computer);
    const command = "(Get-ChildItem inbox).Count";
    expect(protectedComputerLifecycleRefusal(command)).toBeDefined();
    const { deps, routine, execute } = setupComputer(
      { kind: "command", command },
      { stdout: "3\n" },
      { id: "computer-1", scope: "team", kind: "desktop" },
      { shell: { platform: "win32", shell: "powershell.exe", home: "C:\\Users\\rakazo" } },
    );
    deps.commandRefusal = protectedComputerLifecycleRefusal;
    await checkRoutineWatch(deps, routine);
    expect(execute).toHaveBeenCalledWith(
      computer,
      expect.objectContaining({
        argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      }),
      expect.anything(),
    );
  });

  it("retries in a minute without pausing when the computer is busy", async () => {
    vi.mocked(provisionComputer).mockRejectedValueOnce(new ComputerBusyError());
    const { deps, routine, updateMany, messages } = setupComputer({
      kind: "files",
      paths: ["inbox"],
    });
    expect(await tickRoutineWatch(deps, routine, target, scheduledAt)).toEqual({ run: false });
    const data = (updateMany.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data).not.toHaveProperty("active");
    expect(data).not.toHaveProperty("watchState");
    expect((data.nextRunAt as Date).getTime()).toBeLessThan(Date.now() + 2 * 60_000);
    expect(deps.jobs.enqueue).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(0);
  });

  it("refuses a command the desktop-protection guard refuses, without running it", async () => {
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine, updateMany, execute } = setupComputer({
      kind: "command",
      command: "pkill chrome; ls",
    });
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(execute).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ active: false }) }),
    );
  });

  it("fails rather than saving a partial listing when one path cannot be listed", async () => {
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine, updateMany } = setupComputer(
      { kind: "files", paths: ["a", "b"] },
      {
        stdout: "/home/rakazo/bots/bot-1/b/x.txt\t1\t5.25\n",
        stderr: "find: a: Permission denied",
        code: 1,
      },
    );
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          active: false,
          watchState: expect.objectContaining({
            detail: expect.stringContaining("Permission denied"),
          }),
        }),
      }),
    );
  });

  it("keeps sub-second modification times", async () => {
    vi.mocked(provisionComputer).mockResolvedValueOnce({
      id: "computer-1",
      botId: "bot-1",
      kind: "fake",
      providerRef: "fake",
    });
    const { deps, routine, updateMany } = setupComputer(
      { kind: "files", paths: ["a"] },
      { stdout: "/home/rakazo/bots/bot-1/a/x.txt\t1\t5.25\n" },
    );
    routine.watchState = {
      checkedAt: "x",
      outcome: "unchanged",
      fingerprint: null,
      detail: null,
    } as never;
    await tickRoutineWatch(deps, routine, target, scheduledAt);
    expect(JSON.stringify(updateMany.mock.calls[0])).toContain("1:5.25");
  });

  describe("a check's use of the vault's command variables", () => {
    const secret = "ghp_fakefakeRoutineWatchToken";
    afterEach(() => {
      installAuditEventStore(undefined);
      vi.mocked(provisionComputer).mockReset();
    });

    /** A vault with a variable the check's command gets, and one that can't be read. */
    async function watched(watch: Record<string, unknown> = { kind: "command", command: "gh" }) {
      const vault = fakeDatabase();
      for (const [name, ciphertext] of [
        ["gh-token", "cipher-gh"],
        ["stripe-api-key", "cipher-stripe"],
      ] as const) {
        await vault.prisma.vaultCredential.create({
          data: {
            id: name,
            ...accountVault,
            name,
            origin: "",
            auth: { type: "command" },
            ciphertext,
          },
        });
      }
      vi.mocked(provisionComputer).mockResolvedValue({
        id: "computer-1",
        botId: "bot-1",
        kind: "fake",
        providerRef: "fake",
      });
      const secretStore = {
        async load(ciphertext: string) {
          if (ciphertext === "cipher-gh") return secret;
          throw new Error("unreadable");
        },
      };
      return {
        vault,
        ...setupComputer(watch, { stdout: "ok\n" }, undefined, { vault, secretStore }),
      };
    }

    it("records each variable a check's command was sent with, with no site", async () => {
      const rows = fakeAuditLog();
      const { deps, routine, execute } = await watched();
      await checkRoutineWatch(deps, routine);
      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ env: { GH_TOKEN: secret }, unsetEnv: ["STRIPE_API_KEY"] }),
        expect.anything(),
      );
      // Only the variable it got: the one that can't be read is unset, and no use.
      expect(rows).toEqual([
        expect.objectContaining({
          organizationId: "org-1",
          spaceId: "space-1",
          action: "credential.used",
          actorType: "bot",
          actorId: "bot-1",
          targetType: "vault_credential",
          targetId: "gh-token",
          targetLabel: "gh-token",
          runId: null,
          threadId: null,
          metadata: { tool: "routine_watch", scope: "account", name: "gh-token", kind: "command" },
        }),
      ]);
      // The next check is sent it again, which is its own use.
      await checkRoutineWatch(deps, routine);
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain(secret);
    });

    it("records nothing for a files watch, or a command the computer never got", async () => {
      const rows = fakeAuditLog();
      const files = await watched({ kind: "files", paths: ["inbox"] });
      await checkRoutineWatch(files.deps, files.routine);
      // Refused by the desktop-protection guard, then put off because the computer is busy.
      const refused = await watched({ kind: "command", command: "pkill chrome; gh" });
      await tickRoutineWatch(refused.deps, refused.routine, target, scheduledAt);
      const busy = await watched();
      vi.mocked(provisionComputer).mockRejectedValue(new ComputerBusyError());
      await tickRoutineWatch(busy.deps, busy.routine, target, scheduledAt);
      for (const { execute } of [refused, busy]) expect(execute).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
    });

    it("gives and records no variable the routine's bot may not use", async () => {
      const rows = fakeAuditLog();
      const { vault, deps, routine, execute } = await watched();
      // Limited in this Space to chosen bots, of which the routine's bot is none.
      await vault.prisma.vaultCredentialLimit.createMany({
        data: [{ credentialId: "gh-token", userId: "user-1", spaceId: "space-1" }],
      });
      await checkRoutineWatch(deps, routine);
      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ env: expect.anything() }),
        expect.anything(),
      );
      expect(rows).toEqual([]);
    });

    it("names a guest's account variable only in their own organization", async () => {
      const rows = fakeAuditLog("guest");
      const { deps, routine } = await watched();
      await checkRoutineWatch(deps, routine);
      expect(rows.map((row) => [row.organizationId, row.targetLabel])).toEqual([
        ["org-1", null],
        ["org-own", "gh-token"],
      ]);
      expect(rows[0]!.metadata).toEqual({
        tool: "routine_watch",
        scope: "account",
        kind: "command",
      });
    });

    it("records a use once the command was sent, also when the check then fails", async () => {
      const rows = fakeAuditLog();
      const { deps, routine, execute } = await watched();
      execute.mockImplementation(async function* () {
        yield { type: "stderr", data: "starting" };
        throw new Error("the connection to the computer was lost");
      });
      await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(
        "The check could not run on the computer",
      );
      expect(rows).toHaveLength(1);
    });

    it("checks all the same when the audit log can't be written", async () => {
      fakeAuditLog("member", true);
      const { deps, routine } = await watched();
      expect((await checkRoutineWatch(deps, routine)).state.detail).toBe("ok");
    });
  });
});

describe("watchFolder", () => {
  // A team computer refuses "." as a bot path, which failed every files watch live.
  it("is the bot's own folder on a team computer and the workspace on a private one", () => {
    expect(watchFolder("team", "bot-1")).toBe("/home/rakazo/bots/bot-1");
    expect(watchFolder("dedicated", "bot-1")).toBe("/home/rakazo");
  });
});

describe("toolResultText", () => {
  // The shape the VEC brain's brain_changed returned live through an installed MCP server.
  const envelope = {
    content: [{ type: "text", text: '{\n  "changes": [{"what": "add test note"}]\n}' }],
    isError: false,
  };

  it("unwraps an MCP result to its text", () => {
    expect(toolResultText(envelope)).toBe('{\n  "changes": [{"what": "add test note"}]\n}');
  });

  it("joins several text parts and skips non-text ones", () => {
    expect(
      toolResultText({
        content: [
          { type: "text", text: "one" },
          { type: "image", data: "…" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("keeps an error result's text alone instead of repeating its structured copy", () => {
    expect(
      toolResultText({
        content: [{ type: "text", text: "Permission denied for folder Reports" }],
        structuredContent: { error: "Permission denied for folder Reports" },
        isError: true,
      }),
    ).toBe("Permission denied for folder Reports");
  });

  it("keeps plain strings and other data readable", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("file watch boundaries", () => {
  it("allows normalized team paths inside the bot folder", () => {
    expect(resolveWatchPath("team", "bot-1", "/home/rakazo/bots/bot-1/inbox/../notes")).toBe(
      "/home/rakazo/bots/bot-1/notes",
    );
    expect(resolveWatchPath("team", "bot-1", "notes")).toBe("/home/rakazo/bots/bot-1/notes");
  });
  it.each(["/etc", "../bot-2", "/home/rakazo/bots/bot-1/../../shared", "shared/../../other"])(
    "refuses team escape %s",
    (path) => {
      expect(() => resolveWatchPath("team", "bot-1", path)).toThrow("inside the bot's folder");
    },
  );
  it("keeps dedicated computers unrestricted", () => {
    expect(resolveWatchPath("dedicated", "bot-1", "/etc")).toBe("/etc");
    expect(resolveWatchPath("dedicated", "bot-1", "../tmp")).toBe("/home/tmp");
  });
});

describe("files listing script", () => {
  it("resolves a relative team root in the provider's working directory", () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "routine-watch-")));
    try {
      mkdirSync(join(folder, "inbox"));
      // Keep the containment check real; emulate GNU find on hosts with BSD find.
      const script = `find() { printf 'inbox/note.txt\\t3\\t1.25\\n'; }\n${FILES_SCRIPT}`;
      const result = spawnSync("sh", ["-c", script, "watch", ".", "inbox"], {
        cwd: folder,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("inbox/note.txt\t3\t1.25\n");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points outside the bot folder before listing", () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "routine-watch-")));
    try {
      const folder = join(temp, "bot");
      mkdirSync(folder);
      const outside = join(temp, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "private.txt"), "fixture");
      const link = join(folder, "link");
      symlinkSync(outside, link);
      for (const path of [link, join(link, "private.txt")]) {
        const result = spawnSync("sh", ["-c", FILES_SCRIPT, "watch", folder, path], {
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Path escapes the bot folder");
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("keeps an earlier listing failure and its stderr when the last path succeeds", () => {
    // Simulate a sandbox where one find fails, followed by a successful listing.
    const script = `find() { if [ "$2" = / ]; then echo denied >&2; return 1; fi; printf 'ok\\t1\\t1.234\\n'; }\n${FILES_SCRIPT}`;
    const result = spawnSync("sh", ["-c", script, "watch", "", "/", "/."], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("denied");
    expect(result.stdout).toContain("1.234");
  });
});

describe("readItems", () => {
  it("prefers MCP structured results over display text", () => {
    const reading = readItems(
      {
        structuredContent: { items: [{ id: "item-1", version: 2 }] },
        content: [{ type: "text", text: "One item is available." }],
      },
      ["id", "version"],
    );
    expect(reading).toEqual(readItems([{ id: "item-1", version: 2 }], ["id", "version"]));
  });

  it("reads every JSON text block of an unstructured MCP result", () => {
    const items = [
      { id: "item-1", version: 1 },
      { id: "item-2", version: 2 },
    ];
    const reading = readItems(
      { content: items.map((item) => ({ type: "text", text: JSON.stringify(item) })) },
      ["id", "version"],
    );
    expect(reading).toEqual(readItems(items, ["id", "version"]));
  });

  it("reads an empty structured result with no text blocks", () => {
    expect(readItems({ structuredContent: { result: [] }, content: [] }, ["id"]).entries).toEqual(
      {},
    );
  });

  it("keeps support for a JSON document split across text blocks", () => {
    const reading = readItems(
      {
        content: [
          { type: "text", text: '{"items":' },
          { type: "text", text: '[{"id":"item-1"}]}' },
        ],
      },
      ["id"],
    );
    expect(reading).toEqual(readItems([{ id: "item-1" }], ["id"]));
  });

  it("does not silently drop an invalid text block beside a valid item", () => {
    expect(() =>
      readItems(
        {
          content: [
            { type: "text", text: '{"id":"item-1"}' },
            { type: "text", text: "not JSON" },
          ],
        },
        ["id"],
      ),
    ).toThrow("The result is not JSON");
  });

  it("falls back to JSON text when structuredContent is not an object", () => {
    expect(
      readItems(
        { structuredContent: "invalid", content: [{ type: "text", text: '{"id":"item-1"}' }] },
        ["id"],
      ),
    ).toEqual(readItems([{ id: "item-1" }], ["id"]));
  });

  const inbox = (messages: unknown[]) => ({
    content: [{ type: "text", text: JSON.stringify({ fetchedAt: Date.now(), messages }) }],
  });

  it("ignores everything outside the tracked fields", () => {
    const first = readItems(inbox([{ id: "m1", subject: "Invoice", snippet: "a" }]), ["id"]);
    const again = readItems(inbox([{ id: "m1", subject: "Invoice", snippet: "b" }]), ["id"]);
    expect(first.fingerprint).toBe(again.fingerprint);
  });

  it("names new, updated and gone items by their title", () => {
    const before = readItems(
      [
        { id: "t1", name: "Write rate card", date_updated: "1" },
        { id: "t2", name: "Call printer", date_updated: "1" },
      ],
      ["id", "date_updated"],
    );
    const after = readItems(
      [
        { id: "t1", name: "Write rate card", date_updated: "2" },
        { id: "t3", name: "Book venue", date_updated: "1" },
      ],
      ["id", "date_updated"],
    );
    const previous = {
      checkedAt: "x",
      outcome: "unchanged" as const,
      fingerprint: before.fingerprint,
      entries: before.entries,
      detail: null,
    };
    expect(compareReading(previous, after, NOW).state.detail).toBe(
      "New: Book venue\nUpdated: Write rate card\nGone: Call printer",
    );
  });

  it("finds items nested anywhere in the result", () => {
    const reading = readItems({ data: { files: [{ id: "f1", name: "Rates.pdf" }] } }, ["id"]);
    expect(Object.keys(reading.entries ?? {})).toEqual(["f1"]);
  });

  it("treats an empty list as no items, not a failure", () => {
    expect(readItems(inbox([]), ["id"]).entries).toEqual({});
  });
});

describe("watch tool guard", () => {
  function setupTool(
    tool: { name: string; readOnly?: boolean },
    args: Record<string, unknown>,
    rules: unknown[] = [],
  ) {
    const execute = vi.fn(async function* () {
      yield { type: "result", data: [] };
    });
    const deps = {
      prisma: {
        connection: { findMany: vi.fn(async () => []) },
        spaceSettingOverride: { findUnique: vi.fn(async () => null) },
        actionApprovalRule: { findMany: vi.fn(async () => []) },
        userActionApprovalRule: { findMany: vi.fn(async () => rules) },
      },
      connector: {
        discoverTools: vi.fn(async () => [{ ...tool, route: { connectorId: "installed" } }]),
        execute,
      },
    } as unknown as RoutineWatchTickDeps;
    const routine = {
      id: "r",
      spaceId: "s",
      userId: "u",
      botId: "b",
      watch: { kind: "tool", tool: tool.name, args },
      watchState: null,
    };
    return { deps, routine, execute };
  }

  it("refuses a tool that changes things, without calling it", async () => {
    const { deps, routine, execute } = setupTool({ name: "send_email" }, {});
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/can change data/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a write action on a tool that takes one", async () => {
    const { deps, routine, execute } = setupTool({ name: "clickbot_tasks" }, { action: "delete" });
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/can change data/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a tool that does not say it only reads, like brain_propose", async () => {
    const { deps, routine, execute } = setupTool({ name: "brain_propose" }, {});
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/can change data/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a read this space's rules ask approval for", async () => {
    const { deps, routine, execute } = setupTool({ name: "brain_search", readOnly: true }, {}, [
      { effect: "require_approval", matchKind: "tool", matchValue: "brain_search" },
    ]);
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/approval/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a tool its integration declares as a write", async () => {
    const { deps, routine } = setupTool({ name: "brain_changed", readOnly: false }, {});
    await expect(checkRoutineWatch(deps, routine)).rejects.toThrow(/can change data/);
  });

  it("allows reads, including tools whose name does not say", async () => {
    for (const [name, args] of [
      ["brain_changed", {}],
      ["clickbot_tasks", { action: "list" }],
      ["search_threads", { query: "invoice" }],
    ] as const) {
      const { deps, routine } = setupTool({ name, readOnly: true }, args);
      await expect(checkRoutineWatch(deps, routine)).resolves.toMatchObject({ changed: false });
    }
  });
});

describe("tracked result regressions", () => {
  it("compares only tracked fields while retaining titles for notes", () => {
    const before = readItems([{ id: "m1", subject: "Before", snippet: "a" }], ["id"]);
    const after = readItems([{ id: "m1", subject: "After", snippet: "b" }], ["id"]);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.entries).not.toEqual(before.entries);
  });
  it("fingerprints every item and ignores ordering beyond the detail limit", () => {
    const list = Array.from({ length: 2001 }, (_, i) => ({ id: String(i), modifiedTime: "1" }));
    const before = readItems(list, ["id", "modifiedTime"]);
    expect(before.entries).toBeUndefined();
    expect(readItems([...list].reverse(), ["id", "modifiedTime"]).fingerprint).toBe(
      before.fingerprint,
    );
    list[2000]!.modifiedTime = "2";
    expect(readItems(list, ["id", "modifiedTime"]).fingerprint).not.toBe(before.fingerprint);
  });
  it("includes children even when their parent has an identity", () => {
    const before = readItems({ id: "folder", files: [{ id: "file", modifiedTime: "1" }] }, [
      "id",
      "modifiedTime",
    ]);
    const after = readItems({ id: "folder", files: [{ id: "file", modifiedTime: "2" }] }, [
      "id",
      "modifiedTime",
    ]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
  it("keeps readable names and item wording when the last item disappears", () => {
    const before = readItems([{ id: "t1", name: "Call printer" }], ["id"]);
    expect(describeEntryChanges(before.entries!, {})).toBe("Gone: Call printer");
  });
});

it("loads authorized connection context for discovery, creation validation and connector rules", async () => {
  const connection = {
    id: "connection-1",
    connectorId: "pipedream",
    provider: "google_drive",
    providerRef: "fake-account",
    displayName: "Drive",
    status: "connected",
  };
  const discoverTools = vi.fn(async () => [
    { name: "google_drive_list_files", readOnly: true, description: "List", inputSchema: {} },
  ]);
  const rules: unknown[] = [];
  const execute = vi.fn(async function* () {
    yield { type: "result", data: [] };
  });
  const deps = {
    prisma: {
      connection: {
        findMany: vi.fn(async () => [
          connection,
          { ...connection, id: "revoked", status: "revoked" },
        ]),
      },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      actionApprovalRule: { findMany: vi.fn(async () => []) },
      userActionApprovalRule: { findMany: vi.fn(async () => rules) },
    },
    connector: { discoverTools, execute },
  } as unknown as RoutineWatchTickDeps;
  const routine = {
    id: "r",
    spaceId: "s",
    userId: "u",
    botId: "b",
    watch: { kind: "tool", tool: "google_drive_list_files" },
    watchState: null,
  };
  await checkRoutineWatch(deps, routine);
  await validateRoutineWatch(deps, RoutineWatchSchema.parse(routine.watch), routine);
  expect(discoverTools).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(deps.connector!.discoverTools).mock.calls) {
    expect(call[0]).toMatchObject({
      connectedConnections: [
        {
          id: "connection-1",
          connectorId: "pipedream",
          externalId: "google_drive",
          providerRef: "fake-account",
        },
      ],
      connectedProviders: [],
    });
  }
  rules.push({ effect: "require_approval", matchKind: "connector", matchValue: "google_drive" });
  await expect(checkRoutineWatch(deps, routine)).rejects.toThrow("needs approval");
  expect(execute).toHaveBeenCalledOnce();
});

describe("overlapping tracked identities", () => {
  it("retains parent values when a nested object has the same ID", () => {
    const result = (modifiedTime: string) => ({
      id: "1",
      modifiedTime,
      owner: { id: "1", name: "Owner" },
    });
    expect(readItems(result("1"), ["id", "modifiedTime"]).fingerprint).not.toBe(
      readItems(result("2"), ["id", "modifiedTime"]).fingerprint,
    );
  });
  it("keeps all duplicate-ID values and ignores their ordering", () => {
    const list = [
      { id: "1", modifiedTime: "1" },
      { id: "1", modifiedTime: "2" },
    ];
    const before = readItems(list, ["id", "modifiedTime"]);
    expect(readItems([...list].reverse(), ["id", "modifiedTime"]).fingerprint).toBe(
      before.fingerprint,
    );
    expect(readItems([list[0]], ["id", "modifiedTime"]).fingerprint).not.toBe(before.fingerprint);
  });
});
