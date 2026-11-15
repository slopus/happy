import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { HISTORY_EVAL_CASES } from "./evals/cases.js";
import { runTrial } from "./evals/runner.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("product history clarification eval boundary", () => {
  it.each([
    {
      id: "history-1000-balanced-ambiguity-v2",
      options: ["Aurora", "Borealis"],
      status: "failed",
      assistance: true,
    },
    {
      id: "history-1000-balanced-clarification-v3",
      options: ["Aurora", "Borealis"],
      status: "passed",
      assistance: false,
    },
  ])(
    "preserves the expected outcome for $id with choice labels $options",
    async (row) => {
      const scenario = HISTORY_EVAL_CASES.find((candidate) => candidate.id === row.id)!;
      const fixtureKey = "synthetic-clarification-fixture-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            expect(request) {
              expect(request.tools?.some((tool) => tool.function.name === "ask_user")).toBe(true);
            },
            response: {
              type: "tool",
              id: "synthetic-project-choice",
              name: "ask_user",
              arguments: { question: "Which project do you mean?", options: row.options },
            },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-clarification-"));
      try {
        const { createApp } = await import("@rakazo/api/app");
        const result = await runTrial(scenario, 1, {
          connection: {
            provider: model.model.provider,
            modelId: model.model.id,
            baseUrl: model.baseUrl,
            apiKey: fixtureKey,
            contextWindow: 1_000_000,
            maxTokens: 4096,
          },
          timeoutMs: 30_000,
          maxToolCalls: 30,
          createApp: (composio) =>
            createApp({
              databaseUrl: process.env.DATABASE_URL!,
              realtimeDatabaseUrl: process.env.DATABASE_URL!,
              authUrl: "http://127.0.0.1:5173",
              webOrigin: "http://127.0.0.1:5173",
              dataDir,
              sandboxProvider: "fake",
              agentRuntime: "pi",
              runtime: new PiAgentRuntime(),
              contextStrategy: "snapshots",
              wakeupDriver: "memory",
              signupsEnabled: "true",
              composio,
              encryptionKey: "synthetic-clarification-encryption-key",
            }),
        });
        model.assertComplete();
        expect(model.requests).toHaveLength(1);
        expect(result).toMatchObject({
          status: row.status,
          cleanupFailed: false,
          assisted: false,
          modelCalls: 1,
        });
        expect(result.stepAccounting?.reconciliation).toMatchObject({
          allCallsAccounted: true,
          modelCalls: 1,
        });
        if (row.assistance) expect(result.reason).toContain("Agent requested assistance");
        else {
          expect(result.artifacts["final-response"]).toContain("Which project do you mean?");
          expect(result.artifacts["final-response"]).toContain(row.options[0]);
          if (row.status === "passed")
            expect(result.trace[0]).toMatchObject({ status: "waiting_input", tools: ["ask_user"] });
          else
            expect(
              result.criteria
                .filter((criterion) => !criterion.pass)
                .map((criterion) => criterion.id),
            ).toEqual(["exclude-ORBIT-731", "exclude-COMET-219"]);
        }
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
