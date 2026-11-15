import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { HISTORY_EVAL_CASES } from "./evals/cases.js";
import { runTrial } from "./evals/runner.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("product history diagnostic loop", () => {
  it("follows actual outgoing diagnostic cursors with the product default and full product instructions", async () => {
    const scenario = HISTORY_EVAL_CASES.find((row) => row.id === "history-1000-long-tool-loop")!;
    expect(scenario.history?.messages).toHaveLength(1000);
    expect(scenario.history?.summary).toBeDefined();
    const assistantProse = "Synthetic explanatory prose for protocol stress coverage. ".repeat(120);
    const inputEstimates: number[] = [];
    const selectedInputEstimates: number[] = [];
    const syntheticUsage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const observations: Array<{
      segment: number;
      bytes: number;
      keys: string[];
      omitted: boolean;
      outgoingBytes: number;
      toolResults: number;
    }> = [];
    let previousToolContent: string[] = [];
    const latest = (request: ModelEmulatorRequest) => {
      expect(JSON.stringify(request.messages)).toContain("Do not deploy.");
      const tools = request.messages.filter((row) => row.role === "tool");
      const parsed = tools.map(
        (row) =>
          JSON.parse(String(row.content)) as {
            segment: number;
            nextCursor: string | null;
            diagnostic: string;
          },
      );
      const latestSegment = parsed.at(-1)!.segment;
      expect(parsed.map((row) => row.segment)).toEqual(
        Array.from({ length: latestSegment }, (_, i) => i + 1),
      );
      const calls = request.messages.flatMap((row) => row.tool_calls ?? []);
      for (const [index, row] of tools.entries()) {
        const call = calls.find((entry) => entry.id === row.tool_call_id);
        expect(call?.function.name).toBe("CRM_READ_DIAGNOSTIC");
        expect(JSON.parse(call!.function.arguments).cursor).toBe(
          index === 0 ? "start" : parsed[index - 1]!.nextCursor,
        );
      }
      // Earlier results go out as first sent until a rebuild compresses them all at once.
      const toolContent = tools.map((row) => String(row.content));
      const earlier = toolContent.slice(0, -1);
      const compressed = (text: string) => Buffer.byteLength(text) <= 1024;
      expect(
        earlier.every((text, i) => text === previousToolContent[i]) ||
          (!previousToolContent.every(compressed) && earlier.every(compressed)),
      ).toBe(true);
      previousToolContent = toolContent;
      const message = tools.at(-1);
      const content = String(message?.content);
      const result = JSON.parse(content) as {
        segment: number;
        nextCursor: string | null;
        diagnostic: string;
        contextTruncated?: boolean;
      };
      observations.push({
        segment: result.segment,
        bytes: Buffer.byteLength(content),
        keys: Object.keys(result),
        omitted: Boolean(result.contextTruncated),
        outgoingBytes: Buffer.byteLength(JSON.stringify(request)),
        toolResults: request.messages.filter((row) => row.role === "tool").length,
      });
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(12_000);
      if (result.segment < 12) expect(result.contextTruncated).toBe(true);
      expect(result.segment).toBe(observations.length);
      expect(result).toHaveProperty("nextCursor");
      expect(typeof result.diagnostic).toBe("string");
      return result;
    };
    const fixtureKey = "synthetic-product-loop-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          usage: syntheticUsage,
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Read the Aurora diagnostic chain");
            expect(JSON.stringify(request.messages)).toContain(
              "Start with the project name alone, or one distinctive topic word if no project is named",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "Empty narrower queries do not exhaust the broader topic query’s matches.",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "first check the visible conversation",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "do not repeat retrieval solely because the user asks again",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "Do not claim evidence is unavailable while that broader search still has an unexplored cursor.",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "If the requested fact remains absent, say so briefly without volunteering adjacent facts.",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "If multiple projects match and none is selected, ask which project before giving candidate facts.",
            );
            expect(JSON.stringify(request.messages)).toContain(
              "Treat pagination cursors as opaque: copy the returned continuation value exactly, never calculate or guess it. When the tool reports no next page, stop; if a cursor is rejected, recheck the last successful result before retrying.",
            );
            expect(
              request.tools?.some((tool) => tool.function.name === "CRM_READ_DIAGNOSTIC"),
            ).toBe(true);
          },
          response: {
            type: "tool",
            id: "diagnostic-start",
            name: "CRM_READ_DIAGNOSTIC",
            arguments: { cursor: "start" },
            assistantText: assistantProse,
          },
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          usage: syntheticUsage,
          expect: () => {},
          response(request: ModelEmulatorRequest) {
            const result = latest(request);
            return result.nextCursor === null
              ? { type: "text" as const, text: result.diagnostic }
              : {
                  type: "tool" as const,
                  id: `diagnostic-follow-${index}`,
                  name: "CRM_READ_DIAGNOSTIC",
                  arguments: { cursor: result.nextCursor },
                  assistantText: assistantProse,
                };
          },
        })),
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-product-loop-"));
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
        timeoutMs: 40_000,
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
            runtime: new PiAgentRuntime({
              onContextDecision(decision) {
                selectedInputEstimates.push(decision.estimatedInputTokens);
              },
              modelCallObserver: {
                beforeCall(call) {
                  inputEstimates.push(call.inputTokensEstimate);
                  expect(call.inputTokensEstimate + call.maxOutputTokens).toBeLessThanOrEqual(
                    1_000_000,
                  );
                  return String(inputEstimates.length);
                },
                afterCall() {},
              },
            }),
            wakeupDriver: "memory",
            signupsEnabled: "true",
            composio,
            encryptionKey: "synthetic-product-loop-encryption-key",
          }),
      });
      model.assertComplete();
      expect(result).toMatchObject({ status: "passed", toolCalls: 12, cleanupFailed: false });
      expect(observations.map((row) => row.segment)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      expect(model.requests).toHaveLength(13);
      expect(inputEstimates).toHaveLength(13);
      expect(selectedInputEstimates).toHaveLength(13);
      expect(selectedInputEstimates.at(-1)!).toBeGreaterThan(selectedInputEstimates[0]! + 32_768);
      expect(selectedInputEstimates.every((estimate) => estimate <= 1_000_000 - 4096)).toBe(true);
      expect(observations.map((row) => row.toolResults)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      process.stdout.write(
        `Synthetic product diagnostic result shapes: ${JSON.stringify({ observations, inputEstimates, selectedInputEstimates })}\n`,
      );
    } finally {
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
