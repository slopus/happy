/**
 * Managed installs for npm-published stdio MCP servers.
 *
 * `npx -y <package>` downloads the package on every cold start, inside the MCP startup
 * timeout. A slow registry turns that into a timeout that kills npx mid-download, and the
 * interrupted install leaves a half-populated `~/.npm/_npx` entry without the bin, so every
 * later launch fails with "Connection closed". Instead the connector installs the package
 * once into its own directory, with its own (longer) timeout, publishes it atomically, and
 * launches the installed bin directly.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

export const DEFAULT_MCP_INSTALL_TIMEOUT_MS = 180_000;
const READY_MARKER = ".ready";
const LOCK_POLL_MS = 250;
/** How long past the holder's install timeout a lock is still honoured. */
const LOCK_GRACE_MS = 30_000;
const OUTPUT_TAIL_CHARS = 2_000;

/** An `npx` launch reduced to the registry package it runs and the bin's own arguments. */
export type NpxLaunch = {
  /** Registry spec: `name`, `name@version`, `name@tag` or `name@range`. */
  spec: string;
  /** Bin named with `-p <spec> <bin>`; otherwise npx's default bin selection applies. */
  binName?: string;
  binArgs: string[];
};

/**
 * A bin installed by {@link ensureMcpPackage}. Only values this module issued are accepted
 * as a stdio launch target, so a path that came from configuration cannot bypass the
 * command allowlist.
 */
export type InstalledMcpBin = { readonly binPath: string };

const issued = new WeakSet<InstalledMcpBin>();

/** True for a bin issued by {@link ensureMcpPackage} in this process. */
export function isInstalledMcpBin(value: unknown): value is InstalledMcpBin {
  return typeof value === "object" && value !== null && issued.has(value as InstalledMcpBin);
}

const NAME_PART = "[A-Za-z0-9][A-Za-z0-9._~-]*";
const PACKAGE_NAME = new RegExp(`^(?:@${NAME_PART}/)?${NAME_PART}$`);
// Versions, dist-tags and ranges without spaces. Paths, URLs, git and alias specs all need
// a character outside this set (`/`, `:`, `#`).
const VERSION_SELECTOR = /^[A-Za-z0-9.^~<>=*|+_-]+$/;
const TARBALL_NAME = /\.(?:tgz|tar|tar\.gz)$/i;
const BIN_NAME = /^[A-Za-z0-9._-]+$/;

/** Split a registry spec into its package name, or undefined when it is not one. */
export function registryPackageName(spec: string): string | undefined {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  const name = at === -1 ? spec : spec.slice(0, at);
  const selector = at === -1 ? undefined : spec.slice(at + 1);
  if (!PACKAGE_NAME.test(name) || TARBALL_NAME.test(name) || name.length > 214) return undefined;
  if (selector !== undefined && !VERSION_SELECTOR.test(selector)) return undefined;
  return name;
}

export function isNpxCommand(command: string): boolean {
  return /^npx(?:\.cmd|\.exe)?$/i.test(basename(command.trim()));
}

// Package managers and runners that fetch and run packages Rakazo can't vet. Whole commands,
// not subcommands: global flags (`pnpm -C dir dlx`) and auto-installs (`bun run`, `uv run
// --with`) make subcommand checks easy to slip past.
const PACKAGE_RUNNER =
  /^(?:npm|pnpm|pnpx|yarn|yarnpkg|corepack|bun|bunx|deno|uv|uvx|pipx)(?:\.cmd|\.exe|\.ps1)?$/i;

/** Whether `command` is a package runner other than npx, which stdio launches never use. */
export function isPackageRunnerCommand(command: string): boolean {
  return PACKAGE_RUNNER.test(basename(command.trim()));
}

/**
 * Recognise `npx [-y|--yes] <spec> [args...]` and `npx [-y] -p|--package <spec> <bin> [args...]`
 * (with optional `--` separators). Anything else, including unknown npx flags and specs that
 * are not plain registry packages (paths, git or tarball URLs, aliases), returns undefined and
 * must not be launched.
 */
