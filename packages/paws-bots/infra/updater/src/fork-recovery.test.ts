import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdaterApp } from "./index.js";
import { DEFAULT_COMPOSE_FILE, resolveUpdaterConfig } from "./updater-logic.js";

const token = "fake-updater-recovery-token-0000000000";
const currentCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);
const oldTag = `local-${currentCommit}`;
const originalRemote = "https://github.com/example/previous-fork";
const nextRemote = "https://github.com/example/next-fork";
const originalEnv = `POSTGRES_APP_PASSWORD=fake-app-password\nRAKAZO_IMAGE_TAG=${oldTag}\nRAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\n`;
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

type Failure = "checkout" | "merge" | "recreate" | "restore-checkout" | "recover" | "read-head";
interface Invocation {
  command: string;
  args: string[];
  commit: string;
  compose?: string;
  serviceEnv?: string;
  imageTag?: string;
  envFile?: string;
}

// These executables use only fixture files. PATH contains no real git or Docker, and the
// updater's production execFile runner is used so command ordering is exercised end to end.
const fakeExecutable = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const stateFile = path.join(__dirname, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const call = { command, args, commit: state.commit };
const log = () => fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(call) + "\n");
const fail = (message) => { process.stderr.write(message); process.exit(1); };
const hasFailure = (name) => fixture.failures.includes(name);
const moveCheckout = (commit, branch, revision) => {
  state.commit = commit;
  state.branch = branch;
  fs.writeFileSync(fixture.composeFile, fixture[revision + "Compose"]);
  fs.writeFileSync(fixture.serviceEnv, "REVISION=" + revision + "\n");
};
if (command === "docker") {
  call.compose = fs.readFileSync(args[args.indexOf("--file") + 1], "utf8");
  call.serviceEnv = fs.readFileSync(fixture.serviceEnv, "utf8");
  call.envFile = fs.readFileSync(args[args.indexOf("--env-file") + 1], "utf8");
  call.imageTag = process.env.RAKAZO_IMAGE_TAG;
  log();
  if (!args.includes("up")) fail("Unexpected Docker command");
  if (args.includes("--build") && fixture.failures.length > 0) fail("new API unhealthy");
  if (args.includes("--no-build") && hasFailure("recover")) fail("cached image unavailable");
} else if (command === "git") {
  log();
  const joined = args.join(" ");
  if (joined === "rev-parse HEAD") {
    if (hasFailure("read-head")) fail("HEAD unreadable");
    process.stdout.write(state.commit);
  } else if (joined === "rev-parse --abbrev-ref HEAD") {
    process.stdout.write(state.branch);
  } else if (joined === "remote get-url origin") {
    process.stdout.write(state.remote);
  } else if (args[0] === "ls-remote") {
    process.stdout.write(fixture.targetCommit + "\trefs/heads/main\n");
  } else if (args[0] === "remote" && args[1] === "set-url") {
    state.remote = args[3];
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } else if (args[0] === "checkout" || args[0] === "merge") {
    const restore = args.includes("-B") || args.includes("--detach");
    if (restore && hasFailure("restore-checkout")) fail("checkout restore blocked");
    if (restore) {
      moveCheckout(args.at(-1), args.includes("-B") ? args[2] : "HEAD", "old");
    } else {
      moveCheckout(fixture.targetCommit, "main", "new");
    }
    fs.writeFileSync(stateFile, JSON.stringify(state));
    if (!restore && hasFailure(args[0])) fail("checkout transition failed");
  } else if (args[0] !== "fetch" && !args.includes("status") && !args.includes("ls-files")) {
    fail("Unexpected Git command");
  }
} else {
  fail("Unexpected executable");
}
`;

async function deployment(options: { failures: Failure[]; branch?: string; composePath?: string }) {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-fork-recovery-"));
  directories.push(deployDir);
  const bin = path.join(deployDir, "fake-bin");
  const composeFile = path.join(deployDir, options.composePath ?? DEFAULT_COMPOSE_FILE);
  const config = resolveUpdaterConfig({
    RAKAZO_DEPLOY_DIR: deployDir,
    RAKAZO_UPDATER_TOKEN: token,
    RAKAZO_COMPOSE_FILE: options.composePath,
    COMPOSE_PROJECT_NAME: "fixture-stack",
  });
  const serviceEnv = path.join(path.dirname(composeFile), "service.env");
  const compose = (revision: string) =>
    `services:\n  api:\n    image: example/app:\${RAKAZO_IMAGE_TAG}\n    env_file: ./service.env\n    command: ${revision}\n`;
  await Promise.all([
    mkdir(bin),
    mkdir(path.join(deployDir, ".git")),
    mkdir(path.dirname(composeFile), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(config.envFile, originalEnv),
    writeFile(composeFile, compose("old")),
    writeFile(serviceEnv, "REVISION=old\n"),
    writeFile(
      path.join(bin, "fixture.json"),
      JSON.stringify({
        failures: options.failures,
        targetCommit,
        composeFile,
        serviceEnv,
        oldCompose: compose("old"),
        newCompose: compose("new"),
      }),
    ),
    writeFile(
      path.join(bin, "state.json"),
      JSON.stringify({
        commit: currentCommit,
        branch: options.branch ?? "deploy",
        remote: originalRemote,
      }),
    ),
    ...["git", "docker"].map((name) =>
      writeFile(path.join(bin, name), `#!${process.execPath}\n${fakeExecutable}`, { mode: 0o700 }),
    ),
  ]);
  vi.stubEnv("PATH", bin);
  const subject = createUpdaterApp(config);
  const response = await subject.request("/apply", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ repoUrl: nextRemote, branch: "main" }),
  });
  const calls = (await readFile(path.join(bin, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Invocation);
  return {
    response,
    record: (await response.json()) as ServerUpdateRun,
    calls,
    config,
    composeFile,
    state: JSON.parse(await readFile(path.join(bin, "state.json"), "utf8")),
  };
}

describe.skipIf(process.platform === "win32")("fork recovery through fake executables", () => {
  it.each([
    { branch: "deploy", composePath: undefined },
    { branch: "HEAD", composePath: "ops/custom-compose.yml" },
  ])("restores $branch and its Compose configuration before recovery", async (options) => {
    const fixture = await deployment({ ...options, failures: ["recreate"] });
    expect(fixture.response.status).toBe(200);
    expect(fixture.record).toMatchObject({ ok: false, restart: "not-required" });
    const docker = fixture.calls.filter((call) => call.command === "docker");
    expect(docker).toHaveLength(2);
    expect(docker[0]).toMatchObject({
      commit: targetCommit,
      compose: expect.stringContaining("command: new"),
      serviceEnv: "REVISION=new\n",
    });
    expect(docker[1]).toMatchObject({
      commit: currentCommit,
      compose: expect.stringContaining("command: old"),
      serviceEnv: "REVISION=old\n",
      imageTag: oldTag,
      envFile: originalEnv,
    });
    expect(fixture.record.steps.map((step) => step.id)).toEqual([
      "remote",
      "fetch",
      "checkout",
      "merge",
      "recreate",
      "restore-checkout",
      "recover",
      "restore-remote",
    ]);
    expect(docker[1]?.args).toEqual(
      expect.arrayContaining([
        "-p",
        "fixture-stack",
        "--file",
        fixture.composeFile,
        "--pull",
        "never",
        "--no-build",
      ]),
    );
    expect(fixture.state).toEqual({
      commit: currentCommit,
      branch: options.branch,
      remote: originalRemote,
    });
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it("skips Compose recovery when restoring the checkout fails", async () => {
    const fixture = await deployment({ failures: ["restore-checkout"] });
    expect(fixture.record).toMatchObject({
      ok: false,
      restart: "manual",
      error: "Build the new images and recreate the services failed.",
    });
    expect(fixture.record.restartAdvice).toMatch(/skipped.*checkout could not be restored/);
    expect(fixture.calls.filter((call) => call.command === "docker")).toHaveLength(1);
    expect(fixture.record.steps.filter((step) => step.id === "restore-checkout")).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
    expect(fixture.record.steps.at(-1)).toMatchObject({ id: "restore-remote", ok: true });
    expect(fixture.state.remote).toBe(originalRemote);
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it("reports failed Compose recovery while keeping the restored checkout and image pin", async () => {
    const fixture = await deployment({ failures: ["recover"] });
    expect(fixture.record).toMatchObject({
      ok: false,
      restart: "manual",
      error: "Build the new images and recreate the services failed.",
    });
    expect(fixture.record.steps.find((step) => step.id === "recover")).toMatchObject({ ok: false });
    expect(fixture.calls.filter((call) => call.command === "docker")[1]).toMatchObject({
      commit: currentCommit,
      serviceEnv: "REVISION=old\n",
      imageTag: oldTag,
    });
    expect(fixture.state).toMatchObject({
      commit: currentCommit,
      branch: "deploy",
      remote: originalRemote,
    });
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it.each(["checkout", "merge"] as const)(
    "restores a partially failed %s without invoking Compose",
    async (failure) => {
      const fixture = await deployment({ failures: [failure] });
      expect(fixture.record.ok).toBe(false);
      expect(fixture.record.steps.find((step) => step.id === "restore-checkout")).toMatchObject({
        ok: true,
      });
      expect(fixture.calls.every((call) => call.command === "git")).toBe(true);
      expect(fixture.state).toEqual({
        commit: currentCommit,
        branch: "deploy",
        remote: originalRemote,
      });
      expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
    },
  );

  it("refuses a fork update if its original commit cannot be read", async () => {
    const fixture = await deployment({ failures: ["read-head"] });
    expect(fixture.response.status).toBe(400);
    expect(fixture.record.error).toMatch(/commit.*before updating/);
    expect(
      fixture.calls.some(
        (call) =>
          call.args.includes("fetch") ||
          call.args.includes("checkout") ||
          call.command === "docker",
      ),
    ).toBe(false);
    expect(await readFile(fixture.config.envFile, "utf8")).toBe(originalEnv);
  });

  it("keeps the new checkout and image pin after a successful update", async () => {
    const fixture = await deployment({ failures: [] });
    expect(fixture.record).toMatchObject({ ok: true, restart: "recreated" });
    expect(
      fixture.record.steps.some((step) => step.id.startsWith("restore") || step.id === "recover"),
    ).toBe(false);
    expect(fixture.calls.filter((call) => call.command === "docker")).toHaveLength(1);
    expect(fixture.state).toEqual({ commit: targetCommit, branch: "main", remote: nextRemote });
    expect(await readFile(fixture.config.envFile, "utf8")).toContain(
      `RAKAZO_IMAGE_TAG=local-${targetCommit}\n`,
    );
  });
});
