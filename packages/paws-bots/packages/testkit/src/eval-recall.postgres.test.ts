import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Evidence } from "./evals/cases.js";
import { RECALL_EVAL_CASES } from "./evals/recall.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ObservedToolCall } from "./evals/tool-calls.js";
import { observeToolCalls } from "./evals/tool-calls.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureKey = "offline-recall-eval-key";
const lastTool = (request: ModelEmulatorRequest) =>
  JSON.parse(String(request.messages.findLast((m) => m.role === "tool")?.content));

/** Search for the lease, then read it from its path or answer without opening it. */
function findLease(read: boolean): ModelEmulatorStep[] {
  let leasePath = "";
  return [
    {
      expect() {},
      response: { type: "tool", id: "find", name: "search_history", arguments: { query: "lease" } },
    },
    {
      expect(request) {
        const [hit] = lastTool(request).messages;
        expect(hit.attachments).toEqual([
          expect.objectContaining({ name: "lisbon-office-lease.md" }),
        ]);
        leasePath = hit.attachments[0].path;
      },
      response: () =>
        read
          ? { type: "tool" as const, id: "read", name: "read_file", arguments: { path: leasePath } }
          : { type: "text" as const, text: "Probably 60 days." },
    },
    ...(read
      ? [
          {
            expect(request: ModelEmulatorRequest) {
              expect(JSON.stringify(lastTool(request))).toContain("Notice period to end the lease");
            },
            response: { type: "text" as const, text: "The Lisbon lease you sent says 90 days." },
          },
        ]
      : []),
  ];
}

describe.skipIf(!databaseAvailable)("recall eval through the product", () => {
  it.each([
    { id: "recall-old-file-uncaptioned", read: true },
    { id: "recall-old-file-uncaptioned", read: false },
  ])(
    "$id passes=$read",
    async ({ id, read }) => {
      const judge = vi.fn(async () => ({ pass: true, reason: "Offline fixture verdict" }));
      const scenario = RECALL_EVAL_CASES.find((c) => c.id === id)!;
      const model = await startModelEmulator({ apiKey: fixtureKey, steps: findLease(read) });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-recall-eval-"));
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
                encryptionKey: "offline-recall-eval-encryption-key-32-chars",
              });
              return { ...handles, toolCallObservations };
            },
          },
        );
        model.assertComplete();
        expect(result.reason, JSON.stringify(result)).toBe(read ? null : "Outcome criteria failed");
        expect(result.cleanupFailed).toBe(false);
        expect(result.criteria).toContainEqual({ id: "read-earlier-file", pass: read });
        // The judge grades meaning only once every deterministic effect holds.
        if (read) expect(judge).toHaveBeenCalledWith(scenario.judge!(evidence!), expect.anything());
        else expect(judge).not.toHaveBeenCalled();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
