import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computerTestSandbox } from "./computer-test-config.js";
import { sessionCookieHeader } from "./index.js";

const live = process.env.RUN_COMPUTER_E2E === "1";
const describeLive = live ? describe : describe.skip;

describeLive("real model and sandbox computer journey", () => {
  let dataDir: string | undefined;
  let handles: Awaited<ReturnType<typeof createApp>>;
  let computer: ComputerRef | undefined;
  let sandboxProvider: "boat" | "e2b" | "novita";
  let botId: string | undefined;
  let runId: string | undefined;

  beforeAll(async () => {
    const sandbox = computerTestSandbox(process.env.SANDBOX_PROVIDER);
    sandboxProvider = sandbox.provider;
    for (const key of [
      "DATABASE_URL",
      sandbox.apiKeyEnv,
      "OPENROUTER_API_KEY",
      "COMPUTER_E2E_MODEL",
    ]) {
      if (!process.env[key]) throw new Error(`${key} is required for pnpm test:computer`);
    }
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-computer-e2e-"));
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider,
      agentRuntime: "pi",
      e2bApiKey: process.env.E2B_API_KEY,
      novitaApiKey: process.env.NOVITA_API_KEY,
      sandboxTemplate: process.env.SANDBOX_TEMPLATE,
      boatApiKey: process.env.BOAT_API_KEY,
      boatApiUrl: process.env.BOAT_API_URL,
      deploymentModelKey: process.env.OPENROUTER_API_KEY,
      defaultProvider: "openrouter",
      defaultModel: process.env.COMPUTER_E2E_MODEL,
      wakeupDriver: "memory",
    });
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: {
        defaultModelProvider: "openrouter",
        defaultModelId: process.env.COMPUTER_E2E_MODEL,
      },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      try {
        if (runId) await handles.runtime.abort(runId);
        const bot = botId
          ? await handles.prisma.bot.findUnique({
              where: { id: botId },
              include: { computer: true },
            })
          : undefined;
        const stored = bot?.computer;
        if (stored?.providerRef) {
          computer = {
            id: stored.providerRef,
            providerRef: stored.providerRef,
            botId: stored.homeKey,
            kind: sandboxProvider,
          };
        }
      } finally {
        if (computer) await handles.sandbox.destroy(computer, testContext(botId ?? computer.botId));
      }
    } finally {
      await handles?.stop().catch(() => undefined);
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("observes and clicks a real browser, then uses terminal and files", async () => {
    const stamp = Date.now();
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({
        email: `computer-${stamp}@rakazo.test`,
        password: "password12",
        name: "Computer E2E",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "Operator",
      title: "Computer acceptance test",
      description: "Uses the visible desktop and its tools.",
      instructions:
        "This is an acceptance test. Follow the requested computer tool sequence exactly and do not claim a visual action succeeded until its result is visible.",
      notifyOnFinish: false,
    });
    botId = bot.id;
    await rpc(handles.app, cookie, "computer/boot", { botId: bot.id });
    const storedBot = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    });
    const stored = storedBot.computer!;
    computer = {
      id: stored.providerRef!,
      providerRef: stored.providerRef!,
      botId: stored.homeKey,
      kind: sandboxProvider,
    };
    await installVisualFixture(handles.sandbox, computer);

    const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
      botId: bot.id,
      text: [
        "Open http://127.0.0.1:8765 using open_path.",
        "Call computer_observe, locate the large CLICK TO PASS button visually, and click it with computer_act.",
        "Re-observe until the page visibly says VISUAL E2E PASSED.",
        "Then use shell to read results/visual-click.txt.",
        "Finally use write_file to create results/llm-confirmed.txt containing exactly visual-e2e-ok.",
      ].join(" "),
    });
    runId = sent.runId;
    const completedRun = await waitForRun(
      () =>
        handles.prisma.run.findUnique({
          where: { id: sent.runId },
          select: { status: true, error: true },
        }),
      180_000,
    );
    expect(completedRun.status, completedRun.error ?? undefined).toBe("completed");

    const clickMarker = new TextDecoder().decode(
      await handles.sandbox.readFile(computer, "results/visual-click.txt", testContext(bot.id)),
    );
    expect(clickMarker).toBe("visual-click-ok");
    const confirmed = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
      botId: bot.id,
      path: "results/llm-confirmed.txt",
    });
    expect(confirmed.content).toBe("visual-e2e-ok");

    const toolEvents = await handles.prisma.event.findMany({
      where: { runId: sent.runId },
      select: { type: true, payload: true },
    });
    const used = new Set(
      toolEvents.flatMap((event) => {
        if (
          event.type !== "agent.tool.called" ||
          !event.payload ||
          typeof event.payload !== "object"
        ) {
          return [];
        }
        const name = "name" in event.payload ? event.payload.name : undefined;
        return typeof name === "string" ? [name] : [];
      }),
    );
    for (const required of [
      "open_path",
      "computer_observe",
      "computer_act",
      "shell",
      "write_file",
    ]) {
      expect(used).toContain(required);
    }

    const originalRef = computer.providerRef;
    await handles.sandbox.destroy(computer, testContext(bot.id));
    // Simulate loss outside the app: the stored state still says running, so use
    // recovery to replace the missing sandbox and restore its checkpoint.
    const recovery = await rpc<{ id: string }>(handles.app, cookie, "computer/recover", {
      botId: bot.id,
    });
    await expect
      .poll(
        async () =>
          (await handles.prisma.computerUpdate.findUniqueOrThrow({ where: { id: recovery.id } }))
            .status,
        { timeout: 120_000 },
      )
      .toBe("completed");
    const replacementBot = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    });
    const replacement = replacementBot.computer!;
    computer = {
      id: replacement.providerRef!,
      providerRef: replacement.providerRef!,
      botId: replacement.homeKey,
      kind: sandboxProvider,
    };
    expect(replacement.providerRef).not.toBe(originalRef);
    const restored = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
      botId: bot.id,
      path: "results/llm-confirmed.txt",
    });
    expect(restored.content).toBe("visual-e2e-ok");
  }, 240_000);
});

