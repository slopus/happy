import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { ServerUpdateRun } from "@rakazo/contracts";
import type { ComposeUpdateStep } from "@rakazo/core";
import {
  chooseUpdateStrategy,
  commitImageTag,
  composeUpArgv,
  composeUpdatePlan,
  DEFAULT_UPDATE_REMOTE,
  forkImageTag,
  gitIndexContentDiffArgv,
  gitStatusArgv,
  gitUntrackedFilesArgv,
  gitWorktreeContentDiffArgv,
  hasValidBearerToken,
  IMAGE_TAG_ENV,
  imageRef,
  isGitCommit,
  normalizeUpdateBranch,
  PREVIOUS_IMAGE_TAG_ENV,
  parseGitNameOnly,
  parseGitStatusPorcelain,
  parseLsRemoteReleases,
  repoIdentity,
  resolveTrackedDirtyPaths,
  rollbackTarget,
  selectLatestRelease,
  upsertEnvAssignments,
  validateUpdateRequest,
} from "@rakazo/core";
import type { Logger } from "@rakazo/logging";
import { SERVICE_NAMES } from "@rakazo/logging";
import { createRootLogger } from "@rakazo/logging/axiom";
import { requestLogging } from "@rakazo/logging/hono";
import type { Context } from "hono";
import { Hono } from "hono";
import type { UpdaterConfig } from "./updater-logic.js";
import {
  missingSecretAssignments,
  readTagState,
  resolveUpdaterConfig,
  truncateOutput,
  UpdateRefused,
} from "./updater-logic.js";

const STEP_TIMEOUT_MS: Record<string, number> = {
  remote: 30_000,
  fetch: 180_000,
  checkout: 60_000,
  merge: 60_000,
  pull: 600_000,
  // A recreate can build, wait up to the worker's 50-minute stop_grace_period for its running
  // jobs, and then wait for the new services to become healthy.
  recreate: 5_400_000,
  recover: 5_400_000,
};
const DEFAULT_TIMEOUT_MS = 120_000;

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  /** Complete machine-readable stdout, bounded by the child process maxBuffer. */
  stdout: string;
  /** Truncated stdout/stderr for diagnostics and update step logs. */
  output: string;
}

export type UpdaterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<CommandResult>;

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
] as const;

/** Child processes get connectivity and Docker settings, never the application's secret-filled env. */
export function commandEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // Root against a checkout the deploy user owns makes git exit 128 with "detected dubious
  // ownership". It is declared here, not in Compose, because this allowlist drops the service
  // environment; it is applied after `overrides` so a caller cannot widen it.
  const deployDir = source.RAKAZO_DEPLOY_DIR?.trim();
  const gitOwnership =
    deployDir === undefined || deployDir === ""
      ? {}
      : {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: deployDir,
        };
  return {
    ...env,
    ...overrides,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    CI: "1",
    ...gitOwnership,
  };
}

function directArguments(args: readonly string[]): string[] | undefined {
  if (!Array.isArray(args)) return undefined;
  if (args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) return undefined;
  return [...args];
}

/**
 * git and docker only, each as argv with `shell: false`. A repository URL or a branch reaches
 * git as one argument and reaches Compose not at all, so there is no string a caller can craft
 * that becomes part of a command line, a build argument, or a service definition.
 */
export const runHostCommand: UpdaterCommandRunner = (command, args, options) => {
  const argv = directArguments(args);
  if ((command !== "git" && command !== "docker") || !argv) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      stdout: "",
      output: "Refusing to run an unexpected program.",
    });
  }
  return new Promise((resolve) => {
    const execOptions = {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      shell: false as const,
      env: commandEnvironment(process.env, options.env),
    };
    const done = (
      error: ExecFileException | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => {
      const output = truncateOutput(`${stdout}${stderr}`);
      if (!error) {
        resolve({ ok: true, exitCode: 0, stdout: String(stdout), output });
        return;
      }
      const exitCode = typeof error.code === "number" ? error.code : null;
      const timedOut = Boolean(error.killed);
      const signal = error.signal ? String(error.signal) : "killed";
      const reason = timedOut
        ? `Timed out after ${options.timeoutMs}ms (${signal}).`
        : error.message;
      resolve({
        ok: false,
        exitCode,
        stdout: String(stdout),
        output: output ? `${output}\n${reason}` : reason,
      });
    };
    if (command === "git") execFile("git", argv, execOptions, done);
    else execFile("docker", argv, execOptions, done);
  });
};

