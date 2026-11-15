import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HistorySearchInput } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { historyFixture } from "./evals/history-fixtures.js";
import { runTrial } from "./evals/runner.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("unfinished broad history search", () => {
  it("validates boundaries and follows the original continuation after a narrower empty query", async () => {
    const filters = { after: "2026-01-01T00:00:00Z", before: "2026-02-01T00:00:00Z" };
    const fixture = historyFixture(1000, "paraphrase");
    const normalizedFilters = {
      after: "2026-01-01T00:00:00.000Z",
      before: "2026-02-01T00:00:00.000Z",
    };
    let nextSearch: HistorySearchInput | undefined;
    let originalId = "";
    const latest = (request: ModelEmulatorRequest) => {
      const text = String(request.messages.findLast((row) => row.role === "tool")?.content);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(10000);
      return JSON.parse(text);
    };
    const key = "synthetic-history-continuation-key";
    const model = await startModelEmulator({
      apiKey: key,
      steps: [
        {
          expect(request) {
            expect(request).toMatchObject({ max_completion_tokens: 4096 });
            expect(JSON.stringify(request.messages)).toContain(
              "call search_history with those arguments",
            );
            expect(JSON.stringify(request.messages)).toContain(fixture.ask);
          },
          response: {
            type: "tool",
            id: "invalid-date-history",
            name: "search_history",
            arguments: { query: "Aurora", before: "2026-02-30" },
          },
        },
        {
          expect(request) {
            expect(
              String(request.messages.findLast((row) => row.role === "tool")?.content),
            ).toContain("ISO date");
          },
          response: {
            type: "tool",
            id: "broad-history",
            name: "search_history",
            arguments: { query: "Aurora", ...filters },
          },
        },
        {
          expect(request) {
            const result = latest(request);
            expect(result.query).toBe("Aurora");
            expect(result.coverage).toEqual({
              scope: "requested_query_and_range",
              status: "partial",
            });
            expect(result.messages).toHaveLength(5);
            expect(result.nextBeforeSeq).toBe(8);
            expect(result.nextSearch).toEqual({
              query: "Aurora",
              beforeSeq: 8,
              limit: 5,
              ...normalizedFilters,
            });
            nextSearch = result.nextSearch;
          },
          response: {
            type: "tool",
            id: "narrow-history",
            name: "search_history",
            arguments: { query: "extraction", ...filters },
          },
        },
        {
          expect(request) {
            const result = latest(request);
            expect(result).toMatchObject({
              query: "extraction",
              messages: [],
              coverage: { scope: "requested_query_and_range", status: "exhausted" },
              nextSearch: null,
            });
            const broad = request.messages
              .filter((row) => row.role === "tool")
              .map((row) => {
                try {
                  return JSON.parse(String(row.content));
                } catch {
                  return null;
                }
              })
              .find((result) => result?.query === "Aurora");
            expect(broad.nextSearch).toEqual(nextSearch);
            expect(broad.coverage.status).toBe("partial");
          },
          response: () => ({
            type: "tool",
            id: "continue-broad-history",
            name: "search_history",
            arguments: { ...nextSearch! },
          }),
        },
        {
          expect(request) {
            const result = latest(request);
            expect(result.query).toBe("Aurora");
            expect(result.coverage.status).toBe("exhausted");
            expect(result.nextSearch).toBeNull();
            originalId = result.messages.find((row: { text: string }) =>
              row.text.includes("Aurora export project is ORBIT-731"),
            )?.messageId;
            expect(originalId).toBeTruthy();
          },
          response: () => ({
            type: "tool",
            id: "read-original-history",
            name: "read_history",
            arguments: { messageId: originalId, limit: 1 },
          }),
        },
        {
          expect(request) {
            expect(
              latest(request).messages.find(
                (row: { messageId: string }) => row.messageId === originalId,
              ).text,
            ).toContain("Aurora export project is ORBIT-731");
          },
          response: { type: "text", text: "ORBIT-731" },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-history-continuation-"));
    try {
      const { createApp } = await import("@rakazo/api/app");
      const result = await runTrial(
        {
          id: "synthetic-history-continuation",
          purpose: "Keep an unfinished broader query actionable after a narrower empty lookup.",
          history: fixture,
          connections: [],
          steps: [{ ask: fixture.ask }],
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
            apiKey: key,
            contextWindow: 1000000,
            maxTokens: 4096,
          },
          timeoutMs: 30000,
          maxToolCalls: 5,
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
              encryptionKey: "synthetic-history-continuation-encryption-key",
            }),
        },
      );
      model.assertComplete();
      expect(result).toMatchObject({
        status: "passed",
        toolCalls: 5,
        modelCalls: 6,
        cleanupFailed: false,
      });
      expect(result.historyPreparationState).toMatchObject({
        generation: 0,
        beforeCursor: 949,
        afterCursor: 949,
      });
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 45000);
});
