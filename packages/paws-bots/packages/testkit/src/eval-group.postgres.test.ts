import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { EvalCase } from "./evals/cases.js";
import type { EvalJudge } from "./evals/judge.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

const fixtureKey = "offline-group-budget-key";
// The subject answers after two tool calls.
const subjectTools = 2;

/**
 * Two members wake for one unaddressed message: the subject answers after two tool calls,
 * then Mika makes `memberTools` calls and answers. Each of Mika's model calls takes
 * `memberCallMs` longer, and its first call also waits for `memberGate`. The trial budget
 * is five tool calls.
 */
async function runGroupBudgetTrial(fixture: {
  memberTools: number;
  memberCallMs: number;
  memberGate?: Promise<void>;
  judge?: EvalJudge;
  grade?: EvalCase["grade"];
  scenarioJudge?: EvalCase["judge"];
}) {
  const { memberTools } = fixture;
  const totalCalls = subjectTools + memberTools + 2; // Each member ends with one text turn.
  // Members decide at about the same time, so the fixture cannot pin run order: every
  // step serves either member, and Mika's first call waits for the subject's finished
  // run, so the trial's per-step watch has ended before Mika's work counts up.
  let subjectCalls = 0;
  let memberCalls = 0;
  const isMember = (request: ModelEmulatorRequest) =>
    JSON.stringify(request.messages).includes("member-keeps-searching");
  const { createDb, asSystem } = await import("@rakazo/db");
  const db = createDb(process.env.DATABASE_URL!);
  const system = asSystem(db.prisma);
  // Both cases share one database, so lookups only count this trial's runs.
  const started = new Date();
  const subjectRunDone = async () =>
    Boolean(
      await system.run.findFirst({
        where: {
          bot: { name: "Assistant" },
          trigger: "user",
          status: "completed",
          createdAt: { gte: started },
        },
        select: { id: true },
      }),
    );
  const steps: ModelEmulatorStep[] = Array.from({ length: totalCalls }, () => ({
    async expect(request) {
      if (!isMember(request)) return;
      if (memberCalls === 0) {
        const gateDeadline = Date.now() + 20_000;
        while (!(await subjectRunDone()) && Date.now() < gateDeadline)
          await new Promise((resolve) => setTimeout(resolve, 50));
        await fixture.memberGate;
      }
      if (fixture.memberCallMs)
        await new Promise((resolve) => setTimeout(resolve, fixture.memberCallMs));
    },
    response: (request: ModelEmulatorRequest) => {
      if (!isMember(request)) {
        subjectCalls += 1;
        if (subjectCalls <= subjectTools)
          return {
            type: "tool" as const,
            id: `subject-search-${subjectCalls}`,
            name: "search_history",
            arguments: { query: `release-${subjectCalls}` },
          };
        return { type: "text" as const, text: "Nothing blocking from my side." };
      }
      memberCalls += 1;
      if (memberCalls <= memberTools)
        return {
          type: "tool" as const,
          id: `member-search-${memberCalls}`,
          name: "search_history",
          arguments: { query: `release-${memberCalls}` },
        };
      return { type: "text" as const, text: "I checked every record; nothing blocks." };
    },
  }));
  const model = await startModelEmulator({ apiKey: fixtureKey, steps });
  const scenario: EvalCase = {
    id: "group-tool-budget",
    purpose:
      "The trial tool budget stops a member still working after the first member's run ended.",
    steps: [{ ask: "Quick check: does anything block tonight's release?", unaddressed: true }],
    group: {
      members: ["Mika"],
      roles: {
        Assistant: "Chief of staff: tracks the release and answers for it.",
        Mika: "Archives: searches the records for anything blocking.",
      },
      instructions: {
        Assistant: "You coordinate releases. Marker: subject-answers-at-once.",
        Mika: "You search the archive until certain. Marker: member-keeps-searching.",
      },
    },
    grade: fixture.grade ?? (() => []),
    ...(fixture.scenarioJudge ? { judge: fixture.scenarioJudge } : {}),
  };
  const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-group-budget-"));
  // The per-run product cap would end Mika's turn at the trial budget, hiding the
  // window the trial itself must guard; keep the run cap above it for this fixture.
  const previousRunCap = process.env.MAX_TOOL_CALLS_PER_TURN;
  process.env.MAX_TOOL_CALLS_PER_TURN = "0";
  try {
    const { createApp } = await import("@rakazo/api/app");
    const result = await runTrial(scenario, 1, {
      connection: {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      },
      timeoutMs: 30_000,
      maxToolCalls: 5,
      ...(fixture.judge ? { judge: fixture.judge } : {}),
      createApp: (composio, messaging) => {
        const sandbox = new EvalSandboxProvider();
        return createApp({
          sandbox,
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: "http://127.0.0.1:5173",
          webOrigin: "http://127.0.0.1:5173",
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio,
          messaging,
          messagingOpenSignup: false,
          cloudAgentProvider: "none",
          encryptionKey: "offline-group-eval-encryption-key",
        });
      },
    });
    const mikaRun = await system.run.findFirst({
      where: { bot: { name: "Mika" }, trigger: "user", createdAt: { gte: started } },
      select: { status: true },
    });
    return { result, memberCalls, totalCalls, requests: model.requests.length, mikaRun };
  } finally {
    if (previousRunCap === undefined) delete process.env.MAX_TOOL_CALLS_PER_TURN;
    else process.env.MAX_TOOL_CALLS_PER_TURN = previousRunCap;
    await model.close();
    await db.prisma.$disconnect();
    await db.pool.end();
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe.skipIf(!databaseAvailable)("group eval tool budget", () => {
  it("stops a group trial while a member is still working past the tool budget", async () => {
    // Stretch each member call past the wait loop's poll interval, as real paid calls are,
    // so the breach is observable while Mika is still working. The budget (the subject's
    // two calls plus Mika's) trips at Mika's fourth call, after the subject's run ended.
    const memberTools = 8;
    const { result, memberCalls, totalCalls, requests, mikaRun } = await runGroupBudgetTrial({
      memberTools,
      memberCallMs: 150,
    });
    expect(result.category).toBe("incomplete");
    expect(result.reason).toBe("Tool call budget exceeded");
    // The trial stopped before Mika's scripted work ran out, and cleanup stopped
    // the run instead of letting it finish through the drain.
    expect(memberCalls).toBeLessThan(memberTools + 1);
    expect(requests).toBeLessThan(totalCalls);
    expect(mikaRun?.status).toBe("cancelled");
  }, 90_000);

  it("grades nothing and calls no judge when a member's run ended over the budget mid-drain", async () => {
    // Mika's four calls (six in all) can fall between two of the drain's 200 ms checks and
    // end its run before the next one. Silence those checks, and start Mika only once the
    // drain is waiting, so the test does not depend on how fast Mika is: then only a check
    // after the drain can see the breach before grading.
    const realSetTimeout = globalThis.setTimeout;
    let drainWaiting!: () => void;
    const memberGate = new Promise<void>((resolve) => {
      drainWaiting = resolve;
    });
    const drainChecks = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay !== 200 || String(callback) !== "() => resolve(false)")
        return realSetTimeout(callback, delay, ...args);
      drainWaiting();
      return realSetTimeout(() => undefined, 0);
    }) as typeof setTimeout);
    let graded = false;
    let judged = false;
    try {
      const { result } = await runGroupBudgetTrial({
        memberTools: 4,
        memberCallMs: 0,
        memberGate,
        grade: () => {
          graded = true;
          return [{ id: "answered", pass: true }];
        },
        scenarioJudge: () => ({ rubric: "Answers the release question.", evidence: [] }),
        judge: async () => {
          judged = true;
          return { pass: true, reason: "fixture" };
        },
      });
      expect(result.category).toBe("incomplete");
      expect(result.reason).toBe("Tool call budget exceeded");
      expect(graded).toBe(false);
      expect(judged).toBe(false);
    } finally {
      drainChecks.mockRestore();
    }
  }, 90_000);
});