export function createUpdaterApp(
  config: UpdaterConfig,
  options: { run?: UpdaterCommandRunner; logger?: Logger } = {},
) {
  const app = new Hono();
  app.use("*", requestLogging(options.logger));
  const run = options.run ?? runHostCommand;
  const composeTarget = {
    composeFiles: config.composeFiles,
    envFiles: [config.envFile],
    projectName: config.projectName,
    services: config.updateServices,
  };
  let running = false;
  let planInFlight: Promise<unknown> | null = null;
  /** Survives API recreate so Settings can confirm apply after the proxy drops. */
  let lastRun: ServerUpdateRun | null = null;

  app.get("/health", (c) => c.json({ ok: true, service: "updater", image: config.image }));

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }
    if (!hasValidBearerToken(c.req.header("authorization"), config.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/state", async (c) => {
    try {
      const tags = readTagState(await readEnvFile());
      const checkout = await readCheckout();
      return c.json({
        deployDir: config.deployDir,
        composeFiles: config.composeFiles,
        image: config.image,
        imageRef: imageRef(config.image, tags.currentTag),
        running,
        lastRun,
        ...tags,
        checkout,
      });
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/plan", async (c) => {
    try {
      if (planInFlight !== null) throw new UpdateRefused("A plan is already running.");
      const request = parseRequest(await body(c.req.raw));
      const work = (async () => {
        const tags = readTagState(await readEnvFile());
        const decision = chooseUpdateStrategy(request);
        const checkout = await readCheckout();
        if (decision.strategy === "build") {
          const targetCommit = await resolveRemoteHead(request);
          return {
            strategy: decision.strategy,
            reason: decision.reason,
            currentTag: tags.currentTag,
            previousTag: tags.previousTag,
            targetTag: null as string | null,
            targetCommit,
            upToDate: upToDateForBuild(tags.currentTag, checkout.commit, targetCommit),
            checkout,
          };
        }
        const target = await resolveRelease(request.repoUrl);
        return {
          strategy: decision.strategy,
          reason: `${decision.reason} Latest stable release: ${target.releaseTag}.`,
          currentTag: tags.currentTag,
          previousTag: tags.previousTag,
          targetTag: target.imageTag,
          targetCommit: target.commit,
          upToDate: target.imageTag === tags.currentTag,
          checkout,
        };
      })().finally(() => {
        planInFlight = null;
      });
      planInFlight = work;
      return c.json(await work);
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/apply", async (c) => {
    try {
      const request = parseRequest(await body(c.req.raw));
      return c.json(await withRunLock(() => apply(request)));
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post("/rollback", async (c) => {
    try {
      return c.json(await withRunLock(rollback));
    } catch (error) {
      return refusal(c, error);
    }
  });

  return app;

  async function body(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  /** The sidecar is its own trust boundary: it re-validates rather than trusting the API's checks. */
  function parseRequest(input: unknown) {
    const source = (input ?? {}) as { repoUrl?: unknown; branch?: unknown };
    const result = validateUpdateRequest(source);
    if ("error" in result) throw new UpdateRefused(result.error);
    return result.request;
  }

  function refusal(c: Context, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, error instanceof UpdateRefused ? 400 : 500);
  }

  async function withRunLock<T>(work: () => Promise<T>): Promise<T> {
    if (running) throw new UpdateRefused("An update is already running.");
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  }

  async function readEnvFile() {
    try {
      return await readFile(config.envFile, "utf8");
    } catch (error) {
      throw new UpdateRefused(
        `Could not read the deployment environment file at ${config.envFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function writeEnvAssignments(assignments: Record<string, string>) {
    const [current, metadata] = await Promise.all([readEnvFile(), lstat(config.envFile)]);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new UpdateRefused("The deployment environment must be a regular, non-symlink file.");
    }
    const contents = upsertEnvAssignments(current, assignments);
    const temporary = `${config.envFile}.rakazo-update-${randomUUID()}`;
    let temporaryFile: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryFile = await open(temporary, "wx", 0o600);
      await temporaryFile.writeFile(contents, { encoding: "utf8" });
      const currentUid = process.getuid?.();
      const currentGid = process.getgid?.();
      if (metadata.uid !== currentUid || metadata.gid !== currentGid) {
        await temporaryFile.chown(metadata.uid, metadata.gid);
      }
      await temporaryFile.sync();
      await temporaryFile.close();
      temporaryFile = null;
      await rename(temporary, config.envFile);
    } catch (error) {
      await temporaryFile?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function git(args: string[], stepId = "read") {
    return run("git", args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[stepId] ?? DEFAULT_TIMEOUT_MS,
    });
  }

  async function hasCheckout() {
    try {
      await access(path.posix.join(config.deployDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  async function readCheckout() {
    if (!(await hasCheckout())) {
      return {
        present: false,
        commit: null,
        branch: null,
        remoteUrl: null,
        dirty: false,
        dirtyPaths: [] as string[],
      };
    }
    const [head, branch, remote, status, untracked] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["remote", "get-url", DEFAULT_UPDATE_REMOTE]),
      git(gitStatusArgv()),
      git(gitUntrackedFilesArgv()),
    ]);
    const porcelain = parseGitStatusPorcelain(status.ok ? status.stdout : "");
    let contentChanged: string[] = [];
    let contentDiffOk = true;
    if (status.ok && !porcelain.clean) {
      const [worktree, index] = await Promise.all([
        git(gitWorktreeContentDiffArgv()),
        git(gitIndexContentDiffArgv()),
      ]);
      contentDiffOk = worktree.ok && index.ok;
      contentChanged = [
        ...parseGitNameOnly(worktree.ok ? worktree.stdout : ""),
        ...parseGitNameOnly(index.ok ? index.stdout : ""),
      ];
    }
    const tracked = resolveTrackedDirtyPaths({
      porcelainChanged: porcelain.changed,
      contentChanged,
      contentDiffOk,
      untrackedPaths: parseGitNameOnly(untracked.ok ? untracked.stdout : ""),
    });
    const stateReadable = status.ok && untracked.ok;
    return {
      present: true,
      commit: head.ok ? head.stdout.trim() : null,
      branch: branch.ok ? branch.stdout.trim() : null,
      remoteUrl: remote.ok ? remote.stdout.trim() : null,
      dirty: stateReadable ? tracked.dirty : true,
      dirtyPaths: stateReadable
        ? tracked.dirtyPaths
        : ["(the updater could not verify the checkout state)"],
    };
  }

  /** `ls-remote` reads the tag list without cloning, so it works for the pull path with no checkout. */
  async function resolveRelease(repoUrl: string) {
    const listed = await run("git", ["ls-remote", "--tags", "--", repoUrl], {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS,
    });
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read releases from ${repoUrl}: ${listed.output}`);
    }
    const release = selectLatestRelease(parseLsRemoteReleases(listed.stdout));
    if (release === null) {
      throw new UpdateRefused(
        `${repoUrl} has no published release tags, so there is no image to pull.`,
      );
    }
    return {
      releaseTag: release.tag,
      commit: release.commit,
      imageTag: commitImageTag(release.commit),
    };
  }

  /** The branch head on the remote, read without fetching, so a plan does not mutate the checkout. */
  async function resolveRemoteHead(request: { repoUrl: string; branch: string }) {
    const listed = await run(
      "git",
      ["ls-remote", "--heads", "--", request.repoUrl, request.branch],
      { cwd: config.deployDir, timeoutMs: STEP_TIMEOUT_MS.fetch ?? DEFAULT_TIMEOUT_MS },
    );
    if (!listed.ok) {
      throw new UpdateRefused(`Could not read ${request.branch} from ${request.repoUrl}.`);
    }
    const commit = listed.stdout.trim().split(/\s/)[0] ?? "";
    if (!isGitCommit(commit)) {
      throw new UpdateRefused(`${request.repoUrl} has no branch called ${request.branch}.`);
    }
    return commit;
  }

  /** A fork is current only when its checkout is on the remote head *and* that build is deployed. */
  function upToDateForBuild(
    currentTag: string,
    commit: string | null,
    targetCommit: string | null,
  ) {
    if (commit === null || targetCommit === null || commit !== targetCommit) return false;
    return currentTag === forkImageTag(commit);
  }

  async function apply(request: { repoUrl: string; branch: string; official: boolean }) {
    const decision = chooseUpdateStrategy(request);
    const tags = readTagState(await readEnvFile());
    const checkout = await readCheckout();

    if (decision.strategy === "build") {
      if (!checkout.present) {
        throw new UpdateRefused(
          "Building a fork needs the deployment's git checkout, and RAKAZO_DEPLOY_DIR has no .git directory. Clone the fork to the deployment directory, or switch back to the official repository to use published images.",
        );
      }
      if (checkout.remoteUrl === null) {
        throw new UpdateRefused(
          `Building a fork needs the deployment checkout to have an ${DEFAULT_UPDATE_REMOTE} remote. Add it or clone the fork again before updating.`,
        );
      }
      if (checkout.dirty) {
        throw new UpdateRefused(
          "The deployment checkout has changed or untracked source files, or its state could not be verified. Commit, stash, clean, or fix it before updating.",
        );
      }
      if (checkout.commit === null || !isGitCommit(checkout.commit)) {
        throw new UpdateRefused(
          "The deployment checkout's current commit could not be verified. Fix it before updating.",
        );
      }
    }

    let targetTag: string | null = null;
    let targetCommit: string | null = null;
    let releaseTag: string | null = null;
    if (decision.strategy === "pull") {
      const target = await resolveRelease(request.repoUrl);
      targetTag = target.imageTag;
      targetCommit = target.commit;
      releaseTag = target.releaseTag;
      if (targetTag === tags.currentTag) {
        return rememberRun(upToDateRecord(request, targetTag, "pull", targetCommit));
      }
    } else {
      const remoteHead = await resolveRemoteHead(request);
      if (upToDateForBuild(tags.currentTag, checkout.commit, remoteHead)) {
        return rememberRun(upToDateRecord(request, tags.currentTag, "build", checkout.commit));
      }
    }

    const steps =
      decision.strategy === "pull"
        ? composeUpdatePlan({ strategy: "pull", target: composeTarget })
        : composeUpdatePlan({
            strategy: "build",
            target: composeTarget,
            repoUrl: request.repoUrl,
            branch: request.branch,
            repointRemote:
              checkout.remoteUrl === null ||
              repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl),
          });

    return rememberRun(
      await execute({
        request,
        strategy: decision.strategy,
        fromTag: tags.currentTag,
        originalPreviousTag: tags.previousTag,
        toTag: targetTag,
        fromCommit: checkout.commit,
        fromBranch: checkout.branch,
        toCommit: targetCommit,
        restoreRemoteUrl:
          decision.strategy === "build" &&
          checkout.remoteUrl !== null &&
          repoIdentity(checkout.remoteUrl) !== repoIdentity(request.repoUrl)
            ? checkout.remoteUrl
            : null,
        steps,
        restartAdvice:
          decision.strategy === "pull"
            ? `The updater deployed ${releaseTag ?? targetTag} from its full source-commit image tag and recreated the API, worker, and web containers. Migrations ran inside the new API container before it became healthy.`
            : "The updater built the fork and recreated the API, worker, and web containers. Migrations ran inside the new API container before it started serving.",
      }),
    );
  }

  async function rollback(): Promise<ServerUpdateRun> {
    const tags = readTagState(await readEnvFile());
    const decision = rollbackTarget(tags);
    if ("error" in decision) throw new UpdateRefused(decision.error);
    const checkout = await readCheckout();
    // Never re-pull a rollback tag: registry tags can move. Reuse the exact image cached when it ran.
    const steps = composeUpdatePlan({ strategy: "pull", target: composeTarget }).filter(
      (step) => step.id !== "pull",
    );
    return rememberRun(
      await execute({
        request: { repoUrl: "", branch: "" },
        strategy: "pull",
        fromTag: tags.currentTag,
        originalPreviousTag: tags.previousTag,
        toTag: decision.tag,
        fromCommit: checkout.commit,
        fromBranch: checkout.branch,
        toCommit: null,
        restoreRemoteUrl: null,
        steps,
        restartAdvice: `Rolled back to ${decision.tag}. Database migrations are not reversed: if the newer version added a migration, roll forward again or restore a database backup.`,
      }),
    );
  }

  function rememberRun(record: ServerUpdateRun): ServerUpdateRun {
    lastRun = record;
    return record;
  }

  /**
   * Pins the tag, runs the plan, and un-pins it again if the run failed, so a failed update never
   * leaves the deployment's `.env` pointing at an image the host does not have.
   */
  async function execute(input: {
    request: { repoUrl: string; branch: string };
    strategy: "pull" | "build";
    fromTag: string;
    originalPreviousTag: string | null;
    toTag: string | null;
    fromCommit: string | null;
    fromBranch: string | null;
    toCommit: string | null;
    restoreRemoteUrl: string | null;
    steps: ComposeUpdateStep[];
    restartAdvice: string;
  }): Promise<ServerUpdateRun> {
    const record: ServerUpdateRun = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      fromCommit: input.fromCommit,
      toCommit: input.toCommit,
      fromTag: input.fromTag,
      toTag: input.toTag,
      strategy: input.strategy,
      repoUrl: input.request.repoUrl,
      branch: input.request.branch,
      restart: "not-required",
      restartAdvice: input.restartAdvice,
      error: null,
      steps: [],
    };
    const revertAssignments = {
      [IMAGE_TAG_ENV]: input.fromTag,
      [PREVIOUS_IMAGE_TAG_ENV]: input.originalPreviousTag ?? input.fromTag,
    };
    // A failed Git command can still change files. Restore once before Compose recovery, or in
    // finally for failures that never reached Compose.
    let checkoutNeedsRestore = false;
    async function restoreCheckout() {
      if (!checkoutNeedsRestore) return true;
      checkoutNeedsRestore = false;
      if (input.fromCommit === null || !isGitCommit(input.fromCommit)) return false;
      return runStep(
        record,
        {
          id: "restore-checkout",
          label: "Restore the previous checkout",
          command: "git",
          args: restoreCheckoutArgv(input.fromBranch, input.fromCommit),
        },
        undefined,
        false,
      );
    }
    try {
      const gitSteps = input.steps.filter((step) => step.command === "git");
      const composeSteps = input.steps.filter((step) => step.command !== "git");

      for (const step of gitSteps) {
        if (step.id === "checkout" || step.id === "merge") checkoutNeedsRestore = true;
        if (!(await runStep(record, step))) return record;
      }

      // The build path only knows its tag after the fast-forward, because the tag is the commit.
      let toTag = input.toTag;
      if (input.strategy === "build") {
        const head = await git(["rev-parse", "HEAD"]);
        const commit = head.ok ? head.stdout.trim() : "";
        if (!isGitCommit(commit)) {
          record.error = "Could not read the commit to build.";
          return record;
        }
        record.toCommit = commit;
        toTag = forkImageTag(commit);
        record.toTag = toTag;
      }
      if (toTag === null) {
        record.error = "Could not resolve a target image tag.";
        return record;
      }

      try {
        await writeEnvAssignments({
          ...missingSecretAssignments(await readEnvFile()),
          [IMAGE_TAG_ENV]: toTag,
          [PREVIOUS_IMAGE_TAG_ENV]: input.fromTag,
        });
      } catch {
        record.error = "Could not persist the target image tag in the deployment environment.";
        record.restartAdvice = `${record.error} Nothing was recreated.`;
        return record;
      }
      const composeEnv: Record<string, string> = { [IMAGE_TAG_ENV]: toTag };
      if (record.toCommit !== null) composeEnv.GIT_SHA = record.toCommit;

      for (const step of composeSteps) {
        if (!(await runStep(record, step, composeEnv))) {
          const primaryError = record.error ?? `${step.label} failed.`;
          // The failed revision may have changed Compose or files it references. The old image
          // must be recreated from the old checkout, using the same configured Compose target.
          const checkoutRestored = await restoreCheckout();
          const envRestored = await writeEnvAssignments(revertAssignments).then(
            () => true,
            () => false,
          );
          if (step.id === "recreate") {
            const previous = composeUpArgv(composeTarget);
            const recovered =
              checkoutRestored &&
              (await runStep(
                record,
                {
                  id: "recover",
                  label: `Restore the previously running ${input.fromTag} image`,
                  command: previous.command,
                  args: previous.args,
                },
                { [IMAGE_TAG_ENV]: input.fromTag },
                false,
              ));
            record.restart = recovered ? "not-required" : "manual";
            record.restartAdvice = recovered
              ? `${primaryError} The updater restored the previously running ${input.fromTag} image${envRestored ? " and its environment pin" : ", but could not restore the environment pin"}. Read the failed step output before retrying.`
              : `${primaryError} Automatic recovery to ${input.fromTag} ${checkoutRestored ? "also failed" : "was skipped because the previous checkout could not be restored"}${envRestored ? "" : ", and the environment pin could not be restored"}. The runtime may contain a mix of versions; use the recorded commands to recover it manually.`;
          } else {
            record.restartAdvice = `${primaryError} No service was recreated${envRestored ? ", and the prior environment pin was restored" : ", but the prior environment pin could not be restored"}. Read the failed step output before retrying.`;
          }
          record.error = primaryError;
          return record;
        }
      }
      record.ok = true;
      record.restart = "recreated";
      return record;
    } finally {
      if (!record.ok && checkoutNeedsRestore && !(await restoreCheckout())) {
        record.restartAdvice = `${record.restartAdvice} The previous checkout also could not be restored; fix it before retrying.`;
      }
      if (!record.ok && input.restoreRemoteUrl !== null) {
        const restored = await runStep(
          record,
          {
            id: "restore-remote",
            label: `Restore the previous ${DEFAULT_UPDATE_REMOTE} remote`,
            command: "git",
            args: ["remote", "set-url", DEFAULT_UPDATE_REMOTE, input.restoreRemoteUrl],
          },
          undefined,
          false,
        );
        if (!restored) {
          record.restartAdvice = `${record.restartAdvice} The previous Git remote also could not be restored; fix it before retrying.`;
        }
      }
      record.finishedAt = new Date().toISOString();
    }
  }

  async function runStep(
    record: ServerUpdateRun,
    step: ComposeUpdateStep,
    env?: Record<string, string>,
    setError = true,
  ) {
    const result = await run(step.command, step.args, {
      cwd: config.deployDir,
      timeoutMs: STEP_TIMEOUT_MS[step.id] ?? DEFAULT_TIMEOUT_MS,
      env: step.command === "docker" ? { COMPOSE_PROJECT_NAME: config.projectName, ...env } : env,
    });
    record.steps.push({
      id: step.id,
      label: step.label,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
    });
    if (!result.ok && setError) record.error = `${step.label} failed.`;
    return result.ok;
  }

  function upToDateRecord(
    request: { repoUrl: string; branch: string },
    tag: string,
    strategy: "pull" | "build",
    commit: string | null,
  ): ServerUpdateRun {
    const now = new Date().toISOString();
    return {
      startedAt: now,
      finishedAt: now,
      ok: true,
      fromCommit: commit,
      toCommit: commit,
      fromTag: tag,
      toTag: tag,
      strategy,
      repoUrl: request.repoUrl,
      branch: request.branch,
      restart: "not-required",
      restartAdvice: `Already running ${tag}; nothing was changed.`,
      error: null,
      steps: [],
    };
  }
}

async function startUpdater() {
  const logger = await createRootLogger(SERVICE_NAMES.updater);
  const config = resolveUpdaterConfig(process.env);
  const app = createUpdaterApp(config, { logger });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    logger.info("updater listening", {
      "http.host": config.host,
      "http.port": config.port,
      "updater.deploy_dir": config.deployDir,
    });
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await closeListeningServer(server);
    await logger.flush({ timeoutMs: 2_000 });
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return server;
}

function closeListeningServer(server: {
  close(callback?: (err?: Error) => void): void;
  closeIdleConnections?: () => void;
}): Promise<void> {
  server.closeIdleConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Put the worktree back on the pre-update branch and commit. `checkout -B` restores a named
 * branch; detached checkouts must use `--detach` so recovery cannot attach to the update target
 * branch and move that tip to the old commit.
 */
export function restoreCheckoutArgv(fromBranch: string | null, fromCommit: string): string[] {
  if (!isGitCommit(fromCommit)) throw new Error("Checkout restore needs a resolved commit.");
  if (fromBranch !== null && fromBranch !== "HEAD") {
    const branch = normalizeUpdateBranch(fromBranch);
    if (!("error" in branch)) return ["checkout", "-B", branch.branch, fromCommit];
  }
  return ["checkout", "--detach", fromCommit];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // A rejected startup keeps Node's default: the error is printed and the process exits.
  void startUpdater();
}
