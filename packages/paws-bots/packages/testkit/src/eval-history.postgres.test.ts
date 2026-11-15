import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runTrial } from "./evals/runner.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseAvailable)("eval history accounting", () => {
  it.each([2, 1])(
    "retains cleared-run tool calls with a budget of %s",
    async (maxToolCalls) => {
      const fixtureKey = "offline-eval-history-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: ["first", "second"].flatMap((turn) => [
          {
            expect(request) {
              const messages = JSON.stringify(request.messages);
              expect(messages).toContain(`Save ${turn} turn.`);
              if (turn === "second") expect(messages).not.toContain("Save first turn.");
            },
            response: {
              type: "tool" as const,
              id: `${turn}-write`,
              name: "write_file",
              arguments: { path: `results/${turn}.txt`, content: turn },
            },
          },
          {
            expect(request) {
              const tool = request.messages.findLast((message) => message.role === "tool");
              expect(tool?.tool_call_id).toBe(`${turn}-write`);
              expect(JSON.parse(String(tool?.content))).toMatchObject({ ok: true });
            },
            response: { type: "text" as const, text: `Saved ${turn} turn.` },
          },
        ]),
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-eval-history-"));
      try {
        const { createApp } = await import("@rakazo/api/app");
        const result = await runTrial(
          {
            id: "cleared-history-fixture",
            purpose: "Keep the full trial budget after clearing the first conversation.",
            steps: [{ ask: "Save first turn." }, { clear: true }, { ask: "Save second turn." }],
            files: ["results/first.txt", "results/second.txt"],
            grade: ({ files }) => [
              {
                id: "both-files-saved",
                pass:
                  files["results/first.txt"] === "first" &&
                  files["results/second.txt"] === "second",
              },
            ],
          },
          1,
          {
            connection: {
              provider: model.model.provider,
              modelId: model.model.id,
              baseUrl: model.baseUrl,
              apiKey: fixtureKey,
              contextWindow: 160_000,
              maxTokens: 4096,
            },
            timeoutMs: 20_000,
            maxToolCalls,
            createApp: (composio) =>
              createApp({
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
                encryptionKey: "offline-eval-history-encryption-key",
              }),
          },
        );
        expect(result.cleanupFailed).toBe(false);
        expect(result.toolCalls).toBe(2);
        if (maxToolCalls === 2) {
          model.assertComplete();
          expect(result).toMatchObject({ status: "passed", category: null, reason: null });
          expect(result.trace).toEqual([
            { step: 1, status: "completed", tools: ["write_file"] },
            { step: 3, status: "completed", tools: ["write_file"] },
          ]);
        } else {
          // Cleanup may abort the last model response as soon as the second tool
          // exceeds the budget, so only the successful journey requires every SSE step.
          expect(result).toMatchObject({
            status: "failed",
            category: "incomplete",
            reason: "Tool call budget exceeded",
          });
        }
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
