import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunActivityRow } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessage } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeRunsList = hasDb ? describe : describe.skip;

describeRunsList("runs.list activity tracker", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-runs-list-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("lists active runs from two bots and keeps completed runs under recent", async () => {
    const cookie = await signup(app, `runs-${stamp}@rakazo.test`, "Runs User");
    const alpha = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Alpha",
      title: "Alpha",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const beta = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Beta",
      title: "Beta",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "bots/update", { botId: beta.id, notifyOnFinish: false });

    await seedRun(prisma, alpha.id, "running", "alpha in flight");
    await seedRun(prisma, beta.id, "queued", "beta in flight");
    await seedRun(prisma, alpha.id, "completed", "alpha done");

    const active = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "active",
    });
    expect(active.runs.map((run) => run.botName).sort()).toEqual(["Alpha", "Beta"]);
    expect(active.runs.find((run) => run.botName === "Beta")?.notificationsEnabled).toBe(false);
    expect(active.runs.some((run) => run.status === "completed")).toBe(false);

    const recent = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "recent",
    });
    expect(recent.runs.some((run) => run.botName === "Alpha" && run.status === "completed")).toBe(
      true,
    );
    expect(recent.runs.some((run) => run.botName === "Beta")).toBe(false);
  });

  it("never returns runs from another workspace", async () => {
    const ownerCookie = await signup(app, `runs-owner-${stamp}@rakazo.test`, "Owner");
    const ownerBot = await rpc<{ id: string }>(app, ownerCookie, "bots/create", {
      name: "OwnerBot",
      title: "OwnerBot",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await seedRun(prisma, ownerBot.id, "running", "owner active run");

    const intruderCookie = await signup(app, `runs-intruder-${stamp}@rakazo.test`, "Intruder");
    const active = await rpc<{ runs: RunActivityRow[] }>(app, intruderCookie, "runs/list", {
      filter: "active",
    });
    expect(active.runs).toEqual([]);
  });

  it("excludes archived bots from recent before applying the limit", async () => {
    const cookie = await signup(app, `runs-archived-${stamp}@rakazo.test`, "Archive User");
    const archivedBot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Archived",
      title: "Archived",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const visibleBot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Visible",
      title: "Visible",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    await rpc(app, cookie, "bots/archive", { botId: archivedBot.id });
    const olderVisibleAt = new Date(Date.now() - 86_400_000);
    for (let i = 0; i < 21; i += 1) {
      await seedRun(
        prisma,
        archivedBot.id,
        "completed",
        `archived filler ${i}`,
        new Date(Date.now() - i * 1_000),
      );
    }
    await seedRun(prisma, visibleBot.id, "completed", "visible run", olderVisibleAt);

    const recent = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "recent",
    });
    expect(recent.runs.some((run) => run.botName === "Archived")).toBe(false);
    expect(recent.runs.some((run) => run.botName === "Visible")).toBe(true);
    expect(recent.runs.length).toBe(1);
  });

  it("lists each chat's latest finished run, so a busy chat leaves room for the rest", async () => {
    const cookie = await signup(app, `runs-busy-${stamp}@rakazo.test`, "Busy User");
    const busy = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Busy",
      title: "Busy",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const quiet = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Quiet",
      title: "Quiet",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const now = Date.now();
    await seedRun(prisma, quiet.id, "completed", "quiet run", new Date(now - 86_400_000));
    for (let i = 0; i < 21; i += 1) {
      // Bridged team-chat conversations get their own threads but are still the bot's chat.
      const thread = await bridgedThread(prisma, busy.id, `busy-${stamp}-${i}`);
      await seedRun(
        prisma,
        busy.id,
        "completed",
        `busy ${i}`,
        new Date(now - i * 1_000),
        thread.id,
      );
    }

    const recent = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "recent",
    });
    expect(recent.runs.map((run) => [run.botName, run.promptSnippet])).toEqual([
      ["Busy", "busy 0"],
      ["Quiet", "quiet run"],
    ]);
  });

  it("returns legacy labels alongside structured agent messages", async () => {
    const cookie = await signup(app, `runs-message-${stamp}@rakazo.test`, "Runs User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Worker",
      title: "Worker",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    for (const source of [
      {
        name: "Maya",
        text: " first\n second ",
        intent: "request",
        kind: "request",
        label: "Maya asked: first second",
      },
      { name: " ", text: "", intent: "result", kind: "update", label: "Update from Another agent" },
      null,
    ]) {
      const run = await seedRun(prisma, bot.id, "running", "[bot] private internal wake prompt");
      const message = source
        ? await createThreadMessage(prisma, {
            threadId: run.threadId,
            role: "user",
            blocks: [
              {
                kind: "bot_message_received",
                fromBotId: "peer",
                fromBotName: source.name,
                text: source.text,
                intent: source.intent as "request" | "result",
              },
            ],
          })
        : null;
      await prisma.run.update({
        where: { id: run.id },
        data: { trigger: "bot_message", sourceMessageId: message?.id ?? null },
      });
      const active = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
        filter: "active",
      });
      const row = active.runs.find((row) => row.runId === run.id);
      expect(row?.promptSnippet).toBe(source?.label ?? "Message from another agent");
      expect(row?.agentMessage).toEqual(
        source
          ? {
              fromBotName: source.name.trim(),
              kind: source.kind,
              text: source.text.replace(/\s+/g, " ").trim(),
            }
          : { kind: "unknown" },
      );
    }
  });

  it("returns group runs with groupId for navigation", async () => {
    const cookie = await signup(app, `runs-group-${stamp}@rakazo.test`, "Group User");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Worker",
      title: "Worker",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Helper",
      title: "Helper",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string }>(app, cookie, "groups/create", {
      name: "Ops",
      botIds: [botA.id, botB.id],
    });
    const groupThread = await prisma.thread.findUniqueOrThrow({ where: { groupId: group.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: groupThread.spaceId,
        userId: groupThread.userId,
        botId: botA.id,
        threadId: groupThread.id,
        prompt: "group task in flight",
        status: "running",
      },
    });
    await prisma.run.create({
      data: {
        spaceId: groupThread.spaceId,
        userId: groupThread.userId,
        botId: botA.id,
        threadId: groupThread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });

    const active = await rpc<{ runs: RunActivityRow[] }>(app, cookie, "runs/list", {
      filter: "active",
    });
    const groupRun = active.runs.find((run) => run.groupId === group.id);
    expect(groupRun).toBeTruthy();
    expect(groupRun?.agentMessage).toBeNull();
    expect(groupRun?.groupName).toBe("Ops");
    expect(groupRun?.botId).toBe(botA.id);
  });
});

async function seedRun(
  prisma: PrismaClient,
  botId: string,
  status: "queued" | "running" | "completed",
  prompt: string,
  completedAt?: Date | null,
  threadId?: string,
) {
  const thread = await prisma.thread.findUniqueOrThrow({
    where: threadId ? { id: threadId } : { botId },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      prompt,
      status,
    },
  });
  return prisma.run.create({
    data: {
      spaceId: thread.spaceId,
      userId: thread.userId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      status,
      trigger: "user",
      completedAt: status === "completed" ? (completedAt ?? new Date()) : null,
    },
  });
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}

async function bridgedThread(prisma: PrismaClient, botId: string, externalKey: string) {
  const direct = await prisma.thread.findUniqueOrThrow({ where: { botId } });
  const conversation = await prisma.externalConversation.create({
    data: {
      provider: "team-chat",
      workspaceId: "workspace",
      externalKey,
      conversationId: externalKey,
      spaceId: direct.spaceId,
      botId,
      userId: direct.userId,
      thread: { create: { spaceId: direct.spaceId, userId: direct.userId } },
    },
    include: { thread: true },
  });
  return conversation.thread!;
}
