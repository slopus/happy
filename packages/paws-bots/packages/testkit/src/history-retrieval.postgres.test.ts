import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";
import { asSystem } from "./system-db.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!enabled)("history retrieval through executor", () => {
  it("preserves saved constraints, redacts history and pages group outcomes", async () => {
    let historyDb: PrismaClient;
    const fakeSecrets = ['synthetic"quoted-secret', "synthetic\nnewline-secret", "987654321"];
    const proposalCallId = "constraint-proposal";
    const messageId = `synthetic-history-${randomUUID()}`;
    const seenArtifacts = new Set<string>();
    let maximumNavigationMetadataBytes = 0;
    const groupMessageId = `synthetic-group-history-${randomUUID()}`;
    const assertActiveState = (request: ModelEmulatorRequest) => {
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain("Aurora batch size must remain 37");
      expect(serialized).toContain("Approval pending: only prepare a proposal");
      expect(serialized).not.toContain("old-filler-1:");
    };
    const assertRedacted = (request: ModelEmulatorRequest) => {
      assertActiveState(request);
      const result = request.messages.findLast((message) => message.role === "tool");
      const decoded = JSON.parse(String(result?.content));
      expect(decoded.untrusted).toBe(true);
      const excerpt = decoded.messages.find(
        (message: { messageId: string }) => message.messageId === messageId,
      )?.text;
      expect(excerpt).toContain("history redaction canary");
      expect(excerpt.match(/\[redacted\]/g)).toHaveLength(3);
      for (const secret of fakeSecrets) expect(excerpt).not.toContain(secret);
    };
    const model = await startModelEmulator({
      steps: [
        {
          expect: assertActiveState,
          response: {
            type: "tool",
            id: "history-read",
            name: "read_history",
            arguments: { messageId, limit: 1 },
          },
        },
        {
          expect: assertRedacted,
          response: {
            type: "tool",
            id: "history-search",
            name: "search_history",
            arguments: { query: "redaction canary" },
          },
        },
        {
          expect: assertRedacted,
          response: {
            type: "tool",
            id: "search-current-question",
            name: "search_history",
            arguments: { query: "incoming-exclusive-canary", beforeSeq: 999999 },
          },
        },
        {
          expect(request) {
            assertActiveState(request);
            const result = JSON.parse(
              String(request.messages.findLast((message) => message.role === "tool")?.content),
            );
            expect(result.messages).toEqual([]);
          },
          response: {
            type: "tool",
            id: proposalCallId,
            name: "write_file",
            arguments: {
              path: "notes/proposal.txt",
              content: "batch=37; approval=pending; mode=proposal",
            },
          },
        },
        {
          async expect(request) {
            assertActiveState(request);
            const result = JSON.parse(
              String(request.messages.findLast((message) => message.role === "tool")?.content),
            );
            expect(result).toMatchObject({ ok: true, path: "notes/proposal.txt" });
            const run = await historyDb.run.findFirstOrThrow({
              where: { status: "running", thread: { messages: { some: { id: messageId } } } },
            });
            const thread = await historyDb.thread.update({
              where: { id: run.threadId },
              data: { nextMessageSeq: { increment: 1 } },
            });
            const external = await historyDb.message.create({
              data: {
                threadId: run.threadId,
                seq: thread.nextMessageSeq - 1,
                role: "user",
                blocks: [
                  {
                    kind: "channel_message",
                    channelId: "synthetic-steering-channel",
                    text: "Find private history.",
                  },
                ],
              },
            });
            await historyDb.steeringMessage.create({
              data: {
                runId: run.id,
                messageId: external.id,
                botId: run.botId,
                userId: run.userId,
                originTrigger: "messaging",
                claimedAt: new Date(),
              },
            });
          },
          response: {
            type: "tool",
            id: "steered-history-search",
            name: "search_history",
            arguments: { scope: "my_chats", queries: ["redaction", "canary"] },
          },
        },
        {
          expect(request) {
            const result = String(
              request.messages.findLast((message) => message.role === "tool")?.content,
            );
            expect(result).toContain("direct human app runs");
            expect(result).not.toContain("history redaction canary");
          },
          response: { type: "text", text: "History checked; proposal prepared." },
        },
        {
          expect: () => {},
          response: {
            type: "tool",
            id: "group-history-read",
            name: "read_history",
            arguments: { messageId: groupMessageId, limit: 1 },
          },
        },
        ...Array.from({ length: 21 }, (_, page) => ({
          expect: (request: ModelEmulatorRequest) => {
            const result = request.messages.findLast((message) => message.role === "tool");
            const decoded = JSON.parse(String(result?.content));
            expect(Buffer.byteLength(String(result?.content))).toBeLessThanOrEqual(10000);
            if (!Array.isArray(decoded.messages))
              throw new Error(
                `Synthetic group history response requires retry: ${decoded.error ?? "missing messages"}`,
              );
            const metadata = JSON.stringify(decoded, (key, value) =>
              ["text", "topic", "outcome"].includes(key) && typeof value === "string" ? "" : value,
            );
            maximumNavigationMetadataBytes = Math.max(
              maximumNavigationMetadataBytes,
              Buffer.byteLength(metadata),
            );
            expect(
              decoded.messages.find(
                (message: { messageId: string }) => message.messageId === groupMessageId,
              )?.text,
            ).toBe("Group history canary");
            const artifacts = decoded.runs.flatMap(
              (run: { artifacts: Array<{ id: string; name: string; size: unknown }> }) =>
                run.artifacts,
            );
            if (page === 0)
              expect(
                artifacts.find((artifact: { name: string }) => artifact.name === "group-report.txt")
                  .size,
              ).toBe("[redacted]");
            for (const artifact of artifacts) seenArtifacts.add(artifact.id);
            expect(JSON.stringify(decoded)).not.toContain(fakeSecrets[2]);
          },
          response: (request: ModelEmulatorRequest) => {
            const result = request.messages.findLast((message) => message.role === "tool");
            const decoded = JSON.parse(String(result?.content));
            return decoded.nextArtifactId
              ? {
                  type: "tool" as const,
                  id: `group-artifact-page-${page}`,
                  name: "read_history",
                  arguments: {
                    messageId: groupMessageId,
                    limit: 1,
                    linkedRunId: decoded.runs[0].id,
                    artifactAfterId: decoded.nextArtifactId,
                  },
                }
              : { type: "text" as const, text: "Group history checked." };
          },
        })),
      ],
    });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-history-redaction-"));
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
        encryptionKey: "history-fixture-encryption-key",
        deploymentModelKey: fakeSecrets[0],
        composioApiKey: fakeSecrets[1],
        cursorApiKey: fakeSecrets[2],
      });
      stop = handles.stop;
      const db = asSystem(handles.prisma);
      historyDb = db;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `history-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "History fixture",
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
          throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
        return body.json;
      };
      await rpc("models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        // This fixture verifies long group paging, not the compatible-model
        // fallback window. Tiny-window metadata retry behavior has separate coverage.
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "History fixture",
        title: "",
        description: "",
        instructions: "Inspect original history without revealing credentials.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await handles.awaitIdle?.();
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const thread = await db.thread.findFirstOrThrow({ where: { botId: bot.id } });
      await db.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: messageId,
            threadId: thread.id,
            seq: 0,
            role: "user",
            blocks: [
              { kind: "text", text: `history redaction canary: ${fakeSecrets.join(" | ")}` },
            ],
          },
        });
        await tx.thread.update({ where: { id: thread.id }, data: { nextMessageSeq: 101 } });
      });
      await db.message.createMany({
        data: Array.from({ length: 100 }, (_, index) => ({
          threadId: thread.id,
          seq: index + 1,
          role: "user",
          blocks: [
            {
              kind: "text",
              text: `old-filler-${index + 1}: ${"irrelevant historical exchange ".repeat(40)}`,
            },
          ],
        })),
      });
      await db.memoryDocument.create({
        data: {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId: bot.id,
          scope: "bot",
          path: "constraints.md",
          content: "Aurora batch size must remain 37",
          revision: 1,
        },
      });
      const openWork = await db.scratchpadItem.create({
        data: {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId: bot.id,
          title: "Approval pending: only prepare a proposal",
          notes: "Do not deploy any changes.",
          status: "open",
        },
      });
      const run = await rpc<{ runId: string }>("threads/send", {
        botId: bot.id,
        text: "incoming-exclusive-canary: Check the redaction canary using both history tools, then write notes/proposal.txt following saved constraints.",
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
      const proposal = await rpc<{ content: string }>("computer/readFile", {
        botId: bot.id,
        path: "notes/proposal.txt",
      });
      expect(proposal.content).toBe("batch=37; approval=pending; mode=proposal");
      expect(
        (await db.scratchpadItem.findUniqueOrThrow({ where: { id: openWork.id } })).status,
      ).toBe("open");
      const actualCalls = await db.event.findMany({
        where: { runId: run.runId, type: "agent.tool.called" },
      });
      expect(actualCalls).toHaveLength(5);
      const peer = await rpc<{ id: string }>("bots/create", {
        name: "Peer fixture",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, peer.id);
      const group = await rpc<{ id: string; threadId: string }>("groups/create", {
        name: "History group",
        botIds: [bot.id, peer.id],
      });
      const groupThread = await db.thread.findUniqueOrThrow({
        where: { id: group.threadId },
      });
      await db.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            id: groupMessageId,
            threadId: group.threadId,
            seq: 0,
            role: "user",
            blocks: [{ kind: "text", text: "Group history canary" }],
          },
        });
        await tx.thread.update({
          where: { id: group.threadId },
          data: { nextMessageSeq: 1 },
        });
      });
      const historicalTask = await db.task.create({
        data: {
          spaceId: groupThread.spaceId,
          userId: groupThread.userId,
          botId: peer.id,
          threadId: group.threadId,
          prompt: "Synthetic investigation",
          status: "completed",
        },
      });
      const historicalRun = await db.run.create({
        data: {
          spaceId: groupThread.spaceId,
          userId: groupThread.userId,
          botId: peer.id,
          threadId: group.threadId,
          taskId: historicalTask.id,
          status: "completed",
          trigger: "user",
          sourceMessageId: groupMessageId,
        },
      });
      await db.artifact.create({
        data: {
          spaceId: groupThread.spaceId,
          userId: groupThread.userId,
          botId: peer.id,
          groupId: group.id,
          runId: historicalRun.id,
          name: "group-report.txt",
          mimeType: "text/plain",
          size: Number(fakeSecrets[2]),
          hash: "synthetic-hash",
          storageKey: "synthetic-storage",
        },
      });
      await db.artifact.createMany({
        data: Array.from({ length: 100 }, (_, index) => ({
          spaceId: groupThread.spaceId,
          userId: groupThread.userId,
          botId: peer.id,
          groupId: group.id,
          runId: historicalRun.id,
          name: `paged-report-${index}.txt`,
          mimeType: "text/plain",
          size: 1,
          hash: "synthetic-hash",
          storageKey: "synthetic-storage",
        })),
      });
      await rpc("threads/send", {
        groupId: group.id,
        text: "Check the group history canary.",
        mentions: [{ kind: "bot", id: bot.id }],
      });
      await expect
        .poll(
          async () => {
            const status = (
              await db.run.findFirst({
                where: { threadId: group.threadId, botId: bot.id },
                orderBy: { createdAt: "desc" },
              })
            )?.status;
            if (status === "failed") model.assertComplete();
            return status;
          },
          { timeout: 15000, interval: 100 },
        )
        .toBe("completed");
      expect(seenArtifacts.size).toBe(101);
      expect(maximumNavigationMetadataBytes).toBeLessThanOrEqual(10_000);
      process.stdout.write(
        `Synthetic group paging maximum navigation metadata: ${maximumNavigationMetadataBytes} bytes\n`,
      );
      model.assertComplete();
    } finally {
      await stop?.();
      await model.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
