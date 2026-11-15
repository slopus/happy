import { setTimeout as delay } from "node:timers/promises";
import { SandboxRateLimitError, SandboxSizeUnavailableError } from "@rakazo/adapter-kit";
import type { ComputerSize } from "@rakazo/contracts";
import { COMPUTER_SIZE_SPECS } from "@rakazo/contracts";
import { shellQuote } from "./computer-support.js";
import type {
  CommandResult,
  CommandStartOpts,
  RemoteDesktop,
  RemoteDesktopSdk,
} from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";
import {
  isSandboxGoneError,
  isSandboxUnsafeStopError,
  SandboxUnsafeStopError,
  sandboxNotFoundError,
} from "./sandbox-errors.js";

/** instabox's stock desktop image; the shared prepare step installs the rest. */
export const INSTABOX_COMPUTER_TEMPLATE = "agent-browser";
/** The desktop gateway serves every screen and terminal on this port. */
const SCREEN_PORT = 6100;
/** instabox ends a foreground command after 10 minutes; longer ones run as background jobs. */
const FOREGROUND_LIMIT_MS = 600_000;
const MAX_READ_BYTES = 1024 ** 3;
/** Parallel file transfers per batch, well under instabox's per-account request limit. */
const FILE_CONCURRENCY = 8;
/** The shared desktop runtime keeps its files under /home/user; point it at the persistent home. */
const LINK_HOME =
  '[ -e /home/user ] || { sudo -n mkdir -p /home && sudo -n ln -s "$HOME" /home/user; }';

export interface InstaboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface InstaboxJob {
  wait(options: { timeoutMs?: number; signal?: AbortSignal }): Promise<InstaboxCommandResult>;
  kill(): Promise<boolean>;
}

export interface InstaboxRunOptions {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  background?: boolean;
  onStdout?: (data: string) => unknown;
}

export interface InstaboxSpec {
  vcpus: number;
  memMiB: number;
}

/** The part of an instabox sandbox the adapter uses, shaped like the SDK's `Sandbox`. */
export interface InstaboxMachine {
  readonly sandboxId: string;
  getInfo(): Promise<{ state: string; machine: { spec: InstaboxSpec } }>;
  pause(): Promise<void>;
  resize(spec: InstaboxSpec): Promise<void>;
  commands: {
    run(command: string, options: InstaboxRunOptions): Promise<InstaboxCommandResult | InstaboxJob>;
  };
  files: {
    read(path: string, options: { format: "bytes"; maxBytes: number }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, options: { signal?: AbortSignal }): Promise<unknown>;
  };
  ports: { publish(port: number): Promise<{ url: string }> };
}

/** The instabox SDK calls the adapter makes; tests pass an in-memory stand-in. */
export interface InstaboxApi {
  create(
    template: string,
    metadata: Record<string, string>,
    spec?: InstaboxSpec,
  ): Promise<InstaboxMachine>;
  connect(id: string, resume: boolean): Promise<InstaboxMachine>;
  kill(id: string): Promise<boolean>;
}

/** The SDK loads only when an instabox computer is used, never in the default runtime. */
export async function nativeInstaboxApi(apiKey: string): Promise<InstaboxApi> {
  const { Sandbox } = await import("@insforge/instabox-sdk");
  return {
    // Without the vault, the account's own secrets never reach a bot's computer.
    create: (template, metadata, spec) =>
      Sandbox.create(template, { apiKey, metadata, vault: false, ...spec }),
    connect: (id, resume) => Sandbox.connect(id, { apiKey, resume }),
    kill: (id) => Sandbox.kill(id, { apiKey }),
  };
}

/** instabox owns the VM lifecycle; the shared Linux runtime owns each bot's desktop. */
export class InstaboxSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(
    options: { apiKey: string; onUnsafeStop?: (providerRef: string) => Promise<void> },
    sdk?: RemoteDesktopSdk,
  ) {
    super({
      id: "instabox",
      label: "instabox",
      apiKey: options.apiKey,
      template: INSTABOX_COMPUTER_TEMPLATE,
      sdk: sdk ?? instaboxSdk(options.apiKey, options.onUnsafeStop),
      // Commands past their deadline come back as exit 124, never as an error.
      isTimeoutError: () => false,
    });
  }
}

