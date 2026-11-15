import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";
const LEASE = "Synthetic lease. Notice period: 90 days. Monthly rent: 4,200.";

const lastToolResult = (request: ModelEmulatorRequest) =>
  JSON.parse(String(request.messages.findLast((message) => message.role === "tool")?.content));

describe.skipIf(!enabled)("earlier files through history tools", () => {
  it("finds a file shared before the recent turns and reads it on the computer", async () => {
    let leasePath = "";
    let leaseId = "";
    const model = await startModelEmulator({
      steps: [
        {
          expect(request) {
            // Older than the recent attachment turns, so the prompt names the file but not its path.
            const prompt = JSON.stringify(request.messages);
            expect(prompt).toContain("lisbon-office-lease.md");
            expect(prompt).not.toContain(leaseId);
          },
          response: {
            type: "tool",
            id: "find-lease",
            name: "search_history",
            arguments: { query: "lease" },
          },
        },
        {
          expect(request) {
            const [hit] = lastToolResult(request).messages;
            expect(hit.attachments).toEqual([
              expect.objectContaining({
                name: "lisbon-office-lease.md",
                mimeType: "text/markdown",
              }),
            ]);
            leasePath = hit.attachments[0].path;
            expect(leasePath).toBe(`attachments/${leaseId}.md`);
          },
          response: () => ({
            type: "tool" as const,
            id: "read-lease",
            name: "read_file",
            arguments: { path: leasePath },
          }),
        },
        {
          expect(request) {
            expect(JSON.stringify(lastToolResult(request))).toContain("Notice period: 90 days");
          },
          response: { type: "text", text: "The lease requires 90 days of notice." },
        },
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-history-files-"));
    let stop: (() => Promise<void>) | undefined;
    try {
      const { createApp } = await import("@rakazo/api/app");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "pi",
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioConnector({ client: new FakeComposioClient() }),
        encryptionKey: "history-files-fixture-encryption-key",
      });
      stop = handles.stop;
      const db = asSystem(handles.prisma);
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `history-files-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "History files fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, origin },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json: T; error?: { message: string } };
        if (response.status >= 400 || body.error)
          throw new Error(`${procedure}: ${body.error?.message ?? JSON.stringify(body)}`);
        return body.json;
      };
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Files fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await handles.awaitIdle?.();
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const upload = (name: string, content: string) =>
        rpc<{ id: string; name: string; mimeType: string; size: number }>("artifacts/create", {
          botId: bot.id,
          name,
          mimeType: "text/markdown",
          contentBase64: Buffer.from(content).toString("base64"),
        });
      const fileBlock = (file: { id: string; name: string; mimeType: string; size: number }) => ({
        kind: "file",
        artifactId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      });
      const lease = await upload("lisbon-office-lease.md", LEASE);
      leaseId = lease.id;
      // Three later turns with files push the lease out of the recent attachment window.
      const later = [];
      for (const index of [1, 2, 3]) later.push(await upload(`weekly-${index}.md`, "Filler."));
      const thread = await db.thread.findFirstOrThrow({ where: { botId: bot.id } });
      await db.message.create({
        data: {
          threadId: thread.id,
          seq: 0,
          role: "user",
          blocks: [{ kind: "text", text: "Signed copy attached." }, fileBlock(lease)],
        },
      });
      for (const [index, file] of later.entries())
        await db.message.create({
          data: {
            threadId: thread.id,
            seq: index + 1,
            role: "user",
            blocks: [{ kind: "text", text: "Weekly update." }, fileBlock(file)],
          },
        });
      await db.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: 4 } });
      const run = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "What notice period does the office lease I sent require?",
      });
      await expect
        .poll(
          async () => {
            const status = (await db.run.findUnique({ where: { id: run.runId } }))?.status;
            if (status === "failed") model.assertComplete();
            return status;
          },
          { timeout: 15000, interval: 100 },
        )
        .toBe("completed");
      model.assertComplete();
    } finally {
      await stop?.();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
