import { runJobKey } from "@rakazo/adapter-kit";
import type { RunStatus } from "@rakazo/contracts";
import { isActive } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

export type BotIntroHarness = {
  app: App;
  prisma: PrismaClient;
  jobs: { cancel(key: string): Promise<void> };
  runtime: { abort(runId: string): Promise<void> };
};

const QUIET_MS = 50;
const POLL_MS = 20;

/**
 * Creation queues an intro run that will take the next model step. Fixed-script
 * fixtures stop it and wait until that bot has no active or queued run, so the
 * scenario's first scripted turn stays aligned.
 */
export async function discardBotIntroRun(
  harness: BotIntroHarness,
  cookie: string,
  botId: string,
  timeoutMs = 15_000,
): Promise<void> {
  const prisma = asSystem(harness.prisma);
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { spaceId: true },
  });
  const deadline = Date.now() + timeoutMs;
  let quietSince = 0;
  while (Date.now() < deadline) {
    // Create can target a space other than the session default. Stop must use that space.
    await rpc(harness.app, cookie, "threads/stop", { botId }, bot?.spaceId);
    const runs = await prisma.run.findMany({
      where: { botId },
      select: { id: true, status: true },
    });
    for (const run of runs) {
      await harness.jobs.cancel(runJobKey(run.id)).catch(() => undefined);
      await harness.runtime.abort(run.id);
    }
    const runningAttempts = await prisma.attempt.count({
      where: { run: { botId }, status: "running" },
    });
    const active = runs.some((run) => isActive(run.status as RunStatus));
    // Expired execution-lease rows are fence tombstones and stay after release.
    // No run at all means this runtime did not queue an intro.
    if (!active && runningAttempts === 0 && runs.length === 0) return;
    if (!active && runningAttempts === 0) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince >= QUIET_MS) return;
    } else {
      quietSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("Bot creation intro did not stop");
}

export async function discardBotIntroFromCreate<T>(
  harness: BotIntroHarness | undefined,
  cookie: string,
  procedure: string,
  result: T,
): Promise<T> {
  if (procedure !== "bots/create" || !harness || !result || typeof result !== "object")
    return result;
  const botId = (result as { id?: unknown }).id;
  if (typeof botId !== "string") return result;
  await discardBotIntroRun(harness, cookie, botId);
  return result;
}

async function rpc(
  app: App,
  cookie: string,
  procedure: string,
  body: unknown,
  spaceId?: string,
): Promise<void> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
  if (!response.ok) throw new Error(`${procedure} failed (${response.status})`);
}
