import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MCP_STDIO_STARTUP_TIMEOUT_MS,
  McpConnector,
  mcpStdioOptionsFromEnv,
} from "./mcp-connector.js";
import * as installer from "./mcp-package-installer.js";
import { mcpPackageDir } from "./mcp-package-installer.js";
import { McpSession } from "./mcp-transport.js";

// No server is shared with every agent, so only assignments reach a bot.
const NO_SHARED_SERVERS = { findMany: async () => [], findFirst: async () => null };

/** A dependency-free stdio MCP server: one `hello` tool that echoes its launch arguments. */
const SERVER_SOURCE = `#!/usr/bin/env node
if (process.env.SILENT) {
  // Like a server whose upstream hangs: alive, but never answers.
  process.stdin.resume();
} else if (process.env.FAIL_LOUDLY) {
  console.error("auth failed for " + process.env.MAIL_API_KEY + " as " + process.env.MAIL_ACCOUNT);
  process.exit(1);
}
if (!process.env.SILENT) {
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.id === undefined) continue;
    if (message.method === "initialize")
      send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } } });
    else if (message.method === "tools/list")
      send({ id: message.id, result: { tools: [{ name: "hello", inputSchema: { type: "object" } }] } });
    else if (message.method === "tools/call")
      send({ id: message.id, result: { content: [{ type: "text", text: "hi " + process.argv.slice(2).join(" ") }] } });
    else send({ id: message.id, result: {} });
  }
});
}
`;

const SPEC = "@demo/mail-mcp@1.0.0";

/** What a finished install leaves behind, without running npm. */
async function publishPackage(root: string): Promise<void> {
  const dir = mcpPackageDir(SPEC, root);
  const packageDir = join(dir, "node_modules", "@demo", "mail-mcp");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@demo/mail-mcp", version: "1.0.0", bin: { "mail-mcp": "server.js" } }),
  );
  await writeFile(join(packageDir, "server.js"), SERVER_SOURCE);
  await chmod(join(packageDir, "server.js"), 0o755);
  await writeFile(join(dir, ".ready"), "{}\n");
}

const SERVER = {
  id: "server-1",
  slug: "mail",
  name: "Mail",
  transport: "stdio",
  command: "npx",
  args: ["-y", SPEC, "--region", "eu"],
  endpoint: null,
  secretId: "secret-1",
  enabled: true,
  revision: 1,
};

function contextFor(botId = "bot-1") {
  return {
    operationId: "test",
    traceId: "test",
    spaceId: "w1",
    userId: "u1",
    botId,
    signal: new AbortController().signal,
  } as never;
}