export function instaboxSdk(
  apiKey: string,
  onUnsafeStop?: (providerRef: string) => Promise<void>,
  load: () => Promise<InstaboxApi> = () => nativeInstaboxApi(apiKey),
): RemoteDesktopSdk {
  let loaded: Promise<InstaboxApi> | undefined;
  const api = () => (loaded ??= load());
  const reach = async (id: string, resume: boolean) => {
    try {
      return await (await api()).connect(id, resume);
    } catch (error) {
      throw translate(error, id);
    }
  };
  const state = async (machine: InstaboxMachine) => {
    try {
      return (await machine.getInfo()).state;
    } catch (error) {
      throw translate(error, machine.sandboxId);
    }
  };
  // A paused instabox computer keeps the failed command in memory, so other instances must be
  // fenced off before the pause or a later resume would start it again.
  const safetyPause = async (machine: InstaboxMachine) => {
    let fenceError: unknown;
    try {
      await onUnsafeStop?.(machine.sandboxId);
    } catch (error) {
      fenceError = error;
    }
    try {
      await machine.pause();
    } catch (error) {
      if (!isSandboxGoneError(translate(error, machine.sandboxId))) throw error;
    }
    if (fenceError) throw fenceError;
  };
  const pause = (machine: InstaboxMachine) => () => safetyPause(machine);
  return {
    create: async (template, options, size) => {
      let machine: InstaboxMachine;
      try {
        // Standard is instabox's default size, which every plan offers.
        const spec = size && size !== "standard" ? specOf(size) : undefined;
        machine = await (await api()).create(template, options.metadata, spec);
      } catch (error) {
        throw translate(error);
      }
      try {
        return await openDesktop(machine, true, pause(machine));
      } catch (error) {
        // Nothing has the new computer's reference yet, so nothing else would delete it.
        await (await api()).kill(machine.sandboxId).catch(() => false);
        throw error;
      }
    },
    resize: async (id, size) => {
      const machine = await reach(id, false);
      let info: Awaited<ReturnType<InstaboxMachine["getInfo"]>>;
      try {
        info = await machine.getInfo();
      } catch (error) {
        throw translate(error, id);
      }
      const want = specOf(size);
      const have = info.machine.spec;
      if (info.state === "running" || (have.vcpus === want.vcpus && have.memMiB === want.memMiB))
        return;
      try {
        await machine.resize(want);
      } catch (error) {
        // instabox starts a computer whose resize operation failed again at its old size.
        if (isFailedOperation(error))
          throw new SandboxSizeUnavailableError("not_offered", { cause: error });
        throw translate(error, id);
      }
    },
    connect: async (id) => {
      const machine = await reach(id, true);
      return openDesktop(machine, true, pause(machine));
    },
    connectRunning: async (id) => {
      const machine = await reach(id, false);
      if ((await state(machine)) !== "running")
        throw new Error("instabox computer is paused; start it before using it");
      return openDesktop(machine, false, pause(machine));
    },
    isRunning: async (id) => (await state(await reach(id, false))) === "running",
    pause: async (id) => {
      let machine: InstaboxMachine;
      try {
        machine = await reach(id, false);
      } catch (error) {
        if (error instanceof Error && error.name === "SandboxNotFoundError") return;
        throw error;
      }
      const current = await state(machine);
      if (current === "suspended" || current === "stopped") return;
      try {
        await machine.pause();
      } catch (error) {
        throw translate(error, id);
      }
    },
    kill: async (id) => {
      try {
        return await (await api()).kill(id);
      } catch (error) {
        throw translate(error);
      }
    },
  };
}

/** Publishes the desktop gateway, and on a new or resumed computer links its home. */
async function openDesktop(
  machine: InstaboxMachine,
  setup: boolean,
  pause: () => Promise<void>,
): Promise<RemoteDesktop> {
  if (setup) await checked(machine, LINK_HOME, pause);
  let host: string;
  try {
    host = new URL((await machine.ports.publish(SCREEN_PORT)).url).host;
  } catch (error) {
    throw translate(error, machine.sandboxId);
  }
  return instaboxDesktop(machine, host, pause);
}

