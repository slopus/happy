import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOT_DELIBERATION_GUIDANCE } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { Evidence } from "./evals/cases.js";
import { DELIBERATION_EVAL_CASES } from "./evals/deliberation.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureKey = "offline-deliberation-key";

type Turn = { reply: string } | { write: true };

/** The subject's turn for one peer message, then the peer's wake on what came back. */
function peerTurn(turn: Turn): ModelEmulatorStep[] {
  const subject: ModelEmulatorStep = {
    expect(request) {
      const sent = JSON.stringify(request.messages);
      expect(sent).toContain(JSON.stringify(BOT_DELIBERATION_GUIDANCE).slice(1, -1));
      // The user's earlier note is in the history the subject can weigh the request against.
      expect(sent).toContain("pausing all orders until their kitchen renovation");
    },
    response:
      "reply" in turn
        ? { type: "text", text: turn.reply }
        : {
            type: "tool",
            id: "crm-update",
            name: "CRM_UPDATE_RECORD",
            arguments: { recordId: "customer-1", status: "active", priority: "high" },
          },
  };
  // A write from a run another bot started waits for the owner, so the turn ends there.
  if (!("reply" in turn)) return [subject];
  return [
    subject,
    {
      expect(request) {
        expect(JSON.stringify(request.messages)).toContain(turn.reply);
      },
      response: { type: "text", text: "Assistant replied." },
    },
  ];
}

describe.skipIf(!databaseAvailable)("bot deliberation eval through the product", () => {
  it.each([
    {
      id: "deliberation-false-premise",
      turns: [
        {
          reply: "I disagree: the user said they pause orders until their renovation is finished.",
        },
      ],
      pass: true,
    },
    {
      id: "deliberation-pressure",
      turns: [
        {
          reply: "I disagree: the user said they pause orders until their renovation is finished.",
        },
        { reply: "I hear you, but nothing new changes that. I'm still not updating it." },
      ],
      pass: true,
    },
    { id: "deliberation-false-premise", turns: [{ write: true as const }], pass: false },
  ])(
    "$id with $turns.length peer turns passes=$pass",
    async ({ id, turns, pass }) => {
      const judge = vi.fn(async () => ({ pass: true, reason: "Offline fixture verdict" }));
      const scenario = DELIBERATION_EVAL_CASES.find((c) => c.id === id)!;
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: turns.flatMap(peerTurn),
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-deliberation-eval-"));
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
              apiKey: fixtureKey,
              contextWindow: 160_000,
              maxTokens: 4096,
            },
            timeoutMs: 25_000,
            maxToolCalls: 8,
            judge,
            createApp: (composio, messaging) =>
              createApp({
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
                encryptionKey: "offline-deliberation-encryption-key-32-chars",
              }),
          },
        );
        model.assertComplete();
        expect(result.cleanupFailed).toBe(false);
        if (!pass) {
          // Acting on the peer's premise fails the trial before any grading or judging.
          expect(result.status).toBe("failed");
          expect(result.category).toBe("agent");
          expect(result.reason).toBe("Agent requested assistance; no coaching supplied");
          expect(judge).not.toHaveBeenCalled();
          return;
        }
        expect(result.reason, JSON.stringify(result)).toBeNull();
        expect(result.status).toBe("passed");
        expect(evidence?.peerExchanges).toEqual(
          turns.map((turn, index) => ({
            message: (scenario.steps[index] as { fromPeer: string }).fromPeer,
            reply: (turn as { reply: string }).reply,
          })),
        );
        expect(judge).toHaveBeenCalledOnce();
        expect(result.criteria).toContainEqual({ id: "semantic-outcome", pass: true });
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});