describe("MCP connector managed stdio launch", () => {
  let root: string;
  let env: Record<string, string>;
  let args: string[] | undefined;
  const updateMany = vi.fn(
    async (_args: { where?: { revision?: number }; data: Record<string, unknown> }) => ({
      count: 1,
    }),
  );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rakazo-mcp-launch-"));
    env = {};
    args = undefined;
    updateMany.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  function connectorFor(
    options: {
      stdioEnabled?: boolean;
      allowedCommands?: string[];
      idleMs?: number;
      server?: typeof SERVER;
      startupTimeoutMs?: number;
      discoveryTimeoutMs?: number;
    } = {},
  ) {
    const server = options.server ?? SERVER;
    const assignment = (botId: string) => ({
      botId,
      serverId: server.id,
      spaceId: "w1",
      userId: "u1",
      allowAllTools: true,
      allowedTools: [],
      server,
    });
    const prisma = {
      botMcpServer: {
        findMany: vi.fn(async ({ where }: { where: { botId: string } }) => [
          assignment(where.botId),
        ]),
        findFirst: vi.fn(async ({ where }: { where: { botId: string } }) =>
          assignment(where.botId),
        ),
      },
      secret: { findFirst: vi.fn(async () => ({ id: "secret-1", ciphertext: "cipher" })) },
      mcpServer: { ...NO_SHARED_SERVERS, updateMany },
    };
    const secrets = { load: vi.fn(async () => JSON.stringify({ env, args })) };
    return new McpConnector(prisma as never, secrets as never, {
      stdioEnabled: options.stdioEnabled ?? true,
      allowedCommands: options.allowedCommands ?? ["npx"],
      packagesDir: root,
      idleMs: options.idleMs,
      startupTimeoutMs: options.startupTimeoutMs,
      discoveryTimeoutMs: options.discoveryTimeoutMs,
    });
  }

  const healthWrites = () => updateMany.mock.calls.map(([args]) => args.data);

  async function callTool(connector: McpConnector, tool: { name: string; route?: unknown }) {
    const events = [];
    for await (const event of connector.execute(
      { tool: tool.name, args: {}, executionId: "call-1", route: tool.route as never },
      contextFor(),
    ))
      events.push(event);
    return events;
  }

  it("launches the managed install's bin with the bin's own arguments", async () => {
    await publishPackage(root);
    const connector = connectorFor();
    try {
      const tools = await connector.discoverTools(contextFor());
      expect(tools.map((tool) => tool.name)).toEqual(["mcp__mail__hello"]);
      const [tool] = tools;
      expect(await callTool(connector, tool!)).toMatchObject([
        { type: "result", data: { content: [{ text: "hi --region eu" }] } },
      ]);
      await vi.waitFor(() =>
        expect(healthWrites()).toContainEqual(
          expect.objectContaining({ healthStatus: "ok", healthToolCount: 1 }),
        ),
      );
    } finally {
      await connector.close();
    }
  });

  it("launches with the arguments kept in the encrypted credential", async () => {
    await publishPackage(root);
    args = ["-y", SPEC, "--region", "us"];
    const connector = connectorFor({ server: { ...SERVER, args: [] } });
    try {
      const [tool] = await connector.discoverTools(contextFor());
      expect(await callTool(connector, tool!)).toMatchObject([
        { type: "result", data: { content: [{ text: "hi --region us" }] } },
      ]);
    } finally {
      await connector.close();
    }
  });

  it.each([
    [{ allowedCommands: ["node"] }, "This stdio command isn't allowed here"],
    [{ stdioEnabled: false }, "Stdio MCP servers aren't available here"],
  ])(
    "refuses a server this deployment can't run before installing, as a warning",
    async (options, reason) => {
      const connector = connectorFor(options);
      const error = vi.spyOn(getLogger(), "error");
      const warn = vi.spyOn(getLogger(), "warn");
      try {
        const tools = await connector.discoverTools(contextFor());
        expect(tools).toMatchObject([{ name: "mcp__mail__unavailable" }]);
        expect(tools[0]?.description).toContain(reason);
        expect(await readdir(root)).toEqual([]);
        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith("mcp discovery failed for server mail", { reason });
        await vi.waitFor(() =>
          expect(healthWrites()).toContainEqual(
            expect.objectContaining({ healthStatus: "error", healthMessage: reason }),
          ),
        );
      } finally {
        vi.restoreAllMocks();
        await connector.close();
      }
    },
  );

  it.each([
    ["bunx", ["pkg"]],
    ["pnpm", ["dlx", "pkg"]],
    ["uvx", ["pkg"]],
  ])("refuses package runner %s before installing or launching", async (command, args) => {
    const launches = vi.spyOn(McpSession.prototype, "connectStdio");
    const installs = vi.spyOn(installer, "ensureMcpPackage");
    const connector = connectorFor({
      allowedCommands: [command],
      server: { ...SERVER, command, args },
    });
    try {
      const tools = await connector.discoverTools(contextFor());
      expect(tools).toMatchObject([{ name: "mcp__mail__unavailable" }]);
      expect(tools[0]?.description).toContain("Only npx can launch packages here");
      expect(launches).not.toHaveBeenCalled();
      expect(installs).not.toHaveBeenCalled();
    } finally {
      await connector.close();
    }
  });

  it.each([
    [["-c", "echo hi"]],
    [["--call", "echo hi"]],
    [["--shell", "sh"]],
    [["-y", "./local-server"]],
    [["-p", "a", "-p", "b", "bin"]],
  ])("refuses an npx launch it can't reduce to a registry package: %j", async (args) => {
    const launches = vi.spyOn(McpSession.prototype, "connectStdio");
    const installs = vi.spyOn(installer, "ensureMcpPackage");
    const connector = connectorFor({ server: { ...SERVER, args } });
    try {
      const tools = await connector.discoverTools(contextFor());
      expect(tools).toMatchObject([{ name: "mcp__mail__unavailable" }]);
      expect(tools[0]?.description).toContain("This npx command isn't supported here");
      expect(launches).not.toHaveBeenCalled();
      expect(installs).not.toHaveBeenCalled();
    } finally {
      await connector.close();
    }
  });

  it("tells the model why an assigned server is unavailable, with secrets redacted", async () => {
    await publishPackage(root);
    env = {
      FAIL_LOUDLY: "1",
      MAIL_API_KEY: "sk-live-0123456789abcdef",
      MAIL_ACCOUNT: "person@example.test",
    };
    const connector = connectorFor();
    try {
      const tools = await connector.discoverTools(contextFor());
      expect(tools).toHaveLength(1);
      const [placeholder] = tools;
      expect(placeholder?.name).toBe("mcp__mail__unavailable");
      expect(placeholder?.description).toContain('"Mail" is assigned to you but is unavailable');
      expect(placeholder?.description).toContain("auth failed for [redacted] as [redacted]");
      const visible = JSON.stringify({ tools, health: healthWrites() });
      expect(visible).not.toContain("sk-live-0123456789abcdef");
      expect(visible).not.toContain("person@example.test");

      const events = await callTool(connector, placeholder!);
      expect(events).toEqual([
        {
          type: "error",
          message: expect.stringMatching(/^MCP server "Mail" is unavailable: .*auth failed for/s),
        },
      ]);
      await vi.waitFor(() =>
        expect(healthWrites()).toContainEqual(
          expect.objectContaining({
            healthStatus: "error",
            healthMessage: expect.stringContaining("auth failed for [redacted]"),
          }),
        ),
      );
    } finally {
      await connector.close();
    }
  });

  it("records installing while another process installs the package, then uses it", async () => {
    const dir = mcpPackageDir(SPEC, root);
    const lock = `${dir}.lock`;
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner"),
      JSON.stringify({
        token: "other",
        pid: process.pid,
        host: hostname(),
        expiresAt: Date.now() + 60_000,
      }),
    );
    const connector = connectorFor();
    try {
      const discovering = connector.discoverTools(contextFor());
      await vi.waitFor(() =>
        expect(healthWrites()).toContainEqual(
          expect.objectContaining({ healthStatus: "installing" }),
        ),
      );
      await publishPackage(root);
      await rm(lock, { recursive: true, force: true });
      expect((await discovering).map((tool) => tool.name)).toEqual(["mcp__mail__hello"]);
    } finally {
      await connector.close();
    }
  });

  describe("a slow or failing server", () => {
    it("is skipped after the discovery deadline instead of holding up the run", async () => {
      await publishPackage(root);
      env = { SILENT: "1" };
      // The launch outlives the deadline (startup allows 3s) and finishes in the background.
      const connector = connectorFor({ discoveryTimeoutMs: 1_000, startupTimeoutMs: 3_000 });
      try {
        const startedAt = Date.now();
        const tools = await connector.discoverTools(contextFor());
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(tools).toMatchObject([{ name: "mcp__mail__unavailable" }]);
        expect(tools[0]?.description).toContain("did not list its tools within 1s");
        await vi.waitFor(() =>
          expect(healthWrites()).toContainEqual(expect.objectContaining({ healthStatus: "error" })),
        );
      } finally {
        await connector.close();
      }
    });

    it("is not retried on every turn, but is again after the backoff or once it works", async () => {
      await publishPackage(root);
      // Fails at once, so the healthy relaunch below keeps the default startup budget.
      env = { FAIL_LOUDLY: "1" };
      const launches = vi.spyOn(McpSession.prototype, "connectStdio");
      const connector = connectorFor({ discoveryTimeoutMs: 5_000 });
      try {
        expect(await connector.discoverTools(contextFor())).toMatchObject([
          { name: "mcp__mail__unavailable" },
        ]);
        expect(launches).toHaveBeenCalledTimes(1);

        // Within the backoff: answered from the last failure, nothing is launched.
        expect(await connector.discoverTools(contextFor("bot-2"))).toMatchObject([
          { name: "mcp__mail__unavailable" },
        ]);
        expect(launches).toHaveBeenCalledTimes(1);

        // After it, the server is tried again, and a success ends the backoff.
        env = {};
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
        expect((await connector.discoverTools(contextFor())).map((tool) => tool.name)).toEqual([
          "mcp__mail__hello",
        ]);
        expect(launches).toHaveBeenCalledTimes(2);
      } finally {
        await connector.close();
      }
    });

    it("ends the backoff once another process records a successful check", async () => {
      await publishPackage(root);
      env = { FAIL_LOUDLY: "1" };
      const server: typeof SERVER & { healthStatus?: string; healthCheckedAt?: Date } = {
        ...SERVER,
      };
      const launches = vi.spyOn(McpSession.prototype, "connectStdio");
      const connector = connectorFor({ server, discoveryTimeoutMs: 5_000 });
      try {
        expect(await connector.discoverTools(contextFor())).toMatchObject([
          { name: "mcp__mail__unavailable" },
        ]);
        expect(launches).toHaveBeenCalledTimes(1);

        // An older success says nothing about the failure that started the backoff.
        server.healthStatus = "ok";
        server.healthCheckedAt = new Date(Date.now() - 60_000);
        expect(await connector.discoverTools(contextFor())).toMatchObject([
          { name: "mcp__mail__unavailable" },
        ]);
        expect(launches).toHaveBeenCalledTimes(1);

        // Test connection in the API passed after it: the next run tries the server again.
        env = {};
        server.healthCheckedAt = new Date(Date.now() + 1_000);
        expect((await connector.discoverTools(contextFor())).map((tool) => tool.name)).toEqual([
          "mcp__mail__hello",
        ]);
        expect(launches).toHaveBeenCalledTimes(2);
      } finally {
        await connector.close();
      }
    });

    it("lets a run go on while its package installs, and uses it on a later turn", async () => {
      const dir = mcpPackageDir(SPEC, root);
      const lock = `${dir}.lock`;
      await mkdir(lock, { recursive: true });
      await writeFile(
        join(lock, "owner"),
        JSON.stringify({
          token: "other",
          pid: process.pid,
          host: hostname(),
          expiresAt: Date.now() + 60_000,
        }),
      );
      // Also bounds the launch once installed, so leave room for a loaded machine.
      const connector = connectorFor({ discoveryTimeoutMs: 2_000 });
      try {
        const tools = await connector.discoverTools(contextFor());
        expect(tools).toMatchObject([{ name: "mcp__mail__unavailable" }]);
        expect(tools[0]?.description).toContain("still installing");
        // Installing is not a failure: no error health and no backoff.
        expect(await connector.discoverTools(contextFor())).toMatchObject([
          { description: expect.stringContaining("still installing") },
        ]);
        expect(healthWrites()).not.toContainEqual(
          expect.objectContaining({ healthStatus: "error" }),
        );

        await publishPackage(root);
        await rm(lock, { recursive: true, force: true });
        await vi.waitFor(
          async () =>
            expect((await connector.discoverTools(contextFor())).map((tool) => tool.name)).toEqual([
              "mcp__mail__hello",
            ]),
          { timeout: 5_000, interval: 100 },
        );
      } finally {
        await connector.close();
      }
    });
  });

  it("runs one process per server for every bot of the same user", async () => {
    await publishPackage(root);
    const launches = vi.spyOn(McpSession.prototype, "connectStdio");
    const connector = connectorFor();
    try {
      await connector.discoverTools(contextFor("bot-1"));
      await connector.discoverTools(contextFor("bot-2"));
      expect(launches).toHaveBeenCalledTimes(1);
    } finally {
      await connector.close();
    }
  });

  it("stops idle processes, never busy ones, and stops its timer on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.spyOn(McpSession.prototype, "connectStdio").mockResolvedValue(undefined);
    vi.spyOn(McpSession.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "hello", inputSchema: { type: "object" } }],
    });
    let finishCall: () => void = () => undefined;
    vi.spyOn(McpSession.prototype, "callTool").mockImplementation(
      () =>
        new Promise((done) => {
          finishCall = () => done({ content: [] });
        }),
    );
    const close = vi.spyOn(McpSession.prototype, "close").mockResolvedValue(undefined);
    await publishPackage(root);
    const connector = connectorFor({ idleMs: 1_000 });
    const sessions = (connector as unknown as { sessions: Map<string, unknown> }).sessions;
    try {
      const [tool] = await connector.discoverTools(contextFor());
      const calling = callTool(connector, tool!);
      await vi.waitFor(() => expect(McpSession.prototype.callTool).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sessions.size).toBe(1);
      expect(close).not.toHaveBeenCalled();

      finishCall();
      await calling;
      // Reaped within one sweep interval after it went idle.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(sessions.size).toBe(0);
      expect(close).toHaveBeenCalledTimes(1);

      await connector.discoverTools(contextFor());
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await connector.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets installing health after a cancelled discovery's shared install settles", async () => {
    let finishInstall: (() => Promise<void> | undefined) | undefined;
    vi.spyOn(installer, "ensureMcpPackage").mockImplementation(async (_spec, options) => {
      options?.onInstall?.();
      finishInstall = options?.onSettled;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const connector = connectorFor();
    try {
      const discovery = connector.discoverTools({
        operationId: "test",
        traceId: "test",
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(finishInstall).toBeDefined());
      controller.abort(new Error("cancelled"));
      await discovery;
      await finishInstall?.();
      expect(healthWrites().at(-1)).toMatchObject({ healthStatus: "unknown" });
    } finally {
      await connector.close();
    }
  });

  it("keeps a newer revision's health when an older install settles", async () => {
    const stored = { revision: 1, healthStatus: "unknown" as unknown };
    updateMany.mockImplementation(async (args) => {
      const revision = args.where?.revision;
      if (revision !== undefined && revision !== stored.revision) return { count: 0 };
      stored.healthStatus = args.data.healthStatus;
      return { count: 1 };
    });
    let finishInstall: (() => Promise<void> | undefined) | undefined;
    vi.spyOn(installer, "ensureMcpPackage").mockImplementation(async (_spec, options) => {
      options?.onInstall?.();
      finishInstall = options?.onSettled;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const connector = connectorFor();
    try {
      const discovery = connector.discoverTools({
        operationId: "test",
        traceId: "test",
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(finishInstall).toBeDefined());
      // An edit elsewhere moved the server on and its check failed.
      Object.assign(stored, { revision: 2, healthStatus: "error" });
      controller.abort(new Error("cancelled"));
      await discovery;
      await finishInstall?.();
      expect(stored).toEqual({ revision: 2, healthStatus: "error" });
      expect(updateMany.mock.calls.map(([args]) => args.where)).toEqual([
        { id: "server-1", revision: 1 },
        { id: "server-1", revision: 1 },
      ]);
    } finally {
      updateMany.mockImplementation(async () => ({ count: 1 }));
      await connector.close();
    }
  });

  it("resets installing health after a timed out discovery's shared install settles", async () => {
    let finishInstall: (() => Promise<void> | undefined) | undefined;
    vi.spyOn(installer, "ensureMcpPackage").mockImplementation(async (_spec, options) => {
      options?.onInstall?.();
      finishInstall = options?.onSettled;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const connector = connectorFor({ discoveryTimeoutMs: 20 });
    try {
      const discovery = connector.discoverTools({
        operationId: "test",
        traceId: "test",
        spaceId: "w1",
        userId: "u1",
        botId: "bot-1",
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(finishInstall).toBeDefined());
      await discovery;
      await finishInstall?.();
      expect(healthWrites().at(-1)).toMatchObject({ healthStatus: "unknown" });
    } finally {
      controller.abort();
      await connector.close();
    }
  });

  it("rejects zero timeouts while preserving zero idle duration", () => {
    expect(
      mcpStdioOptionsFromEnv({
        MCP_STDIO_INSTALL_TIMEOUT_MS: "0",
        MCP_STDIO_STARTUP_TIMEOUT_MS: "0",
        MCP_STDIO_IDLE_MS: "0",
      }),
    ).toMatchObject({
      installTimeoutMs: 180_000,
      startupTimeoutMs: DEFAULT_MCP_STDIO_STARTUP_TIMEOUT_MS,
      idleMs: 0,
    });
  });

  describe("probe", () => {
    it("starts a separate probe for a new server revision", async () => {
      await publishPackage(root);
      const launches = vi.spyOn(McpSession.prototype, "connectStdio");
      const connector = connectorFor();
      try {
        const scope = { spaceId: "w1", userId: "u1" };
        const first = connector.probe(SERVER as never, scope);
        const second = connector.probe({ ...SERVER, revision: 2 } as never, scope);
        expect(first).not.toBe(second);
        await Promise.all([first, second]);
        expect(launches).toHaveBeenCalledTimes(2);
      } finally {
        await connector.close();
      }
    });

    it("starts an isolated process, records the result, and stops it", async () => {
      await publishPackage(root);
      const close = vi.spyOn(McpSession.prototype, "close");
      const connector = connectorFor();
      try {
        const result = await connector.probe(SERVER as never, { spaceId: "w1", userId: "u1" });
        expect(result).toEqual({ status: "ok", message: null, toolCount: 1 });
        expect(close).toHaveBeenCalledTimes(1);
        expect((connector as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
        expect(healthWrites()).toEqual([
          expect.objectContaining({ healthStatus: "ok", healthToolCount: 1 }),
        ]);
      } finally {
        await connector.close();
      }
    });

    it("reuses this process's live session instead of launching a second one", async () => {
      await publishPackage(root);
      const launches = vi.spyOn(McpSession.prototype, "connectStdio");
      const connector = connectorFor();
      try {
        await connector.discoverTools(contextFor());
        const result = await connector.probe(SERVER as never, { spaceId: "w1", userId: "u1" });
        expect(result).toMatchObject({ status: "ok", toolCount: 1 });
        expect(launches).toHaveBeenCalledTimes(1);
      } finally {
        await connector.close();
      }
    });

    it("shares one launch between concurrent probes of a server", async () => {
      await publishPackage(root);
      const launches = vi.spyOn(McpSession.prototype, "connectStdio");
      const connector = connectorFor();
      try {
        const scope = { spaceId: "w1", userId: "u1" };
        const [first, second] = await Promise.all([
          connector.probe(SERVER as never, scope),
          connector.probe(SERVER as never, scope),
        ]);
        expect(first).toEqual(second);
        expect(launches).toHaveBeenCalledTimes(1);
      } finally {
        await connector.close();
      }
    });

    it("returns and records a redacted error", async () => {
      await publishPackage(root);
      env = { FAIL_LOUDLY: "1", MAIL_API_KEY: "sk-live-0123456789abcdef", MAIL_ACCOUNT: "x" };
      const connector = connectorFor();
      try {
        const result = await connector.probe(SERVER as never, { spaceId: "w1", userId: "u1" });
        expect(result.status).toBe("error");
        expect(result.message).toContain("auth failed for [redacted]");
        expect(JSON.stringify(healthWrites())).not.toContain("sk-live-0123456789abcdef");
      } finally {
        await connector.close();
      }
    });
  });
});
