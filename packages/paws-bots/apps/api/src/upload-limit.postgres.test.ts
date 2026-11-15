import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discardBotIntroRun } from "../../../packages/testkit/src/discard-bot-intro.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "applies the configured upload and attachment count limits through the composed app",
  async () => {
    const maxUploadSizeBytes = 20 * 1024 * 1024;
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-upload-limit-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      maxUploadSizeBytes,
      maxAttachmentsPerMessage: 8,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      webOrigin: origin,
      authUrl: origin,
    });
    try {
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `upload-limit-${Date.now()}@example.test`,
          password: "test-password-123",
          name: "Upload tester",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      // Signed out, only `health` is callable, so a large body is discarded unread.
      const signedOut = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie: "session=forged" },
        body: JSON.stringify({ json: { padding: "a".repeat(1024 * 1024) } }),
      });
      expect(signedOut.status).toBe(401);
      const health = await handles.app.request("/rpc/health", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ json: {} }),
      });
      expect(health.status).toBe(200);
      const call = (procedure: string, json: unknown = {}) =>
        handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json }),
        });

      const me = await call("me");
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        json: { maxUploadSizeBytes, maxAttachmentsPerMessage: 8 },
      });

      const bot = await call("bots/create", {
        name: "Upload fixture",
        title: "",
        description: "",
        instructions: "Keep files.",
        notifyOnFinish: false,
      });
      expect(bot.status).toBe(200);
      const botId = ((await bot.json()) as { json: { id: string } }).json.id;
      await discardBotIntroRun(handles, cookie, botId);
      // Above the 10 MiB default, within the configured limit.
      const upload = await call("artifacts/create", {
        botId,
        name: "large.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.alloc(12 * 1024 * 1024, "a").toString("base64"),
      });
      expect(upload.status).toBe(200);
      const artifactIds: string[] = [];
      for (let i = 0; i < 9; i++) {
        const attachment = await call("artifacts/create", {
          botId,
          name: `${i}.txt`,
          mimeType: "text/plain",
          contentBase64: "YQ==",
        });
        expect(attachment.status).toBe(200);
        artifactIds.push(((await attachment.json()) as { json: { id: string } }).json.id);
      }
      const tooMany = await call("threads/send", { botId, artifactIds });
      expect(tooMany.status).toBe(400);
      const accepted = await call("threads/send", { botId, artifactIds: artifactIds.slice(0, 8) });
      expect(accepted.status).toBe(200);
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
