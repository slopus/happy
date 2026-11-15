import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellExportScript, sourceEnvironmentCommand } from "./sandbox-shell-environment.js";

function exported(script: string, name: string) {
  return spawnSync("bash", ["-c", `eval "$(cat)" && printenv ${name}`], {
    input: script,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

describe("shellExportScript", () => {
  it("exports values exactly, whatever they contain", () => {
    const value = `fake'secret "$HOME" $(touch /tmp/never) \`id\`\nline two`;
    const result = exported(shellExportScript({ FAKE_TOKEN: value, OTHER: "" }), "FAKE_TOKEN");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${value}\n`);
  });

  it("is empty without variables", () => {
    expect(shellExportScript({})).toBe("");
  });

  it.each(["1ABC", "$(id)"])("rejects the invalid name %j", (name) => {
    expect(() => shellExportScript({ [name]: "fake" })).toThrow(
      "invalid environment variable name",
    );
  });

  it("fails when an assignment cannot be made", () => {
    expect(exported(shellExportScript({ OK: "fake", EUID: "0" }), "OK").status).not.toBe(0);
  });
});

describe("sourceEnvironmentCommand", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function run(envFile: string, argv: string, PATH = process.env.PATH) {
    return spawnSync("bash", ["-c", sourceEnvironmentCommand(envFile, argv)], {
      encoding: "utf8",
      env: { PATH },
    });
  }

  it("reads the open descriptor instead of reopening the deleted file by path", () => {
    expect(sourceEnvironmentCommand("/env/fake id", "printenv FAKE_TOKEN")).toBe(
      `exec 3< '/env/fake id' || exit 1; rm -f -- '/env/fake id'; eval "$(cat <&3 || echo exit 1)" || exit 1; exec 3<&-; printenv FAKE_TOKEN`,
    );
  });

  it("deletes the file, then runs argv with the exported values", () => {
    directory = mkdtempSync(path.join(tmpdir(), "rakazo-env-"));
    const envFile = path.join(directory, "env");
    const value = `fake'secret\nline two`;
    writeFileSync(envFile, shellExportScript({ FAKE_TOKEN: value }));
    const result = run(envFile, `test ! -e '${envFile}' && printenv FAKE_TOKEN`);
    expect(result.stdout).toBe(`${value}\n`);
    expect(result.status).toBe(0);
    expect(existsSync(envFile)).toBe(false);
  });

  it("does not run argv when the file is missing or cannot apply", () => {
    directory = mkdtempSync(path.join(tmpdir(), "rakazo-env-"));
    const envFile = path.join(directory, "env");
    expect(run(envFile, "echo ran").stdout).toBe("");
    writeFileSync(envFile, shellExportScript({ EUID: "0" }));
    const result = run(envFile, "echo ran");
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });

  it("does not run argv when the file cannot be read", () => {
    directory = mkdtempSync(path.join(tmpdir(), "rakazo-env-"));
    const envFile = path.join(directory, "env");
    writeFileSync(envFile, shellExportScript({ FAKE_TOKEN: "fake" }));
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "cat"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = run(envFile, "echo ran", `${bin}:${process.env.PATH}`);
    expect(result.stdout).toBe("");
    expect(result.status).toBe(1);
  });
});
