import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Evidence } from "./evals/cases.js";
import { FULL_MEMORY_SEED, MEMORY_EVAL_CASES } from "./evals/memory.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ObservedToolCall } from "./evals/tool-calls.js";
import { observeToolCalls } from "./evals/tool-calls.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureKey = "offline-memory-eval-key";
const prompt = (request: ModelEmulatorRequest) => JSON.stringify(request.messages);
const lastTool = (request: ModelEmulatorRequest) =>
  request.messages.findLast((m) => m.role === "tool");

/** One remember call, then a reply once its result is back. */
function save(
  id: string,
  args: { content: string; old_text?: string },
  before: (request: ModelEmulatorRequest) => void,
  reply?: string,
): ModelEmulatorStep[] {
  return [
    {
      expect: before,
      response: { type: "tool", id, name: "remember", arguments: args },
    },
    ...(reply
      ? [
          {
            expect(request: ModelEmulatorRequest) {
              expect(lastTool(request)?.tool_call_id).toBe(id);
              expect(JSON.parse(String(lastTool(request)?.content))).toMatchObject({ ok: true });
            },
            response: { type: "text" as const, text: reply },
          },
        ]
      : []),
  ];
}

function movedCity(rewrite: boolean): ModelEmulatorStep[] {
  return [
    ...save(
      "save-london",
      { content: "Lives in London." },
      (r) => expect(prompt(r)).toContain("I live in London"),
      "Noted.",
    ),
    ...save(
      "save-berlin",
      rewrite
        ? { content: "Lives in Berlin (moved from London).", old_text: "Lives in London." }
        : { content: "Moved to Berlin." },
      (r) => {
        expect(prompt(r)).toContain("Lives in London.");
        expect(prompt(r)).not.toContain("I live in London");
      },
      "Got it.",
    ),
    {
      expect(r) {
        expect(prompt(r).includes("Lives in London.")).toBe(!rewrite);
        expect(prompt(r)).toContain(rewrite ? "Lives in Berlin (moved from London)." : "Berlin");
      },
      response: { type: "text", text: "You live in Berlin." },
    },
  ];
}

const duplicate = FULL_MEMORY_SEED.split("\n").find((line) =>
  line.startsWith("The user restated"),
)!;
function fullMemory(consolidate: boolean): ModelEmulatorStep[] {
  const first: ModelEmulatorStep = {
    expect(r) {
      expect(prompt(r)).toContain("of 4096 bytes");
    },
    response: {
      type: "tool",
      id: "save-code",
      name: "remember",
      arguments: { content: "Office door code: 5829" },
    },
  };
  const refused = (r: ModelEmulatorRequest) => {
    const result = JSON.parse(String(lastTool(r)?.content));
    expect(result.error).toContain("Memory is full");
    expect(result.entries).toContain(duplicate);
  };
  if (!consolidate)
    return [first, { expect: refused, response: { type: "text", text: "Saved your code." } }];
  return [
    first,
    {
      expect: refused,
      response: {
        type: "tool",
        id: "drop-duplicate",
        name: "remember",
        arguments: { content: "", old_text: duplicate },
      },
    },
    ...save(
      "save-code-again",
      { content: "Office door code: 5829" },
      (r) => expect(JSON.parse(String(lastTool(r)?.content))).toMatchObject({ ok: true }),
      "Saved your door code.",
    ),
  ];
}

describe.skipIf(!databaseAvailable)("memory eval through the product", () => {
  it.each([
    { id: "memory-moved-city", steps: () => movedCity(true), pass: true },
    { id: "memory-moved-city", steps: () => movedCity(false), pass: false },
    { id: "memory-full", steps: () => fullMemory(true), pass: true },
    { id: "memory-full", steps: () => fullMemory(false), pass: false },
  ])(
    "$id passes=$pass",
    async ({ id, steps, pass }) => {
      const judge = vi.fn(async () => ({ pass: true, reason: "Offline fixture verdict" }));
      const scenario = MEMORY_EVAL_CASES.find((c) => c.id === id)!;
      const model = await startModelEmulator({ apiKey: fixtureKey, steps: steps() });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-memory-eval-"));
      let evidence: Evidence | undefined;
      try {
        const { createApp } = await import("@rakazo/api/app");
        const { PiAgentRuntime } = await import("@rakazo/adapters");
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
              apiKey: fixtureKey,
              contextWindow: 160_000,
              maxTokens: 4096,
            },
            timeoutMs: 30_000,
            maxToolCalls: 8,
            judge,
            createApp: async (composio, messaging) => {
              const toolCallObservations: ObservedToolCall[] = [];
              const handles = await createApp({
                runtime: observeToolCalls(new PiAgentRuntime(), toolCallObservations, []),
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
                encryptionKey: "offline-memory-eval-encryption-key-32-chars",
              });
              return { ...handles, toolCallObservations };
            },
          },
        );
        model.assertComplete();
        expect(result.reason, JSON.stringify(result)).toBe(pass ? null : "Outcome criteria failed");
        expect(result.status).toBe(pass ? "passed" : "failed");
        expect(result.cleanupFailed).toBe(false);
        if (id === "memory-moved-city") {
          expect(result.criteria).toContainEqual({ id: "first-entry-rewritten", pass });
          expect(evidence?.memory.includes("Lives in London.")).toBe(!pass);
        } else {
          expect(result.criteria).toContainEqual({ id: "new-fact-saved", pass });
          expect(result.criteria).toContainEqual({ id: "memory-within-cap", pass: true });
          if (pass) expect(evidence?.memory).not.toContain(duplicate);
        }
        // The judge grades meaning only once every deterministic effect holds.
        if (pass) expect(judge).toHaveBeenCalledWith(scenario.judge!(evidence!), expect.anything());
        else expect(judge).not.toHaveBeenCalled();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