export function parseNpxLaunch(command: string, args: readonly string[]): NpxLaunch | undefined {
  if (!isNpxCommand(command)) return undefined;
  let spec: string | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-y" || arg === "--yes") continue;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "-p" || arg === "--package" || arg.startsWith("--package=")) {
      // Several packages make the bin choice ambiguous; leave that to npx.
      if (spec !== undefined) return undefined;
      spec = arg.startsWith("--package=") ? arg.slice("--package=".length) : args[++index];
      if (!spec) return undefined;
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    break;
  }
  const rest = args.slice(index);
  if (spec !== undefined) {
    const [binName, ...binArgs] = rest;
    if (!binName || !BIN_NAME.test(binName) || !registryPackageName(spec)) return undefined;
    return { spec, binName, binArgs };
  }
  const [first, ...binArgs] = rest;
  if (!first || !registryPackageName(first)) return undefined;
  return { spec: first, binArgs };
}

/**
 * Where managed packages live: `MCP_PACKAGES_DIR`, else `<DATA_DIR or /data>/mcp-packages`
 * when that volume is writable (the API and worker share it, so one install serves both),
 * else a directory under the OS temp dir.
 */
export function defaultMcpPackagesRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MCP_PACKAGES_DIR?.trim()) return resolve(env.MCP_PACKAGES_DIR.trim());
  const dataDir = resolve(env.DATA_DIR?.trim() || "/data");
  try {
    accessSync(dataDir, constants.W_OK);
    return join(dataDir, "mcp-packages");
  } catch {
    return join(tmpdir(), "rakazo-mcp-packages");
  }
}

export type EnsureMcpPackageOptions = {
  /** Packages directory; defaults to {@link defaultMcpPackagesRoot}. */
  root?: string;
  /** Bin to launch (from `npx -p <spec> <bin>`). */
  binName?: string;
  timeoutMs?: number;
  /** Stops this caller waiting. A started install keeps going, so the next launch finds it. */
  signal?: AbortSignal;
  /** Extra environment for npm, such as the server's `NPM_CONFIG_*` settings. */
  env?: Record<string, string>;
  /** Called once when the package is not installed yet and this call has to wait for it. */
  onInstall?: () => void;
  onSettled?: () => Promise<void>;
  /** npm executable. Tests point this at a stub. */
  npmCommand?: string;
  /** What npm installs instead of `spec` (tests install a local tarball). */
  installTarget?: string;
};

const inFlight = new Map<string, Promise<void>>();

/**
 * The install directory for `spec` under `root`. Native addons are built per Node ABI, so
 * the Node major version is part of the key.
 */
export function mcpPackageDir(
  spec: string,
  root: string,
  env: Record<string, string> = {},
): string {
  const nodeMajor = process.versions.node.split(".")[0];
  const key = createHash("sha256")
    .update(
      `${spec}\0node${nodeMajor}\0${JSON.stringify(Object.entries(npmSettings(env)).sort(([a], [b]) => a.localeCompare(b)))}`,
    )
    .digest("hex")
    .slice(0, 32);
  return join(resolve(root), key);
}

/**
 * Install `spec` once under `root/<hash of spec and Node major>` and return its bin. A
 * directory only becomes visible at its final path, complete and marked ready, through one
 * atomic rename; concurrent callers share one install in-process and one lock across
 * processes on the same volume.
 */
export async function ensureMcpPackage(
  spec: string,
  options: EnsureMcpPackageOptions = {},
): Promise<InstalledMcpBin> {
  const name = registryPackageName(spec);
  if (!name) throw new Error(`Not an npm registry package: ${spec}`);
  const root = resolve(options.root ?? defaultMcpPackagesRoot());
  const dir = mcpPackageDir(spec, root, options.env);
  const key = basename(dir);
  if (!(await isReady(dir))) {
    options.onInstall?.();
    let pending = inFlight.get(dir);
    if (!pending) {
      pending = installLocked({
        root,
        key,
        dir,
        name,
        target: options.installTarget ?? spec,
        timeoutMs: options.timeoutMs ?? DEFAULT_MCP_INSTALL_TIMEOUT_MS,
        env: options.env ?? {},
        npmCommand: options.npmCommand ?? "npm",
      }).finally(() => inFlight.delete(dir));
      inFlight.set(dir, pending);
    }
    void pending
      .then(
        () => options.onSettled?.(),
        () => options.onSettled?.(),
      )
      .catch(() => undefined);
    await abortable(pending, options.signal);
  }
  const bin: InstalledMcpBin = Object.freeze({
    binPath: await resolveBin(dir, name, options.binName),
  });
  issued.add(bin);
  return bin;
}

