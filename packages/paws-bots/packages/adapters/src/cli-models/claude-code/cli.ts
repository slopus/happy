import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Runs the official `claude` executable found on the server's PATH, exactly as installed. Rakazo
 * never signs it in, never reads its sign-in, and never passes it a key: the operator signs in
 * once with `claude auth login`, and every model request is the CLI's own.
 */
export const CLAUDE_CODE_COMMAND = "claude";

/** The oldest CLI whose stream-json history replay and tool switches this bridge relies on. */
export const CLAUDE_CODE_MIN_VERSION = "2.1.280";

/** What the CLI needs to find its own sign-in, reach the network and run; nothing else. */
const PASSTHROUGH_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_ADDRESS",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_NAME",
  "LC_PAPER",
  "LC_TELEPHONE",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  // Set only by an operator who keeps the CLI's sign-in somewhere other than its default.
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows essentials.
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
]);

/**
 * Documented CLI settings. Rakazo owns the conversation, its compaction, memory and instructions,
 * so the CLI keeps none of its own, and every Rakazo tool is listed to the model up front.
 */
const BRIDGE_ENV = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_COMPACT: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  ENABLE_TOOL_SEARCH: "false",
} as const;

/**
 * The child's whole environment, built from an allowlist. API keys, OAuth tokens and every other
 * server secret stay out, so the CLI can only use the sign-in its operator made.
 */
export function claudeCodeEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSTHROUGH_ENV.has(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...BRIDGE_ENV, ...extra };
}

const stoppedProcesses = new WeakSet<ChildProcess>();

/** The CLI owns no persistent state; stop its group immediately after the model turn. */
function stopProcessTree(child: ChildProcess): void {
  if (stoppedProcesses.has(child)) return;
  stoppedProcesses.add(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

export interface ClaudeCodeProcess {
  /** The next stdout line, or undefined once the CLI has closed stdout. */
  nextLine(): Promise<string | undefined>;
  write(line: string): Promise<void>;
  closeInput(): void;
  stop(): void;
  /** The last part of stderr, for diagnosing an unexpected exit. */
  stderrTail(): string;
  /** The exit code once the CLI has exited, waiting briefly for it; null if it has not. */
  exitCode(): Promise<number | null>;
}

const STDERR_TAIL_CHARS = 2_000;
const EXIT_WAIT_MS = 1_000;

export function startClaudeCode(
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): ClaudeCodeProcess {
  const child = spawn(CLAUDE_CODE_COMMAND, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so stopping it also stops the servers it started.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  // Spawning fails asynchronously, for example with ENOENT when the CLI is not on PATH.
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  // A broken pipe after the CLI exits surfaces as its exit; it must not crash the worker.
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  return {
    async nextLine() {
      if (spawnError) throw spawnError;
      let onError: (error: Error) => void = () => {};
      const failed = new Promise<never>((_, reject) => {
        onError = reject;
        child.once("error", onError);
      });
      try {
        const next = await Promise.race([lines.next(), failed]);
        return next.done ? undefined : next.value;
      } finally {
        child.off("error", onError);
      }
    },
    write(line) {
      return new Promise((resolve, reject) => {
        if (child.stdin.destroyed || !child.stdin.writable) {
          reject(new Error("Claude Code stopped reading its input."));
          return;
        }
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
      });
    },
    closeInput() {
      child.stdin.end();
    },
    stop() {
      lines.return?.();
      stopProcessTree(child);
    },
    stderrTail() {
      return stderr.trim();
    },
    exitCode() {
      return Promise.race([
        exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), EXIT_WAIT_MS).unref()),
      ]);
    },
  };
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/** Runs a short CLI subcommand and returns its stdout; ENOENT means the CLI is not installed. */
function capture(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; missing: boolean; timedOut: boolean }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_CODE_COMMAND, args, {
      cwd,
      env: claudeCodeEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessTree(child);
    }, PROBE_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      stopProcessTree(child);
      cleanup();
      reject(signal?.reason ?? new Error("Request was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < PROBE_OUTPUT_LIMIT) stdout += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      resolve({ stdout, missing: error.code === "ENOENT", timedOut });
    });
    child.once("close", () => {
      cleanup();
      resolve({ stdout, missing: false, timedOut });
    });
  });
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parts = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  for (let index = 0; index < floor.length; index += 1) {
    const part = parts[index] ?? 0;
    const min = floor[index] ?? 0;
    if (part !== min) return part > min;
  }
  return true;
}

export const CLAUDE_CODE_NOT_INSTALLED_ERROR =
  "Claude Code is not installed on this server. Install it for the user that runs the Rakazo worker, then run `claude auth login`.";

/** Shaped like a provider HTTP error so the run error view classifies it as a sign-in problem. */
export const CLAUDE_CODE_SIGNED_OUT_ERROR =
  "Claude Code API error (401): Claude Code on this server is not signed in. Run `claude auth login` as the user that runs the Rakazo worker.";

const READY_CACHE_MS = 60_000;
const ready = new Map<string, number>();

/**
 * Checks that the CLI is installed, new enough, and signed in. Only `loggedIn` is read from
 * `claude auth status`; the account details it prints are ignored. A probe that times out or
 * prints something unexpected does not block the request: the CLI then reports its own error.
 */
export async function checkClaudeCode(cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const env = claudeCodeEnv();
  // A different PATH, home or config directory can mean a different CLI or sign-in.
  const key = JSON.stringify(env);
  const checkedAt = ready.get(key);
  if (checkedAt !== undefined && Date.now() - checkedAt < READY_CACHE_MS) return;
  const version = await capture(["--version"], cwd, signal);
  if (version.missing) throw new Error(CLAUDE_CODE_NOT_INSTALLED_ERROR);
  const installed = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1];
  if (installed && !versionAtLeast(installed, CLAUDE_CODE_MIN_VERSION)) {
    throw new Error(
      `Claude Code ${installed} on this server is older than ${CLAUDE_CODE_MIN_VERSION}. Run \`claude update\`.`,
    );
  }
  const status = await capture(["auth", "status", "--json"], cwd, signal);
  if (status.missing) throw new Error(CLAUDE_CODE_NOT_INSTALLED_ERROR);
  let loggedIn: unknown;
  try {
    loggedIn = (JSON.parse(status.stdout) as { loggedIn?: unknown }).loggedIn;
  } catch {
    loggedIn = undefined;
  }
  if (loggedIn === false) throw new Error(CLAUDE_CODE_SIGNED_OUT_ERROR);
  if (loggedIn === true && installed) ready.set(key, Date.now());
}
