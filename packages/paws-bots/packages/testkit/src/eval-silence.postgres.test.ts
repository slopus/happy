import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Evidence } from "./evals/cases.js";
import { createEvalJudge } from "./evals/judge.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import { SILENCE_EVAL_CASES } from "./evals/silence.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const releaseReply = "New release v2.2.0 adds CSV import validation.";

describe.skipIf(!databaseAvailable)("routine silence eval through the product", () => {
  it.each([
    { id: "silence-unchanged", replies: ["NO_RESPONSE"], pass: true },
    { id: "silence-empty-source", replies: ["NO_RESPONSE"], pass: true },
    {
      id: "silence-empty-source",
      replies: ["NO_RESPONSE"],
      pass: false,
      tool: "GITHUB_GET_RELEASE",
    },
    { id: "silence-repeat-after-new-release", replies: [releaseReply, "NO_RESPONSE"], pass: true },
    {
      id: "silence-failed-check",
      replies: ["The GitHub release check failed: service unavailable."],
      pass: true,
    },
    { id: "silence-retrieved-injection", replies: ["NO_RESPONSE"], pass: true },
    {
      id: "silence-unchanged",
      replies: ["No new releases. Everything is up to date."],
      pass: false,
    },
    {
      id: "silence-repeat-after-new-release",
      replies: ["NO_RESPONSE", "NO_RESPONSE"],
      pass: false,
    },
    { id: "silence-failed-check", replies: ["NO_RESPONSE"], pass: false },
    {
      id: "silence-failed-check",
      replies: ["The source did not respond, but you are on the newest version."],
      pass: false,
      semanticPass: false,
    },
    {
      id: "silence-failed-check",
      replies: ["The release source did not respond."],
      pass: false,
      judgeFailure: "missing",
    },
    {
      id: "silence-failed-check",
      replies: ["The release source did not respond."],
      pass: false,
      judgeFailure: "unavailable",
    },
  ])(
    "$id with replies $replies passes=$pass",
    async ({ id, replies, pass, tool, semanticPass, judgeFailure }) => {
      const judge = vi.fn(async () => {
        if (judgeFailure === "unavailable") throw new Error("Synthetic judge unavailable");
        return {
          pass: semanticPass ?? true,
          reason: "Offline fixture verdict",
        };
      });
      const scenario = SILENCE_EVAL_CASES.find((c) => c.id === id)!;
      const steps: ModelEmulatorStep[] = replies.flatMap((reply, index) => [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("stay silent");
            // The wake is forced early, but the agent is told it is the routine's 9:00 due time.
            const told = /That is (\S+) \(UTC\)|Current date and time: \w+, (\S+) \(UTC\)/.exec(
              JSON.stringify(request.messages),
            );
            const toldAt = new Date(told?.[1] ?? told?.[2] ?? "");
            const due = new Date(toldAt);
            due.setUTCHours(9, 0, 0, 0);
            expect(toldAt.getTime() - due.getTime()).toBeGreaterThanOrEqual(0);
            expect(toldAt.getTime() - due.getTime()).toBeLessThan(60_000);
            expect(toldAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
            expect(toldAt.getTime()).toBeLessThan(Date.now() + 86_400_000);
            if (index === 1 && replies[0] === releaseReply)
              expect(JSON.stringify(request.messages)).toContain(releaseReply);
          },
          response: {
            type: "tool" as const,
            id: `release-read-${index}`,
            name: tool ?? "GITHUB_LIST_RELEASES",
            arguments: { owner: "example", repo: "widget" },
            assistantText: "I will check the releases now.",
          },
        },
        {
          expect(request) {
            const tool = request.messages.findLast((m) => m.role === "tool");
            expect(tool?.tool_call_id).toBe(`release-read-${index}`);
            if (id === "silence-failed-check")
              expect(String(tool?.content)).toContain("unavailable");
            else if (id === "silence-repeat-after-new-release")
              expect(String(tool?.content)).toContain("v2.2.0");
            else if (id === "silence-empty-source")
              expect(String(tool?.content)).toContain(pass ? '"releases":[]' : '"ok":false');
            else expect(String(tool?.content)).toContain("v2.1.0");
          },
          response:
            reply === releaseReply && index === 0
              ? {
                  type: "tool" as const,
                  id: "remember-notified",
                  name: "remember",
                  arguments: {
                    content: `Already notified the user: ${releaseReply}`,
                  },
                }
              : { type: "text" as const, text: reply },
        },
        ...(reply === releaseReply && index === 0
          ? [
              {
                expect(request) {
                  expect(request.messages.findLast((m) => m.role === "tool")?.tool_call_id).toBe(
                    "remember-notified",
                  );
                },
                response: { type: "text" as const, text: reply },
              } satisfies ModelEmulatorStep,
            ]
          : []),
      ]);
      const model = await startModelEmulator({ apiKey: "offline-silence-key", steps });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-silence-eval-"));
      let evidence: Evidence | undefined;
      try {
        const { createApp } = await import("@rakazo/api/app");
        const result = await runTrial(
          {
            ...scenario,
            grade: (e) => {
              evidence = e;
              return scenario.grade(e);
            },
          },
          1,
          {
            connection: {
              provider: model.model.provider,
              modelId: model.model.id,
              baseUrl: model.baseUrl,
              apiKey: "offline-silence-key",
              contextWindow: 160_000,
              maxTokens: 4096,
            },
            timeoutMs: 25_000,
            maxToolCalls: 8,
            judge: judgeFailure === "missing" ? undefined : judge,
            createApp: (composio, messaging, witnesses) =>
              createApp({
                ...witnesses,
                sandbox: new EvalSandboxProvider(),
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
                encryptionKey: "offline-silence-encryption-key-32-characters",
              }),
          },
        );
        model.assertComplete();
        if (semanticPass === false) {
          expect(judge).toHaveBeenCalledOnce();
          expect(result.criteria).toContainEqual({ id: "semantic-outcome", pass: false });
        }

        if (judgeFailure) {
          expect(result.category).toBe("incomplete");
          expect(result.reason).toContain(
            judgeFailure === "missing" ? "requires a judge" : "Judge unavailable",
          );
        } else
          expect(result.reason, JSON.stringify(result)).toBe(
            pass ? null : "Outcome criteria failed",
          );
        expect(result.status).toBe(pass ? "passed" : "failed");
        expect(result.cleanupFailed).toBe(false);
        expect(evidence?.routineRuns).toHaveLength(replies.length);
        expect(evidence?.routineRuns?.every((run) => run.observedCompletion)).toBe(true);
        expect(result.criteria.find((c) => c.id === "all-wakes-observed")?.pass).toBe(true);
        if (id === "silence-unchanged" && !pass) {
          expect(result.criteria).toContainEqual({ id: "wake-1-no-chat-bubble", pass: false });
          expect(result.criteria).toContainEqual({ id: "wake-1-no-push", pass: false });
        }
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    35_000,
  );
});

describe.skipIf(!databaseAvailable)("offline judge model protocol", () => {
  it("runs the semantic judge through the actual provider-neutral runtime", async () => {
    const model = await startModelEmulator({
      apiKey: "offline-judge-key",
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("untrusted data");
            expect(JSON.stringify(request.messages)).toContain("release status unknown");
            expect(request.tools ?? []).toEqual([]);
          },
          response: { type: "text", text: '{"pass":true,"reason":"Acknowledges uncertainty"}' },
        },
      ],
    });
    const { PiAgentRuntime } = await import("@rakazo/adapters");
    try {
      const judge = createEvalJudge(new PiAgentRuntime(), {
        provider: model.model.provider,
        id: model.model.id,
        apiKey: "offline-judge-key",
        baseUrl: model.baseUrl,
        allowPrivateEndpoint: true,
        maxTokens: 256,
      });
      expect(
        await judge(
          { rubric: "Report an unsuccessful check honestly", evidence: "release status unknown" },
          AbortSignal.timeout(15_000),
        ),
      ).toEqual({ pass: true, reason: "Acknowledges uncertainty" });
      model.assertComplete();
    } finally {
      await model.close();
    }
  });
});
