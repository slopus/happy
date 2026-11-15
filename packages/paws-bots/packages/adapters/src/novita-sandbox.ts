import { setTimeout as delay } from "node:timers/promises";
import { sandboxIdleMs } from "./computer-idle.js";
import { NOVITA_COMPUTER_TEMPLATE } from "./novita-template.js";
import type {
  CommandResult,
  CommandStartOpts,
  RemoteDesktop,
  RemoteDesktopSdk,
} from "./remote-desktop-sandbox.js";
import { RemoteDesktopSandboxProvider } from "./remote-desktop-sandbox.js";
import { isSandboxGoneError, SandboxUnsafeStopError } from "./sandbox-errors.js";

const REQUEST_TIMEOUT_MS = 15_000;

export interface NovitaCommandHandle {
  readonly stdout: string;
  wait(): Promise<CommandResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
}

interface NovitaEntry {
  name: string;
  type?: string;
  size: number;
  mode: number;
}

/** The part of a Novita desktop handle the adapter uses. */
export interface NovitaDesktop {
  readonly sandboxId: string;
  getHost(port: number): string;
  setTimeout(timeoutMs: number): Promise<void>;
  commands: {
    run(
      command: string,
      options: Omit<CommandStartOpts, "signal"> & { background: true },
    ): Promise<NovitaCommandHandle>;
  };
  files: {
    makeDir(path: string): Promise<boolean>;
    list(path: string): Promise<NovitaEntry[]>;
    getInfo(path: string): Promise<NovitaEntry>;
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(files: { path: string; data: ArrayBuffer }[]): Promise<unknown>;
  };
}

export interface NovitaRunningInfo {
  state?: string;
  sandboxId?: string;
  sandboxDomain?: string;
  envdVersion?: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
}

/**
 * The Novita SDK calls the adapter makes, shaped like the SDK so the offline emulator in
 * `novita-sandbox.test-support.ts` can stand in for it.
 */
export interface NovitaApi {
  desktop: {
    create(
      template: string,
      options: Parameters<RemoteDesktopSdk["create"]>[1],
    ): Promise<NovitaDesktop>;
    connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<NovitaDesktop>;
  };
  sandbox: {
    setTimeout(id: string, timeoutMs: number): Promise<void>;
    pause(id: string, options: { sync: true }): Promise<unknown>;
    getInfo(id: string): Promise<{ state?: string }>;
    kill(id: string): Promise<boolean>;
  };
  getFullInfo(id: string): Promise<NovitaRunningInfo>;
  setTimeout(id: string, timeoutMs: number): Promise<void>;
  /** A local handle to a running computer; it sends no request. */
  attach(
    info: Required<Pick<NovitaRunningInfo, "sandboxId" | "envdVersion">> & NovitaRunningInfo,
  ): NovitaDesktop;
}

/** The SDK loads only when a Novita computer is used, never in the default runtime. */
export async function nativeNovitaApi(apiKey: string): Promise<NovitaApi> {
  const { DesktopSandbox, Novita } = await import("novita-sandbox");
  const client = new Novita({ apiKey, requestTimeoutMs: REQUEST_TIMEOUT_MS });
  const opts = { apiKey, requestTimeoutMs: REQUEST_TIMEOUT_MS };
  return {
    desktop: client.desktop,
    sandbox: client.sandbox,
    getFullInfo: (id) => DesktopSandbox.getFullInfo(id, opts),
    setTimeout: (id, timeoutMs) => DesktopSandbox.setTimeout(id, timeoutMs, opts),
    attach: (info) => new DesktopSandbox({ ...opts, ...info }),
  };
}

export interface NovitaSandboxOptions {
  apiKey: string;
  template?: string;
  onUnsafeStop?: (providerRef: string) => Promise<void>;
}

