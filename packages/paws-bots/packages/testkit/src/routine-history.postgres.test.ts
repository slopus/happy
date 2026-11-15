import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoutineHistory } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeHistory = hasDb ? describe : describe.skip;

describeHistory("routines.history late starts", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-routine-history-"));

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

  it("returns the due time a late run recorded, unchanged by later schedule edits", async () => {
    const cookie = await signup(app, `routine-late-${stamp}@rakazo.test`, "Late User");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Brief",
      title: "Brief",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    const routine = await rpc<{ id: string }>(app, cookie, "routines/create", {
      botId: bot.id,
      name: "Morning brief",
      prompt: "Send the morning brief",
      crons: ["0 8 * * *"],
      timezone: "UTC",
      active: false,
      notify: false,
    });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: bot.id } });
    const seed = async (clientNonce: string, lateSince: Date | null, startedAt: Date) => {
      const task = await prisma.task.create({
        data: {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Send the morning brief",
          status: "completed",
        },
      });
      return prisma.run.create({
        data: {
          spaceId: thread.spaceId,
          userId: thread.userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "completed",
          trigger: "routine",
          routineId: routine.id,
          clientNonce,
          lateSince,
          startedAt,
          completedAt: startedAt,
        },
      });
    };
    const timer = (scheduledFor: string) => `routine-timer:${routine.id}:${scheduledFor}`;
    // Created for Friday's 08:00 while the host was down; started Monday at 10:30.
    const late = await seed(
      timer("2026-10-16T08:00:00.000Z"),
      new Date("2026-10-19T08:00:00Z"),
      new Date("2026-10-19T10:30:00Z"),
    );
    const onTime = await seed(
      timer("2026-10-20T08:00:00.000Z"),
      null,
      new Date("2026-10-20T08:01:00Z"),
    );
    const history = async () =>
      Object.fromEntries(
        (
          await rpc<RoutineHistory>(app, cookie, "routines/history", { routineId: routine.id })
        ).runs.map((run) => [run.id, run.lateSince]),
      );
    const expected = { [late.id]: "2026-10-19T08:00:00.000Z", [onTime.id]: null };
    expect(await history()).toEqual(expected);
    // A later schedule edit does not rewrite what past runs recorded.
    await rpc(app, cookie, "routines/update", {
      routineId: routine.id,
      crons: ["30 10 * * *"],
      timezone: "America/New_York",
    });
    expect(await history()).toEqual(expected);
  });
});

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
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
