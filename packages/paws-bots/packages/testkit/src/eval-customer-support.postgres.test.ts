import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "./evals/cases.js";
import { runTrial } from "./evals/runner.js";
import { EvalSandboxProvider } from "./evals/sandbox.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!databaseAvailable)("offline Slack customer-support eval", () => {
  it("runs the messaging, Salesforce, Zendesk, and reply path through the product", async () => {
    const fixtureKey = "offline-customer-support-key";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("Fairhaven Robotics");
            expect(request.tools?.map((entry) => entry.function.name)).toEqual(
              expect.arrayContaining([
                "SALESFORCE_SEARCH_ACCOUNTS",
                "SALESFORCE_LIST_OPPORTUNITIES",
                "ZENDESK_SEARCH_ORGANIZATIONS",
                "ZENDESK_LIST_TICKETS",
              ]),
            );
          },
          response: {
            type: "tool",
            id: "salesforce-search",
            name: "SALESFORCE_SEARCH_ACCOUNTS",
            arguments: { query: "Fairhaven Robotics" },
          },
        },
        toolStep(
          "SALESFORCE_LIST_OPPORTUNITIES",
          "salesforce-opportunities",
          { accountId: "sf-fairhaven-robotics" },
          "sf-fairhaven-robotics",
        ),
        toolStep(
          "ZENDESK_SEARCH_ORGANIZATIONS",
          "zendesk-search",
          {
            query: "Fairhaven Robotics",
          },
          "Negotiation",
        ),
        toolStep(
          "ZENDESK_LIST_TICKETS",
          "zendesk-tickets",
          { organizationId: "zd-fairhaven-robotics" },
          "zd-fairhaven-robotics",
        ),
        {
          expect(request) {
            const result = request.messages.findLast((message) => message.role === "tool");
            expect(result?.tool_call_id).toBe("zendesk-tickets");
            expect(String(result?.content)).toContain("ZD-1842");
          },
          response: {
            type: "text",
            text: "Casey Morgan owns the renewal, now in Negotiation. Urgent ticket ZD-1842 covers the production SSO incident, and engineering is testing a configuration fix.",
          },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-customer-eval-"));
    try {
      const { createApp } = await import("@rakazo/api/app");
      const scenario = EVAL_CASES.find((candidate) => candidate.id === "slack-customer-update")!;
      const result = await runTrial(scenario, 1, {
        connection: {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        },
        timeoutMs: 20_000,
        maxToolCalls: 8,
        createApp: (composio, messaging) => {
          const sandbox = new EvalSandboxProvider();
          return createApp({
            sandbox,
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
            messagingOpenSignup: false,
            cloudAgentProvider: "none",
            encryptionKey: "offline-customer-eval-encryption-key",
          });
        },
      });

      model.assertComplete();
      expect(
        model.requests.some((request) =>
          JSON.stringify(request.messages).includes("You were just created"),
        ),
      ).toBe(false);
      expect(result).toMatchObject({
        status: "passed",
        category: null,
        cleanupFailed: false,
        toolCalls: 4,
      });
      expect(result.criteria.every((criterion) => criterion.pass)).toBe(true);
    } finally {
      try {
        await model.close();
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

function toolStep(name: string, id: string, args: Record<string, unknown>, priorResult?: string) {
  return {
    expect(request: ModelEmulatorRequest) {
      if (priorResult) {
        const result = request.messages.findLast((message) => message.role === "tool");
        expect(String(result?.content)).toContain(priorResult);
      }
    },
    response: { type: "tool" as const, id, name, arguments: args },
  };
}
