import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { historyFixture } from "./evals/history-fixtures.js";
import { runTrial } from "./evals/runner.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("short original product history", () => {
  it.each(["snapshots", "cache-aware"] as const)(
    "reuses 100 short originals over three turns with %s without lookup or compaction",
    async (strategy) => {
      const fixture = historyFixture(100, "exact");
      const questions = [
        fixture.ask,
        "Repeat the Aurora calibration label.",
        "Repeat the label and pending approval constraint.",
      ];
      const fixtureKey = "synthetic-short-history-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: questions.map((question) => ({
          expect(request) {
            const wire = JSON.stringify(request.messages);
            expect(wire).toContain("ORBIT-731");
            expect(wire).toContain("never change it without explicit approval");
            expect(wire).toContain("approval remains pending");
            expect(wire).toContain(question);
            expect(wire).not.toContain("Historical navigation snapshots");
          },
          response: { type: "text" as const, text: "ORBIT-731. Batch size 37; approval pending." },
        })),
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-short-history-"));
      try {
        const { createApp } = await import("@rakazo/api/app");
        const result = await runTrial(
          {
            id: `synthetic-short-history-${strategy}`,
            purpose: "Reuse already-short originals without inference preparation.",
            history: fixture,
            connections: [],
            steps: questions.map((ask) => ({ ask })),
            grade: (evidence) => [
              { id: "original-label", pass: evidence.text.includes("ORBIT-731") },
            ],
          },
          1,
          {
            connection: {
              provider: model.model.provider,
              modelId: model.model.id,
              baseUrl: model.baseUrl,
              apiKey: fixtureKey,
              contextWindow: 1_000_000,
              maxTokens: 4096,
            },
            timeoutMs: 30_000,
            maxToolCalls: 0,
            createApp: (composio) =>
              createApp({
                databaseUrl: process.env.DATABASE_URL!,
                realtimeDatabaseUrl: process.env.DATABASE_URL!,
                authUrl: "http://127.0.0.1:5173",
                webOrigin: "http://127.0.0.1:5173",
                dataDir,
                sandboxProvider: "fake",
                agentRuntime: "pi",
                contextStrategy: strategy,
                wakeupDriver: "memory",
                signupsEnabled: "true",
                composio,
                encryptionKey: "synthetic-short-history-encryption-key",
              }),
          },
        );
        model.assertComplete();
        expect(result).toMatchObject({
          status: "passed",
          toolCalls: 0,
          modelCalls: 3,
          cleanupFailed: false,
        });
        expect(model.requests).toHaveLength(3);
        expect(result.historyPreparationState?.generation).toBe(0);
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
