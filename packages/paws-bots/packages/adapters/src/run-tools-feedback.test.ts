import { toolRequiresApproval, toolResultTaintsRun } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { selectBuiltinToolsForRun } from "./run-tool-selection.js";
import { FEEDBACK_REPORTS_PER_HOUR, feedbackTools } from "./run-tools-feedback.js";

type Report = Record<string, unknown> & { userId: string; createdAt: Date };

function fakeRun(existing: Report[] = []) {
  const reports = [...existing];
  const ctx = {
    deps: {
      prisma: {
        feedbackReport: {
          count: async ({ where }: { where: { userId: string; createdAt: { gte: Date } } }) =>
            reports.filter(
              (report) => report.userId === where.userId && report.createdAt >= where.createdAt.gte,
            ).length,
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const id = `report-${reports.length + 1}`;
            reports.push({ ...data, id, userId: String(data.userId), createdAt: new Date() });
            return { id };
          },
        },
      },
    },
    run: {
      id: "run-1",
      userId: "user-1",
      spaceId: "space-1",
      botId: "bot-1",
      threadId: "thread-1",
    },
    secrets: ["sk-test-secret"],
  };
  const call = (args: Record<string, unknown>) =>
    feedbackTools.feedback!(
      ctx as never,
      {
        name: "feedback",
        args,
        executionId: "call-1",
        finish: async (result: unknown) => result,
      } as never,
    );
  return { reports, call };
}

describe("feedback", () => {
  it("saves the report with where it happened", async () => {
    const { reports, call } = fakeRun();
    await expect(
      call({ kind: "bug", description: "  The computer pane stayed blank.  " }),
    ).resolves.toEqual({ sent: true, id: "report-1" });
    expect(reports).toEqual([
      expect.objectContaining({
        userId: "user-1",
        spaceId: "space-1",
        botId: "bot-1",
        threadId: "thread-1",
        runId: "run-1",
        kind: "bug",
        description: "The computer pane stayed blank.",
      }),
    ]);
  });

  it("redacts secrets the run has seen", async () => {
    const { reports, call } = fakeRun();
    await call({ kind: "bug", description: "The key sk-test-secret was rejected." });
    expect(reports[0]?.description).toBe("The key [redacted] was rejected.");
  });

  it.each([
    { kind: "bug" },
    { kind: "bug", description: "   " },
    { kind: "praise", description: "Nice" },
    { kind: "bug", description: "x".repeat(2_001) },
    { kind: "bug", description: "Broken", email: "someone@example.test" },
  ])("rejects invalid input: %o", async (args) => {
    const { reports, call } = fakeRun();
    await expect(call(args)).resolves.toHaveProperty("error");
    expect(reports).toHaveLength(0);
  });

  it("limits how many reports one user sends in an hour", async () => {
    const recent = Array.from({ length: FEEDBACK_REPORTS_PER_HOUR }, () => ({
      userId: "user-1",
      createdAt: new Date(),
    }));
    const old = { userId: "user-1", createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) };
    const limited = fakeRun(recent);
    await expect(limited.call({ kind: "feedback", description: "More" })).resolves.toEqual({
      error: expect.stringContaining("Too many"),
    });
    const allowed = fakeRun([...recent.slice(1), old]);
    await expect(allowed.call({ kind: "feedback", description: "More" })).resolves.toMatchObject({
      sent: true,
    });
  });

  it("asks for approval and does not taint the run", () => {
    expect(toolRequiresApproval("feedback", false)).toBe(true);
    expect(toolResultTaintsRun("feedback")).toBe(false);
  });

  it("is offered only on runs the user started", () => {
    const offered = (trigger: string) =>
      selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: null,
        trigger,
        semanticMemoryEnabled: false,
        messagingChannelRun: trigger === "messaging",
      }).some((tool) => tool.name === "feedback");
    expect(offered("user")).toBe(true);
    for (const trigger of ["routine", "webhook", "bot_message", "created"])
      expect(offered(trigger), trigger).toBe(false);
  });
});
