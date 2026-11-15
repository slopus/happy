import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { historyFixture } from "./evals/history-fixtures.js";
import { runTrial } from "./evals/runner.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("persisted source-verified history followups", () => {
  it.each([
    { size: 1000 as const, strategy: "snapshots" as const },
    { size: 1000 as const, strategy: undefined },
    { size: 100 as const, strategy: undefined },
  ])(
    "retains source-verified replies with $size originals and $strategy strategy",
    async ({ size, strategy }) => {
      const fixture = historyFixture(size, "exact");
      const questions = [
        fixture.ask,
        "What was that Aurora calibration label again?",
        "Repeat just the Aurora calibration label.",
      ];
      const verifiedReply = "Source-verified Aurora calibration label: ORBIT-731.";
      let originalId = "";
      const toolResult = (request: ModelEmulatorRequest) =>
        JSON.parse(String(request.messages.findLast((row) => row.role === "tool")?.content));
      const followup = (request: ModelEmulatorRequest, index: number) => {
        const serialized = JSON.stringify(request.messages);
        expect(serialized).toContain(questions[index]);
        // Earlier replies are replayed as assistant turns.
        expect(
          request.messages.filter(
            (row) =>
              row.role === "assistant" && JSON.stringify(row.content).includes(verifiedReply),
          ).length,
        ).toBe(index);
        expect(serialized).toContain("do not repeat retrieval solely because the user asks again");
      };
      const key = "synthetic-history-followup-key";
      const model = await startModelEmulator({
        apiKey: key,
        steps: [
          {
            expect(request) {
              expect(JSON.stringify(request.messages)).toContain(questions[0]);
            },
            response: {
              type: "tool",
              id: "lookup-calibration",
              name: "search_history",
              arguments: { query: "calibration" },
            },
          },
          {
            expect(request) {
              const result = toolResult(request);
              originalId = result.messages.find((row: { text: string }) =>
                row.text.includes("Aurora export project is ORBIT-731"),
              )?.messageId;
              expect(originalId).toBeTruthy();
            },
            response: () => ({
              type: "tool",
              id: "verify-original",
              name: "read_history",
              arguments: { messageId: originalId, limit: 1 },
            }),
          },
          {
            expect(request) {
              expect(
                toolResult(request).messages.find(
                  (row: { messageId: string }) => row.messageId === originalId,
                ).text,
              ).toContain("Aurora export project is ORBIT-731");
            },
            response: { type: "text", text: verifiedReply },
          },
          {
            expect(request) {
              followup(request, 1);
            },
            response: { type: "text", text: verifiedReply },
          },
          {
            expect(request) {
              followup(request, 2);
            },
            response: { type: "text", text: verifiedReply },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-history-followup-"));
      try {
        const { createApp } = await import("@rakazo/api/app");
        const result = await runTrial(
          {
            id: "synthetic-source-verified-followups",
            purpose:
              "Verify persisted source-backed prior replies remain available across repeated questions.",
            history: fixture,
            connections: [],
            steps: questions.map((ask) => ({ ask })),
            grade: (evidence) => [
              { id: "verified-label", pass: evidence.text.includes("ORBIT-731") },
            ],
          },
          1,
          {
            connection: {
              provider: model.model.provider,
              modelId: model.model.id,
              baseUrl: model.baseUrl,
              apiKey: key,
              contextWindow: 1_000_000,
              maxTokens: 4096,
            },
            timeoutMs: 30_000,
            maxToolCalls: 2,
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
                encryptionKey: "synthetic-history-followup-encryption-key",
              }),
          },
        );
        model.assertComplete();
        expect(result).toMatchObject({
          status: "passed",
          toolCalls: 2,
          modelCalls: 5,
          cleanupFailed: false,
        });
        expect(result.historyPreparationState).toMatchObject({
          generation: 0,
          beforeCursor: size === 1000 ? 949 : null,
          afterCursor: size === 1000 ? 949 : null,
        });
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
