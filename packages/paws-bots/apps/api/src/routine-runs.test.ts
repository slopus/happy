import type { Actor } from "@rakazo/contracts";
import { RoutineHistorySchema } from "@rakazo/contracts";
import { runFailureError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listRoutineRuns } from "./routine-runs.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const at = new Date("2026-01-02T12:00:00Z");
function fixture() {
  const routine = vi.fn().mockResolvedValue({ botId: "bot-1" });
  const runs = vi.fn().mockResolvedValue([]);
  const messages = vi.fn().mockResolvedValue([]);
  const prisma = {
    routine: { findFirst: routine },
    run: { findMany: runs },
    $queryRaw: messages,
  } as unknown as PrismaClient;
  return { prisma, routine, runs, messages };
}
describe("routine history", () => {
  it("refuses missing, foreign or archived routines before reading runs", async () => {
    const { prisma, routine, runs, messages } = fixture();
    routine.mockResolvedValue(null);
    await expect(listRoutineRuns(prisma, actor, "routine-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(routine).toHaveBeenCalledWith({
      where: {
        id: "routine-1",
        spaceId: actor.spaceId,
        bot: { archivedAt: null },
      },
      select: { botId: true },
    });
    expect(runs).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });
  it("returns a bounded, newest-first history including silent, failed and queued runs", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockResolvedValue(
      ["completed", "failed", "queued"].map((status, i) => ({
        id: `run-${i}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: i === 1 ? "group-1" : null },
        status,
        error: "504: request timed out",
        createdAt: at,
        startedAt: status === "queued" ? null : at,
        completedAt: status === "queued" ? null : new Date(at.getTime() + 82_000),
      })),
    );
    messages.mockResolvedValue([{ id: "reply-new", runId: "run-1", threadId: "thread-1" }]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history)).toEqual(history);
    expect(history.runs.map((row) => row.messageId)).toEqual([null, "reply-new", null]);
    expect(history.runs.map((row) => row.groupId)).toEqual([null, "group-1", null]);
    expect(history.runs[2]?.startedAt).toBeNull();
    expect(history.runs.map((row) => row.error)).toEqual([null, "504: request timed out", null]);
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ error: true }) }),
    );
    expect(runs).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          routineId: "routine-1",
          botId: "bot-1",
          spaceId: actor.spaceId,
        },
        take: 21,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    const sql = messages.mock.calls[0]?.[0];
    expect(sql.sql).toContain('DISTINCT ON (m."runId")');
    expect(sql.sql).toContain('r."threadId" = m."threadId"');
    expect(sql.values).toEqual(["run-0", "run-1", "run-2", actor.spaceId, actor.spaceId]);
  });
  it("returns a shorter page with a cursor when asked for fewer runs", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: `run-${i}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        error: null,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      })),
    );
    const history = await listRoutineRuns(prisma, actor, "routine-1", undefined, 2);
    expect(runs).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(history.runs.map((row) => row.id)).toEqual(["run-0", "run-1"]);
    expect(history.nextCursor).toEqual({ id: "run-1", createdAt: at.toISOString() });
  });
  it("bounds stored errors like thread failures", async () => {
    const { prisma, runs } = fixture();
    const error = "x".repeat(400);
    runs.mockResolvedValue([
      {
        id: "failed-run",
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "failed",
        error,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(history.runs[0]?.error).toBe(`${"x".repeat(300)}…`);
    expect(history.runs[0]?.error).toBe(
      runFailureError({ type: "run.failed", payload: { error } }),
    );
  });
  it("does not confuse a database failure with an empty history", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockRejectedValue(new Error("database unavailable"));
    await expect(listRoutineRuns(prisma, actor, "routine-1")).rejects.toThrow(
      "database unavailable",
    );
    expect(messages).not.toHaveBeenCalled();
  });
  it("skips the message query when the routine has never run", async () => {
    const { prisma, messages } = fixture();
    await expect(listRoutineRuns(prisma, actor, "routine-1")).resolves.toEqual({
      runs: [],
      nextCursor: null,
    });
    expect(messages).not.toHaveBeenCalled();
  });
  it("pages all history using stable timestamp/id boundaries without including the lookahead row", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({
        id: `run-${String(30 - i).padStart(2, "0")}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        createdAt: at,
        startedAt: at,
        completedAt: at,
      })),
    );
    const first = await listRoutineRuns(prisma, actor, "routine-1");
    expect(first.runs).toHaveLength(20);
    expect(first.nextCursor).toEqual({ id: "run-11", createdAt: at.toISOString() });
    runs.mockResolvedValue([]);
    const next = await listRoutineRuns(prisma, actor, "routine-1", first.nextCursor!);
    expect(next).toEqual({ runs: [], nextCursor: null });
    expect(runs).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          routineId: "routine-1",
          botId: "bot-1",
          spaceId: actor.spaceId,
          OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: "run-11" } }],
        },
      }),
    );
  });
  it("keeps the group destination of a routine execution", async () => {
    const { prisma, runs, messages } = fixture();
    runs.mockResolvedValue([
      {
        id: "group-run",
        botId: "bot-1",
        threadId: "group-thread",
        thread: { groupId: "group-1" },
        status: "completed",
        createdAt: at,
        startedAt: at,
        completedAt: at,
      },
    ]);
    messages.mockResolvedValue([
      { id: "group-reply", runId: "group-run", threadId: "group-thread" },
    ]);
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history).runs[0]).toMatchObject({
      groupId: "group-1",
      messageId: "group-reply",
    });
  });
  it("returns the due time recorded on a run that started late", async () => {
    const { prisma, runs } = fixture();
    runs.mockResolvedValue(
      [new Date("2026-01-02T08:00:00Z"), null].map((lateSince, i) => ({
        id: `run-${i}`,
        botId: "bot-1",
        threadId: "thread-1",
        thread: { groupId: null },
        status: "completed",
        error: null,
        lateSince,
        createdAt: at,
        startedAt: at,
        completedAt: at,
      })),
    );
    const history = await listRoutineRuns(prisma, actor, "routine-1");
    expect(RoutineHistorySchema.parse(history)).toEqual(history);
    expect(history.runs.map((run) => run.lateSince)).toEqual(["2026-01-02T08:00:00.000Z", null]);
  });
});
