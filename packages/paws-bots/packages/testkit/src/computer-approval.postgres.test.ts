import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient, FakeSandboxProvider } from "@rakazo/adapters";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi computer approval", () => {
  beforeAll(() => {
    // Use the existing compatible-endpoint capability declaration so the real
    // executor exposes computer tools without mocking its model vision gate.
    vi.stubEnv("RAKAZO_OPENAI_COMPATIBLE_VISION_MODELS", "offline-fixture");
  });
  afterAll(() => vi.unstubAllEnvs());

  it.each(["allow", "deny"] as const)(
    "%s enforces the persisted computer action before any sandbox effect",
    async (answer) => {
      let sandbox: FakeSandboxProvider;
      const approvedArgs = {
        actions: [{ kind: "type", text: "approved clipboard content" }],
        observe: false,
        settle_ms: 0,
      };
      const resultStep =
        (id: string): ModelEmulatorStep["expect"] =>
        (request) => {
          const result = request.messages.findLast((message) => message.role === "tool");
          expect(result?.tool_call_id).toBe(id);
          const body = JSON.parse(String(result?.content));
          if (answer === "allow") expect(body).toMatchObject({ ok: true, completed: 1 });
          else expect(JSON.stringify(body)).toMatch(/denied/i);
          // Inspect the provider state while the run still owns its screen;
          // completed runs release that screen and discard its placeholder state.
          const screens = [...sandbox.boxes.values()].flatMap((box) => [...box.screens.values()]);
          expect(screens).not.toContain("unapproved replacement");
          if (answer === "allow") expect(screens).toContain("approved clipboard content");
          else expect(screens).not.toContain("approved clipboard content");
        };
      const fixtureKey = "offline-computer-approval-key";
      const model = await startModelEmulator({
        apiKey: fixtureKey,
        steps: [
          {
            expect(request) {
              expect(request.tools).toContainEqual(
                expect.objectContaining({
                  function: expect.objectContaining({ name: "computer_act" }),
                }),
              );
            },
            response: {
              type: "tool",
              id: "pending-action",
              name: "computer_act",
              arguments: approvedArgs,
            },
          },
          {
            // Restore the original pending call before another model choice.
            expect: resultStep("pending-action"),
            response: { type: "text", text: "Finished the approval fixture." },
          },
        ],
      });
      const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-approval-"));
      let stop: (() => Promise<void>) | undefined;
      try {
        const { createApp } = await import("@rakazo/api/app");
        const handles = await createApp({
          databaseUrl: process.env.DATABASE_URL!,
          realtimeDatabaseUrl: process.env.DATABASE_URL!,
          authUrl: fixtureOrigin,
          webOrigin: fixtureOrigin,
          dataDir,
          sandboxProvider: "fake",
          agentRuntime: "pi",
          wakeupDriver: "memory",
          signupsEnabled: "true",
          composio: new ComposioConnector({ client: new FakeComposioClient() }),
          encryptionKey: "offline-computer-fixture-encryption-key",
        });
        stop = handles.stop;
        const db = asSystem(handles.prisma);
        expect(handles.sandbox).toBeInstanceOf(FakeSandboxProvider);
        sandbox = handles.sandbox as FakeSandboxProvider;
        // Keep the real fake-provider implementation; observe calls and its state
        // independently of the model's claims and the persisted effect record.
        const act = vi.spyOn(sandbox, "act");
        const signup = await handles.app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin: fixtureOrigin },
          body: JSON.stringify({
            email: `computer-approval-${randomUUID()}@rakazo.test`,
            password: "password12",
            name: "Computer approval fixture",
          }),
        });
        expect(signup.status).toBeLessThan(400);
        const cookie = sessionCookieHeader(signup);
        await rpc(handles.app, cookie, "models/connect", {
          provider: model.model.provider,
          modelId: model.model.id,
          baseUrl: model.baseUrl,
          apiKey: fixtureKey,
          contextWindow: 160_000,
          maxTokens: 4096,
        });
        const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
          name: "Computer fixture",
          title: "",
          description: "",
          instructions: "Complete the computer task.",
          notifyOnFinish: false,
        });
        await discardBotIntroRun(handles, cookie, bot.id);
        await rpc(handles.app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
        const storedBot = await db.bot.findUniqueOrThrow({ where: { id: bot.id } });
        await db.userActionApprovalRule.create({
          data: {
            userId: storedBot.userId,
            effect: "require_approval",
            matchKind: "tool",
            matchValue: "computer_act",
          },
        });
        const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
          botId: bot.id,
          text: "Put approved clipboard content on the computer clipboard.",
        });
        const waitForRun = async (status: string) => {
          await expect
            .poll(
              async () => {
                const run = await db.run.findUniqueOrThrow({
                  where: { id: sent.runId },
                });
                if (run.status === "failed") model.assertComplete();
                return run.status;
              },
              { timeout: 15_000, interval: 100 },
            )
            .toBe(status);
        };
        await waitForRun("waiting_input");
        expect(model.requests).toHaveLength(1);
        expect(act).not.toHaveBeenCalled();
        const effects = await db.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(effects).toHaveLength(2);
        expect(effects.find((effect) => effect.kind === "runtime_checkpoint")).toMatchObject({
          status: "runtime_checkpoint",
          request: {},
        });
        const actionEffect = effects.find((effect) => effect.kind === "computer_act")!;
        expect(actionEffect).toMatchObject({
          kind: "computer_act",
          status: "intended",
          request: approvedArgs,
        });
        const card = await db.message.findFirstOrThrow({
          where: { runId: sent.runId, role: "bot" },
          orderBy: { seq: "desc" },
        });
        expect(card.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "ask", approvalEffectId: actionEffect.id }),
          ]),
        );
        await rpc(handles.app, cookie, "threads/answer", {
          botId: bot.id,
          runId: sent.runId,
          messageId: card.id,
          answer,
        });
        await waitForRun("completed");
        model.assertComplete();
        expect(act).toHaveBeenCalledTimes(answer === "allow" ? 1 : 0);
        if (answer === "allow") {
          expect(act.mock.calls[0]![1]).toEqual({
            actions: [{ kind: "clipboard", text: "approved clipboard content" }],
            observe: false,
            settleMs: 0,
          });
        }
        const settledEffects = await db.externalEffect.findMany({
          where: { runId: sent.runId },
        });
        expect(settledEffects).toHaveLength(1);
        expect(settledEffects[0]).toMatchObject({
          id: actionEffect.id,
          status: answer === "allow" ? "completed" : "denied",
          request: approvedArgs,
        });
      } finally {
        try {
          await stop?.();
        } finally {
          await model.close();
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    },
    45_000,
  );
});

async function rpc<T>(
  app: App,
  cookie: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
    body: JSON.stringify({ json: input }),
  });
  const body = (await response.json()) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || body.error)
    throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
  return body.json as T;
}
