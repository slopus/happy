import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ComposioConnector,
  diagnoseReleaseWatchRun,
  FakeComposioClient,
  githubToolResultHasSeededRelease,
  RELEASE_WATCH_GITHUB_TOOL_NAMES,
  resolveReleaseWatchEvalModelId,
} from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { afterAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

if (process.env.VERIFY_PROVIDERS) loadRootEnv({ allowInTests: true });

const live = Boolean(
  process.env.VERIFY_PROVIDERS && process.env.OPENROUTER_API_KEY && process.env.DATABASE_URL,
);
const describeLive = live ? describe : describe.skip;

describeLive("live release-watch eval (GPT 5.6 Luna + GitHub emulator)", () => {
  let stop: (() => Promise<void>) | undefined;
  let dataDir: string | undefined;
  const fake = new FakeComposioClient();
  const composio = new ComposioConnector({ client: fake });

  afterAll(async () => {
    try {
      await stop?.();
    } finally {
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("writes a concrete routine and reads seeded releases via GitHub tools, not the browser", async () => {
    const { modelId, label } = resolveReleaseWatchEvalModelId(process.env);
    process.env.PI_DEFAULT_MODEL = modelId;

    const { createApp } = await import("@rakazo/api/app");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-release-watch-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      composio,
    });
    stop = handles.stop;

    const stamp = Date.now();
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `release-watch-${stamp}@rakazo.test`,
        password: "password12",
        name: "Release Watch",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);

    const me = await rpc<{ spaceId: string; userId: string }>(handles.app, cookie, "me");
    const started = await rpc<{ connectionId: string; authorizationUrl: null }>(
      handles.app,
      cookie,
      "connections/begin",
      { connectorId: "composio", provider: "GITHUB", displayName: "GitHub" },
    );
    expect(started.authorizationUrl).toBeNull();

    const discoveredGithubTools = await composio.discoverTools({
      operationId: "release-watch-canary",
      traceId: "release-watch-canary",
      spaceId: me.spaceId,
      userId: me.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "composio",
          externalId: "GITHUB",
          displayName: "GitHub",
        },
      ],
    });
    expect(discoveredGithubTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...RELEASE_WATCH_GITHUB_TOOL_NAMES]),
    );

    const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Release watch eval",
      instructions: "You are a chief of staff.",
      notifyOnFinish: true,
    });

    // Mirror the Discord user ask: no tool names, no Bing/browser coaching.
    // schedule_create + connected-plugin guidance should steer the model.
    await rpc(handles.app, cookie, "threads/send", {
      botId: bot.id,
      text: [
        "Create a daily task to watch for new releases of elie222/rakazo",
        "and stay current on the project's capabilities.",
      ].join(" "),
    });

    await waitFor(handles.app, cookie, bot.id, 180_000);

    const routines = await rpc<Array<{ id: string; name: string; prompt: string }>>(
      handles.app,
      cookie,
      "routines/list",
      { botId: bot.id },
    );
    expect(routines.length).toBeGreaterThan(0);
    const routine =
      routines.find((row) => /rakazo|release/i.test(`${row.name}\n${row.prompt}`)) ?? routines[0]!;

    const dueAt = new Date(Date.now() - 1_000);
    await handles.prisma.routine.update({
      where: { id: routine.id },
      data: { nextRunAt: dueAt, active: true },
    });
    fake.executions.length = 0;
    const priorToolEvent = await handles.prisma.event.findFirst({
      where: { botId: bot.id, type: "agent.tool.called" },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const routineToolSeqFloor = priorToolEvent?.seq ?? -1;
    await handles.jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId: routine.id, scheduledFor: dueAt.toISOString() },
    });

    const snap = await waitFor(handles.app, cookie, bot.id, 180_000, { requireSeenRun: true });
    const routineRunId = snap.run?.id;
    const toolEvents = await handles.prisma.event.findMany({
      where: {
        botId: bot.id,
        type: "agent.tool.called",
        seq: { gt: routineToolSeqFloor },
        ...(routineRunId ? { runId: routineRunId } : {}),
      },
      orderBy: { seq: "asc" },
    });
    const calledFromEvents = toolEvents.map((event) => {
      const payload = event.payload as { name?: string };
      return String(payload.name ?? "");
    });
    // Cleared before the routine woke, so every row belongs to this run.
    const routineExecutions = fake.executions;
    const calledToolNames = [...calledFromEvents, ...routineExecutions.map((row) => row.tool)];
    const seededReleaseTags = fake.listGithubReleases().map((release) => release.tag);
    const resultText = JSON.stringify(snap);
    const githubToolResults = routineExecutions
      .filter((row) => (RELEASE_WATCH_GITHUB_TOOL_NAMES as readonly string[]).includes(row.tool))
      .map((row) => row.result);
    const diagnosis = diagnoseReleaseWatchRun({
      // Use tools the bot actually discovered — do not hardcode availability.
      availableToolNames: discoveredGithubTools.map((tool) => tool.name),
      calledToolNames,
      routinePrompt: routine.prompt,
      resultText,
      seededReleaseTags,
      githubToolResults,
    });

    if (!diagnosis.pass) {
      throw new Error(
        [
          "release-watch eval failed",
          `model=${label} (${modelId})`,
          `routinePrompt=${JSON.stringify(routine.prompt)}`,
          `calledTools=${JSON.stringify(calledToolNames)}`,
          `discoveredGithubTools=${JSON.stringify(discoveredGithubTools.map((tool) => tool.name))}`,
          diagnosis.summary,
        ].join("\n"),
      );
    }

    expect(
      githubToolResults.some((result) =>
        githubToolResultHasSeededRelease(result, seededReleaseTags),
      ),
    ).toBe(true);
  }, 420_000);
});

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Snap = {
  messages: Array<{ role: string; blocks: unknown[] }>;
  run: {
    id: string;
    status: string;
    botId?: string;
    trigger?: string;
    routineId?: string | null;
  } | null;
};

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = (await res.json()) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

async function waitFor(
  app: App,
  cookie: string,
  botId: string,
  ms: number,
  options?: { requireSeenRun?: boolean },
): Promise<Snap> {
  const start = Date.now();
  let last: Snap | null = null;
  let seenRun = false;
  let lastSeenRun: Snap["run"] = null;
  while (Date.now() - start < ms) {
    last = await rpc<Snap>(app, cookie, "threads/get", { botId });
    if (last.run) {
      seenRun = true;
      lastSeenRun = last.run;
    }
    const terminal = !!last.run && ["completed", "failed", "cancelled"].includes(last.run.status);
    // Keep lastSeenRun for tool attribution if the active run slot clears after completion.
    if (terminal) return { ...last, run: last.run ?? lastSeenRun };
    if (!last.run && (!options?.requireSeenRun || seenRun)) {
      return { ...last, run: lastSeenRun };
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for live model turn: ${JSON.stringify(last)}`);
}