export function instaboxDesktop(
  machine: InstaboxMachine,
  host: string,
  pause: () => Promise<void>,
): RemoteDesktop {
  return {
    sandboxId: machine.sandboxId,
    getHost: (port) => {
      if (port !== SCREEN_PORT)
        throw new Error(`instabox computer publishes port ${SCREEN_PORT} only`);
      return host;
    },
    // instabox has no lifetime deadline to move; this only proves the computer still runs.
    setTimeout: async () => {
      let state: string;
      try {
        state = (await machine.getInfo()).state;
      } catch (error) {
        const translated = translate(error, machine.sandboxId);
        // box() drops this handle on any throw. A rate limit says nothing about the computer.
        if (translated instanceof SandboxRateLimitError) return;
        throw translated;
      }
      if (state !== "running") {
        const error = new Error(`instabox computer is ${state}`);
        error.name = "SandboxNotRunningError";
        throw error;
      }
    },
    commands: { run: (command, options) => runCommand(machine, command, options, pause) },
    files: {
      makeDir: async (path) => {
        await checked(machine, `mkdir -p -- ${shellQuote(path)}`, pause);
        return true;
      },
      list: async (path, options) => listEntries(machine, path, pause, options.signal),
      getInfo: async (path, options) => {
        const result = await runCommand(
          machine,
          `stat -L -c '%s %a' -- ${shellQuote(path)}`,
          { signal: options.signal },
          pause,
        );
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `no such file: ${path}`);
        const [size, mode] = result.stdout.trim().split(" ");
        return {
          name: path.split("/").at(-1) ?? path,
          type: "file",
          size: Number(size),
          mode: Number.parseInt(mode ?? "0", 8),
        };
      },
      read: async (path, options) => {
        options.signal?.throwIfAborted();
        try {
          return await machine.files.read(path, { format: "bytes", maxBytes: MAX_READ_BYTES });
        } catch (error) {
          throw translate(error);
        }
      },
      write: async (files, options) => {
        for (let index = 0; index < files.length; index += FILE_CONCURRENCY) {
          await Promise.all(
            files.slice(index, index + FILE_CONCURRENCY).map(async (file) => {
              try {
                await machine.files.write(file.path, new Uint8Array(file.data), {
                  signal: options.signal,
                });
              } catch (error) {
                throw translate(error);
              }
            }),
          );
        }
      },
    },
  };
}