async function installVisualFixture(sandbox: SandboxProvider, computer: ComputerRef) {
  const source = `
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PAGE = b'''<!doctype html><meta charset="utf-8"><title>Rakazo visual test</title>
<style>body{font-family:sans-serif;text-align:center;padding-top:120px}button{width:760px;height:300px;font-size:58px;background:#2563eb;color:white;border:0;border-radius:24px}</style>
<button onclick="fetch('/passed',{method:'POST'}).then(()=>document.body.innerHTML='<h1 style=font-size:72px>VISUAL E2E PASSED</h1>')">CLICK TO PASS</button>'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(PAGE)
    def do_POST(self):
        Path('results').mkdir(exist_ok=True)
        Path('results/visual-click.txt').write_text('visual-click-ok')
        self.send_response(204); self.end_headers()

HTTPServer(('127.0.0.1', 8765), Handler).serve_forever()
`;
  const context = testContext(computer.botId);
  await sandbox.writeFile(
    computer,
    { path: "visual_server.py", content: new TextEncoder().encode(source) },
    context,
  );
  for await (const event of sandbox.execute(
    computer,
    { argv: ["bash", "-lc", "nohup python3 visual_server.py > visual-server.log 2>&1 &"] },
    context,
  )) {
    if (event.type === "exit" && event.code !== 0)
      throw new Error("fixture server failed to start");
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let ready = false;
    for await (const event of sandbox.execute(
      computer,
      { argv: ["bash", "-lc", "curl -fsS http://127.0.0.1:8765 >/dev/null"] },
      context,
    )) {
      if (event.type === "exit") ready = event.code === 0;
    }
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("visual fixture did not become ready");
}

function testContext(botId: string) {
  return {
    operationId: "computer-e2e",
    traceId: "computer-e2e",
    spaceId: "computer-e2e",
    userId: "computer-e2e",
    botId,
    signal: new AbortController().signal,
  };
}

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type RunState = { status: string; error: string | null };

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

async function waitForRun(load: () => Promise<RunState | null>, timeoutMs: number) {
  const started = Date.now();
  let run: RunState | null = null;
  while (Date.now() - started < timeoutMs) {
    run = await load();
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`computer E2E timed out with status ${run?.status ?? "unknown"}`);
}
