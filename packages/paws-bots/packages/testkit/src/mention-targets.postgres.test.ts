import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

describeWithDatabase("structured @ mention targets", () => {
  let handles: AppHandles;
  let app: App;
  let prisma: AppHandles["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-mention-targets-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
      signupsEnabled: "true",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("starts a routine test run on the owning bot", async () => {
    const cookie = await signup(app, `mention-routine-${stamp}@rakazo.test`, "Routine Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Daily digest",
      prompt: "Summarize inbox",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const tested = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
    });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: tested.runId } });
    expect(run.botId).toBe(bot.id);
    expect(run.trigger).toBe("routine");
  });

  it("replays routine testRun with the same clientNonce", async () => {
    const cookie = await signup(app, `mention-routine-replay-${stamp}@rakazo.test`, "Replay Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "ReplayBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Replay digest",
      prompt: "Replay inbox",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const nonce = `routine-mention:${stamp}:replay`;
    const first = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: nonce,
    });
    const second = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: nonce,
    });
    expect(second.runId).toBe(first.runId);
    const run = await prisma.run.findUniqueOrThrow({ where: { id: first.runId } });
    expect(run.clientNonce).toBe(`routine-run:${run.userId}:${nonce}`);

    // The previous release stored the key without the user id; its retry replays that run.
    const legacyNonce = `routine-mention:${stamp}:legacy`;
    const task = await prisma.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: "Replay inbox",
        status: "queued",
      },
    });
    const legacy = await prisma.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: task.id,
        userId: run.userId,
        status: "queued",
        trigger: "routine",
        routineId: routine.id,
        clientNonce: `routine-test:${legacyNonce}`,
      },
    });
    const retried = await rpc<{ runId: string }>(app, cookie, "routines/testRun", {
      routineId: routine.id,
      clientNonce: legacyNonce,
    });
    expect(retried.runId).toBe(legacy.id);
    expect(await prisma.run.count({ where: { routineId: routine.id } })).toBe(2);
  });

  describe("send with routines", () => {
    type Receipt = { routineRunIds: string[]; send?: { runId: string; taskId: string } };

    async function owner(name: string) {
      const cookie = await signup(app, `send-routines-${name}-${stamp}@rakazo.test`, name);
      const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
        name: "Chief",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      });
      const routine = (routineName: string) =>
        rpc<{ id: string }>(app, cookie, "routines/create", {
          botId: bot.id,
          name: routineName,
          prompt: `Run ${routineName}`,
          crons: ["0 9 * * 1"],
          timezone: "UTC",
          notify: false,
          active: false,
        });
      return { cookie, bot, digest: await routine("Digest"), review: await routine("Review") };
    }

    it("saves the message and runs once for a repeated or concurrent nonce", async () => {
      const { cookie, bot, digest, review } = await owner("Once");
      const clientNonce = `send-routines-${stamp}`;
      const input = {
        botId: bot.id,
        clientNonce,
        text: "and the notes",
        routineIds: [digest.id, review.id],
      };
      const concurrent = await Promise.all(
        Array.from({ length: 3 }, () =>
          rpc<Receipt>(app, cookie, "threads/sendWithRoutines", input),
        ),
      );
      const retried = await rpc<Receipt>(app, cookie, "threads/sendWithRoutines", input);

      const [first] = concurrent;
      expect(first?.routineRunIds).toHaveLength(2);
      for (const receipt of [...concurrent, retried]) expect(receipt).toEqual(first);
      const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      expect(await prisma.message.count({ where: { threadId: thread.id, clientNonce } })).toBe(1);
      expect(await prisma.run.count({ where: { routineId: digest.id } })).toBe(1);
      expect(await prisma.run.count({ where: { routineId: review.id } })).toBe(1);
      expect(await prisma.task.count({ where: { threadId: thread.id } })).toBe(
        await prisma.run.count({ where: { threadId: thread.id } }),
      );

      const routinesOnly = {
        botId: bot.id,
        clientNonce: `${clientNonce}-only`,
        routineIds: [digest.id],
      };
      const [ran, ...others] = await Promise.all(
        Array.from({ length: 3 }, () =>
          rpc<Receipt>(app, cookie, "threads/sendWithRoutines", routinesOnly),
        ),
      );
      expect(ran?.send).toBeUndefined();
      for (const receipt of others) expect(receipt).toEqual(ran);
      expect(await rpc<Receipt>(app, cookie, "threads/sendWithRoutines", routinesOnly)).toEqual(
        ran,
      );
      expect(await prisma.run.count({ where: { routineId: digest.id } })).toBe(2);
    });

    it("treats stop sent with a routine as a message, so the routine still runs", async () => {
      const { cookie, bot, digest } = await owner("Stop");
      const sent = await rpc<Receipt>(app, cookie, "threads/sendWithRoutines", {
        botId: bot.id,
        clientNonce: `send-stop-${stamp}`,
        text: "stop",
        routineIds: [digest.id],
      });
      const [routineRun] = sent.routineRunIds;
      expect((await prisma.run.findUniqueOrThrow({ where: { id: routineRun! } })).status).not.toBe(
        "cancelled",
      );
    });

    it.each([
      ["routines-only", {}],
      ["with-text", { text: "and the notes" }],
    ])("replays a saved submission when a retry adds a routine (%s)", async (name, extra) => {
      const { cookie, bot, digest, review } = await owner(`Grow-${name}`);
      // A backslash must not change which submission the nonce names.
      const input = { botId: bot.id, clientNonce: `send-grow\\${name}-${stamp}`, ...extra };
      const first = await rpc<Receipt>(app, cookie, "threads/sendWithRoutines", {
        ...input,
        routineIds: [digest.id],
      });
      const retried = await rpc<Receipt>(app, cookie, "threads/sendWithRoutines", {
        ...input,
        routineIds: [digest.id, review.id],
      });

      expect(retried).toEqual(first);
      expect(await prisma.run.count({ where: { routineId: digest.id } })).toBe(1);
      expect(await prisma.run.count({ where: { routineId: review.id } })).toBe(0);
    });

    it.each([
      ["routines-only", undefined],
      ["with-text", "and the notes"],
    ])(
      "lets one of two concurrent sends win while the other waits mid-transaction (%s)",
      async (name, text) => {
        const { cookie, bot, digest } = await owner(`Race-${name}`);
        const createBot = (botName: string) =>
          rpc<{ id: string }>(app, cookie, "bots/create", {
            name: botName,
            title: "",
            description: "",
            instructions: "",
            notifyOnFinish: true,
          });
        const slow = await createBot("Slow");
        const other = await createBot("Other");
        const late = await rpc<{ id: string }>(app, cookie, "routines/create", {
          botId: slow.id,
          name: "Late",
          prompt: "Run late",
          crons: ["0 9 * * 1"],
          timezone: "UTC",
          notify: false,
          active: false,
        });
        const slowThread = await prisma.thread.findUniqueOrThrow({ where: { botId: slow.id } });
        const clientNonce = `send-race-${name}-${stamp}`;
        // Holding the slow bot's thread stops B on its first run insert, after its saved-run lookup.
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const holding = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const holder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM threads WHERE id = ${slowThread.id} FOR UPDATE`;
            locked();
            await released;
          },
          { timeout: 20_000 },
        );
        await holding;
        const second = raw(app, cookie, "threads/sendWithRoutines", {
          botId: other.id,
          clientNonce,
          text,
          routineIds: [late.id, digest.id],
        });
        for (let tries = 0; ; tries += 1) {
          const [waiting] = await prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM pg_locks WHERE NOT granted`;
          if (Number(waiting?.count) > 0) break;
          if (tries > 100) throw new Error("the second send never waited");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const first = await rpc<Receipt>(app, cookie, "threads/sendWithRoutines", {
          botId: bot.id,
          clientNonce,
          text,
          routineIds: [digest.id],
        });
        release();
        await holder;
        const response = await second;

        expect(response.status).toBe(200);
        expect(((await response.json()) as { json: Receipt }).json.routineRunIds).toEqual(
          first.routineRunIds,
        );
        expect(await prisma.run.count({ where: { routineId: digest.id } })).toBe(1);
        expect(await prisma.run.count({ where: { routineId: late.id } })).toBe(0);
        expect(await prisma.message.count({ where: { clientNonce } })).toBe(text ? 1 : 0);
      },
    );

    it("rolls back the message and every run when the last step fails", async () => {
      const { cookie, bot, digest, review } = await owner("Rollback");
      const clientNonce = `send-rollback-${stamp}`;
      const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
      // An event already holds the next sequence number, so appending the message's event, the
      // send's last write, fails after the message and the runs were inserted.
      await prisma.event.create({
        data: {
          spaceId: thread.spaceId,
          threadId: thread.id,
          botId: bot.id,
          seq: thread.nextEventSeq,
          type: "thread.meta",
          payload: {},
        },
      });
      const tasksBefore = await prisma.task.count({ where: { threadId: thread.id } });

      const response = await raw(app, cookie, "threads/sendWithRoutines", {
        botId: bot.id,
        clientNonce,
        text: "and the notes",
        routineIds: [digest.id, review.id],
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await prisma.message.count({ where: { threadId: thread.id, clientNonce } })).toBe(0);
      expect(await prisma.run.count({ where: { routineId: { in: [digest.id, review.id] } } })).toBe(
        0,
      );
      expect(await prisma.task.count({ where: { threadId: thread.id } })).toBe(tasksBefore);
      expect(await prisma.thread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({
        nextEventSeq: thread.nextEventSeq,
        nextMessageSeq: thread.nextMessageSeq,
      });
    });

    it("rejects the whole send when one routine is not the caller's", async () => {
      const victim = await owner("Victim");
      const caller = await owner("Caller");
      const clientNonce = `send-foreign-${stamp}`;

      const response = await raw(app, caller.cookie, "threads/sendWithRoutines", {
        botId: caller.bot.id,
        clientNonce,
        text: "and the notes",
        routineIds: [caller.digest.id, victim.digest.id],
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: caller.bot.id } });
      expect(await prisma.message.count({ where: { threadId: thread.id, clientNonce } })).toBe(0);
      expect(
        await prisma.run.count({
          where: { routineId: { in: [caller.digest.id, victim.digest.id] } },
        }),
      ).toBe(0);
    });
  });

  it("includes connector intent on a 1:1 send prompt", async () => {
    const cookie = await signup(app, `mention-connector-${stamp}@rakazo.test`, "Connector Owner");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const started = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      provider: "gmail",
      displayName: "Gmail",
    });
    await rpc(app, cookie, "connections/complete", { connectionId: started.connectionId });

    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "check my email",
      mentions: [{ kind: "connector", id: started.connectionId }],
    });
    const run = await prisma.run.findUniqueOrThrow({
      where: { id: sent.runId },
      include: { task: true },
    });
    expect(run.task.prompt).toContain("Use these connectors if relevant: Gmail");
  });

  it("lands a group-targeted send in the group transcript, not the 1:1 bot thread", async () => {
    const cookie = await signup(app, `mention-group-${stamp}@rakazo.test`, "Group Owner");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Planning",
      botIds: [botA.id, botB.id],
    });
    const messageText = "follow up from 1:1 reroute";
    await rpc(app, cookie, "threads/send", {
      groupId: group.id,
      text: messageText,
    });
    const groupSnap = await rpc<{
      messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
    }>(app, cookie, "threads/get", { groupId: group.id });
    const botSnap = await rpc<{
      messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
    }>(app, cookie, "threads/get", { botId: botA.id });
    const groupHasMessage = groupSnap.messages.some((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text?.includes(messageText)),
    );
    const botHasMessage = botSnap.messages.some((message) =>
      message.blocks.some((block) => block.kind === "text" && block.text?.includes(messageText)),
    );
    expect(groupHasMessage).toBe(true);
    expect(botHasMessage).toBe(false);
  });

  it("wakes every member, each free to stay silent, on an unmentioned group send", async () => {
    const cookie = await signup(app, `mention-group-default-${stamp}@rakazo.test`, "Group Default");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "BotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Squad",
      botIds: [botA.id, botB.id],
    });
    const before = await prisma.run.count({
      where: { threadId: group.threadId, trigger: "user" },
    });
    await rpc(app, cookie, "threads/send", { groupId: group.id, text: "hello team" });
    const runs = await prisma.run.findMany({
      where: { threadId: group.threadId, trigger: "user" },
      select: { botId: true, groupReplyOptional: true },
    });
    expect(runs.length - before).toBe(2);
    expect(runs.map((run) => run.botId).sort()).toEqual([botA.id, botB.id].sort());
    expect(runs.every((run) => run.groupReplyOptional)).toBe(true);
  });

  it("wakes a mentioned group member from typed bot chips and ignores non-members", async () => {
    const cookie = await signup(app, `mention-out-${stamp}@rakazo.test`, "Out Of Chat");
    const botA = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "MemberA",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const botB = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "MemberB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const outsider = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Outsider",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const group = await rpc<{ id: string; threadId: string }>(app, cookie, "groups/create", {
      name: "Core",
      botIds: [botA.id, botB.id],
    });
    const sent = await rpc<{ runId: string; runIds?: string[] }>(app, cookie, "threads/send", {
      groupId: group.id,
      text: "@MemberB @Outsider please review",
      mentions: [
        { kind: "bot", id: botB.id },
        { kind: "bot", id: outsider.id },
      ],
    });
    const runIds = sent.runIds ?? [sent.runId];
    const runs = await prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { botId: true },
    });
    expect(runs.map((run) => run.botId).sort()).toEqual([botB.id].sort());
  });

  it("rejects another user's routine, connection, and group mentions", async () => {
    const ada = await signup(app, `mention-auth-ada-${stamp}@rakazo.test`, "Ada Auth");
    const bob = await signup(app, `mention-auth-bob-${stamp}@rakazo.test`, "Bob Auth");
    const adaBot = await rpc<{ id: string }>(app, ada, "bots/create", {
      name: "AdaBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const bobBot = await rpc<{ id: string }>(app, bob, "bots/create", {
      name: "BobBot",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const adaBotB = await rpc<{ id: string }>(app, ada, "bots/create", {
      name: "AdaBotB",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const routine = await rpc<{ id: string }>(app, ada, "routines/create", {
      botId: adaBot.id,
      name: "Private routine",
      prompt: "do work",
      crons: ["0 9 * * 1"],
      timezone: "UTC",
      notify: false,
      active: false,
    });
    const started = await rpc<{ connectionId: string }>(app, ada, "connections/begin", {
      provider: "gmail",
      displayName: "Gmail",
    });
    await rpc(app, ada, "connections/complete", { connectionId: started.connectionId });
    const group = await rpc<{ id: string }>(app, ada, "groups/create", {
      name: "Ada group",
      botIds: [adaBot.id, adaBotB.id],
    });

    const routineAttempt = await raw(app, bob, "routines/testRun", { routineId: routine.id });
    expect(routineAttempt.status).toBeGreaterThanOrEqual(400);

    const connectionAttempt = await raw(app, bob, "threads/send", {
      botId: bobBot.id,
      text: "use connector",
      mentions: [{ kind: "connector", id: started.connectionId }],
    });
    expect(connectionAttempt.status).toBeGreaterThanOrEqual(400);

    const groupAttempt = await raw(app, bob, "threads/send", {
      groupId: group.id,
      text: "intrude",
    });
    expect(groupAttempt.status).toBeGreaterThanOrEqual(400);

    const routineRuns = await prisma.run.count({ where: { botId: adaBot.id, trigger: "routine" } });
    expect(routineRuns).toBe(0);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) {
    throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  }
  return sessionCookieHeader(res);
}

async function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
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

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  let parsed: { json?: T; error?: { message?: string } };
  try {
    parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  } catch {
    throw new Error(`${proc} ${res.status}: ${text}`);
  }
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
