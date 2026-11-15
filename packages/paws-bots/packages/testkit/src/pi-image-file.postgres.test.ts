import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const databaseAvailable = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const fixtureOrigin = "http://127.0.0.1:5173";

describe.skipIf(!databaseAvailable)("offline Pi product journey", () => {
  it("confirms an owned image as a file and completes text-only file-tool work", async () => {
    const fixtureKey = "offline-product-fixture-key";
    let attachmentPath = "";
    const model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: [
        {
          expect(request) {
            expect(JSON.stringify(request.messages)).toContain("image/png");
            expect(JSON.stringify(request.messages)).not.toContain("image_url");
            expect(JSON.stringify(request.messages)).toContain(attachmentPath);
          },
          response: () => ({
            type: "tool",
            id: "inspect-image-file",
            name: "shell",
            arguments: { command: `wc -c ${attachmentPath}` },
          }),
        },
        { expect() {}, response: { type: "text", text: "File workflow completed." } },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-offline-product-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
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
        encryptionKey: "offline-model-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixtureOrigin },
        body: JSON.stringify({
          email: `offline-pi-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
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
        name: "File fixture",
        title: "",
        description: "",
        instructions: "Complete the task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const artifact = await rpc<{ id: string }>(handles.app, cookie, "artifacts/create", {
        botId: bot.id,
        name: "picture.png",
        mimeType: "image/png",
        contentBase64: Buffer.from([137, 80, 78, 71]).toString("base64"),
      });
      attachmentPath = `attachments/${artifact.id}.png`;
      const input = {
        botId: bot.id,
        text: "Process the attached image as a file",
        artifactIds: [artifact.id],
        clientNonce: "image-file-confirmation",
      };
      const rejected = await handles.app.request("/rpc/threads/send", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: fixtureOrigin },
        body: JSON.stringify({ json: { ...input, imageHandling: "confirm" } }),
      });
      expect(rejected.status).toBe(409);
      expect(model.requests).toHaveLength(0);
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        ...input,
        imageHandling: "file",
      });
      await expect
        .poll(
          async () => {
            const run = await asSystem(handles.prisma).run.findUnique({
              where: { id: sent.runId },
              select: { status: true },
            });
            if (run?.status === "failed") model.assertComplete();
            return run?.status;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();
      const stored = await asSystem(handles.prisma).message.findFirst({
        where: { clientNonce: input.clientNonce },
        select: { blocks: true },
      });
      expect(stored?.blocks).toEqual(
        expect.arrayContaining([
          {
            kind: "file",
            artifactId: artifact.id,
            name: "picture.png",
            mimeType: "image/png",
            size: 4,
          },
        ]),
      );
      const imageFile = await rpc<{ contentBase64: string }>(
        handles.app,
        cookie,
        "computer/downloadFile",
        {
          botId: bot.id,
          path: `attachments/${artifact.id}.png`,
        },
      );
      expect(imageFile.contentBase64).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
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
