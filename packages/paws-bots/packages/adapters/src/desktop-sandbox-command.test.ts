import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processTree from "./desktop-process-tree.js";
import { assertHostCommandsAllowed, DesktopSandboxProvider } from "./desktop-sandbox.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

describe("desktop command execution", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { code: 0, signal: null, expected: 0, stderr: "" },
    { code: 7, signal: null, expected: 7, stderr: "" },
    { code: null, signal: null, expected: 1, stderr: "" },
    { code: null, signal: "SIGTERM", expected: 1, stderr: "command terminated by SIGTERM\n" },
    { code: null, signal: "SIGSEGV", expected: 1, stderr: "command terminated by SIGSEGV\n" },
  ])("reports close code $code and signal $signal", async ({ code, signal, expected, stderr }) => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
    roots.push(root);
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "close", homePath: "/unused" }, ctx);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const tree = { alive: () => false, kill: vi.fn(), close: vi.fn() };
    const spawn = vi.spyOn(processTree, "spawnOwnedCommand").mockImplementation(() => {
      setImmediate(() => child.emit("close", code, signal));
      return { child: child as unknown as ChildProcessWithoutNullStreams, tree };
    });
    try {
      const result = await collect(desktop.execute(computer, { argv: ["test-command"] }, ctx));
      expect(result).toEqual({ code: expected, stdout: "", stderr });
    } finally {
      spawn.mockRestore();
      await desktop.destroy(computer, ctx);
    }
  });

  it.each(["error", "cancel"] as const)(
    "preserves %s when close follows settlement",
    async (outcome) => {
      const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
      roots.push(root);
      const desktop = new DesktopSandboxProvider({ root });
      const controller = new AbortController();
      const computer = await desktop.provision({ botId: "settlement", homePath: "/unused" }, ctx);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      const tree = { alive: () => false, kill: vi.fn(), close: vi.fn() };
      const spawn = vi.spyOn(processTree, "spawnOwnedCommand").mockImplementation(() => {
        setImmediate(() => {
          if (outcome === "error") child.emit("error", new Error("spawn failed"));
          else controller.abort();
          child.emit("close", null, "SIGTERM");
        });
        return { child: child as unknown as ChildProcessWithoutNullStreams, tree };
      });
      try {
        const events: ProcessEvent[] = [];
        for await (const event of desktop.execute(
          computer,
          { argv: ["test-command"] },
          { ...ctx, signal: controller.signal },
        ))
          events.push(event);
        expect(events).toEqual(
          outcome === "error"
            ? [
                { type: "stderr", data: "spawn failed" },
                { type: "exit", code: 1 },
              ]
            : [
                { type: "stderr", data: "command aborted\n" },
                { type: "exit", code: 130 },
              ],
        );
        expect(tree.kill).toHaveBeenCalledTimes(outcome === "cancel" ? 1 : 0);
      } finally {
        spawn.mockRestore();
        await desktop.destroy(computer, ctx);
      }
    },
  );

  it("only hosts commands in the desktop app or a local development process", () => {
    const node = { ...process.versions, electron: undefined };
    const electron = { ...process.versions, electron: "38.0.0" };
    const refused = "SANDBOX_PROVIDER=desktop runs bot commands directly on this host";
    expect(() => assertHostCommandsAllowed({ NODE_ENV: "production" }, node)).toThrow(refused);
    expect(() => assertHostCommandsAllowed({}, node)).toThrow(refused);
    expect(() => assertHostCommandsAllowed({ NODE_ENV: "production" }, electron)).not.toThrow();
    expect(() => assertHostCommandsAllowed({ NODE_ENV: "development" }, node)).not.toThrow();
    expect(() => assertHostCommandsAllowed({ NODE_ENV: "test" }, node)).not.toThrow();
  });

  it("leaves the desktop app's own bridge free to build the provider", () => {
    // The guard sits where a backend selects SANDBOX_PROVIDER=desktop, not in the constructor.
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => new DesktopSandboxProvider()).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives commands a shell environment and the request env, never backend secrets", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
    roots.push(root);
    vi.stubEnv("DATABASE_URL", "postgres://fake:fake@127.0.0.1/fake");
    vi.stubEnv("ENCRYPTION_KEY", "fake-encryption-key");
    vi.stubEnv("BETTER_AUTH_SECRET", "fake-auth-secret");
    vi.stubEnv("HOME", "/fake-home");
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "env", homePath: "/unused" }, ctx);
    try {
      const result = await collect(
        desktop.execute(
          computer,
          {
            argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
            env: { BOT_TOKEN: "fake-bot-token" },
          },
          ctx,
        ),
      );
      expect(result.code).toBe(0);
      const env = JSON.parse(result.stdout) as Record<string, string>;
      expect(env).not.toHaveProperty("DATABASE_URL");
      expect(env).not.toHaveProperty("ENCRYPTION_KEY");
      expect(env).not.toHaveProperty("BETTER_AUTH_SECRET");
      expect(env.BOT_TOKEN).toBe("fake-bot-token");
      expect(env.HOME).toBe("/fake-home");
      expect(env.PATH ?? env.Path).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
      await desktop.destroy(computer, ctx);
    }
  });

  it("keeps UTF-8 characters split across output chunks intact", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
    roots.push(root);
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "utf8", homePath: "/unused" }, ctx);
    try {
      const script = [
        'const bytes = Buffer.from("é😀");',
        "process.stdout.write(bytes.subarray(0, 1));",
        "process.stderr.write(bytes.subarray(2, 4));",
        "setTimeout(() => {",
        "  process.stdout.write(bytes.subarray(1, 2));",
        "  process.stderr.write(bytes.subarray(4));",
        "}, 100);",
      ].join("\n");
      const result = await collect(
        desktop.execute(computer, { argv: [process.execPath, "-e", script] }, ctx),
      );
      expect(result).toEqual({ code: 0, stdout: "é", stderr: "😀" });
    } finally {
      await desktop.destroy(computer, ctx);
    }
  });

  it("never starts an OS process for an already-cancelled command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
    roots.push(root);
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "cancelled", homePath: "/unused" }, ctx);
    const spawn = vi.spyOn(processTree, "spawnOwnedCommand").mockImplementation(() => {
      throw new Error("A cancelled command must not create a process");
    });
    try {
      const result = await collect(
        desktop.execute(
          computer,
          { argv: [process.execPath, "-e", "process.exit(0)"] },
          { ...ctx, signal: AbortSignal.abort() },
        ),
      );
      expect(result).toMatchObject({ code: 130, stderr: "command aborted\n" });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      await desktop.destroy(computer, ctx);
    }
  });

  it("does not pass the program or its arguments through a shell", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
    roots.push(root);
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "cmd", homePath: "/unused" }, ctx);
    const marker = path.join(computer.providerRef, "pwned");
    const payload = `$(touch ${marker}); touch ${marker}`;

    const literal = await collect(
      desktop.execute(
        computer,
        {
          argv: [process.execPath, "-e", "process.stdout.write(process.argv[1] ?? '')", payload],
        },
        ctx,
      ),
    );
    expect(literal.code).toBe(0);
    expect(literal.stdout).toBe(payload);
    expect(existsSync(marker)).toBe(false);

    const injected = await collect(
      desktop.execute(computer, { argv: [`${process.execPath}; touch ${marker}`] }, ctx),
    );
    expect(injected.code).toBe(1);
    expect(injected.stderr).toContain("ENOENT");
    expect(existsSync(marker)).toBe(false);

    const binaryNul = await collect(
      desktop.execute(computer, { argv: [`${process.execPath}\0`] }, ctx),
    );
    expect(binaryNul).toMatchObject({ code: 1, stderr: "command rejected\n" });

    const nul = await collect(desktop.execute(computer, { argv: [process.execPath, "a\0b"] }, ctx));
    expect(nul).toMatchObject({ code: 1, stderr: "command rejected\n" });

    const batch = await collect(
      desktop.execute(computer, { argv: ["tool.cmd", "/c", payload] }, ctx),
    );
    expect(batch).toMatchObject({ code: 1, stderr: "command rejected\n" });

    await desktop.destroy(computer, ctx);
  });

  it.skipIf(process.platform === "win32")(
    "runs executable paths containing punctuation and .com",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-command-"));
      roots.push(root);
      const binary = path.join(root, "node$&';.com");
      symlinkSync(process.execPath, binary);
      const desktop = new DesktopSandboxProvider({ root });
      const computer = await desktop.provision({ botId: "cmd", homePath: "/unused" }, ctx);
      const result = await collect(
        desktop.execute(
          computer,
          {
            argv: [binary, "-e", "process.stdout.write('ok')"],
          },
          ctx,
        ),
      );
      expect(result).toEqual({ code: 0, stdout: "ok", stderr: "" });
      await desktop.destroy(computer, ctx);
    },
  );
});

async function collect(events: AsyncIterable<ProcessEvent>) {
  let stdout = "";
  let stderr = "";
  let code = -1;
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}
