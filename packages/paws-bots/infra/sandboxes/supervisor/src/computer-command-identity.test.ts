import { Duplex, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computerCommandEnv } from "./supervisor-logic.js";

type ExecOptions = { Cmd: string[]; Env?: string[]; User?: string };

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  inspect: vi.fn(),
  failWhen: (_options: { Cmd: string[] }): boolean => false,
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockReset();
  mock.failWhen = () => false;
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" },
    },
    State: { Running: true, StartedAt: "2026-01-01T00:00:00Z" },
    HostConfig: {},
  });
  mock.exec.mockImplementation(async (options: ExecOptions) => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([]),
        writable: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: mock.failWhen(options) ? 1 : 0 }),
  }));
});

function post(path: string, body: unknown) {
  return supervisorApp.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify(body),
  });
}

const execs = () => mock.exec.mock.calls.map(([options]) => options as ExecOptions);

// Every exec, including file writes for uploads, inherits the container's non-root user
// (see containerCreateOptions) instead of naming one.
function expectContainerUser() {
  expect(execs().length).toBeGreaterThan(0);
  for (const options of execs()) expect(options).not.toHaveProperty("User");
}

describe("computer command identity", () => {
  it("runs the bot's commands with the workspace environment and the container's user", async () => {
    const response = await post("/computers/computer-exec/exec", {
      argv: ["echo", "hi"],
      env: { EXTRA: "1" },
    });
    await response.text();
    expect(execs().at(-1)?.Env).toEqual([...computerCommandEnv({ display: ":1" }), "EXTRA=1"]);
    expectContainerUser();
  });

  it("keeps a silent command's response alive until it exits", async () => {
    vi.useFakeTimers();
    try {
      let finish = (_code: number) => {};
      const exited = new Promise<number>((resolve) => {
        finish = resolve;
      });
      mock.exec.mockImplementation(async () => ({
        start: async () => {
          const output = new Readable({ read() {} });
          void exited.then(() => output.push(null));
          return Duplex.from({
            readable: output,
            writable: new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
          });
        },
        inspect: async () => ({ ExitCode: await exited }),
      }));
      const response = await post("/computers/computer-exec/exec", { argv: ["sleep", "600"] });
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(decoder.decode((await reader?.read())?.value)).toBe("\n");
      finish(0);
      let rest = "";
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        rest += decoder.decode(chunk.value);
      }
      expect(rest.trim().split("\n").at(-1)).toBe(JSON.stringify({ type: "exit", code: 0 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the keep-alive when the caller cancels a command that never exits", async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      mock.exec.mockImplementation(async () => ({
        start: async () =>
          Duplex.from({
            readable: new Readable({ read() {} }),
            writable: new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
          }),
        inspect: async () => ({ ExitCode: 0 }),
      }));
      const response = await post("/computers/computer-exec/exec", { argv: ["sleep", "600"] });
      const reader = response.body?.getReader();
      await vi.advanceTimersByTimeAsync(15_000);
      await reader?.read();
      const before = vi.getTimerCount();
      await reader?.cancel();
      expect(clear).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(before - 1);
    } finally {
      clear.mockRestore();
      vi.useRealTimers();
    }
  });

  it("starts the user's terminal with the same environment and user as the bot's shell", async () => {
    mock.failWhen = (options) => options.Cmd.join(" ").includes("terminal-fixture-token");
    const response = await post("/computers/computer-terminal/terminal", {
      controlToken: "terminal-fixture-token",
    });
    expect(response.status).toBe(400);
    const terminal = execs().find((options) =>
      options.Cmd.join(" ").includes("terminal-fixture-token"),
    );
    expect(terminal?.Env).toEqual(computerCommandEnv({ display: ":1" }));
    expectContainerUser();
  });

  it("writes uploaded files as the container's user", async () => {
    const response = await post("/computers/computer-files/files", {
      path: "notes.txt",
      content: Buffer.from("hello").toString("base64"),
    });
    expect(response.status).toBe(200);
    expect(execs().at(-1)?.Cmd[0]).toBe("python3");
    expectContainerUser();
  });
});
