import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdaterCommandRunner } from "./index.js";
import {
  commandEnvironment,
  createUpdaterApp,
  restoreCheckoutArgv,
  runHostCommand,
} from "./index.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const token = "fake-review-updater-token-000000000000";
const app = createUpdaterApp(
  resolveUpdaterConfig({
    RAKAZO_DEPLOY_DIR: "/rakazo-updater-tests-no-such-directory",
    RAKAZO_UPDATER_TOKEN: token,
  }),
);
const authorized = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const currentCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function deployment(env = "RAKAZO_IMAGE_TAG=v1.0.0\nRAKAZO_IMAGE_TAG_PREVIOUS=v0.9.0\n") {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-updater-test-"));
  temporaryDirectories.push(deployDir);
  await writeFile(path.join(deployDir, ".env"), env);
  return {
    deployDir,
    config: resolveUpdaterConfig({ RAKAZO_DEPLOY_DIR: deployDir, RAKAZO_UPDATER_TOKEN: token }),
  };
}

function ok(output = "") {
  return { ok: true, exitCode: 0, stdout: output, output };
}

function failed(output: string) {
  return { ok: false, exitCode: 1, stdout: "", output };
}

function request(app: ReturnType<typeof createUpdaterApp>, pathname: string, body?: unknown) {
  return app.request(pathname, {
    method: "POST",
    headers: authorized,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("updater HTTP surface", () => {
  it("answers health without credentials, for the compose healthcheck", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "updater" });
  });

  it("rejects every privileged route without the shared token", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/state"],
      ["POST", "/plan"],
      ["POST", "/apply"],
      ["POST", "/rollback"],
    ];
    for (const [method, pathname] of routes) {
      const response = await app.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects a wrong or malformed token", async () => {
    for (const authorization of [`Bearer ${"x".repeat(token.length)}`, token, "Basic abc"]) {
      const response = await app.request("/state", { headers: { authorization } });
      expect(response.status).toBe(401);
    }
  });

  it("re-validates the repository URL at its own boundary", async () => {
    const cases = [
      "http://github.com/a/b",
      "file:///etc/passwd",
      "https://user:pw@github.com/a/b",
      "--upload-pack=id",
      "https://github.com/a/b?x=1",
    ];
    for (const repoUrl of cases) {
      const response = await app.request("/apply", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({ repoUrl, branch: "main" }),
      });
      expect(response.status, repoUrl).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error, repoUrl).toBeTruthy();
    }
  });

  it("re-validates the branch at its own boundary", async () => {
    const response = await app.request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/elie222/rakazo", branch: "--exec=id" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a fork build when the deployment has no checkout to build from", async () => {
    const fixture = await deployment();
    const response = await createUpdaterApp(fixture.config).request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/someone/rakazo", branch: "main" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/no \.git directory/);
  });

  it("refuses a rollback when no previous tag was recorded", async () => {
    const fixture = await deployment("RAKAZO_IMAGE_TAG=v1.0.0\n");
    const response = await createUpdaterApp(fixture.config).request("/rollback", {
      method: "POST",
      headers: authorized,
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/nothing to roll back/);
  });

  it("reports the deployment it manages without touching Docker", async () => {
    const fixture = await deployment();
    const response = await createUpdaterApp(fixture.config).request("/state", {
      headers: authorized,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployDir: fixture.deployDir,
      currentTag: "v1.0.0",
      previousTag: "v0.9.0",
      checkout: { present: false },
    });
  });

  it("fails closed when the deployment environment cannot be read", async () => {
    const response = await app.request("/state", { headers: authorized });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/\.env/) });
  });

  it("refuses a failed plan without leaving a rejection that could stop the process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const subject = createUpdaterApp(
        resolveUpdaterConfig({
          RAKAZO_DEPLOY_DIR: "/rakazo-updater-tests-no-such-directory",
          RAKAZO_UPDATER_TOKEN: token,
        }),
      );
      const input = { repoUrl: "https://github.com/elie222/rakazo", branch: "main" };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request(subject, "/plan", input);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringMatching(/\.env/),
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("updater orchestration", () => {
  it("serializes updates before their asynchronous preflight can race", async () => {
    const fixture = await deployment();
    let releaseGate: ((result: ReturnType<typeof ok>) => void) | undefined;
    const pendingRelease = new Promise<ReturnType<typeof ok>>((resolve) => {
      releaseGate = resolve;
    });
    let reachedRemote!: () => void;
    const atRemote = new Promise<void>((resolve) => {
      reachedRemote = resolve;
    });
    const run: UpdaterCommandRunner = async (command, args) => {
      if (command === "git" && args.includes("ls-remote")) {
        reachedRemote();
        return pendingRelease;
      }
      return ok();
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const input = { repoUrl: "https://github.com/elie222/rakazo", branch: "main" };
    const first = request(subject, "/apply", input);
    await atRemote;
    const second = await request(subject, "/apply", input);
    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toEqual({ error: "An update is already running." });
    releaseGate?.(ok(`${targetCommit}\trefs/tags/v1.1.0\n`));
    expect((await first).status).toBe(200);
  });

  it("restores the previous remote when a fork update fails after repointing it", async () => {
    const fixture = await deployment();
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const previousRemote = "https://github.com/example/previous-fork";
    const nextRemote = "https://github.com/example/next-fork";
    const run: UpdaterCommandRunner = async (command, args) => {
      calls.push({ command, args });
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok(previousRemote);
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (args[0] === "fetch") return failed("registry unavailable");
      return ok();
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", { repoUrl: nextRemote, branch: "main" });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual(["remote", "fetch", "restore-remote"]);
    expect(
      calls.filter(({ args }) => args.slice(0, 3).join(" ") === "remote set-url origin"),
    ).toEqual([
      { command: "git", args: ["remote", "set-url", "origin", nextRemote] },
      { command: "git", args: ["remote", "set-url", "origin", previousRemote] },
    ]);
  });

  it("restores the prior image after a recreate fails health checks", async () => {
    const fixture = await deployment();
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    let upCalls = 0;
    const run: UpdaterCommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.1.0\n`);
      if (args.includes("pull")) return ok("pulled");
      upCalls += 1;
      return upCalls === 1 ? failed("api did not become healthy") : ok("restored");
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", {
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record).toMatchObject({ ok: false, restart: "not-required" });
    expect(record.steps.map((step) => step.id)).toEqual(["pull", "recreate", "recover"]);
    expect(record.restartAdvice).toMatch(/restored the previously running v1\.0\.0 image/);
    const composeUp = calls.filter(({ args }) => args.includes("up"));
    expect(composeUp).toHaveLength(2);
    expect(composeUp[0]?.args).toEqual(expect.arrayContaining(["--wait", "--pull", "never"]));
    expect(composeUp[0]?.args).toContain("--no-build");
    expect(composeUp[1]?.args).toContain("--no-build");
    expect(composeUp[0]?.env?.RAKAZO_IMAGE_TAG).toBe(`sha-${targetCommit}`);
    expect(composeUp[1]?.env?.RAKAZO_IMAGE_TAG).toBe("v1.0.0");
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      "RAKAZO_IMAGE_TAG=v1.0.0",
    );

    const state = await subject.request("/state", { method: "GET", headers: authorized });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      running: false,
      lastRun: { ok: false, fromTag: "v1.0.0", toTag: `sha-${targetCommit}` },
    });
  });

  it("resets a fork checkout when recreate fails after the fast-forward", async () => {
    const fixture = await deployment("RAKAZO_IMAGE_TAG=local\n");
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: string[][] = [];
    let upCalls = 0;
    const run: UpdaterCommandRunner = async (command, args) => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") {
        // After the merge step the checkout is on the target; before that it is still current.
        const merged = calls.some((seen) => seen[0] === "merge");
        return ok(merged ? targetCommit : currentCommit);
      }
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (command === "docker" && args.includes("up")) {
        upCalls += 1;
        return upCalls === 1 ? failed("api did not become healthy") : ok("restored");
      }
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "recreate",
      "restore-checkout",
      "recover",
    ]);
    expect(calls).toContainEqual(["checkout", "-B", "main", currentCommit]);
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      "RAKAZO_IMAGE_TAG=local",
    );
  });

  it("restores the prior branch when merge fails after checkout switches", async () => {
    const fixture = await deployment("RAKAZO_IMAGE_TAG=local\n");
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("deploy");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (args[0] === "merge") return failed("not a fast-forward");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "restore-checkout",
    ]);
    expect(calls).toContainEqual(["checkout", "-B", "deploy", currentCommit]);
  });

  it("rolls back from the cached image without trusting the registry tag again", async () => {
    const fixture = await deployment();
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/rollback");
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(true);
    expect(calls.some((args) => args.includes("pull"))).toBe(false);
    expect(calls.find((args) => args.includes("up"))).toEqual(
      expect.arrayContaining(["--pull", "never"]),
    );
  });

  it("preserves the environment owner and surrounding values with mode 0600", async () => {
    const fixture = await deployment("FAKE_SETTING=kept\nRAKAZO_IMAGE_TAG=v1.0.0\n");
    const envFile = path.join(fixture.deployDir, ".env");
    await chmod(envFile, 0o644);
    const before = await lstat(envFile);
    const run: UpdaterCommandRunner = async (command) =>
      command === "git" ? ok(`${targetCommit}\trefs/tags/v1.1.0\n`) : ok();
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const after = await lstat(envFile);
    expect({ uid: after.uid, gid: after.gid, mode: after.mode & 0o777 }).toEqual({
      uid: before.uid,
      gid: before.gid,
      mode: 0o600,
    });
    expect(await readFile(envFile, "utf8")).toMatch(/FAKE_SETTING=kept/);
  });

  it("adds a missing app database password before recreating, so newer Compose files start", async () => {
    const fixture = await deployment("POSTGRES_PASSWORD=kept\nRAKAZO_IMAGE_TAG=v1.0.0\n");
    const envFile = path.join(fixture.deployDir, ".env");
    let envAtRecreate = "";
    const run: UpdaterCommandRunner = async (command, args) => {
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.1.0\n`);
      if (args.includes("up")) envAtRecreate = await readFile(envFile, "utf8");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(envAtRecreate).toMatch(/^POSTGRES_APP_PASSWORD=[0-9a-f]{32}$/m);
    expect(envAtRecreate).toMatch(/^POSTGRES_PASSWORD=kept$/m);
  });

  it("refuses to replace a symlinked deployment environment", async () => {
    const fixture = await deployment();
    const envFile = path.join(fixture.deployDir, ".env");
    const target = path.join(fixture.deployDir, "fake-target");
    await writeFile(target, "RAKAZO_IMAGE_TAG=v1.0.0\n");
    await rm(envFile);
    await symlink(target, envFile);
    const run: UpdaterCommandRunner = async (command) =>
      command === "git" ? ok(`${targetCommit}\trefs/tags/v1.1.0\n`) : ok();
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/persist/),
    });
    expect(await readFile(target, "utf8")).toBe("RAKAZO_IMAGE_TAG=v1.0.0\n");
  });

  it("fails closed when it cannot verify checkout cleanliness", async () => {
    const fixture = await deployment();
    await mkdir(path.join(fixture.deployDir, ".git"));
    const run: UpdaterCommandRunner = async (_command, args) => {
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status")) return failed("cannot read index");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/verified/),
    });
  });
});

