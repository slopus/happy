import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CreateSandboxFromSnapshotParams, FileInfo, SandboxState } from "@daytona/sdk";
import {
  DaytonaAuthenticationError,
  DaytonaConflictError,
  DaytonaError,
  DaytonaGoneError,
  DaytonaNotFoundError,
  DaytonaProcessExecutionTimeoutError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
  DaytonaValidationError,
} from "@daytona/sdk";
import type { PageBrowserCommand } from "@rakazo/adapter-kit";
import { shellQuote } from "@rakazo/core/node/desktop-runtime";
import { parse } from "shell-quote";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrowserProvider } from "./computer-browser.js";
import type { DaytonaSandbox, DaytonaSandboxSdk } from "./daytona-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";
import { installPageBrowserCommand } from "./page-browser-install.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

const temporaryRoots: string[] = [];

describe("DaytonaSandboxProvider", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("offers native page tools on the bot's existing desktop", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const browser = new ComputerBrowserProvider({ sandbox: provider });
    expect(browser.describe().capabilities.page).toBe(true);
  });

  it("fills on the existing screen using stdin after removing its private input", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "team-home", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    expect(
      fixture.executeCommand.mock.calls.some(
        ([command]) => parse(command).at(-1) === installPageBrowserCommand(),
      ),
    ).toBe(true);
    let inputFile = "";
    fixture.sandbox.fs.uploadFile.mockImplementation(async (content, target) => {
      inputFile = target;
      await writeFile(target, content, { mode: 0o600 });
    });
    const original = fixture.executeCommand.getMockImplementation()!;
    const run = promisify(execFile);
    const registry = await mkdtemp(path.join(tmpdir(), "daytona-page-test-"));
    temporaryRoots.push(registry);
    fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
      if (!command.includes("/tmp/rakazo-page-input-")) return original(command, cwd, env, timeout);
      const helper = [
        "const fs = require('node:fs');",
        "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
        `if (fs.existsSync(${JSON.stringify(inputFile)}) || fs.existsSync(${JSON.stringify(inputFile.slice(0, inputFile.lastIndexOf("/")))})) process.exit(1);`,
        "console.log(JSON.stringify({ok:true,completed:request.actions.length,display:process.env.DISPLAY,port:process.env.RAKAZO_CDP_PORT}));",
      ].join("\n");
      const script = parse(command).at(-1);
      let actual =
        typeof script === "string" && command.startsWith("bash -c ")
          ? script.replace(
              "/usr/local/bin/rakazo-page-browser act",
              `node -e ${shellQuote(helper)}`,
            )
          : command;
      if (actual.includes("RAKAZO_BROWSER_ARGS_STDIN")) {
        const slot = actual.match(/slot="\$dir\/([^"/]+)"/)?.[1];
        if (!slot) throw new Error("Expected a fenced desktop command");
        await writeFile(
          path.join(registry, slot),
          `${actual.includes("DISPLAY=:20") ? 0 : 1}\n\nview\n`,
        );
        actual = actual.replaceAll("/tmp/rakazo/desktop-assignments", registry);
      }
      const result = await run("bash", ["-c", `flock() { :; }\n${actual}`]);
      return { exitCode: 0, result: result.stdout };
    });
    const request: PageBrowserCommand = {
      command: "act",
      actions: [
        {
          kind: "fill",
          ref: "e1",
          text: "fake-vault-password",
          origin: "https://example.com",
          field: "password",
        },
      ],
    };
    await provider.observe(computer, { ...context, botId: "writer" });
    await expect(
      provider.pageBrowser(computer, request, { ...context, botId: "writer" }),
    ).resolves.toMatchObject({ ok: true, completed: 1, display: ":20", port: "9241" });
    await expect(
      provider.pageBrowser(computer, request, { ...context, botId: "researcher" }),
    ).resolves.toMatchObject({ ok: true, completed: 1, display: ":21", port: "9242" });
    expect(new Set(fixture.sandbox.fs.uploadFile.mock.calls.map(([, target]) => target)).size).toBe(
      2,
    );
    expect(
      fixture.executeCommand.mock.calls.every(
        ([command]) => !command.includes("fake-vault-password"),
      ),
    ).toBe(true);
    expect(fixture.sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from(`${JSON.stringify(request)}\n`),
      inputFile,
      25,
    );
  });

  it.each([false, true])(
    "keeps desktop fallback when page installation fails (throws=%s)",
    async (throws) => {
      const fixture = daytonaFixture();
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
      const original = fixture.executeCommand.getMockImplementation()!;
      fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
        if (parse(command).at(-1) === installPageBrowserCommand()) {
          if (throws) throw new Error("installer timed out");
          return { exitCode: 1, result: "installer unavailable" };
        }
        return original(command, cwd, env, timeout);
      });
      await expect(provider.prepare(computer, context)).resolves.toBeUndefined();
      await expect(provider.observe(computer, context)).resolves.toMatchObject({ width: 1280 });
    },
  );

  it.each(["upload", "execute", "cancel", "timeout"])(
    "cleans browser input after %s without replaying the action",
    async (failure) => {
      const fixture = daytonaFixture();
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
      const original = fixture.executeCommand.getMockImplementation()!;
      const controller = new AbortController();
      let dispatched = 0;
      let inputFile = "";
      fixture.sandbox.fs.uploadFile.mockImplementation(async (_content, target) => {
        inputFile = target;
        if (failure === "upload") throw new Error("fake-vault-password");
        if (failure === "cancel") controller.abort();
      });
      fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
        if (command.includes("/usr/local/bin/rakazo-page-browser snapshot")) {
          dispatched++;
          if (failure === "timeout") throw new DaytonaProcessExecutionTimeoutError("timed out");
          throw new Error("fake-vault-password");
        }
        return original(command, cwd, env, timeout);
      });
      const result = provider.pageBrowser(
        computer,
        { command: "snapshot" },
        { ...context, signal: controller.signal },
      );
      await expect(result).rejects.toThrow(
        failure === "upload"
          ? "Could not transfer browser input"
          : failure === "timeout"
            ? "Page browser timed out"
            : failure === "cancel"
              ? /abort/i
              : "Page browser unavailable or interrupted",
      );
      expect(dispatched).toBe(failure === "execute" || failure === "timeout" ? 1 : 0);
      expect(fixture.executeCommand.mock.calls.at(-1)).toEqual([
        expect.stringContaining(`rm -f -- '${inputFile}'`),
        undefined,
        undefined,
        10,
      ]);
    },
  );

  it("waits for an already dispatched action before returning cancellation", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const original = fixture.executeCommand.getMockImplementation()!;
    let dispatch = () => {};
    const dispatched = new Promise<void>((resolve) => {
      dispatch = resolve;
    });
    let finish = (_value: { exitCode: number; result: string }) => {};
    const finished = new Promise<{ exitCode: number; result: string }>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    let calls = 0;
    fixture.executeCommand.mockImplementation(async (command, cwd, env, timeout) => {
      if (command.includes("/usr/local/bin/rakazo-page-browser snapshot")) {
        calls++;
        dispatch();
        return finished;
      }
      return original(command, cwd, env, timeout);
    });
    const result = provider.pageBrowser(
      computer,
      { command: "snapshot" },
      { ...context, signal: controller.signal },
    );
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await dispatched;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ exitCode: 0, result: '{"ok":true}' });
    await expect(result).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
    expect(fixture.executeCommand.mock.calls.at(-1)?.[0]).toMatch(/^rm -f -- /);
  });

  it("forwards an optional snapshot name to create()", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ snapshot: "rakazo-computer" }, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "rakazo-computer" }),
      { timeout: 120 },
    );
  });

  it("falls back to DAYTONA_SNAPSHOT when config.snapshot is unset", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", " env-snapshot ");
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "env-snapshot" }),
      { timeout: 120 },
    );
  });

  it("prefers config.snapshot over DAYTONA_SNAPSHOT", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", "env-snapshot");
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ snapshot: " config-snapshot " }, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: "config-snapshot" }),
      { timeout: 120 },
    );
  });

  it("prunes excluded directories before listing their contents and keeps project core", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    for (const file of [
      "project/node_modules/pkg/index.js",
      ".cache/uv/data",
      ".yarn/cache/pkg",
      ".yarn/patches/fix.patch",
      "packages/core/notes.txt",
      "core.123",
      "run.log",
      ".browser-profiles/chromium/Cache/data",
      ".browser-profiles/chromium/Default/Cookies",
    ]) {
      await provider.writeFile(computer, { path: file, content: Buffer.from("ok") }, context);
    }
    const listing = vi.spyOn(fixture.sandbox.fs, "listFiles");
    const files = [];
    for await (const file of provider.exportWorkspace(computer, context)) files.push(file.path);
    expect(files.sort()).toEqual([
      ".browser-profiles/chromium/Default/Cookies",
      ".yarn/patches/fix.patch",
      "packages/core/notes.txt",
    ]);
    const visited = listing.mock.calls.map(([directory]) => directory);
    expect(visited).not.toContain("/home/daytona/rakazo-home/project/node_modules");
    expect(visited).not.toContain("/home/daytona/rakazo-home/.cache");
    expect(visited).not.toContain("/home/daytona/rakazo-home/.yarn/cache");
    expect(visited).not.toContain("/home/daytona/rakazo-home/.browser-profiles/chromium/Cache");
  });

  it("omits snapshot from create() when unset", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", "   ");
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    expect(fixture.create.mock.calls[0]?.[0]).not.toHaveProperty("snapshot");
  });

  it("preserves desktop command output in failures", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    fixture.executeCommand.mockResolvedValueOnce({ exitCode: 1, result: "could not start Xvfb" });

    await expect(provider.observe(computer, context)).rejects.toThrow("could not start Xvfb");
  });

  it("implements the portable command, file, screen, and computer-use contract", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);

    expect(computer).toMatchObject({
      id: "daytona-box",
      kind: "daytona",
      providerRef: "daytona-box",
      fresh: true,
    });
    expect(computer).not.toHaveProperty("started");
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^rakazo-/),
        labels: { botId: "bot-a", rakazo: "computer" },
        envVars: { VNC_RESOLUTION: "1280x800" },
      }),
      { timeout: 120 },
    );

    const events = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "hello"], env: { FAKE_TOKEN: "fake-secret" }, unsetEnv: ["FAILED"] },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    // Secrets go in the env field, never in command text.
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      "'env' '-u' 'FAILED' '--' 'echo' 'hello'",
      "/home/daytona/rakazo-home",
      { FAKE_TOKEN: "fake-secret" },
      300,
    );

    const binary = Uint8Array.from([0, 255, 1, 128]);
    await provider.writeFile(
      computer,
      { path: "bin/tool", content: binary, executable: true },
      context,
    );
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(binary);
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 4, executable: true },
    ]);
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    expect(exported).toContainEqual({
      path: "bin/tool",
      content: binary,
      executable: true,
    });

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 10, y: 20 },
    });
    expect(observation.image).toEqual(Uint8Array.from([1, 2, 3]));

    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "down", x: 10, y: 20 },
          { kind: "pointer", type: "up", x: 30, y: 40 },
          { kind: "key", key: "enter" },
          { kind: "clipboard", text: "hello" },
          { kind: "scroll", direction: "down", amount: 2 },
        ],
        observe: false,
      },
      context,
    );
    expect(result).toEqual({ completed: 5 });
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("mousemove 10 20 mousedown 1"),
      undefined,
      undefined,
      300,
    );
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("mousemove 30 40 mouseup 1"),
      undefined,
      undefined,
      300,
    );
    const [screen, interactiveScreen] = await Promise.all([
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      provider.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "control-1" },
        context,
      ),
    ]);
    expect(screen.url).toContain("/vnc.html");
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    await screen.close();
    expect(new URL(interactiveScreen.url!).searchParams.get("path")).toBe(
      "websockify?token=control-1",
    );
    expect(fixture.getSignedPreviewUrl).toHaveBeenCalledOnce();

    await provider.stop(computer, context);
    expect(fixture.expireSignedPreviewUrl).toHaveBeenCalledWith(6100, "preview-token");
    expect(fixture.stop).toHaveBeenCalledWith(120);
  });

  it("reconnects stopped sandboxes and replaces missing ones", async () => {
    const existing = daytonaFixture({ id: "existing", state: "stopped" });
    const provider = new DaytonaSandboxProvider({}, existing.client);
    const reconnected = await provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerRef: "existing",
        providerKind: "daytona",
      },
      context,
    );
    expect(existing.start).toHaveBeenCalledWith(120);
    expect(reconnected).toMatchObject({
      providerRef: "existing",
      fresh: false,
      started: true,
    });

    const replacement = daytonaFixture({ id: "replacement" });
    const replacingProvider = new DaytonaSandboxProvider({}, replacement.client);
    const replaced = await replacingProvider.provision(
      {
        botId: "bot-b",
        homePath: "/unused",
        providerRef: "missing",
        providerKind: "daytona",
      },
      context,
    );
    expect(replaced).toMatchObject({ providerRef: "replacement", fresh: true });
  });

  describe("reconnecting from each Daytona state", () => {
    const request = {
      botId: "bot-a",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "daytona" as const,
    };

    type Case = {
      state: SandboxState;
      desiredState?: DaytonaSandbox["desiredState"];
      recoverable?: boolean;
      /** States Daytona reports on later refreshes, as a background transition progresses. */
      later?: SandboxState[];
      expected: "running" | "started" | "replaced";
      call?: "start" | "recover" | "waitUntilStarted";
      timeout?: number;
    };
    const cases: Case[] = [
      { state: "started", expected: "running" },
      { state: "stopped", desiredState: "stopped", expected: "started", call: "start" },
      { state: "paused", desiredState: "paused", expected: "started", call: "start" },
      {
        state: "archived",
        desiredState: "archived",
        expected: "started",
        call: "start",
        timeout: 600,
      },
      { state: "starting", expected: "started", call: "waitUntilStarted" },
      { state: "restoring", expected: "started", call: "waitUntilStarted", timeout: 600 },
      { state: "creating", expected: "started", call: "waitUntilStarted" },
      { state: "pulling_snapshot", expected: "started", call: "waitUntilStarted" },
      { state: "resuming", expected: "started", call: "waitUntilStarted" },
      {
        state: "stopping",
        desiredState: "stopped",
        later: ["stopping", "stopped"],
        expected: "started",
        call: "start",
        // Two one-second polls of the 120 second budget have passed.
        timeout: 118,
      },
      {
        state: "archiving",
        desiredState: "archived",
        later: ["archived"],
        expected: "started",
        call: "start",
        // One poll of the restore budget has passed.
        timeout: 599,
      },
      { state: "unknown", later: ["started"], expected: "started" },
      { state: "error", recoverable: true, expected: "started", call: "recover" },
      { state: "error", recoverable: false, expected: "replaced" },
      { state: "build_failed", expected: "replaced" },
      { state: "destroying", desiredState: "destroyed", expected: "replaced" },
      { state: "destroyed", desiredState: "destroyed", expected: "replaced" },
    ];

    it.each(cases)("$state (recoverable: $recoverable) -> $expected", async (testCase) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({
        id: "existing",
        createdId: "replacement",
        state: testCase.state,
        desiredState: testCase.desiredState ?? "started",
        recoverable: testCase.recoverable,
        later: testCase.later,
      });
      const provider = new DaytonaSandboxProvider({}, fixture.client);

      const computer = await drive(provider.provision(request, context));

      if (testCase.expected === "replaced") {
        expect(computer).toMatchObject({ providerRef: "replacement", fresh: true });
        expect(fixture.start).not.toHaveBeenCalled();
        return;
      }
      expect(computer).toMatchObject({ providerRef: "existing", fresh: false });
      expect(computer.started).toBe(testCase.expected === "started" ? true : undefined);
      expect(fixture.create).not.toHaveBeenCalled();
      if (testCase.call) {
        expect(fixture[testCase.call]).toHaveBeenCalledWith(testCase.timeout ?? 120);
      }
    });

    type ErrorCase = {
      name: string;
      state?: SandboxState;
      arrange: (fixture: DaytonaFixture) => void;
      expected: "started" | "replaced" | Error;
    };
    const rateLimited = new DaytonaRateLimitError("Too many requests", 429);
    const unauthorized = new DaytonaAuthenticationError("Invalid API key", 401);
    const regionMissing = new DaytonaNotFoundError("Region not found", 404);
    const errorCases: ErrorCase[] = [
      {
        name: "409 while another state change is in progress waits for it",
        arrange: (fixture) =>
          fixture.start.mockImplementationOnce(async () => {
            fixture.remote.state = "starting";
            fixture.remote.desiredState = "started";
            throw new DaytonaConflictError("Sandbox state change in progress", 409);
          }),
        expected: "started",
      },
      {
        name: "410 from start is gone",
        arrange: (fixture) =>
          fixture.start.mockRejectedValueOnce(new DaytonaGoneError("Sandbox is gone", 410)),
        expected: "replaced",
      },
      {
        name: "410 from get is gone",
        arrange: (fixture) =>
          fixture.get.mockRejectedValueOnce(new DaytonaGoneError("Sandbox is gone", 410)),
        expected: "replaced",
      },
      {
        name: "400 because the sandbox errored after lookup is gone when unrecoverable",
        arrange: (fixture) => {
          fixture.remote.state = "error";
          fixture.remote.recoverable = false;
          fixture.get.mockImplementationOnce(async () => {
            fixture.sandbox.state = "stopped";
            return fixture.sandbox;
          });
        },
        expected: "replaced",
      },
      {
        name: "a start that ends in an unrecoverable error is gone",
        arrange: (fixture) =>
          fixture.start.mockImplementationOnce(async () => {
            fixture.remote.state = "error";
            fixture.remote.recoverable = false;
            throw new DaytonaError("Sandbox existing failed to start with status: error");
          }),
        expected: "replaced",
      },
      {
        name: "a recovery that fails again is gone",
        state: "error",
        arrange: (fixture) => {
          fixture.remote.recoverable = true;
          fixture.recover.mockRejectedValueOnce(
            new DaytonaError("Sandbox existing failed to start with status: error"),
          );
        },
        expected: "replaced",
      },
      {
        name: "404 for something other than the sandbox is not gone",
        arrange: (fixture) => fixture.start.mockRejectedValueOnce(regionMissing),
        expected: regionMissing,
      },
      {
        name: "401 is surfaced",
        arrange: (fixture) => fixture.get.mockRejectedValueOnce(unauthorized),
        expected: unauthorized,
      },
      {
        name: "429 is surfaced",
        arrange: (fixture) => fixture.start.mockRejectedValueOnce(rateLimited),
        expected: rateLimited,
      },
      {
        name: "a transition that never settles times out instead of hanging",
        state: "stopping",
        arrange: () => undefined,
        expected: new DaytonaTimeoutError("Daytona sandbox existing is still stopping"),
      },
      {
        name: "an archived sandbox that keeps conflicting times out instead of hanging",
        state: "archived",
        arrange: (fixture) =>
          fixture.start.mockRejectedValue(
            new DaytonaConflictError("Sandbox state change in progress", 409),
          ),
        expected: new DaytonaTimeoutError("Daytona sandbox existing is still archived"),
      },
    ];

    it.each(errorCases)("$name", async ({ state, arrange, expected }) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({
        id: "existing",
        createdId: "replacement",
        state: state ?? "stopped",
        desiredState: "stopped",
      });
      arrange(fixture);
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const provisioning = drive(provider.provision(request, context));

      if (expected instanceof Error) {
        await expect(provisioning).rejects.toThrow(expected.message);
        await provisioning.catch((error: unknown) => expect(isSandboxGoneError(error)).toBe(false));
        expect(fixture.create).not.toHaveBeenCalled();
        expect(fixture.deleteSandbox).not.toHaveBeenCalled();
        return;
      }
      const computer = await provisioning;
      expect(computer).toMatchObject(
        expected === "replaced"
          ? { providerRef: "replacement", fresh: true }
          : { providerRef: "existing", fresh: false, started: true },
      );
    });
  });

  describe("stopping from each Daytona state", () => {
    const computer = {
      id: "existing",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "existing",
      fresh: false,
    };

    type Case = {
      state: SandboxState;
      later?: SandboxState[];
      stops: boolean;
    };
    const cases: Case[] = [
      { state: "started", stops: true },
      { state: "paused", stops: true },
      { state: "stopped", stops: false },
      { state: "archived", stops: false },
      { state: "archiving", stops: false },
      { state: "error", stops: false },
      { state: "build_failed", stops: false },
      { state: "destroying", stops: false },
      { state: "destroyed", stops: false },
      { state: "stopping", later: ["stopping", "stopped"], stops: false },
      { state: "starting", later: ["started"], stops: true },
      { state: "unknown", later: ["started"], stops: true },
    ];

    it.each(cases)("$state", async ({ state, later, stops }) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({ id: "existing", state, later });
      const provider = new DaytonaSandboxProvider({}, fixture.client);

      await expect(drive(provider.stop(computer, context))).resolves.toBeUndefined();
      expect(fixture.stop).toHaveBeenCalledTimes(stops ? 1 : 0);
      if (stops) expect(fixture.remote.state).toBe("stopped");
    });

    type ErrorCase = {
      name: string;
      state?: SandboxState;
      later?: SandboxState[];
      arrange: (fixture: DaytonaFixture) => void;
      expected?: Error;
    };
    const rateLimited = new DaytonaRateLimitError("Too many requests", 429);
    const errorCases: ErrorCase[] = [
      {
        name: "409 while another state change is in progress waits for it",
        later: ["stopped"],
        arrange: (fixture) =>
          fixture.stop.mockImplementationOnce(async () => {
            fixture.remote.state = "stopping";
            throw new DaytonaConflictError("Sandbox state change in progress", 409);
          }),
      },
      {
        name: "410 from stop is already gone",
        arrange: (fixture) =>
          fixture.stop.mockRejectedValueOnce(new DaytonaGoneError("Sandbox is gone", 410)),
      },
      {
        name: "404 from stop after the sandbox was deleted is already gone",
        arrange: (fixture) =>
          fixture.stop.mockImplementationOnce(async () => {
            fixture.remote.missing = true;
            throw new DaytonaNotFoundError("Sandbox not found", 404);
          }),
      },
      {
        name: "400 because the sandbox stopped after lookup is already stopped",
        arrange: (fixture) => {
          fixture.remote.state = "stopped";
          fixture.get.mockImplementationOnce(async () => {
            fixture.sandbox.state = "started";
            return fixture.sandbox;
          });
        },
      },
      {
        name: "a stop that ends in an error has nothing left to stop",
        arrange: (fixture) =>
          fixture.stop.mockImplementationOnce(async () => {
            fixture.remote.state = "error";
            throw new DaytonaError("Sandbox failed to stop with status: error");
          }),
      },
      {
        name: "429 is surfaced",
        arrange: (fixture) => fixture.stop.mockRejectedValueOnce(rateLimited),
        expected: rateLimited,
      },
      {
        name: "a stop that never settles times out instead of hanging",
        state: "stopping",
        arrange: () => undefined,
        expected: new DaytonaTimeoutError("Daytona sandbox existing is still stopping"),
      },
    ];

    it.each(errorCases)("$name", async ({ state, later, arrange, expected }) => {
      vi.useFakeTimers();
      const fixture = daytonaFixture({ id: "existing", state: state ?? "started", later });
      arrange(fixture);
      const provider = new DaytonaSandboxProvider({}, fixture.client);
      const stopping = drive(provider.stop(computer, context));

      if (expected) await expect(stopping).rejects.toThrow(expected.message);
      else await expect(stopping).resolves.toBeUndefined();
    });
  });

  it("deletes the sandbox a timed-out create left behind", async () => {
    const fixture = daytonaFixture();
    const timeout = new DaytonaTimeoutError(
      "Failed to create and start sandbox within 120 seconds",
    );
    fixture.create.mockImplementationOnce(async (params) => {
      fixture.remote.name = params.name;
      fixture.remote.missing = false;
      fixture.remote.state = "creating";
      throw timeout;
    });
    const provider = new DaytonaSandboxProvider({}, fixture.client);

    await expect(provider.provision({ botId: "bot-a", homePath: "/unused" }, context)).rejects.toBe(
      timeout,
    );
    const name = fixture.create.mock.calls[0]?.[0].name;
    expect(name).toMatch(/^rakazo-/);
    expect(fixture.get).toHaveBeenCalledWith(name);
    expect(fixture.deleteSandbox).toHaveBeenCalledOnce();
    expect(fixture.remote.missing).toBe(true);
  });

  it("surfaces a create that Daytona rejected without leaving anything to delete", async () => {
    const fixture = daytonaFixture();
    const rejected = new DaytonaRateLimitError("Too many requests", 429);
    fixture.create.mockRejectedValueOnce(rejected);
    const provider = new DaytonaSandboxProvider({}, fixture.client);

    await expect(provider.provision({ botId: "bot-a", homePath: "/unused" }, context)).rejects.toBe(
      rejected,
    );
    expect(fixture.deleteSandbox).not.toHaveBeenCalled();
  });

  it("drops a cached handle once Daytona reports the sandbox gone", async () => {
    vi.useFakeTimers();
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    fixture.remote.missing = true;

    // A recently checked handle is trusted without asking Daytona.
    await expect(provider.readFile(computer, "missing.txt", context)).resolves.toEqual(
      new Uint8Array(),
    );
    expect(fixture.get).not.toHaveBeenCalled();

    vi.advanceTimersByTime(61_000);
    const failure = await provider.prepare(computer, context).catch((error: unknown) => error);
    expect(isSandboxGoneError(failure)).toBe(true);

    // Reconnecting replaces the sandbox instead of reusing the dead handle.
    fixture.options.createdId = "replacement";
    const replaced = await provider.provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "daytona-box", providerKind: "daytona" },
      context,
    );
    expect(replaced).toMatchObject({ providerRef: "replacement", fresh: true });
  });

  it("re-validates a cached handle when the computer is provisioned again", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    // Stopped outside Rakazo, for example from the Daytona dashboard.
    fixture.remote.state = "stopped";
    fixture.remote.desiredState = "stopped";

    const reconnected = await provider.provision(
      { botId: "bot-a", homePath: "/unused", providerRef: "daytona-box", providerKind: "daytona" },
      context,
    );
    expect(reconnected).toMatchObject({ providerRef: "daytona-box", fresh: false, started: true });
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent reconnect and workspace preparation", async () => {
    const fixture = daytonaFixture({ id: "shared", state: "stopped" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const request = {
      botId: "bot-a",
      homePath: "/unused",
      providerRef: "shared",
      providerKind: "daytona" as const,
    };

    const computers = await Promise.all([
      provider.provision(request, context),
      provider.provision(request, context),
    ]);
    await Promise.all(computers.map((computer) => provider.prepare(computer, context)));

    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(
      fixture.executeCommand.mock.calls.filter(([command]) =>
        String(command).startsWith("mkdir -p -- "),
      ),
    ).toHaveLength(1);
  });

  it("returns a fresh reference before workspace preparation fails", async () => {
    const fixture = daytonaFixture({ prepareFails: true });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({ providerRef: "daytona-box", fresh: true });
    await expect(provider.prepare(computer, context)).rejects.toThrow(
      /could not create Daytona workspace/,
    );
    expect(fixture.deleteSandbox).not.toHaveBeenCalled();
  });

  it("surfaces transient stop failures so cleanup can retry", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    fixture.stop.mockRejectedValueOnce(new Error("temporary Daytona outage"));

    await expect(provider.stop(computer, context)).rejects.toThrow("temporary Daytona outage");
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });

  it("reports only a started sandbox as running, without starting it", async () => {
    const fixture = daytonaFixture({ id: "remote", state: "stopped" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = {
      id: "remote",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "remote",
    };

    expect(await provider.isRunning(computer, context)).toBe(false);
    fixture.remote.state = "started";
    expect(await provider.isRunning(computer, context)).toBe(true);
    expect(await provider.isRunning({ ...computer, kind: "e2b" }, context)).toBe(false);
    fixture.remote.missing = true;
    expect(await provider.isRunning(computer, context)).toBe(false);
    fixture.get.mockRejectedValueOnce(new Error("temporary Daytona outage"));
    await expect(provider.isRunning(computer, context)).rejects.toThrow("temporary Daytona outage");
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("distinguishes transient lookup failures from an already deleted sandbox", async () => {
    const fixture = daytonaFixture({ id: "remote" });
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = {
      id: "remote",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "remote",
      fresh: false,
    };
    fixture.get.mockRejectedValueOnce(new Error("temporary Daytona outage"));

    await expect(provider.stop(computer, context)).rejects.toThrow("temporary Daytona outage");
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
  });

  it("accepts definitive deletion while preserving transient teardown failures", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    const failure = new Error("temporary Daytona outage");
    fixture.deleteSandbox
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(new DaytonaNotFoundError("Sandbox not found", 404));

    await expect(provider.destroy(computer, context)).rejects.toBe(failure);
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fixture.deleteSandbox).toHaveBeenCalledTimes(2);
    // Subsequent teardown can also observe the missing resource during lookup.
    fixture.remote.missing = true;
    await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
    expect(fixture.deleteSandbox).toHaveBeenCalledTimes(2);
  });

  it("gives Team bots distinct Daytona previews using the shared runtime", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({}, fixture.client);
    const computer = await provider.provision({ botId: "team-home", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    const writer = { ...context, botId: "writer" };
    const researcher = { ...context, botId: "researcher" };

    fixture.getSignedPreviewUrl.mockImplementation(async (port: number) => ({
      sandboxId: "daytona-box",
      port,
      url: `https://${port}-preview.proxy.daytona.test`,
      token: `token-${port}`,
    }));
    await provider.observe(computer, writer);
    await provider.observe(computer, researcher);
    const writerView = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      writer,
    );
    const researcherView = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      researcher,
    );
    expect(writerView.url).toContain("6100-preview");
    expect(
      fixture.executeCommand.mock.calls.some(([command]) => command.includes("0.0.0.0:6100 8>&-")),
    ).toBe(true);
    expect(researcherView.url).not.toBe(writerView.url);
    expect(researcherView.url).toContain("6100-preview");
    expect(new URL(researcherView.url!).searchParams.get("path")).toMatch(
      /^websockify\?token=view-/,
    );

    await provider.act(
      computer,
      {
        actions: [{ kind: "pointer", type: "click", x: 4, y: 5 }],
        observe: false,
      },
      researcher,
    );
    expect(
      fixture.executeCommand.mock.calls.some(([command]) => command.includes("DISPLAY=:21")),
    ).toBe(true);

    await provider.releaseScreen(computer, writer);
    await expect(provider.observe(computer, researcher)).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });

    const researcherControl = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      researcher,
    );
    expect(researcherControl.url).toContain("6100-preview");
    expect(new URL(researcherControl.url!).searchParams.get("path")).toBe(
      "websockify?token=lease-1",
    );
    expect(
      fixture.executeCommand.mock.calls.some(([command]) =>
        String(command).includes("sockets/control-"),
      ),
    ).toBe(true);

    expect(provider.describe().capabilities.multiScreen).toBe(true);
  });
});

