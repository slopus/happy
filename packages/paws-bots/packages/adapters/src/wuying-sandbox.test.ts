import type * as TimersPromises from "node:timers/promises";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { isSandboxGoneError } from "./sandbox-errors.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";
import { psLiteral, quoteWindowsArgument, windowsKeyChord } from "./wuying-sandbox.js";
import { FAKE_PROFILE, FakeWuyingDesktop } from "./wuying-sandbox.test-support.js";

// Power polling advances a virtual clock, so start and stop tests run instantly.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof TimersPromises>()),
  setTimeout: async () => undefined,
}));

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function run(desktop: FakeWuyingDesktop, computer: ComputerRef, argv: string[]) {
  const events: ProcessEvent[] = [];
  // Within the gateway's one-minute call, a command runs through process_exec.
  for await (const event of desktop.provider().execute(computer, { argv, timeoutMs: 30_000 }, ctx))
    events.push(event);
  return events;
}

describe("WuyingSandboxProvider", () => {
  it("meets the shared workspace contract", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "portable", homePath: "/h" }, ctx);
    await assertSandboxWorkspaceContract(provider, computer, ctx);
  });

  it("keeps each computer's home in its own folder under the user profile", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot-a", homePath: "/h" }, ctx);
    expect(computer).toMatchObject({ kind: "wuying", providerRef: "ecd-fake", fresh: true });
    expect(desktop.has(`${FAKE_PROFILE}\\rakazo\\bot-a`)).toBe(true);
    expect(await provider.environment(computer, ctx)).toEqual({
      platform: "win32",
      home: `${FAKE_PROFILE}\\rakazo\\bot-a`,
      shell: "powershell.exe",
    });
    const again = await provider.provision({ botId: "bot-a", homePath: "/h" }, ctx);
    expect(again.fresh).toBe(false);
    await expect(provider.listFiles(computer, "../bot-b", ctx)).rejects.toThrow("escapes");
    await expect(provider.provision({ botId: "a/../b", homePath: "/h" }, ctx)).rejects.toThrow();
  });

  it("starts a stopped desktop, and stops it only when no other computer still uses it", async () => {
    const desktop = new FakeWuyingDesktop();
    desktop.status = "Stopped";
    const computer = await desktop.provider().provision({ botId: "bot", homePath: "/h" }, ctx);
    expect(computer.started).toBe(true);
    expect(desktop.control).toEqual(["start"]);
    await desktop.provider("ecd-fake", async () => true).stop(computer, ctx);
    expect(desktop.status).toBe("Running");
    await desktop.provider("ecd-fake", async () => false).stop(computer, ctx);
    expect(desktop.status).toBe("Stopped");
    expect(desktop.control).toEqual(["start", "stop"]);
    // Another computer started on it while it powered off.
    desktop.status = "Running";
    const uses = [false, true];
    await desktop.provider("ecd-fake", async () => uses.shift() ?? true).stop(computer, ctx);
    expect(desktop.status).toBe("Running");
    expect(desktop.control).toEqual(["start", "stop", "stop", "start"]);
  });

  it("saves a workspace without dependency folders, and reports one too large to save", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    const text = (value: string) => new TextEncoder().encode(value);
    await provider.writeFile(
      computer,
      { path: "src/run.sh", content: text("x"), executable: true },
      ctx,
    );
    await provider.writeFile(
      computer,
      { path: "node_modules/pkg/index.js", content: text("y") },
      ctx,
    );
    const saved = [];
    for await (const file of provider.exportWorkspace(computer, ctx)) saved.push(file);
    expect(saved).toEqual([{ path: "src/run.sh", content: text("x"), executable: true }]);
    await expect(
      (async () => {
        for await (const _ of provider.exportWorkspace(computer, ctx, {
          maxBytes: 0,
          maxFiles: 10,
        }));
      })(),
    ).rejects.toBeInstanceOf(WorkspaceTooLargeError);
  });

  it("escapes every quote PowerShell reads as a single quote", () => {
    expect(psLiteral("C:\\it's \u2018a\u2019 \u201Ab\u201B")).toBe(
      "'C:\\it''s \u2018\u2018a\u2019\u2019 \u201A\u201Ab\u201B\u201B'",
    );
  });

  it("treats a desktop the control plane no longer lists as gone", async () => {
    const desktop = new FakeWuyingDesktop();
    vi.spyOn(desktop, "desktopStatus").mockResolvedValue(null);
    const error = await desktop
      .provider()
      .provision({ botId: "bot", homePath: "/h" }, ctx)
      .catch((caught: unknown) => caught);
    expect(isSandboxGoneError(error)).toBe(true);
  });

  it("runs commands in the home with UTF-8 PowerShell output", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    desktop.exec = () => ({ status: "completed", exit_code: 3, stdout: "out", stderr: "err" });
    const events = await run(desktop, computer, [
      "powershell.exe",
      "-NoLogo",
      "-Command",
      "Get-Date",
    ]);
    expect(events).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 3 },
    ]);
    const exec = desktop.calls.findLast((call) => call.tool === "process_exec");
    expect(exec?.args).toMatchObject({
      program: "powershell.exe",
      cwd: `${FAKE_PROFILE}\\rakazo\\bot`,
    });
    expect((exec?.args.args as string[] | undefined)?.at(-1)).toMatch(
      /^\[Console\]::OutputEncoding=.*Get-Date$/,
    );
  });

  it("reports a command that ran out of time", async () => {
    const desktop = new FakeWuyingDesktop();
    const computer = await provisionPrepared(
      desktop.provider(),
      { botId: "b", homePath: "/h" },
      ctx,
    );
    desktop.exec = () => ({ status: "timeout", exit_code: 1, stdout: "", stderr: "" });
    expect((await run(desktop, computer, ["ping.exe"])).at(-1)).toEqual({
      type: "exit",
      code: 124,
    });
  });

  it("runs a command allowed over a minute detached and streams its output", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    desktop.background = { stdout: "第 1 行\r\n", stderr: "warn", code: 7, polls: 2 };
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["powershell.exe", "-Command", "npm install"], timeoutMs: 600_000 },
      ctx,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "第 1 行\r\n" },
      { type: "stderr", data: "warn" },
      { type: "exit", code: 7 },
    ]);
    expect(desktop.calls.some((call) => call.tool === "process_exec")).toBe(false);
    // The command reaches PowerShell encoded, untouched by command-line quoting.
    expect(desktop.backgroundCommand).toMatch(/^\[Console\]::OutputEncoding=.*npm install$/);
    const long = `Write-Output '${"x".repeat(20_000)}'`;
    for await (const _ of provider.execute(
      computer,
      { argv: ["powershell.exe", "-Command", long], timeoutMs: 600_000 },
      ctx,
    ));
    // One too long for a command line goes through a file instead.
    expect(desktop.backgroundCommand?.endsWith(long)).toBe(true);
    // So does a short script whose other arguments make the command line too long.
    desktop.calls.length = 0;
    for await (const _ of provider.execute(
      computer,
      {
        argv: ["powershell.exe", "-Command", "Write-Output $args", "y".repeat(31_000)],
        timeoutMs: 600_000,
      },
      ctx,
    ));
    expect(
      desktop.calls.some(
        (call) => call.tool === "fs_write" && String(call.args.path).endsWith("\\command.ps1"),
      ),
    ).toBe(true);
    const launch = desktop.calls.find((call) => call.tool === "app_start");
    const dir = /'([^']+)\\run\.ps1'/.exec(
      String((launch?.args.args as string[] | undefined)?.at(-1)),
    )?.[1];
    expect(dir?.startsWith(`${FAKE_PROFILE}\\rakazo\\.runs\\`)).toBe(true);
    expect(desktop.has(dir ?? "")).toBe(false);
  });

  it("stops a detached command when its run is cancelled", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    desktop.background = { stdout: "started", code: null };
    const abort = new AbortController();
    const events: ProcessEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider.execute(
          computer,
          { argv: ["ping.exe", "-t", "127.0.0.1"], timeoutMs: 600_000 },
          { ...ctx, signal: abort.signal },
        )) {
          events.push(event);
          abort.abort(new Error("cancelled"));
        }
      })(),
    ).rejects.toThrow("cancelled");
    expect(events).toEqual([{ type: "stdout", data: "started" }]);
    expect(desktop.calls.some((call) => call.tool === "app_stop")).toBe(true);
    expect(desktop.calls.at(-1)).toMatchObject({ tool: "fs_delete", args: { recursive: true } });
  });

  it("presses single keys natively and sends chords through SendKeys", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    await provider.act(
      computer,
      {
        actions: [
          { kind: "key", key: "Return" },
          { kind: "key", key: "c", modifiers: ["ctrl"] },
          { kind: "key", key: "ctrl+shift+Left" },
        ],
        observe: false,
      },
      ctx,
    );
    expect(
      desktop.calls.filter((call) => call.tool === "input_keyboard").map((call) => call.args),
    ).toEqual([{ key: "Enter", action: "press" }]);
    expect(desktop.sentKeys).toEqual(["^c", "^+{LEFT}"]);
    expect(
      [...desktop.calls].reverse().find((call) => call.tool === "fs_delete")?.args.path,
    ).toMatch(/\\rakazo\\.runs\\/);
  });

  it("maps key names to the gateway's names and SendKeys codes", () => {
    expect(windowsKeyChord("BackSpace")).toEqual({ native: "Backspace" });
    expect(windowsKeyChord("Prior")).toEqual({ native: "PageUp" });
    expect(windowsKeyChord("a")).toEqual({ native: "a" });
    expect(windowsKeyChord("super")).toEqual({ native: "Meta" });
    expect(windowsKeyChord("A", ["ctrl"])).toEqual({ sendKeys: "^a" });
    expect(windowsKeyChord("+", ["ctrl"])).toEqual({ sendKeys: "^{+}" });
    expect(windowsKeyChord("F5")).toEqual({ sendKeys: "{F5}" });
    expect(windowsKeyChord("Tab", ["alt"])).toEqual({ sendKeys: "%{TAB}" });
    expect(() => windowsKeyChord("r", ["super"])).toThrow("not available");
    expect(() => windowsKeyChord("c", ["hyper"])).toThrow("Unknown modifier");
  });

  it("quotes arguments the way Windows reads them back", () => {
    expect(quoteWindowsArgument("plain")).toBe("plain");
    expect(quoteWindowsArgument("")).toBe('""');
    expect(quoteWindowsArgument("a b")).toBe('"a b"');
    expect(quoteWindowsArgument('c"d')).toBe('"c\\"d"');
    expect(quoteWindowsArgument("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });

  it("maps actions from the scaled screenshot back to desktop pixels", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    const observed = await provider.observe(computer, ctx);
    expect(observed).toMatchObject({ width: 1600, height: 1000, cursor: { x: 400, y: 200 } });
    await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "click", x: 100, y: 50 },
          { kind: "pointer", type: "down", x: 10, y: 10 },
          { kind: "pointer", type: "up", x: 20, y: 30 },
          { kind: "key", key: "c", modifiers: ["ctrl"] },
          { kind: "scroll", direction: "down", amount: 2 },
        ],
        observe: false,
      },
      ctx,
    );
    const input = desktop.calls.filter((call) => call.tool.startsWith("input_"));
    expect(input.map((call) => call.args)).toEqual([
      { action: "click", button: "left", x: 200, y: 100 },
      { action: "move", x: 20, y: 20 },
      { action: "drag", button: "left", x: 20, y: 20, to_x: 40, to_y: 60 },
      { action: "scroll", scroll: -2 },
    ]);
  });

  it("hands the screen to the app as a one-time Wuying login", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    const screen = await provider.connectScreen(computer, { view: "stream" }, ctx);
    const url = new URL(screen.url ?? "");
    expect(url.protocol).toBe("wuying:");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      desktop_id: "ecd-fake",
      region_id: "cn-hangzhou",
      auth_code: "one-time-code",
    });
  });

  it("removes only the computer's home, never the desktop", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const a = await provisionPrepared(provider, { botId: "a", homePath: "/h" }, ctx);
    await provisionPrepared(provider, { botId: "b", homePath: "/h" }, ctx);
    await provider.destroy(a, ctx);
    expect(desktop.has(`${FAKE_PROFILE}\\rakazo\\a`)).toBe(false);
    expect(desktop.has(`${FAKE_PROFILE}\\rakazo\\b`)).toBe(true);
    expect(desktop.control).not.toContain("stop");
  });

  it("removes only well-formed workspace children", async () => {
    const desktop = new FakeWuyingDesktop();
    const provider = desktop.provider();
    const computer = await provisionPrepared(provider, { botId: "bot", homePath: "/h" }, ctx);
    await provider.workspaceDirectories(computer, { action: "ensure", paths: ["bots/x"] }, ctx);
    expect(await provider.workspaceDirectories(computer, { action: "list" }, ctx)).toEqual([
      "bots/x",
    ]);
    await expect(
      provider.workspaceDirectories(
        computer,
        { action: "remove", parent: "bots", names: ["..\\other"] },
        ctx,
      ),
    ).rejects.toThrow("escapes");
    await provider.workspaceDirectories(
      computer,
      { action: "remove", parent: "bots", names: ["x"] },
      ctx,
    );
    expect(await provider.workspaceDirectories(computer, { action: "list" }, ctx)).toEqual([]);
  });
});