/** Novita owns the VM lifecycle; the shared Linux runtime owns each bot's desktop. */
export class NovitaSandboxProvider extends RemoteDesktopSandboxProvider {
  constructor(options: NovitaSandboxOptions, sdk?: RemoteDesktopSdk) {
    super({
      id: "novita",
      label: "Novita",
      apiKey: options.apiKey,
      template: options.template?.trim() || NOVITA_COMPUTER_TEMPLATE,
      sdk: sdk ?? novitaSdk(options.apiKey, options.onUnsafeStop),
      isTimeoutError: (error) => isNamed(error, "TimeoutError"),
    });
  }
}

export function novitaSdk(
  apiKey: string,
  onUnsafeStop?: (providerRef: string) => Promise<void>,
  load: () => Promise<NovitaApi> = () => nativeNovitaApi(apiKey),
): RemoteDesktopSdk {
  let loaded: Promise<NovitaApi> | undefined;
  const api = () => (loaded ??= load());
  const safetyPause = async (id: string) => {
    // Fence other API/worker instances before suspending a process whose stop is uncertain.
    try {
      await onUnsafeStop?.(id);
    } finally {
      await pauseNovitaComputer(await api(), id);
    }
  };
  const wrap = (desktop: NovitaDesktop) =>
    novitaDesktop(desktop, () => safetyPause(desktop.sandboxId));
  return {
    create: async (template, options) =>
      wrap(await (await api()).desktop.create(template, options)),
    connect: async (id, options) => wrap(await (await api()).desktop.connect(id, options)),
    connectRunning: async (id) => wrap(await runningNovitaDesktop(await api(), id)),
    keepAlive: async (id, options) => (await api()).sandbox.setTimeout(id, options.timeoutMs),
    isRunning: async (id) => (await (await api()).sandbox.getInfo(id)).state === "running",
    pause: async (id) => pauseNovitaComputer(await api(), id),
    kill: async (id) => destroyNovitaComputer(await api(), id, safetyPause),
  };
}

/** A GET and local handle construction must never resume a paused guest. */
export async function runningNovitaDesktop(api: NovitaApi, id: string): Promise<NovitaDesktop> {
  const info = await api.getFullInfo(id);
  if (info.state !== "running")
    throw new Error("Novita computer is paused; start it before using it");
  if (info.sandboxId !== id || typeof info.envdVersion !== "string")
    throw new Error("Invalid Novita computer identity");
  try {
    await api.setTimeout(id, sandboxIdleMs());
  } catch (error) {
    const current = await api.getFullInfo(id);
    if (current.state !== "running")
      throw new Error("Novita computer is paused; start it before using it");
    if (isSandboxGoneError(error))
      throw new Error("Novita computer is present but its idle timeout could not be extended");
    throw error;
  }
  return api.attach({
    sandboxId: info.sandboxId,
    sandboxDomain: info.sandboxDomain,
    envdVersion: info.envdVersion,
    envdAccessToken: info.envdAccessToken,
    trafficAccessToken: info.trafficAccessToken,
  });
}

/** Novita has no per-call AbortSignal; translate cancellation at the SDK boundary. */
export function novitaDesktop(desktop: NovitaDesktop, pause: () => Promise<void>): RemoteDesktop {
  return {
    sandboxId: desktop.sandboxId,
    getHost: (port) => desktop.getHost(port),
    setTimeout: (timeoutMs) => desktop.setTimeout(timeoutMs),
    commands: { run: (command, options) => runNovitaCommand(desktop, command, options, pause) },
    files: {
      makeDir: (path) => desktop.files.makeDir(path),
      list: (path, options) => fileRequest(options.signal, () => desktop.files.list(path)),
      getInfo: (path, options) => fileRequest(options.signal, () => desktop.files.getInfo(path)),
      read: (path, options) =>
        fileRequest(options.signal, () => desktop.files.read(path, { format: "bytes" })),
      write: (files, options) => fileRequest(options.signal, () => desktop.files.write(files)),
    },
  };
}

