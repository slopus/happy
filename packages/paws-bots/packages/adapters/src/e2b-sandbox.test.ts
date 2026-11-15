import { createServer } from "node:http";
import type { CommandResult, EntryInfo } from "@e2b/desktop";
import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  FileType,
  RateLimitError,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxUnreachableError,
  TimeoutError,
} from "@e2b/desktop";
import type { CommandRequest, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { sandboxIdleMs } from "./computer-idle.js";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import type { E2BDesktop, E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider, e2bCreateOptions, keepingAwake } from "./e2b-sandbox.js";
import { E2B_COMPUTER_TEMPLATE, E2B_DESKTOP_TEMPLATE } from "./e2b-template.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

const context = {
  operationId: "e2b-test",
  traceId: "e2b-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("E2B computer backend", () => {
  it("bills while running", () => {
    expect(new E2BSandboxProvider("test-key").billsWhileRunning()).toBe(true);
  });

  it("removes inherited variables after the command environment overlay", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const provider = new E2BSandboxProvider("test-key", {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        commands: { run },
      })),
    } as unknown as E2BSandboxSdk);
    const events = [];
    for await (const event of provider.execute(
      { id: "existing", providerRef: "existing", kind: "e2b", botId: "bot" },
      { argv: ["true"], env: { FAILED: "fake-space" }, unsetEnv: ["FAILED"] },
      context,
    ))
      events.push(event);
    expect(events).toEqual([{ type: "exit", code: 0 }]);
    expect(run).toHaveBeenCalledWith(
      "'env' '-u' 'FAILED' '--' 'true'",
      expect.objectContaining({ envs: { FAILED: "fake-space" } }),
    );
  });

  it("revokes an extra display's control without starting or waiting for its view", async () => {
    const command = vi.fn(async (value: string) => {
      if (value.includes("RAKAZO_SCREEN_INDEX=")) {
        return { stdout: "RAKAZO_SCREEN_INDEX=1\n", stderr: "", exitCode: 0 };
      }
      if (value.includes("RAKAZO_SCREEN_PASSWORD=") || value.includes("flock 8")) {
        throw new Error("extra view is unavailable");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const provider = new E2BSandboxProvider("test-key", {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        display: ":0",
        commands: { run: command },
      })),
    } as unknown as E2BSandboxSdk);

    await expect(
      provider.setScreenControl(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "bot" },
        false,
        { ...context, botId: "bot" },
        "expired-control-token",
      ),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("expired-control-token"),
      expect.objectContaining({ signal: context.signal }),
    );
  });

  it("reconnects concurrent primary viewers without using the SDK's global VNC lifecycle", async () => {
    const command = vi.fn(async (_value: string) => ({
      stdout: "RAKAZO_DESKTOP=0:savedkey\n",
      stderr: "",
      exitCode: 0,
    }));
    const globalStream = vi.fn(async () => {
      throw new Error("Stream is already running");
    });
    const sdk = {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        display: ":0",
        getHost: (port: number) => `${port}-desktop.test`,
        commands: { run: command },
        stream: { start: globalStream, stop: globalStream },
      })),
    } as unknown as E2BSandboxSdk;
    const computer = {
      id: "existing",
      providerRef: "existing",
      kind: "e2b" as const,
      botId: "bot",
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const [first, second] = await Promise.all([
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.provision({ ...computer, providerKind: "e2b", homePath: "/unused" }, context),
    ]);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(first.url).toBe(second.url);
    expect(new URL(first.url!).searchParams.get("path")).toBe("websockify?token=savedkey");

    const restarted = new E2BSandboxProvider("test-key", sdk);
    const restored = await restarted.connectScreen(computer, { view: "stream" }, context);
    expect(restored.url).toBe(first.url);
    const commandsBeforeClose = command.mock.calls.length;
    await first.close();
    expect(command).toHaveBeenCalledTimes(commandsBeforeClose);
    expect(globalStream).not.toHaveBeenCalled();
  });

  it("e2b-screen-traffic-token sends the traffic token for screen and terminal", async () => {
    const computer = {
      id: "existing",
      providerRef: "existing",
      kind: "e2b" as const,
      botId: "bot",
    };
    const provider = (trafficAccessToken?: string) => {
      const desktop = {
        sandboxId: "existing",
        getHost: (port: number) => `${port}-desktop.test`,
        setTimeout: async () => undefined,
        commands: {
          run: async () => ({
            stdout: "RAKAZO_DESKTOP=0:savedkey\n",
            stderr: "",
            exitCode: 0,
          }),
        },
        files: {
          makeDir: async () => true,
          list: async () => [],
          getInfo: async () => ({ name: "x", size: 0, mode: 0 }),
          read: async () => new Uint8Array(),
          write: async () => undefined,
        },
        ...(trafficAccessToken !== undefined ? { trafficAccessToken } : {}),
      } satisfies E2BDesktop;
      const sdk = {
        create: async () => desktop,
        connect: async () => desktop,
        pause: async () => undefined,
        kill: async () => true,
      } satisfies E2BSandboxSdk;
      return new E2BSandboxProvider("test-key", sdk);
    };

    const restricted = provider("tok");
    const screen = await restricted.connectScreen(computer, { view: "stream" }, context);
    expect(screen.headers?.["e2b-traffic-access-token"]).toBe("tok");
    const terminal = await restricted.connectTerminal(
      computer,
      { controlToken: "lease-1" },
      context,
    );
    expect(terminal.headers?.["e2b-traffic-access-token"]).toBe("tok");

    const open = await provider().connectScreen(computer, { view: "stream" }, context);
    expect(open.headers).toBeUndefined();
    const blank = await provider("").connectScreen(computer, { view: "stream" }, context);
    expect(blank.headers).toBeUndefined();
  });

  it("only filters transient cache files inside portable browser profiles", () => {
    expect(shouldSkipPortableWorkspaceFile("project/Cache/important.txt")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile("project/lock")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/Cache/data")).toBe(true);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/SingletonLock")).toBe(true);
  });

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    undefined,
  ])("preserves an existing sandbox after a %s transport failure", async (code) => {
    const desktop = { sandboxId: "fresh-e2b-box" } as unknown as Sandbox;
    const failure = new Error("fetch failed", {
      cause: Object.assign(new Error("transport unavailable"), { code }),
    });
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ sandboxId: "existing" }),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);

    const request = {
      botId: "bot-1",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "e2b" as const,
    };
    await expect(provider.provision(request, context)).rejects.toBe(failure);
    expect(sdk.create).not.toHaveBeenCalled();
    await expect(provider.provision(request, context)).resolves.toMatchObject({
      providerRef: "existing",
      fresh: false,
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("reports a sandbox running from its status without connecting to it", async () => {
    const outage = new Error("fetch failed");
    const sdk: E2BSandboxSdk = {
      create: vi.fn(),
      connect: vi.fn(),
      pause: vi.fn(),
      kill: vi.fn(async () => true),
      isRunning: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new SandboxNotFoundError("Sandbox existing not found"))
        .mockRejectedValueOnce(outage),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "existing",
      providerRef: "existing",
      kind: "e2b" as const,
      botId: "bot",
    };

    await expect(provider.isRunning(computer, context)).resolves.toBe(true);
    await expect(provider.isRunning(computer, context)).resolves.toBe(false);
    await expect(provider.isRunning(computer, context)).resolves.toBe(false);
    await expect(provider.isRunning(computer, context)).rejects.toBe(outage);
    await expect(provider.isRunning({ ...computer, kind: "novita" }, context)).resolves.toBe(false);
    expect(sdk.isRunning).toHaveBeenCalledTimes(4);
    expect(sdk.isRunning).toHaveBeenCalledWith("existing", {
      apiKey: "test-key",
      signal: context.signal,
    });
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("reads a sandbox's status from the E2B SDK", async () => {
    const info = (state: string) => ({ state }) as Awaited<ReturnType<typeof Sandbox.getInfo>>;
    const getInfo = vi
      .spyOn(Sandbox, "getInfo")
      .mockResolvedValueOnce(info("running"))
      .mockResolvedValueOnce(info("paused"));
    const provider = new E2BSandboxProvider("test-key");
    const computer = {
      id: "existing",
      providerRef: "existing",
      kind: "e2b" as const,
      botId: "bot",
    };
    try {
      await expect(provider.isRunning(computer, context)).resolves.toBe(true);
      await expect(provider.isRunning(computer, context)).resolves.toBe(false);
      expect(getInfo).toHaveBeenCalledWith("existing", {
        apiKey: "test-key",
        signal: context.signal,
        retries: 0,
      });
    } finally {
      getInfo.mockRestore();
    }
  });

  it("creates new computers from the Rakazo computer template", async () => {
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue({ sandboxId: "fresh" }),
      connect: vi.fn(),
      pause: vi.fn(),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);

    await expect(
      provider.provision({ botId: "bot-1", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ providerRef: "fresh", fresh: true });
    expect(sdk.create).toHaveBeenCalledOnce();
    expect(sdk.create).toHaveBeenCalledWith(
      E2B_COMPUTER_TEMPLATE,
      e2bCreateOptions("bot-1", "test-key"),
    );
  });

  it("falls back to the stock desktop template when this account has not built it", async () => {
    const missing = Object.assign(new SandboxError("404: template 'rakazo-computer' not found"), {
      statusCode: 404,
    });
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockRejectedValueOnce(missing).mockResolvedValue({ sandboxId: "stock" }),
      connect: vi.fn(),
      pause: vi.fn(),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);

    await expect(
      provider.provision({ botId: "bot-1", homePath: "/unused" }, context),
    ).resolves.toMatchObject({ providerRef: "stock", fresh: true });
    expect(sdk.create).toHaveBeenNthCalledWith(
      2,
      E2B_DESKTOP_TEMPLATE,
      e2bCreateOptions("bot-1", "test-key"),
    );
  });

  it("does not hide other create failures behind the stock template", async () => {
    const limited = Object.assign(new SandboxError("429: rate limited"), { statusCode: 429 });
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockRejectedValue(limited),
      connect: vi.fn(),
      pause: vi.fn(),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);

    await expect(provider.provision({ botId: "bot-1", homePath: "/unused" }, context)).rejects.toBe(
      limited,
    );
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("creates a replacement when the provider confirms the sandbox no longer exists", async () => {
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue({ sandboxId: "replacement" }),
      connect: vi.fn().mockRejectedValue(
        Object.assign(new Error("Sandbox not found"), {
          name: "SandboxNotFoundError",
        }),
      ),
      pause: vi.fn(),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    await expect(
      provider.provision(
        {
          botId: "bot-1",
          homePath: "/unused",
          providerRef: "missing",
          providerKind: "e2b",
        },
        context,
      ),
    ).resolves.toMatchObject({ providerRef: "replacement", fresh: true });
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it("creates once when the real SDK answers 503, leaving retries to the lifecycle", async () => {
    const requests = await withApiAnswering(503, async () => {
      const provider = new E2BSandboxProvider("e2b_test");
      await expect(
        provider.provision({ botId: "bot-1", homePath: "/unused" }, context),
      ).rejects.toMatchObject({ statusCode: 503 });
    });
    // A replayed create could start a second sandbox if the first 503 came after it started.
    expect(requests).toEqual(["POST /v2/sandboxes"]);
  });

  it.each([
    { method: "destroy", status: 404, outcome: "resolves" },
    { method: "destroy", status: 503, outcome: "rejects" },
    { method: "stop", status: 409, outcome: "resolves" },
    { method: "stop", status: 429, outcome: "rejects" },
    { method: "stop", status: 404, outcome: "gone" },
  ] as const)(
    "$method maps a real SDK $status without resuming the sandbox",
    async ({ method, status, outcome }) => {
      const requests = await withApiAnswering(status, async () => {
        const provider = new E2BSandboxProvider("e2b_test");
        const computer = {
          id: "paused",
          providerRef: "paused",
          kind: "e2b" as const,
          botId: "bot",
        };
        const result = provider[method](computer, context);
        if (outcome === "resolves") await expect(result).resolves.toBeUndefined();
        else if (outcome === "rejects")
          await expect(result).rejects.toMatchObject({ statusCode: status });
        else await expect(result).rejects.toSatisfy(isSandboxGoneError);
      });
      // One request: the lifecycle owns retries, and a stop or destroy never resumes the sandbox.
      expect(requests).toEqual([
        method === "destroy" ? "DELETE /sandboxes/paused" : "POST /sandboxes/paused/pause",
      ]);
    },
  );

  it("gives screen setup commands a real timeout and surfaces a failed one as unavailable", async () => {
    const run = vi.fn(async (_command: string, opts?: { timeoutMs?: number }) => {
      // The SDK throws on a non-zero exit rather than returning the result, and caps the
      // command at 60s unless a timeout is passed.
      if ((opts?.timeoutMs ?? 60_000) <= 60_000) {
        throw Object.assign(new Error("signal: terminated"), {
          name: "CommandExitError",
          result: { exitCode: -1, stdout: "", stderr: "", error: "signal: terminated" },
        });
      }
      throw Object.assign(new Error("boom"), {
        name: "CommandExitError",
        result: { exitCode: 1, stdout: "", stderr: "boom", error: "boom" },
      });
    });
    const desktop = {
      sandboxId: "screen-e2b-box",
      display: ":0",
      commands: { run },
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "screen-e2b-box",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "screen-e2b-box",
      fresh: false,
    };

    await expect(provider.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
      Error,
    );
    expect(run.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(60_000);
  });

  it("surfaces a setup timeout without treating it as a missing sandbox", async () => {
    const run = vi.fn(async () => {
      throw new TimeoutError(
        "deadline_exceeded: This error is likely due to exceeding 'timeoutMs' — the total time a long running request (like command execution or directory watch) can be active.",
      );
    });
    const desktop = {
      sandboxId: "timeout-e2b-box",
      display: ":0",
      commands: { run },
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "timeout-e2b-box",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "timeout-e2b-box",
      fresh: false,
    };

    await expect(provider.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
      Error,
    );
  });

  it("prepares a reused computer idempotently", async () => {
    let profilesConfigured = false;
    const command = vi.fn(async (value: string) => {
      if (value.startsWith('test "$(readlink') && !profilesConfigured) {
        throw new Error("profiles are not configured");
      }
      if (value.includes("ln -s")) profilesConfigured = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const desktop = {
      sandboxId: "reused-e2b-box",
      commands: { run: command },
      launch: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision(
      {
        botId: "bot-1",
        homePath: "/unused",
        providerRef: "reused-e2b-box",
        providerKind: "e2b",
      },
      context,
    );

    await provider.prepare(computer, context);
    await provider.prepare(computer, context);

    expect(command.mock.calls.every(([value]) => value.includes("apt-get"))).toBe(true);
    expect(desktop.launch).not.toHaveBeenCalled();
  });

  it("opens http(s) URLs through the named browser launcher", async () => {
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const launch = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    const desktop = {
      sandboxId: "e2b-open-url-box",
      display: ":0",
      commands: { run: command },
      files: { makeDir: vi.fn(async () => undefined) },
      launch,
      open,
    } as unknown as Sandbox;
    const provider = new E2BSandboxProvider("test-key", {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    });
    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/unused", providerKind: "e2b" },
      context,
    );

    await provider.act(
      computer,
      { actions: [{ kind: "open", path: "https://example.com/docs" }], observe: false },
      context,
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("browser-launch-20"),
      expect.anything(),
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("https://example.com/docs"),
      expect.anything(),
    );
    expect(launch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    await provider.act(
      computer,
      { actions: [{ kind: "open", path: "notes/readme.md" }], observe: false },
      context,
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home/notes/readme.md"),
      expect.anything(),
    );
  });

  it("opens a terminal in the workspace root or the Team bot folder", async () => {
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const desktop = {
      sandboxId: "e2b-terminal-box",
      display: ":0",
      commands: { run: command },
      files: { makeDir: vi.fn(async () => undefined) },
      getHost: (port: number) => `${port}-e2b-terminal-box.e2b.test`,
    } as unknown as Sandbox;
    const provider = new E2BSandboxProvider("test-key", {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    });
    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/unused", providerKind: "e2b" },
      context,
    );

    const root = await provider.connectTerminal(computer, { controlToken: "lease-1" }, context);
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home"),
      expect.anything(),
    );
    const socket = new URL(root.url).searchParams.get("path");
    expect(new URL(root.url).host).toBe("6100-e2b-terminal-box.e2b.test");
    expect(socket).toMatch(/^websockify\?token=[0-9a-f-]{36}$/);

    await provider.connectTerminal(
      computer,
      { controlToken: "lease-1", cwd: "bots/bot-1" },
      context,
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home/bots/bot-1"),
      expect.anything(),
    );
  });

  it("controls the desktop and exposes a portable workspace", async () => {
    const files = new Map<string, Uint8Array>();
    const leftClick = vi.fn(async () => undefined);
    const typeText = vi.fn(async () => undefined);
    const respond = desktopCommandResponder();
    const command = vi.fn(async (value: string, _options?: Record<string, unknown>) => {
      const response = respond(value);
      if (response) return response;
      if (value.includes("hang")) {
        throw new TimeoutError(
          "deadline_exceeded: This error is likely due to exceeding 'timeoutMs' — the total time a long running request (like command execution or directory watch) can be active.",
        );
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        disconnect: async () => undefined,
      };
    });
    const getStreamUrl = vi.fn(() => "https://desktop.test/vnc.html");
    const streamStart = vi.fn(async () => undefined);
    const streamStop = vi.fn(async () => undefined);
    const desktop = {
      sandboxId: "e2b-test-box",
      display: ":0",
      getHost: (port: number) => `${port}-desktop.test`,
      commands: { run: command },
      files: {
        makeDir: vi.fn(async () => undefined),
        write: vi.fn(async (entries: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of entries) files.set(entry.path, new Uint8Array(entry.data));
        }),
        read: vi.fn(async (filePath: string) => {
          const content = files.get(filePath);
          if (!content) throw new Error("missing file");
          return content;
        }),
        list: vi.fn(async (directory: string) => {
          const prefix = `${directory.replace(/\/$/, "")}/`;
          return [...files.entries()]
            .filter(([filePath]) => filePath.startsWith(prefix))
            .map(([filePath, content]) => ({
              name: filePath.slice(prefix.length),
              type: "file" as const,
              size: content.byteLength,
              mode: 0o600,
            }));
        }),
      },
      stream: {
        start: streamStart,
        stop: streamStop,
        getAuthKey: () => "screen-key",
        getUrl: getStreamUrl,
      },
      launch: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      getScreenSize: vi.fn(async () => ({ width: 1280, height: 800 })),
      getCursorPosition: vi.fn(async () => ({ x: 10, y: 20 })),
      getCurrentWindowId: vi.fn(async () => "42"),
      getWindowTitle: vi.fn(async () => "Browser"),
      leftClick,
      rightClick: vi.fn(async () => undefined),
      moveMouse: vi.fn(async () => undefined),
      mousePress: vi.fn(async () => undefined),
      mouseRelease: vi.fn(async () => undefined),
      write: typeText,
      press: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
      setTimeout: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => true),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision(
      {
        botId: "bot-1",
        homePath: "/unused",
        providerRef: "foreign-provider-machine",
        providerKind: "docker",
      },
      context,
    );
    expect(sdk.connect).not.toHaveBeenCalled();
    await provider.prepare(computer, context);
    await provider.importWorkspace(
      computer,
      (async function* () {
        // Empty durable home on first boot.
      })(),
      context,
    );

    const timeoutEvents = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["hang"], timeoutMs: 42 },
      context,
    )) {
      timeoutEvents.push(event);
    }
    expect(timeoutEvents).toEqual([
      { type: "stderr", data: "command timed out after 42 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(command).toHaveBeenCalledWith(
      "'hang'",
      expect.objectContaining({ timeoutMs: 42, signal: context.signal }),
    );

    await provider.writeFile(
      computer,
      {
        path: "notes/result.txt",
        content: new TextEncoder().encode("portable"),
      },
      context,
    );
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", context)),
    ).toBe("portable");
    expect(await provider.listFiles(computer, "notes", context)).toEqual([
      { path: "notes/result.txt", kind: "file", size: 8 },
    ]);

    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "click", x: 100, y: 120 },
          { kind: "clipboard", text: "hello" },
        ],
        observe: true,
      },
      context,
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("xdotool mousemove 100 120 click 1"),
      expect.anything(),
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("xdotool type"),
      expect.anything(),
    );
    expect(result.observation).toMatchObject({ width: 1280, height: 800 });
    expect(command.mock.calls.some(([value]) => String(value).includes(".browser-profiles"))).toBe(
      true,
    );
    expect(command.mock.calls.some(([value]) => String(value).includes("cp -a"))).toBe(false);
    const [screen] = await Promise.all([
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.connectScreen(computer, { view: "stream" }, context),
    ]);
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      context,
    );
    expect(control.url).toContain("6100-desktop.test");
    expect(command.mock.calls.some(([value]) => String(value).includes("0.0.0.0:6100 8>&-"))).toBe(
      true,
    );
    expect(new URL(control.url!).searchParams.get("path")).toBe("websockify?token=lease-1");
    await provider.setScreenControl(computer, false, context, "lease-1");
    await screen.close();
    expect(streamStop).not.toHaveBeenCalled();
    await provider.stop(computer, context);
    expect(sdk.pause).toHaveBeenCalledWith("e2b-test-box", { apiKey: "test-key" });
  });

  it("gives Team bots distinct E2B screens and shared files", async () => {
    const files = new Map<string, Uint8Array>();
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const desktop = {
      sandboxId: "e2b-shared",
      display: ":0",
      getHost: (port: number) => `${port}-desktop.test`,
      commands: { run: command },
      files: {
        makeDir: vi.fn(async () => undefined),
        write: vi.fn(async (entries: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of entries) files.set(entry.path, new Uint8Array(entry.data));
        }),
        read: vi.fn(async (filePath: string) => {
          const content = files.get(filePath);
          if (!content) throw new Error("missing file");
          return content;
        }),
        list: vi.fn(async (directory: string) => {
          const prefix = `${directory.replace(/\/$/, "")}/`;
          return [...files.entries()]
            .filter(([filePath]) => filePath.startsWith(prefix))
            .map(([filePath, content]) => ({
              name: filePath.slice(prefix.length),
              type: "file" as const,
              size: content.byteLength,
              mode: 0o600,
            }));
        }),
      },
      stream: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getAuthKey: () => "key",
        getUrl: () => "https://6100-desktop.test/vnc.html",
      },
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      getScreenSize: vi.fn(async () => ({ width: 1280, height: 800 })),
      getCursorPosition: vi.fn(async () => ({ x: 1, y: 1 })),
      getCurrentWindowId: vi.fn(async () => "1"),
      getWindowTitle: vi.fn(async () => "Desk"),
      leftClick: vi.fn(async () => undefined),
      moveMouse: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("e2b_test", {
      create: vi.fn(async () => desktop as never),
      connect: vi.fn(),
      pause: vi.fn(),
      kill: vi.fn(async () => true),
    } as unknown as E2BSandboxSdk);
    const computer = await provider.provision({ botId: "team-home", homePath: "/tmp" }, context);
    const writer = { ...context, botId: "writer" };
    const researcher = { ...context, botId: "researcher" };

    await provider.observe(computer, writer);
    await provider.observe(computer, researcher);
    const writerView = await provider.connectScreen(computer, { view: "stream" }, writer);
    const researcherView = await provider.connectScreen(computer, { view: "stream" }, researcher);
    expect(writerView.url).toContain("6100-desktop.test");
    expect(researcherView.url).not.toBe(writerView.url);
    expect(researcherView.url).toContain("6100-desktop.test");
    expect(new URL(researcherView.url!).searchParams.get("path")).toMatch(
      /^websockify\?token=view-/,
    );
    expect(writerView.url).not.toBe(researcherView.url);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
      command.mock.calls.some(([value]) => String(value).includes("Xvfb :${desktop_display}")),
    ).toBe(true);
    expect(command.mock.calls.some(([value]) => String(value).includes("pkill -x x11vnc"))).toBe(
      false,
    );

    await provider.act(
      computer,
      {
        actions: [{ kind: "pointer", type: "click", x: 1, y: 2 }],
        observe: false,
      },
      researcher,
    );
    expect(
      command.mock.calls.some(([value]) => String(value).includes("DISPLAY=:21 xdotool")),
    ).toBe(true);
    expect(desktop.moveMouse).not.toHaveBeenCalled();

    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      researcher,
    );
    expect(control.url).toContain("6100-desktop.test");
    expect(command.mock.calls.some(([value]) => String(value).includes("0.0.0.0:6100 8>&-"))).toBe(
      true,
    );
    expect(new URL(control.url!).searchParams.get("path")).toBe("websockify?token=lease-1");

    await provider.writeFile(
      computer,
      { path: "shared/note.txt", content: new TextEncoder().encode("office") },
      researcher,
    );
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "shared/note.txt", writer)),
    ).toBe("office");

    await provider.releaseScreen(computer, writer);
    await expect(provider.observe(computer, researcher)).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
    expect(provider.describe().capabilities.multiScreen).toBe(true);

    for (let index = 0; index < 100; index += 1) {
      await provider.observe(computer, {
        ...context,
        botId: `bot-${index + 2}`,
      });
    }
    await expect(
      provider.observe(computer, { ...context, botId: "bot-102" }),
    ).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
  });
});

