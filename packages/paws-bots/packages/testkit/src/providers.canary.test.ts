import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CreateOSSandboxProvider,
  createSandboxProvider,
  E2BSandboxProvider,
  NovitaSandboxProvider,
  PiAgentRuntime,
} from "@rakazo/adapters";
import type { RunStatus } from "@rakazo/contracts";
import { isTerminal } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { afterAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";

if (process.env.VERIFY_PROVIDERS) loadRootEnv({ allowInTests: true });

const liveE2b = Boolean(process.env.VERIFY_PROVIDERS && process.env.E2B_API_KEY);
const liveBoat = Boolean(process.env.VERIFY_PROVIDERS && process.env.BOAT_API_KEY);
const liveBoxd = Boolean(process.env.VERIFY_PROVIDERS && process.env.BOXD_API_KEY);
const liveInstabox = Boolean(process.env.VERIFY_PROVIDERS && process.env.INSTABOX_API_KEY);
const liveCreateos = Boolean(process.env.VERIFY_PROVIDERS && process.env.CREATEOS_SANDBOX_API_KEY);
const livePi = Boolean(process.env.VERIFY_PROVIDERS && process.env.OPENROUTER_API_KEY);
const livePiApp = Boolean(livePi && process.env.DATABASE_URL);

const describeE2b = liveE2b ? describe : describe.skip;
const describeBoat = liveBoat ? describe : describe.skip;
const describeBoxd = liveBoxd ? describe : describe.skip;
const describeInstabox = liveInstabox ? describe : describe.skip;
const describeCreateos = liveCreateos ? describe : describe.skip;
const describePi = livePi ? describe : describe.skip;
const describePiApp = livePiApp ? describe : describe.skip;

describeE2b("live E2B canary", () => {
  it("provisions a desktop, runs a command, and destroys it", async () => {
    const sandbox = new E2BSandboxProvider(process.env.E2B_API_KEY!);
    const ctx = {
      operationId: "canary",
      traceId: "canary",
      spaceId: "canary",
      userId: "canary",
      signal: new AbortController().signal,
    };
    const computer = await sandbox.provision(
      { botId: "canary", homePath: "/home/user/rakazo-home" },
      ctx,
    );
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "e2b-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("e2b-ok");
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 120_000);
});

describeBoat("live Boat canary", () => {
  it("provisions a desktop, observes it, preserves a file across stop/resume, and destroys it", async () => {
    const sandbox = await createSandboxProvider("boat", {
      boatApiKey: process.env.BOAT_API_KEY,
      boatApiUrl: process.env.BOAT_API_URL,
    });
    const ctx = {
      operationId: "boat-canary",
      traceId: "boat-canary",
      spaceId: "boat-canary",
      userId: "boat-canary",
      signal: new AbortController().signal,
    };
    const request = { botId: "boat-canary", homePath: "/home/user/rakazo-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv: ["echo", "boat-ok"] }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("boat-ok");
      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );
      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);

      await sandbox.stop(computer, ctx);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer.fresh).toBe(false);
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 240_000);
});

describeBoxd("live boxd canary", () => {
  it("provisions a desktop, observes it, keeps a file and a running process across stop/resume, and destroys it", async () => {
    const sandbox = await createSandboxProvider("boxd", {
      boxdApiKey: process.env.BOXD_API_KEY,
      boxdOrg: process.env.BOXD_ORG,
    });
    const ctx = {
      operationId: "boxd-canary",
      traceId: "boxd-canary",
      spaceId: "boxd-canary",
      userId: "boxd-canary",
      signal: new AbortController().signal,
    };
    const run = async (argv: string[]) => {
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      return stdout;
    };
    const request = { botId: "boxd-canary", homePath: "/home/boxd/rakazo-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      expect(await run(["echo", "boxd-ok"])).toContain("boxd-ok");
      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );
      await run(["bash", "-c", "nohup sleep 600 >/dev/null 2>&1 & echo $! > canary.pid"]);
      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);

      await sandbox.stop(computer, ctx);
      expect(await sandbox.isStopped?.(computer, ctx)).toBe(true);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer).toMatchObject({ fresh: false, started: true });
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
      // A suspend keeps memory, so the process is still running after the resume.
      expect(await run(["bash", "-c", "kill -0 $(cat canary.pid) && echo alive"])).toContain(
        "alive",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 600_000);
});

describeInstabox("live instabox canary", () => {
  it("provisions a desktop, serves its screen, keeps a file and a running process across stop/resume, and destroys it", async () => {
    const sandbox = await createSandboxProvider("instabox", {
      instaboxApiKey: process.env.INSTABOX_API_KEY,
    });
    const ctx = {
      operationId: "instabox-canary",
      traceId: "instabox-canary",
      spaceId: "instabox-canary",
      userId: "instabox-canary",
      signal: new AbortController().signal,
    };
    const run = async (argv: string[]) => {
      let stdout = "";
      for await (const event of sandbox.execute(computer, { argv }, ctx)) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      return stdout;
    };
    const request = { botId: "instabox-canary", homePath: "/home/user/rakazo-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      expect(await run(["echo", "instabox-ok"])).toContain("instabox-ok");
      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );
      await run(["bash", "-c", "nohup sleep 600 >/dev/null 2>&1 & echo $! > canary.pid"]);
      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);
      const screen = await sandbox.connectScreen(computer, { view: "stream" }, ctx);
      expect((await fetch(screen.url!)).status).toBe(200);

      await sandbox.stop(computer, ctx);
      expect(await sandbox.isRunning?.(computer, ctx)).toBe(false);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer).toMatchObject({ fresh: false });
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
      // A suspend keeps memory, so the process is still running after the resume.
      expect(await run(["bash", "-c", "kill -0 $(cat canary.pid) && echo alive"])).toContain(
        "alive",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 600_000);
});

describe.skipIf(!process.env.VERIFY_PROVIDERS || !process.env.NOVITA_API_KEY)(
  "live Novita canary",
  () => {
    it("provisions a desktop, observes it, preserves a file across stop/resume, and destroys it", async () => {
      const sandbox = new NovitaSandboxProvider({
        apiKey: process.env.NOVITA_API_KEY!,
        template: process.env.SANDBOX_TEMPLATE,
      });
      const ctx = {
        operationId: "novita-canary",
        traceId: "novita-canary",
        spaceId: "novita-canary",
        userId: "novita-canary",
        signal: new AbortController().signal,
      };
      const request = { botId: "novita-canary", homePath: "/home/user/rakazo-home" };
      let computer = await sandbox.provision(request, ctx);
      try {
        await sandbox.prepare(computer, ctx);
        let stdout = "";
        for await (const event of sandbox.execute(computer, { argv: ["echo", "novita-ok"] }, ctx)) {
          if (event.type === "stdout") stdout += event.data;
          if (event.type === "exit") expect(event.code).toBe(0);
        }
        expect(stdout).toContain("novita-ok");
        await sandbox.writeFile(
          computer,
          { path: "canary.txt", content: new TextEncoder().encode("preserved") },
          ctx,
        );
        expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);

        await sandbox.stop(computer, ctx);
        computer = await sandbox.provision(
          { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
          ctx,
        );
        expect(computer.fresh).toBe(false);
        await sandbox.prepare(computer, ctx);
        expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
          "preserved",
        );
      } finally {
        await sandbox.destroy(computer, ctx);
      }
    }, 240_000);
  },
);