async function fileRequest<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const result = await work();
  signal?.throwIfAborted();
  return result;
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/** Pause is idempotent; a lost acknowledgement must not leave compute billing unchecked. */
export async function pauseNovitaComputer(
  api: Pick<NovitaApi, "sandbox">,
  id: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api.sandbox.pause(id, { sync: true });
    } catch (error) {
      if (isNamed(error, "SandboxNotFoundError")) return;
      lastError = error;
    }
    try {
      const info = await api.sandbox.getInfo(id);
      if (info.state === "paused") return;
      lastError ??= new Error("Novita computer is still running after pause");
    } catch (error) {
      if (isNamed(error, "SandboxNotFoundError")) return;
      lastError = error;
    }
    if (attempt < 2) await delay(1000 * 2 ** attempt);
  }
  throw new Error(
    "Novita computer could not be paused after three attempts; it may still be running",
    { cause: lastError },
  );
}

/** Deletion retries never resume a paused computer, even after a lost acknowledgement. */
export async function destroyNovitaComputer(
  api: Pick<NovitaApi, "sandbox">,
  id: string,
  safetyPause: (id: string) => Promise<void> = (id) => pauseNovitaComputer(api, id),
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!(await api.sandbox.kill(id))) return false;
    } catch (error) {
      if (isNamed(error, "SandboxNotFoundError")) return false;
      lastError = error;
    }
    try {
      await api.sandbox.getInfo(id);
    } catch (error) {
      if (isNamed(error, "SandboxNotFoundError")) return true;
      lastError = error;
    }
    if (attempt < 2) await delay(1000 * 2 ** attempt);
  }
  try {
    await safetyPause(id);
  } catch (pauseError) {
    throw new SandboxUnsafeStopError(
      "Novita computer deletion and pause both failed; the computer may still be running",
      new AggregateError([lastError, pauseError]),
    );
  }
  throw new SandboxUnsafeStopError(
    "Novita computer deletion was not confirmed; the computer was paused instead",
    lastError,
  );
}

async function runNovitaCommand(
  desktop: Pick<NovitaDesktop, "commands">,
  command: string,
  options: CommandStartOpts,
  pause: () => Promise<void>,
) {
  const { signal, ...opts } = options;
  signal?.throwIfAborted();
  let handle: NovitaCommandHandle;
  try {
    handle = await desktop.commands.run(command, { ...opts, background: true });
  } catch (error) {
    // The process can start before its start event reaches us, leaving no PID to kill.
    if (isNamed(error, "CommandExitError")) throw error;
    return pauseAfterUnsafeCommand(pause, error);
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.reason ?? new Error("command aborted"));
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([handle.wait(), aborted]);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    // A non-zero command exit is complete. A broken stream or deadline says nothing
    // about the remote process, so terminate it before reporting that failure.
    if (!signal?.aborted && isNamed(error, "CommandExitError")) throw error;
    let killError: unknown;
    let killed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await handle.kill();
        killed = true;
        break;
      } catch (failure) {
        killError = failure;
      }
      if (attempt < 2) await delay(250 * 2 ** attempt);
    }
    if (killed) {
      if (signal?.aborted)
        return { exitCode: 130, stdout: handle.stdout, stderr: "command aborted\n" };
      throw error;
    }
    return pauseAfterUnsafeCommand(pause, killError);
  } finally {
    signal?.removeEventListener("abort", abort);
    await handle.disconnect();
  }
}

async function pauseAfterUnsafeCommand(pause: () => Promise<void>, cause: unknown): Promise<never> {
  try {
    await pause();
  } catch (pauseError) {
    throw new SandboxUnsafeStopError(
      "Novita command termination failed and the safety stop could not be completed; the computer may still be running",
      new AggregateError([cause, pauseError]),
    );
  }
  throw new SandboxUnsafeStopError(
    "Novita computer was paused after command termination failed; the command may remain suspended",
    cause,
  );
}
