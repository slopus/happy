import { describe, expect, it, vi } from "vitest";
import { TASK_CATALOG_GUIDANCE, taskCatalogFromTool } from "./task-catalog.js";

describe("task catalog", () => {
  it("returns the bot's real work records and exposed tool roster", async () => {
    const prisma = {
      scratchpadItem: {
        findMany: vi.fn(async () => [
          {
            id: "item-1",
            botId: "bot-1",
            title: "Check the inbox",
            status: "open",
            notes: "Use the connected mail tool.",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      },
      routine: {
        findMany: vi.fn(async () => [
          {
            id: "routine-1",
            name: "Morning report",
            prompt: "Read the report and summarize it.",
            crons: ["0 9 * * *"],
            active: true,
            nextRunAt: new Date("2026-01-03T09:00:00.000Z"),
          },
        ]),
      },
      taughtSkill: {
        findMany: vi.fn(async (_args: Record<string, unknown>) => [
          { id: "taught-1", name: "Export report", goal: "Export the report", status: "saved" },
        ]),
      },
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "skill-1",
            name: "Daily report",
            description: "Build the daily report",
            content: "steps",
            source: "user",
          },
        ]),
      },
    };

    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "user-1",
        tools: [
          { name: "task_catalog", description: "Catalog", readOnly: true },
          { name: "task_catalog", description: "Duplicate", readOnly: true },
          { name: "GITHUB_LIST_RELEASES", description: "List releases", readOnly: true },
        ],
      },
    );

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: "item-1", title: "Check the inbox", source: "scratchpad" }),
    ]);
    expect(result.routines).toEqual([
      expect.objectContaining({ routineId: "routine-1", name: "Morning report", active: true }),
    ]);
    expect(result.taughtSkills).toEqual([
      {
        id: "taught-1",
        name: "Export report",
        goal: "Export the report",
        status: "saved",
        source: "taught_skill",
      },
    ]);
    expect(prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          botId: "bot-1",
          status: "saved",
        },
      }),
    );
    expect(prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ userId: expect.anything() }),
      }),
    );
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Daily report", source: "user", readOnly: false }),
      ]),
    );
    expect(result.tools).toEqual([
      { name: "task_catalog", description: "Catalog", readOnly: true },
      { name: "GITHUB_LIST_RELEASES", description: "List releases", readOnly: true },
    ]);
    expect(result.guidance).toBe(TASK_CATALOG_GUIDANCE);
  });

  it("lists a group run's routines from every chat and marks the ones posting there", async () => {
    const findMany = vi.fn(async (_args: Record<string, unknown>) => [
      { id: "r-dm", name: "Daily check", crons: ["0 8 * * *"], threadId: "dm-thread" },
      { id: "r-group", name: "Digest", crons: ["0 9 * * *"], threadId: "group-thread" },
    ]);
    const prisma = {
      scratchpadItem: { findMany: vi.fn(async () => []) },
      routine: { findMany },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
    };
    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "user-1",
        groupThreadId: "group-thread",
        tools: [],
      },
    );
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { spaceId: "space-1", botId: "bot-1" },
    });
    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty("threadId");
    expect(result.routines).toEqual([
      expect.objectContaining({ routineId: "r-dm", inThisChat: false }),
      expect.objectContaining({ routineId: "r-group", inThisChat: true }),
    ]);
  });
});