describeCreateos("live CreateOS canary", () => {
  it("provisions a desktop, exports GUI-only work, survives pause, and destroys it", async () => {
    const sandbox = new CreateOSSandboxProvider({
      apiKey: process.env.CREATEOS_SANDBOX_API_KEY!,
      baseUrl: process.env.CREATEOS_SANDBOX_BASE_URL,
      shape: process.env.CREATEOS_SANDBOX_SHAPE,
      rootfs: process.env.CREATEOS_SANDBOX_ROOTFS,
    });
    const ctx = {
      operationId: "createos-canary",
      traceId: "createos-canary",
      spaceId: "createos-canary",
      userId: "createos-canary",
      signal: new AbortController().signal,
    };
    const request = { botId: "createos-canary", homePath: "/home/desktop/rakazo-home" };
    let computer = await sandbox.provision(request, ctx);
    try {
      await sandbox.prepare(computer, ctx);
      let stdout = "";
      for await (const event of sandbox.execute(
        computer,
        { argv: ["echo", "createos-ok"], cwd: "notes", env: { CANARY: "works" } },
        ctx,
      )) {
        if (event.type === "stdout") stdout += event.data;
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      expect(stdout).toContain("createos-ok");

      expect((await sandbox.observe(computer, ctx)).image.byteLength).toBeGreaterThan(0);
      expect(
        (await sandbox.connectScreen(computer, { view: "stream", interactive: true }, ctx)).url,
      ).toBeTruthy();

      await sandbox.writeFile(
        computer,
        { path: "canary.txt", content: new TextEncoder().encode("preserved") },
        ctx,
      );

      // A GUI-only action must still mark the workspace exportable.
      await sandbox.act(computer, { actions: [{ kind: "wait", ms: 0 }], observe: false }, ctx);
      const exported: string[] = [];
      for await (const file of sandbox.exportWorkspace(computer, ctx)) exported.push(file.path);
      expect(exported).toContain("canary.txt");

      await sandbox.stop(computer, ctx);
      computer = await sandbox.provision(
        { ...request, providerRef: computer.providerRef, providerKind: computer.kind },
        ctx,
      );
      expect(computer.fresh).toBe(false);
      await sandbox.prepare(computer, ctx);
      expect(new TextDecoder().decode(await sandbox.readFile(computer, "canary.txt", ctx))).toBe(
        "preserved",
      );
    } finally {
      await sandbox.destroy(computer, ctx);
    }
  }, 600_000);
});

describePi("live OpenRouter / Pi canary", () => {
  it("streams a reply from deepseek/deepseek-v4-flash-0731", async () => {
    const runtime = new PiAgentRuntime();
    let text = "";
    for await (const event of runtime.run(
      {
        botId: "canary",
        threadId: "canary",
        runId: `pi-${Date.now()}`,
        prompt: "Reply with exactly the word pong and nothing else.",
        instructions: "You are a concise test bot. Do not call tools.",
        history: [],
        tools: [],
        model: {
          provider: "openrouter",
          id: "deepseek/deepseek-v4-flash-0731",
          apiKey: process.env.OPENROUTER_API_KEY,
        },
      },
      {
        operationId: "canary",
        traceId: "canary",
        spaceId: "canary",
        userId: "canary",
        signal: new AbortController().signal,
      },
    )) {
      if (event.type === "text") text += event.text;
      if (event.type === "done" && event.text && !text) text = event.text;
    }
    expect(text.trim().toLowerCase()).toBe("pong");
    expect(text).not.toMatch(/sk-or-|OPENROUTER_API_KEY/i);
  }, 90_000);
});

describePiApp("live OpenRouter product journey", () => {
  let stop: (() => Promise<void>) | undefined;
  let dataDir: string | undefined;

  afterAll(async () => {
    try {
      await stop?.();
    } finally {
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("completes a bot turn through the API with the live model", async () => {
    const { createApp } = await import("@rakazo/api/app");
    dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-pi-"));
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
    });
    stop = handles.stop;
    const stamp = Date.now();
    const email = `pi-${stamp}@rakazo.test`;
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name: "Pi Canary" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const botRes = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Canary",
      instructions: "Reply briefly. Prefer the write_file tool when asked to write a file.",
      notifyOnFinish: true,
    });
    const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
      botId: botRes.id,
      text: "Use write_file to save notes/result.txt containing exactly openrouter-ok",
    });
    const run = await waitForRun(
      () =>
        handles.prisma.run.findUnique({
          where: { id: sent.runId },
          select: { status: true },
        }),
      90_000,
    );
    expect(run.status).toBe("completed");
    const snap = await rpc<Snap>(handles.app, cookie, "threads/get", { botId: botRes.id });
    const blob = JSON.stringify(snap);
    expect(blob).not.toMatch(/sk-or-/i);
    const file = await rpc<{ content: string }>(handles.app, cookie, "computer/readFile", {
      botId: botRes.id,
      path: "notes/result.txt",
    });
    expect(file.content).toBe("openrouter-ok");
  }, 120_000);
});

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Snap = {
  messages: Array<{ role: string; blocks: unknown[] }>;
  run: { status: string } | null;
};

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const parsed = (await res.json()) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error)
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? "failed"}`);
  return parsed.json as T;
}

async function waitForRun(load: () => Promise<{ status: string } | null>, ms: number) {
  const start = Date.now();
  let last: { status: string } | null = null;
  while (Date.now() - start < ms) {
    last = await load();
    if (last && isTerminal(last.status as RunStatus)) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timeout waiting for live model turn: ${last?.status ?? "not found"}`);
}