describe("sandbox-gone detection", () => {
  // Wordings verified against e2b 2.49.1 and 2.63.0 dist; newer SDKs name not-running errors.
  const gone = [
    new SandboxNotFoundError("Sandbox is probably not running anymore"),
    new SandboxNotFoundError("Paused sandbox sandbox-ref-1 not found"),
    // The SDK error class must also identify loss when the API supplies a different message.
    new SandboxNotFoundError("Unavailable"),
  ];
  const notGone = [
    // With onTimeout "pause" these usually mean paused; the adapter resumes before deciding.
    new TimeoutError(
      "502: This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
    ),
    new TimeoutError(
      "stream reset: The sandbox was killed or reached its end of life while the request was in flight.",
    ),
    new Error("bash: x11vnc: command not found"),
    new Error("Path /home/user/rakazo-home/notes.md not found"),
    new Error("tar: /home/user/x: No such file or directory"),
    new TimeoutError(
      "canceled: This error is likely due to exceeding 'requestTimeoutMs'. You can pass the request timeout value as an option when making the request.",
    ),
    Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
  ];

  it.each(gone)("reads %s as gone", (error) => {
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it.each(notGone)("does not read %s as gone", (error) => {
    expect(isSandboxGoneError(error)).toBe(false);
  });
});

/** Runs `work` against a local API that answers every request with `status`; returns the requests. */
async function withApiAnswering(status: number, work: () => Promise<void>): Promise<string[]> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    // Local tools can probe any listening loopback port; the SDK never calls the root.
    if (request.url === "/") {
      response.writeHead(404).end();
      return;
    }
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: status, message: "sandbox unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    vi.stubEnv("E2B_API_URL", `http://127.0.0.1:${address.port}`);
    await work();
    return requests;
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type FakeState = "running" | "paused" | "killing" | "killed";

/**
 * One E2B sandbox as the API and envd report it. Its timeout is an absolute deadline that
 * only setTimeout and connect move; past it the sandbox pauses, as onTimeout "pause" does.
 */
class FakeE2B {
  state: FakeState = "running";
  revoked = false;
  deadline = 0;
  setTimeoutError?: Error;
  connectError?: Error;
  pauseError?: Error;
  command?: (command: string) => Promise<CommandResult>;
  readonly calls = { connect: 0, pause: 0, kill: 0, setTimeout: 0 };
  readonly files = new Map<string, Uint8Array>();

  constructor(readonly id = "box-1") {}

  readonly sdk = {
    create: async () => {
      this.extend(sandboxIdleMs());
      return this.handle();
    },
    connect: async (_id: string, options: { timeoutMs: number }) => {
      this.calls.connect += 1;
      this.authorize();
      this.settle();
      if (this.connectError) throw this.connectError;
      if (this.state === "killed")
        throw new SandboxNotFoundError(`Paused sandbox ${this.id} not found`);
      if (this.state === "killing") throw apiError(409, `Sandbox ${this.id} is being killed`);
      this.state = "running";
      this.extend(options.timeoutMs);
      return this.handle();
    },
    pause: async () => {
      this.calls.pause += 1;
      this.authorize();
      this.settle();
      if (this.pauseError) throw this.pauseError;
      if (this.state === "killed") throw new SandboxNotFoundError(`Sandbox ${this.id} not found`);
      if (this.state !== "running") return false;
      this.state = "paused";
      return true;
    },
    kill: async () => {
      this.calls.kill += 1;
      this.authorize();
      if (this.state === "killed") return false;
      this.state = "killed";
      return true;
    },
  } satisfies E2BSandboxSdk;

  handle(): E2BDesktop {
    const envd = async <T>(work: () => T | Promise<T>): Promise<T> => {
      this.settle();
      if (this.state !== "running") {
        // What the SDK throws when the proxy no longer finds the sandbox, paused or deleted.
        throw new SandboxNotRunningError(
          `The sandbox ${this.id} was not found: The sandbox was killed or reached its timeout.`,
        );
      }
      return work();
    };
    const missing = (path: string) => new FileNotFoundError(`Path ${path} not found`);
    return {
      sandboxId: this.id,
      getHost: (port) => `${port}-${this.id}.e2b.test`,
      setTimeout: async (timeoutMs) => {
        this.calls.setTimeout += 1;
        this.authorize();
        this.settle();
        if (this.setTimeoutError) throw this.setTimeoutError;
        if (this.state === "killing") throw apiError(409, `Sandbox ${this.id} is being killed`);
        if (this.state !== "running")
          throw new SandboxNotFoundError(`Sandbox ${this.id} not found`);
        this.extend(timeoutMs);
      },
      commands: {
        run: (command) =>
          envd(async () => {
            const result = await (this.command?.(command) ?? ok());
            await envd(() => undefined);
            if (result.exitCode !== 0) throw new CommandExitError(result);
            return result;
          }),
      },
      files: {
        makeDir: () => envd(() => true),
        list: (path) =>
          envd(() =>
            [...this.files.keys()]
              .filter((file) => file.startsWith(`${path}/`))
              .map((file) => entry(file.slice(path.length + 1), this.files.get(file)!.byteLength)),
          ),
        getInfo: (path) =>
          envd(() => {
            const content = this.files.get(path);
            if (!content) throw missing(path);
            return entry(path, content.byteLength);
          }),
        read: (path) =>
          envd(() => {
            const content = this.files.get(path);
            if (!content) throw missing(path);
            return content;
          }),
        write: (files) =>
          envd(() => {
            for (const file of files) this.files.set(file.path, new Uint8Array(file.data));
          }),
      },
    };
  }

  private extend(timeoutMs: number) {
    this.deadline = Date.now() + timeoutMs;
  }

  private settle() {
    if (this.state === "running" && Date.now() >= this.deadline) this.state = "paused";
  }

  private authorize() {
    if (this.revoked) throw new AuthenticationError("Invalid API key");
  }
}

function apiError(status: number, message: string): SandboxError {
  return Object.assign(new SandboxError(`${status}: ${message}`), { statusCode: status });
}

function ok(stdout = ""): Promise<CommandResult> {
  return Promise.resolve({ exitCode: 0, stdout, stderr: "" });
}

function entry(name: string, size: number): EntryInfo {
  return {
    name,
    path: name,
    type: FileType.FILE,
    size,
    mode: 0o600,
    permissions: "-rw-------",
    owner: "user",
    group: "user",
    modifiedTime: new Date(0),
  };
}

async function runCommand(
  provider: E2BSandboxProvider,
  computer: ComputerRef,
  request: CommandRequest = { argv: ["true"] },
) {
  const events: ProcessEvent[] = [];
  for await (const event of provider.execute(computer, request, context)) events.push(event);
  return events;
}

describe("E2B sandbox lifecycle", () => {
  async function started(fake = new FakeE2B()) {
    const provider = new E2BSandboxProvider("e2b_test", fake.sdk);
    const computer = await provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
    return { fake, provider, computer };
  }
  const notes = "/home/user/rakazo-home/notes.txt";

  it.each([
    ["listFiles", (p: E2BSandboxProvider, c: ComputerRef) => p.listFiles(c, "", context)],
    ["readFile", (p: E2BSandboxProvider, c: ComputerRef) => p.readFile(c, "notes.txt", context)],
    ["execute", (p: E2BSandboxProvider, c: ComputerRef) => runCommand(p, c)],
    [
      "writeFile",
      (p: E2BSandboxProvider, c: ComputerRef) =>
        p.writeFile(c, { path: "notes.txt", content: new Uint8Array([1]) }, context),
    ],
  ] as const)(
    "resumes a sandbox E2B paused under %s instead of reporting it gone",
    async (_, use) => {
      const { fake, provider, computer } = await started();
      fake.files.set(notes, new Uint8Array([1]));
      fake.state = "paused";

      const error = await use(provider, computer).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(isSandboxGoneError(error)).toBe(false);
      expect(fake.state).toBe("running");
      expect(fake.calls.connect).toBe(1);
      await expect(use(provider, computer)).resolves.not.toThrow();
    },
  );

  it("reports a sandbox as gone only once resuming it fails", async () => {
    const { fake, provider, computer } = await started();
    fake.state = "killed";
    await expect(provider.listFiles(computer, "", context)).rejects.toSatisfy(isSandboxGoneError);
    expect(fake.calls.connect).toBe(1);
  });

  it.each([
    { state: "paused", fresh: false, created: 0 },
    { state: "killing", fresh: true, created: 1 },
    { state: "killed", fresh: true, created: 1 },
  ] as const)("provisions over a $state sandbox", async ({ state, fresh, created }) => {
    const fake = new FakeE2B();
    fake.state = state;
    const create = vi.spyOn(fake.sdk, "create");
    const provider = new E2BSandboxProvider("e2b_test", fake.sdk);
    await expect(
      provider.provision(
        { botId: "bot-1", homePath: "/unused", providerRef: "box-1", providerKind: "e2b" },
        context,
      ),
    ).resolves.toMatchObject({ fresh });
    expect(create).toHaveBeenCalledTimes(created);
  });

  it("does not replace a sandbox when connecting is rate limited", async () => {
    const fake = new FakeE2B();
    fake.connectError = new RateLimitError("429: rate limited");
    const create = vi.spyOn(fake.sdk, "create");
    const provider = new E2BSandboxProvider("e2b_test", fake.sdk);
    await expect(
      provider.provision(
        { botId: "bot-1", homePath: "/unused", providerRef: "box-1", providerKind: "e2b" },
        context,
      ),
    ).rejects.toBe(fake.connectError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { name: "paused", arrange: (fake: FakeE2B) => (fake.state = "paused"), result: "resolves" },
    {
      name: "past the plan's lifetime (400)",
      arrange: (fake: FakeE2B) => (fake.setTimeoutError = apiError(400, "timeout too long")),
      result: "resolves",
    },
    {
      name: "mid-pause (409)",
      arrange: (fake: FakeE2B) => (fake.setTimeoutError = apiError(409, "sandbox is pausing")),
      result: "resolves",
    },
    { name: "being killed", arrange: (fake: FakeE2B) => (fake.state = "killing"), result: "gone" },
    { name: "killed", arrange: (fake: FakeE2B) => (fake.state = "killed"), result: "gone" },
    { name: "a revoked key", arrange: (fake: FakeE2B) => (fake.revoked = true), result: "auth" },
  ])("keepAlive reconnects instead of trusting a sandbox $name", async ({ arrange, result }) => {
    const { fake, provider, computer } = await started();
    arrange(fake);
    const kept = provider.keepAlive(computer);
    if (result === "resolves") {
      await expect(kept).resolves.toBeUndefined();
      expect(fake.state).toBe("running");
    } else if (result === "gone") {
      await expect(kept).rejects.toSatisfy(isSandboxGoneError);
    } else {
      await expect(kept).rejects.toBeInstanceOf(AuthenticationError);
    }
    expect(fake.calls.connect).toBe(1);
  });

  it("keeps probing after a failed keepAlive instead of serving the stale handle", async () => {
    const { fake, provider, computer } = await started();
    fake.setTimeoutError = apiError(400, "timeout too long");
    fake.connectError = new RateLimitError("429: rate limited");
    await expect(provider.keepAlive(computer)).rejects.toBe(fake.connectError);

    fake.connectError = undefined;
    fake.setTimeoutError = undefined;
    await expect(provider.listFiles(computer, "", context)).resolves.toEqual([]);
    expect(fake.calls.connect).toBe(2);
  });

  it("reconnects when the stale-handle probe fails for any reason", async () => {
    vi.useFakeTimers();
    try {
      const { fake, provider, computer } = await started();
      vi.advanceTimersByTime(61_000);
      fake.setTimeoutError = apiError(400, "timeout too long");
      await expect(provider.listFiles(computer, "", context)).resolves.toEqual([]);
      expect(fake.calls).toMatchObject({ setTimeout: 1, connect: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the sandbox awake for a command that outlasts its timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SANDBOX_IDLE_MS", "180000");
    try {
      const { fake, provider, computer } = await started();
      fake.command = async () => {
        await new Promise((resolve) => setTimeout(resolve, 30 * 60_000));
        return ok("done\n");
      };
      const events = runCommand(provider, computer, { argv: ["build"], timeoutMs: 60 * 60_000 });
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await expect(events).resolves.toEqual([
        { type: "stdout", data: "done\n" },
        { type: "exit", code: 0 },
      ]);
      expect(fake.state).toBe("running");
      const extensions = fake.calls.setTimeout;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fake.calls.setTimeout).toBe(extensions);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("extends a cached handle before a command could outlast its remaining timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SANDBOX_IDLE_MS", "60000");
    try {
      const { fake, provider, computer } = await started();
      await vi.advanceTimersByTimeAsync(50_000);
      fake.command = async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        return ok();
      };
      const events = runCommand(provider, computer);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(events).resolves.toEqual([{ type: "exit", code: 0 }]);
      expect(fake.calls.connect).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("does not resume a sandbox that stop paused while a request was in flight", async () => {
    const { fake, provider, computer } = await started();
    let finish!: () => void;
    fake.command = async () => {
      await new Promise<void>((resolve) => (finish = resolve));
      return ok();
    };
    const events = runCommand(provider, computer).catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await provider.stop(computer, context);
    finish();
    const error = await events;
    expect(error).toBeInstanceOf(Error);
    expect(isSandboxGoneError(error)).toBe(false);
    expect(fake.state).toBe("paused");
    expect(fake.calls.connect).toBe(0);
  });

  it("maps only the command's own deadline to exit 124", async () => {
    const { fake, provider, computer } = await started();
    fake.command = async () => {
      throw new TimeoutError(
        "deadline_exceeded: This error is likely due to exceeding 'timeoutMs' — the total time a long running request (like command execution or directory watch) can be active.",
      );
    };
    await expect(
      runCommand(provider, computer, { argv: ["hang"], timeoutMs: 42 }),
    ).resolves.toEqual([
      { type: "stderr", data: "command timed out after 42 ms\n" },
      { type: "exit", code: 124 },
    ]);

    const canceled = new TimeoutError(
      "canceled: This error is likely due to exceeding 'requestTimeoutMs'. You can pass the request timeout value as an option when making the request.",
    );
    fake.command = async () => {
      throw canceled;
    };
    await expect(runCommand(provider, computer)).rejects.toBe(canceled);

    fake.command = async () => {
      fake.state = "paused";
      return ok();
    };
    const error = await runCommand(provider, computer).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(isSandboxGoneError(error)).toBe(false);
    expect(fake.state).toBe("running");
  });

  it("resumes a sandbox the SDK could not reach to check", async () => {
    const { fake, provider, computer } = await started();
    fake.command = async () => {
      fake.state = "paused";
      throw new SandboxUnreachableError(
        "fetch failed: The sandbox could not be reached and its health probe failed too.",
      );
    };
    const error = await runCommand(provider, computer).catch((failure: unknown) => failure);
    expect(isSandboxGoneError(error)).toBe(false);
    expect(fake.state).toBe("running");
    expect(fake.calls.connect).toBe(1);
  });

  it("reports a non-zero exit as the command's result", async () => {
    const { fake, provider, computer } = await started();
    fake.command = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "busy\n",
      error: "exit status 1",
    });
    await expect(runCommand(provider, computer)).resolves.toEqual([
      { type: "stderr", data: "busy\n" },
      { type: "exit", code: 1 },
    ]);
  });

  it.each([
    { state: "running", result: "resolves", after: "paused" },
    { state: "paused", result: "resolves", after: "paused" },
    { state: "killed", result: "gone", after: "killed" },
  ] as const)("stops a $state sandbox without resuming it", async ({ state, result, after }) => {
    const { fake, provider, computer } = await started();
    fake.state = state;
    const stopped = provider.stop(computer, context);
    if (result === "resolves") await expect(stopped).resolves.toBeUndefined();
    else await expect(stopped).rejects.toSatisfy(isSandboxGoneError);
    expect(fake.state).toBe(after);
    expect(fake.calls.connect).toBe(0);
  });

  it("surfaces a rate-limited pause so the computer is not marked stopped while billing", async () => {
    const { fake, provider, computer } = await started();
    fake.pauseError = new RateLimitError("429: rate limited");
    await expect(provider.stop(computer, context)).rejects.toBe(fake.pauseError);
    expect(fake.state).toBe("running");
  });

  it.each(["running", "paused", "killed"] as const)(
    "destroys a %s sandbox without resuming it",
    async (state) => {
      const { fake, provider, computer } = await started();
      fake.state = state;
      await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
      expect(fake.state).toBe("killed");
      expect(fake.calls).toMatchObject({ connect: 0, kill: 1 });
    },
  );
});

describe("keepingAwake", () => {
  it("finishes the first timeout extension before reading", async () => {
    const order: string[] = [];
    const desktop = {
      setTimeout: vi.fn(async () => {
        await Promise.resolve();
        order.push("extended");
      }),
    };
    const items = (async function* () {
      order.push("read");
      yield 1;
    })();
    for await (const _ of keepingAwake(desktop, items)) {
      // drain
    }
    expect(order).toEqual(["extended", "read"]);
  });

  it("extends the sandbox timeout while a long export is still reading", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SANDBOX_IDLE_MS", "180000");
    try {
      const desktop = { setTimeout: vi.fn(async () => undefined) };
      let finish!: () => void;
      const slow = (async function* () {
        yield "first";
        await new Promise<void>((resolve) => (finish = resolve));
        yield "last";
      })();
      const read: string[] = [];
      const done = (async () => {
        for await (const item of keepingAwake(desktop, slow)) read.push(item);
      })();

      await vi.advanceTimersByTimeAsync(0);
      expect(desktop.setTimeout).toHaveBeenCalledTimes(1);
      expect(read).toEqual(["first"]);
      await vi.advanceTimersByTimeAsync(200_000);
      expect(desktop.setTimeout).toHaveBeenCalledWith(180_000);
      expect(desktop.setTimeout.mock.calls.length).toBeGreaterThanOrEqual(2);

      finish();
      await done;
      const calls = desktop.setTimeout.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(desktop.setTimeout).toHaveBeenCalledTimes(calls);
      expect(read).toEqual(["first", "last"]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});