/** Runs fake timers until the promise settles, so state polling completes without waiting. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let elapsed = 0; !settled && elapsed < 1_000_000; elapsed += 1_000) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return promise;
}

type DaytonaFixture = ReturnType<typeof daytonaFixture>;

/**
 * A stateful fake of the Daytona SDK surface the adapter uses. `remote` is what the Daytona API
 * knows; the sandbox handle only sees it through get(), refreshData() and lifecycle calls.
 */
function daytonaFixture(
  options: {
    id?: string;
    createdId?: string;
    state?: SandboxState;
    desiredState?: DaytonaSandbox["desiredState"];
    recoverable?: boolean;
    later?: SandboxState[];
    prepareFails?: boolean;
  } = {},
) {
  const remote: {
    id: string;
    name?: string;
    missing: boolean;
    state: SandboxState;
    desiredState?: DaytonaSandbox["desiredState"];
    recoverable?: boolean;
  } = {
    id: options.id ?? "daytona-box",
    missing: options.state === undefined,
    state: options.state ?? "started",
    desiredState: options.desiredState ?? "started",
    recoverable: options.recoverable,
  };
  const transitions = [...(options.later ?? [])];
  const notFound = () =>
    new DaytonaNotFoundError(`Sandbox with ID or name ${remote.id} not found`, 404);
  const sync = () => {
    if (remote.missing) throw notFound();
    sandbox.id = remote.id;
    sandbox.state = remote.state;
    sandbox.desiredState = remote.desiredState;
    sandbox.recoverable = remote.recoverable;
  };
  const settle = (state: SandboxState) => {
    remote.state = state;
    remote.desiredState = state === "started" || state === "stopped" ? state : remote.desiredState;
    sync();
  };

  const files = new Map<string, Buffer>();
  const modes = new Map<string, string>();
  const screenRegistry = desktopCommandResponder();
  const executeCommand = vi.fn(
    async (command: string, _cwd?: string, _env?: Record<string, string>, _timeout?: number) => {
      const registryResult = screenRegistry(command);
      if (registryResult)
        return { exitCode: registryResult.exitCode, result: registryResult.stdout };
      if (command.endsWith("'echo' 'hello'")) return { exitCode: 0, result: "hello\n" };
      if (options.prepareFails && command.startsWith("mkdir -p -- ")) {
        return { exitCode: 1, result: "could not create Daytona workspace" };
      }
      if (command.startsWith("chmod 700 -- ")) {
        for (const match of command.matchAll(/'([^']+)'/g)) modes.set(match[1]!, "0755");
      }
      return { exitCode: 0, result: "" };
    },
  );
  const uploadFile = vi.fn(async (content: Buffer, target: string) => {
    files.set(target, Buffer.from(content));
    modes.set(target, modes.get(target) ?? "0644");
  });
  const downloadFile = vi.fn(async (target: string) => Buffer.from(files.get(target) ?? []));
  const listFiles = vi.fn(async (directory: string) => {
    const prefix = `${directory.replace(/\/$/, "")}/`;
    const entries = new Map<string, FileInfo>();
    for (const [target, content] of files) {
      if (!target.startsWith(prefix)) continue;
      const remainder = target.slice(prefix.length);
      const [name, ...rest] = remainder.split("/");
      if (!name) continue;
      entries.set(
        name,
        fileInfo(name, rest.length > 0, rest.length ? 0 : content.byteLength, modes.get(target)),
      );
    }
    return [...entries.values()];
  });

  const refreshData = vi.fn(async () => {
    const next = transitions.shift();
    if (next) settle(next);
    sync();
  });
  const start = vi.fn(async (_timeout?: number) => {
    if (remote.missing) throw notFound();
    if (remote.state === "error" || remote.state === "build_failed") {
      throw new DaytonaValidationError("Sandbox is in an errored state", 400);
    }
    if (!["stopped", "paused", "archived"].includes(remote.state)) {
      throw new DaytonaConflictError("Sandbox state change in progress", 409);
    }
    settle("started");
  });
  const recover = vi.fn(async (_timeout?: number) => {
    if (!remote.recoverable) throw new DaytonaValidationError("Sandbox is not recoverable", 400);
    remote.recoverable = undefined;
    settle("started");
  });
  const waitUntilStarted = vi.fn(async (_timeout?: number) => {
    if (remote.desiredState !== "started") {
      throw new DaytonaTimeoutError("Sandbox failed to become ready within the timeout period");
    }
    settle("started");
  });
  const stop = vi.fn(async (_timeout?: number, _force?: boolean) => {
    if (remote.missing) throw notFound();
    if (!["started", "paused"].includes(remote.state)) {
      throw ["stopped", "archived", "error", "build_failed"].includes(remote.state)
        ? new DaytonaValidationError(`Sandbox is ${remote.state}`, 400)
        : new DaytonaConflictError("Sandbox state change in progress", 409);
    }
    settle("stopped");
  });
  const deleteSandbox = vi.fn(async (_timeout?: number, _wait?: boolean) => {
    if (remote.missing) throw notFound();
    remote.missing = true;
  });
  const expireSignedPreviewUrl = vi.fn(async (_port: number, _token: string) => undefined);
  const getSignedPreviewUrl = vi.fn(async (port: number, _expiresInSeconds?: number) => ({
    sandboxId: remote.id,
    port,
    url: `https://${port}-preview.proxy.daytona.test`,
    token: "preview-token",
  }));

  const sandbox = {
    id: remote.id,
    state: remote.state,
    desiredState: remote.desiredState,
    recoverable: remote.recoverable,
    process: { executeCommand },
    fs: {
      uploadFile,
      downloadFile,
      listFiles,
      getFileDetails: vi.fn(async (target: string) =>
        fileInfo(target.split("/").at(-1) ?? target, false, files.get(target)?.byteLength ?? 0),
      ),
    },
    computerUse: { stop: vi.fn(async () => ({ message: "stopped" })) },
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getWorkDir: vi.fn(async () => "/home/daytona"),
    getSignedPreviewUrl,
    expireSignedPreviewUrl,
    refreshActivity: vi.fn(async () => undefined),
    refreshData,
    start,
    recover,
    waitUntilStarted,
    stop,
    delete: deleteSandbox,
  } satisfies DaytonaSandbox;

  const create = vi.fn(
    async (params: CreateSandboxFromSnapshotParams, _options: { timeout: number }) => {
      Object.assign(remote, {
        id: options.createdId ?? options.id ?? "daytona-box",
        name: params.name,
        missing: false,
        recoverable: undefined,
      });
      settle("started");
      return sandbox;
    },
  );
  const get = vi.fn(async (idOrName: string) => {
    if (idOrName !== remote.id && idOrName !== remote.name) throw notFound();
    sync();
    return sandbox;
  });
  const client = { create, get } satisfies DaytonaSandboxSdk;

  return {
    options,
    remote,
    sandbox,
    client,
    create,
    get,
    executeCommand,
    refreshData,
    start,
    recover,
    waitUntilStarted,
    stop,
    deleteSandbox,
    getSignedPreviewUrl,
    expireSignedPreviewUrl,
  };
}

function fileInfo(name: string, isDir: boolean, size: number, mode = "0644"): FileInfo {
  return {
    group: "daytona",
    isDir,
    modTime: "",
    modifiedAt: "2026-01-01T00:00:00Z",
    mode,
    name,
    owner: "daytona",
    permissions: mode === "0755" ? "rwxr-xr-x" : "rw-r--r--",
    size,
  };
}