describe("child process environment", () => {
  it("declares the deployment directory safe so git works on a non-root checkout", () => {
    // The child environment is rebuilt from an allowlist, so GIT_CONFIG_* set on the Compose
    // service never reaches git. Without these three, every git call exits 128 with "detected
    // dubious ownership" on the layout docs/self-host-production.md recommends.
    const env = commandEnvironment({ RAKAZO_DEPLOY_DIR: "/srv/rakazo" });
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/srv/rakazo");
  });

  it("keeps the exemption scoped to the deployment directory, whoever calls it", () => {
    const env = commandEnvironment(
      { RAKAZO_DEPLOY_DIR: "/opt/rakazo" },
      { GIT_CONFIG_VALUE_0: "*", GIT_CONFIG_COUNT: "9" },
    );
    expect(env.GIT_CONFIG_VALUE_0).toBe("/opt/rakazo");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });

  it("sets no git ownership exemption when no deployment directory is known", () => {
    const env = commandEnvironment({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("passes operational settings and explicit overrides without leaking application secrets", () => {
    const env = commandEnvironment(
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.invalid",
        BETTER_AUTH_SECRET: "fake-secret-that-must-not-leak",
        DATABASE_URL: "postgres://fake.invalid/db",
        AXIOM_TOKEN: "fake-axiom-token",
        LOG_LEVEL: "debug",
      },
      { RAKAZO_IMAGE_TAG: "sha-123" },
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.invalid",
      RAKAZO_IMAGE_TAG: "sha-123",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AXIOM_TOKEN).toBeUndefined();
    expect(env.LOG_LEVEL).toBeUndefined();
  });

  it("restores detached checkouts without attaching to a branch tip", () => {
    expect(restoreCheckoutArgv("HEAD", currentCommit)).toEqual([
      "checkout",
      "--detach",
      currentCommit,
    ]);
    expect(restoreCheckoutArgv(null, currentCommit)).toEqual([
      "checkout",
      "--detach",
      currentCommit,
    ]);
    expect(restoreCheckoutArgv("deploy", currentCommit)).toEqual([
      "checkout",
      "-B",
      "deploy",
      currentCommit,
    ]);
  });
});

describe("runHostCommand", () => {
  it("passes shell syntax to git as one argument and refuses any other program", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rakazo-host-command-"));
    temporaryDirectories.push(dir);
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const out = path.join(dir, "argv.json");
    const git = path.join(bin, "git");
    await writeFile(
      git,
      `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await chmod(git, 0o755);
    const payload = "a; touch pwned $(id)";
    const result = await runHostCommand("git", ["status", payload], {
      cwd: dir,
      timeoutMs: 5_000,
      env: { PATH: bin, ARGV_OUT: out },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(["status", payload]);

    const marker = path.join(dir, "pwned");
    const bash = path.join(bin, "bash");
    await writeFile(
      bash,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    await chmod(bash, 0o755);
    const refused = await runHostCommand("bash", ["-c", payload], {
      cwd: dir,
      timeoutMs: 1_000,
      env: { PATH: bin },
    });
    expect(refused).toEqual({
      ok: false,
      exitCode: null,
      stdout: "",
      output: "Refusing to run an unexpected program.",
    });
    await expect(readFile(marker, "utf8")).rejects.toThrow();

    const nul = await runHostCommand("docker", ["a\0b"], { cwd: dir, timeoutMs: 1_000 });
    expect(nul).toEqual({
      ok: false,
      exitCode: null,
      stdout: "",
      output: "Refusing to run an unexpected program.",
    });
  });
});
