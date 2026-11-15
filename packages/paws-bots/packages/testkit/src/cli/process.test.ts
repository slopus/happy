import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { runProcess } from "./process.js";

let child: EventEmitter;
beforeEach(() => {
  child = new EventEmitter();
  spawn.mockReset().mockReturnValue(child);
});
afterEach(() => vi.restoreAllMocks());

function platform(value: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(value);
}

it("runs pnpm through its Node entry on Windows without shell expansion", async () => {
  platform("win32");
  const entry = path.resolve("fixture with spaces", "pnpm.cjs");
  const args = ["exec", "tool", "space value", 'quoted"value', "&echo unsafe", "%literal%"];
  const env = { npm_execpath: entry, MARKER: "kept" };
  const pending = runProcess("pnpm", args, env);
  expect(spawn).toHaveBeenCalledWith(process.execPath, [entry, ...args], {
    stdio: "inherit",
    env,
    shell: false,
  });
  child.emit("exit", 0);
  await expect(pending).resolves.toBeUndefined();
});

it("keeps the ordinary pnpm executable on POSIX", async () => {
  platform("linux");
  const env = { npm_execpath: path.resolve("pnpm.cjs") };
  const pending = runProcess("pnpm", ["test"], env);
  expect(spawn).toHaveBeenCalledWith("pnpm", ["test"], { stdio: "inherit", env, shell: false });
  child.emit("exit", 0);
  await pending;
});

it("does not change non-pnpm commands on Windows", async () => {
  platform("win32");
  const env = { npm_execpath: path.resolve("pnpm.cjs") };
  const pending = runProcess("node", ["script.js"], env);
  expect(spawn).toHaveBeenCalledWith("node", ["script.js"], {
    stdio: "inherit",
    env,
    shell: false,
  });
  child.emit("exit", 0);
  await pending;
});

it.each([undefined, "pnpm.cjs", path.resolve("npm-cli.js")])(
  "does not execute an unrecognized pnpm entry: %s",
  async (entry) => {
    platform("win32");
    const env = { npm_execpath: entry };
    const pending = runProcess("pnpm", ["test"], env);
    expect(spawn).toHaveBeenCalledWith("pnpm", ["test"], { stdio: "inherit", env, shell: false });
    child.emit("exit", 0);
    await pending;
  },
);

describe("child failures", () => {
  it("rejects a spawn error", async () => {
    const pending = runProcess("pnpm", [], {});
    const error = new Error("spawn failed");
    child.emit("error", error);
    await expect(pending).rejects.toBe(error);
  });
  it("preserves nonzero exit errors", async () => {
    const pending = runProcess("pnpm", ["test"], {});
    child.emit("exit", 7);
    await expect(pending).rejects.toThrow("pnpm test exited 7");
  });
});