/** One entry per line: type, size, octal mode, then the name, which ends at the NUL. */
async function listEntries(
  machine: InstaboxMachine,
  path: string,
  pause: () => Promise<void>,
  signal?: AbortSignal,
) {
  const result = await runCommand(
    machine,
    `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y %s %m %f\\0'`,
    { signal },
    pause,
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot list ${path}`);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [kind, size, mode] = line.split(" ", 3);
      const name = line.split(" ").slice(3).join(" ");
      return {
        name,
        type: kind === "f" ? "file" : kind === "d" ? "dir" : "other",
        size: Number(size),
        mode: Number.parseInt(mode ?? "0", 8),
      };
    });
}

async function checked(
  machine: InstaboxMachine,
  command: string,
  pause: () => Promise<void>,
): Promise<void> {
  const result = await runCommand(machine, command, { timeoutMs: 60_000 }, pause);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `instabox command failed with exit ${result.exitCode}`);
}

const ABORTED: CommandResult = { exitCode: 130, stdout: "", stderr: "command aborted\n" };

/** A non-zero exit, a deadline, or an abort is a result; only transport failures throw. */
async function runCommand(
  machine: InstaboxMachine,
  command: string,
  options: CommandStartOpts,
  pause: () => Promise<void>,
): Promise<CommandResult> {
  const { signal, timeoutMs, ...rest } = options;
  // Nothing was started, so there is no remote process to stop.
  if (signal?.aborted) return ABORTED;
  try {
    // Aborting a foreground command only closes its stream. A command the caller can cancel,
    // and one past the foreground limit, runs as a job whose process we can kill.
    if (signal || (timeoutMs !== undefined && timeoutMs > FOREGROUND_LIMIT_MS)) {
      return await runJob(machine, command, rest, timeoutMs, signal, pause);
    }
    // Streamed output is never cut short; a buffered result keeps 1 MiB of each stream.
    const result = (await machine.commands.run(command, {
      ...rest,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onStdout: () => undefined,
    })) as InstaboxCommandResult;
    return commandResult(result, timeoutMs);
  } catch (error) {
    if (isCommandExit(error)) return commandResult(error, timeoutMs);
    if (isSandboxUnsafeStopError(error)) throw error;
    throw translate(error, machine.sandboxId);
  }
}

/** A background job has no 10-minute limit; its stdout and stderr arrive as one log. */
async function runJob(
  machine: InstaboxMachine,
  command: string,
  options: Pick<CommandStartOpts, "cwd" | "envs">,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  pause: () => Promise<void>,
): Promise<CommandResult> {
  let job: InstaboxJob;
  try {
    // The caller's signal is not passed: aborting the start can leave a job and no handle.
    job = (await machine.commands.run(command, {
      ...options,
      background: true,
    })) as InstaboxJob;
  } catch (error) {
    if (isCommandExit(error)) return commandResult(error, timeoutMs);
    const translated = translate(error, machine.sandboxId);
    if (isSandboxGoneError(translated) || translated instanceof SandboxRateLimitError) {
      throw translated;
    }
    // The process can start before its start result reaches us, leaving no job to kill.
    return pauseAfterUnsafeCommand(pause, error);
  }
  if (signal?.aborted) {
    await confirmJobStopped(job, pause);
    return ABORTED;
  }
  try {
    return commandResult(
      await job.wait({
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signal ? { signal } : {}),
      }),
      timeoutMs,
    );
  } catch (error) {
    if (isCommandExit(error)) return commandResult(error, timeoutMs);
    const translated = translate(error, machine.sandboxId);
    // A deleted computer is not still billing. Anything else left the job running.
    if (isSandboxGoneError(translated)) throw translated;
    await confirmJobStopped(job, pause);
    if (signal?.aborted) return ABORTED;
    if (errorCode(error) === "job_wait_timeout") return timedOut(timeoutMs);
    throw translated;
  }
}

/** Retries a kill that fails, then pauses the computer. */
async function confirmJobStopped(job: InstaboxJob, pause: () => Promise<void>): Promise<void> {
  let cause: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // false: every process had already exited, so the job is stopped either way.
      await job.kill();
      return;
    } catch (failure) {
      cause = failure;
    }
    if (attempt < 2) await delay(250 * 2 ** attempt);
  }
  return pauseAfterUnsafeCommand(pause, cause);
}

async function pauseAfterUnsafeCommand(pause: () => Promise<void>, cause: unknown): Promise<never> {
  try {
    await pause();
  } catch (pauseError) {
    throw new SandboxUnsafeStopError(
      "instabox command termination failed and the safety stop could not be completed; the computer may still be running",
      new AggregateError([cause, pauseError]),
    );
  }
  throw new SandboxUnsafeStopError(
    "instabox computer was paused after command termination failed; the command may remain suspended",
    cause,
  );
}

function commandResult(
  result: InstaboxCommandResult,
  timeoutMs: number | undefined,
): CommandResult {
  if (result.timedOut) return { ...timedOut(timeoutMs), stdout: result.stdout };
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function timedOut(timeoutMs: number | undefined): CommandResult {
  const message = `command timed out after ${timeoutMs ?? 60_000} ms\n`;
  return { exitCode: 124, stdout: "", stderr: message, error: message };
}

function isCommandExit(error: unknown): error is Error & InstaboxCommandResult {
  return error instanceof Error && error.name === "CommandExitError";
}

function errorCode(error: unknown): unknown {
  return error instanceof Error ? (error as { code?: unknown }).code : undefined;
}

/**
 * Rate limits from any call. A 404 means the computer is gone only when `id` names the computer
 * the call was about: a missing file or job inside it answers 404 too.
 */
function translate(error: unknown, id?: string): unknown {
  if (!(error instanceof Error)) return error;
  const status = (error as { status?: unknown }).status;
  if (status === 429) return new SandboxRateLimitError({ cause: error });
  if (errorCode(error) === "spec_not_allowed")
    return new SandboxSizeUnavailableError("not_offered", { cause: error });
  if (id && status === 404 && !isInsideComputerNotFound(error))
    return sandboxNotFoundError(`instabox sandbox ${id} not found`, { cause: error });
  return error;
}

/** The SDK's error for an operation that ran and failed: no HTTP status, the operation named. */
function isFailedOperation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, operationId } = error as { status?: unknown; operationId?: unknown };
  return (
    status === 0 && typeof operationId === "string" && errorCode(error) !== "operation_timeout"
  );
}

function specOf(size: ComputerSize): InstaboxSpec {
  const { vcpus, memoryGb } = COMPUTER_SIZE_SPECS[size];
  return { vcpus, memMiB: memoryGb * 1024 };
}

function isInsideComputerNotFound(error: Error): boolean {
  return /^(?:file|directory) not found:|^no job /.test(error.message);
}