async function isReady(dir: string): Promise<boolean> {
  try {
    await access(join(dir, READY_MARKER));
    return true;
  } catch {
    return false;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  void promise.catch(() => undefined);
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type InstallPlan = {
  root: string;
  key: string;
  dir: string;
  name: string;
  target: string;
  timeoutMs: number;
  env: Record<string, string>;
  npmCommand: string;
};

async function installLocked(plan: InstallPlan): Promise<void> {
  await mkdir(plan.root, { recursive: true });
  const lock = `${plan.dir}.lock`;
  let token: string | undefined;
  while (!token) {
    if (await isReady(plan.dir)) return;
    token = await tryLock(lock, plan.timeoutMs);
    if (!token) {
      await breakStaleLock(lock, plan.timeoutMs);
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  }
  try {
    if (await isReady(plan.dir)) return;
    // Holding the lock, anything left for this key is debris from an interrupted install.
    await rm(plan.dir, { recursive: true, force: true });
    for (const entry of await readdir(plan.root)) {
      if (entry.startsWith(`.tmp-${plan.key}-`))
        await rm(join(plan.root, entry), { recursive: true, force: true });
    }
    const staging = await mkdtemp(join(plan.root, `.tmp-${plan.key}-`));
    try {
      // Anchor npm at the staging dir so it never walks up to an unrelated project.
      await writeFile(join(staging, "package.json"), '{"private":true}\n');
      await runNpmInstall(plan, staging);
      await makeBinsExecutable(staging, plan.name);
      await writeFile(join(staging, READY_MARKER), `${JSON.stringify({ target: plan.target })}\n`);
      await rename(staging, plan.dir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      // A holder whose lock expired mid-install may still have published the same package.
      if (await isReady(plan.dir)) return;
      throw error;
    }
  } finally {
    await releaseLock(lock, token);
  }
}

type LockOwner = { token: string; pid: number; host: string; expiresAt: number };

/** Atomic `mkdir` lock; the owner file says when a crashed holder's lock may be taken. */
async function tryLock(lock: string, timeoutMs: number): Promise<string | undefined> {
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    expiresAt: Date.now() + timeoutMs + LOCK_GRACE_MS,
  };
  await writeFile(join(lock, "owner"), JSON.stringify(owner));
  return owner.token;
}

async function readOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    return JSON.parse(await readFile(join(lock, "owner"), "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

async function breakStaleLock(lock: string, timeoutMs: number): Promise<void> {
  const inspected = await stat(lock).catch(() => undefined);
  if (!inspected) return;
  const owner = await readOwner(lock);
  let stale: boolean;
  if (owner) {
    stale =
      Date.now() > owner.expiresAt ||
      (owner.host === hostname() && owner.pid !== process.pid && !processAlive(owner.pid));
  } else {
    // The holder died between mkdir and writing its owner file (or the lock just vanished).
    const created = await stat(lock).then(
      (info) => info.mtimeMs,
      () => undefined,
    );
    stale = created !== undefined && Date.now() > created + timeoutMs + LOCK_GRACE_MS;
  }
  if (!stale) return;
  // Quarantine atomically, then verify that we moved the lock we inspected.
  const aside = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, aside);
  } catch {
    return;
  }
  const movedOwner = await readOwner(aside);
  const moved = await stat(aside);
  if (
    moved.ino !== inspected.ino ||
    moved.dev !== inspected.dev ||
    movedOwner?.token !== owner?.token
  ) {
    // A different waiter already replaced the expired owner. Never delete its lock.
    // If another owner has acquired the path meanwhile, keep the quarantine intact.
    await rename(aside, lock).catch(() => undefined);
    return;
  }
  await rm(aside, { recursive: true, force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function releaseLock(lock: string, token: string): Promise<void> {
  // A lock taken over after this install overran its timeout belongs to someone else now.
  if ((await readOwner(lock))?.token !== token) return;
  await rm(lock, { recursive: true, force: true });
}

/** npm and proxy settings from the host, the server's own env on top. */
export function npmSettings(extra: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(extra).filter(([key]) =>
      /^(?:npm_config_|https?_proxy$|no_proxy$|node_extra_ca_certs$)/i.test(key),
    ),
  );
}

function installEnvironment(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      /^npm_config_/i.test(key) ||
      /^(?:https?_proxy|no_proxy)$/i.test(key) ||
      key === "NODE_EXTRA_CA_CERTS"
    )
      env[key] = value;
  }
  for (const [key, value] of Object.entries(npmSettings(extra))) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  return env;
}

function runNpmInstall(plan: InstallPlan, prefix: string): Promise<void> {
  const args = [
    "install",
    "--ignore-scripts",
    "--prefix",
    prefix,
    "--no-save",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--loglevel=warn",
    plan.target,
  ];
  return new Promise<void>((resolvePromise, reject) => {
    let output = "";
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 2);
    };
    let child: ChildProcess;
    try {
      child = spawn(plan.npmCommand, args, {
        env: installEnvironment(plan.env),
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so a timeout also stops everything npm started.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, plan.timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run npm to install ${plan.target}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!timedOut && code === 0) {
        resolvePromise();
        return;
      }
      const tail = output.trim().slice(-OUTPUT_TAIL_CHARS);
      const reason = timedOut
        ? `timed out after ${Math.round(plan.timeoutMs / 1000)}s`
        : `failed (${code === null ? `signal ${signal}` : `exit ${code}`})`;
      reject(new Error(`npm install ${plan.target} ${reason}${tail ? `: ${tail}` : ""}`));
    });
  });
}

function killTree(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

type DeclaredBins = { packageDir: string; unscoped: string; bins: Array<[string, string]> };

/** The bins an installed package declares, as paths inside the package. */
async function declaredBins(dir: string, name: string): Promise<DeclaredBins> {
  const packageDir = join(dir, "node_modules", ...name.split("/"));
  let manifest: { name?: string; bin?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch {
    throw new Error(`npm did not install ${name}`);
  }
  const unscoped = (manifest.name ?? name).replace(/^@[^/]+\//, "");
  const raw =
    typeof manifest.bin === "string"
      ? { [unscoped]: manifest.bin }
      : manifest.bin && typeof manifest.bin === "object"
        ? (manifest.bin as Record<string, unknown>)
        : {};
  const bins: Array<[string, string]> = [];
  for (const [bin, path] of Object.entries(raw)) {
    if (typeof path !== "string") continue;
    const binPath = resolve(packageDir, path);
    // A bin must stay inside its package; anything else is not launched.
    if (binPath.startsWith(packageDir + sep)) {
      const actual = await realpath(binPath).catch(() => undefined);
      const actualPackage = await realpath(packageDir);
      const actualRoot = await realpath(dir);
      if (actualPackage.startsWith(actualRoot + sep) && actual?.startsWith(actualPackage + sep))
        bins.push([bin, actual]);
    }
  }
  return { packageDir, unscoped, bins };
}

/** npm leaves bins executable only through its links; the launch uses the target directly. */
async function makeBinsExecutable(dir: string, name: string): Promise<void> {
  const { bins } = await declaredBins(dir, name);
  if (bins.length === 0) throw new Error(`${name} does not declare a bin to run`);
  await Promise.all(bins.map(([, path]) => chmod(path, 0o755).catch(() => undefined)));
}

/** npx's choice: the named bin, else the only bin, else the one named after the package. */
async function resolveBin(dir: string, name: string, binName?: string): Promise<string> {
  const { unscoped, bins } = await declaredBins(dir, name);
  const byName = new Map(bins);
  // Like npx: names that all run the same file (aliases) are one choice.
  const targets = new Set(bins.map(([, path]) => path));
  const chosen = binName
    ? byName.get(binName)
    : targets.size === 1
      ? bins[0]?.[1]
      : byName.get(unscoped);
  if (!chosen) {
    const available = bins.map(([bin]) => bin).join(", ") || "none";
    throw new Error(
      binName
        ? `${name} has no bin named ${binName} (available: ${available})`
        : `${name} does not declare a single bin to run (available: ${available})`,
    );
  }
  return chosen;
}
