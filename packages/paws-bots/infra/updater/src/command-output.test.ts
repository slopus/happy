import type { ExecFileException } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdaterApp, runHostCommand } from "./index.js";
import { resolveUpdaterConfig, truncateOutput } from "./updater-logic.js";

const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));

const directories: string[] = [];
const token = "fake-command-output-token-00000000000";
const latestCommit = "a".repeat(40);
const olderCommit = "b".repeat(40);
const tags = [
  `${latestCommit}\trefs/tags/v10.0.0`,
  ...Array.from({ length: 200 }, (_, i) => `${olderCommit}\trefs/tags/v9.0.${i}`),
].join("\n");

function commandOutput(stdout: string, stderr = "", error: ExecFileException | null = null) {
  execFile.mockImplementation(
    (
      _command,
      _args,
      _options,
      done: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      done(error, stdout, stderr);
    },
  );
}

afterEach(async () => {
  execFile.mockReset();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function plan(route = "/plan", currentTag = "v1.0.0") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-command-output-"));
  directories.push(dir);
  await writeFile(path.join(dir, ".env"), `RAKAZO_IMAGE_TAG=${currentTag}\n`);
  const app = createUpdaterApp({
    ...resolveUpdaterConfig({ RAKAZO_DEPLOY_DIR: "/fixture", RAKAZO_UPDATER_TOKEN: token }),
    deployDir: dir,
    envFile: path.join(dir, ".env"),
  });
  return app.request(route, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "main" }),
  });
}

describe("command output", () => {
  it("selects the latest release even when it precedes the diagnostic tail", async () => {
    expect(tags.length).toBeGreaterThan(8_000);
    commandOutput(tags);
    const response = await plan();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      targetCommit: latestCommit,
      reason: expect.stringContaining("v10.0.0"),
    });
  });

  it("keeps stderr out of the release parser", async () => {
    commandOutput(`${latestCommit}\trefs/tags/v10.0.0\n`, `${olderCommit}\trefs/tags/v99.0.0\n`);
    await expect((await plan()).json()).resolves.toMatchObject({ targetCommit: latestCommit });
  });

  it("recognizes the latest release as already deployed when applying", async () => {
    commandOutput(tags);
    const response = await plan("/apply", `sha-${latestCommit}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      toTag: `sha-${latestCommit}`,
      toCommit: latestCommit,
      steps: [],
    });
    expect(execFile.mock.calls.every(([command]) => command === "git")).toBe(true);
  });

  it("retains the peeled commit of an annotated release before the diagnostic tail", async () => {
    const olderTags = tags.slice(tags.indexOf("\n") + 1);
    commandOutput(
      `${olderCommit}\trefs/tags/v10.0.0\n${latestCommit}\trefs/tags/v10.0.0^{}\n${olderTags}`,
    );
    await expect((await plan()).json()).resolves.toMatchObject({ targetCommit: latestCommit });
  });

  it("refuses unexpected programs and NUL arguments without executing", async () => {
    for (const [command, args] of [
      ["bash", ["-c", "echo unsafe"]],
      ["git", ["a\0b"]],
    ] as const) {
      await expect(
        runHostCommand(command, [...args], { cwd: os.tmpdir(), timeoutMs: 5_000 }),
      ).resolves.toMatchObject({
        ok: false,
        exitCode: null,
        stdout: "",
      });
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it("preserves machine stdout and bounds diagnostic output", async () => {
    const stdout = `${"x".repeat(9_000)}\0 \n`;
    const stderr = "diagnostic\n";
    commandOutput(stdout, stderr);
    const result = await runHostCommand("git", ["ls-remote", "--tags", "--", "example"], {
      cwd: os.tmpdir(),
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      stdout,
      output: truncateOutput(stdout + stderr),
    });
    expect(result.output.length).toBeLessThanOrEqual(8_001);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--tags", "--", "example"],
      expect.objectContaining({
        maxBuffer: 8 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        timeout: 5_000,
      }),
      expect.any(Function),
    );
  });

  it.each([
    { code: 1, message: "git failed" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", message: "stdout maxBuffer length exceeded" },
    { killed: true, signal: "SIGTERM" as const, message: "command timed out" },
  ])("refuses incomplete releases after a command failure: $message", async (failure) => {
    commandOutput(tags, "", Object.assign(new Error(failure.message), failure));
    const response = await plan("/apply");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Could not read releases"),
    });
  });
});
