import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Boxd, Machine } from "@boxd-sh/sdk";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  TerminalRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import {
  SandboxRateLimitError,
  SandboxUnavailableError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import {
  BASE_SNAPSHOT_BUILD_TIMEOUT_MS,
  BaseSnapshotCache,
  computerSnapshotName,
} from "./computer-base-snapshot.js";
import {
  normalizeWorkspacePath,
  shellQuote,
  workspaceCwd,
  workspacePath,
} from "./computer-support.js";
import { PortableFileBatcher } from "./computer-workspace.js";
import {
  INSTALL_LINUX_BROWSER,
  LinuxDesktop,
  onBotScreen,
  PREPARE_LINUX_DESKTOP,
  VERIFY_LINUX_DESKTOP,
} from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { abortedCommandEvents, timedOutCommandEvents } from "./sandbox-command-events.js";
import { sandboxNotFoundError } from "./sandbox-errors.js";
import { shellExportScript, sourceEnvironmentCommand } from "./sandbox-shell-environment.js";
import {
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindCommand,
} from "./workspace-save-policy.js";

const DISPLAY_START = 20;
const HOME = "/home/boxd";
const WORKSPACE = `${HOME}/rakazo-home`;
const BROWSER_PROFILES = `${WORKSPACE}/.browser-profiles`;
/** Outside the workspace so checkpoints never carry it. */
const COMMAND_ENV = `${HOME}/.rakazo-command-env`;
/** The desktop gateway serves every screen and terminal on this port, each behind its own token. */
const SCREEN_PORT = 6100;
const SCREEN_PROXY = "screen";
const READY_TIMEOUT_MS = 5 * 60_000;
const DESKTOP_COMMAND_TIMEOUT_MS = 120_000;
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 120_000;
/** A machine's first subdomain needs its own certificate, usually 10 to 30 seconds after create. */
const SCREEN_READY_TIMEOUT_MS = 90_000;
/** How long a stopped command gets to report its exit before it counts as stopped anyway. */
const STOP_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** The SDK loads only when boxd is configured; its error classes are read after a call fails. */
const boxdSdk = () => import("@boxd-sh/sdk");

/** The boxd SDK calls this provider makes; tests pass a stand-in. */
export interface BoxdSandboxClient {
  machines: Pick<
    Boxd["machines"],
    "create" | "get" | "delete" | "start" | "pause" | "streamExec"
  > & {
    fs: Pick<Boxd["machines"]["fs"], "read" | "write" | "list" | "remove">;
    proxies: Pick<Boxd["machines"]["proxies"], "create">;
  };
  snapshots: Pick<Boxd["snapshots"], "create" | "get">;
}

interface BoxdCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
}

export class BoxdSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: HOME,
      workspaceDir: WORKSPACE,
      browserProfilesDir: BROWSER_PROFILES,
      displayStart: DISPLAY_START,
      portStart: SCREEN_PORT,
      // boxd's HTTPS proxy reaches the machine through its network interface.
      bindHost: "0.0.0.0",
    }),
    run: async (computer, command, context) => {
      const result = await this.run(this.id(computer), bashCommand(command), {
        timeoutMs: DESKTOP_COMMAND_TIMEOUT_MS,
        signal: context.signal,
      });
      return {
        code: result.timedOut ? 124 : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    screenUrl: async (computer, port, context) => {
      if (port !== SCREEN_PORT) throw new Error("boxd computer has no proxy for that port");
      return `${await this.screenOrigin(this.id(computer), context.signal)}/vnc.html`;
    },
  });
  private readonly client: BoxdSandboxClient;
  private readonly org: string | undefined;
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly screens = new Map<string, string>();
  private readonly baseSnapshot = new BaseSnapshotCache({
    provider: "boxd",
    name: BOXD_COMPUTER_SNAPSHOT,
    build: () => this.buildComputerSnapshot(),
    warnMissingOnce: false,
  });

  constructor(config: { org?: string }, client: BoxdSandboxClient) {
    this.client = client;
    this.org = config.org;
  }

  describe() {
    return {
      id: "boxd",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    context.signal.throwIfAborted();
    if (request.providerRef && request.providerKind === "boxd") {
      try {
        const started = await this.ensureRunning(request.providerRef, context.signal);
        return { ...this.ref(request.providerRef, request.botId, false), started };
      } catch (error) {
        if (!isMachineGone(error)) throw error;
        this.forget(request.providerRef);
      }
    }
    const fromSnapshot = await this.computerSnapshot(context.signal);
    const name = `rakazo-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const params = {
      name,
      ...(this.org ? { org: this.org } : {}),
      // Bots run untrusted code: no boxd credentials inside, and no route to other machines.
      isolated: true,
      // Rakazo's idle sleep stops the computer; boxd's own counts only network traffic and would
      // freeze a long command that prints nothing.
      config: { autoSuspendTimeout: 0 },
    };
    let machine: Machine;
    try {
      machine = await (fromSnapshot
        ? this.client.machines.create({ ...params, fromSnapshot })
        : this.client.machines.create(params));
    } catch (error) {
      // A lost reply can hide a machine created under this name.
      await this.client.machines.delete(name).catch(() => undefined);
      throw await providerError(error);
    }
    if (context.signal.aborted) {
      await this.destroy(this.ref(machine.id, request.botId, true), context);
      context.signal.throwIfAborted();
    }
    return this.ref(machine.id, request.botId, true);
  }

  /**
   * Builds the snapshot new computers start from, unless it is already ready: a fresh machine
   * with the desktop tools installed and checked. The build machine is deleted afterwards.
   */
  async buildComputerSnapshot(
    signal: AbortSignal = AbortSignal.timeout(BASE_SNAPSHOT_BUILD_TIMEOUT_MS),
  ): Promise<{ name: string; built: boolean }> {
    const name = BOXD_COMPUTER_SNAPSHOT;
    // A save already in progress, from another process or an earlier run, may finish it.
    if ((await this.settledSnapshot(name, signal)) === "ready") return { name, built: false };
    const machine = await this.client.machines.create({
      name: `rakazo-snapshot-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      ...(this.org ? { org: this.org } : {}),
      isolated: true,
      config: { autoSuspendTimeout: 0 },
    });
    try {
      await this.ensureRunning(machine.id, signal);
      for (const command of BOXD_COMPUTER_SETUP) {
        const result = await this.run(machine.id, bashCommand(command), {
          timeoutMs: PREPARE_TIMEOUT_MS,
          signal,
        });
        if (result.exitCode !== 0 || result.timedOut) {
          throw new Error("could not prepare the boxd computer snapshot", {
            cause: new Error(commandFailure(result)),
          });
        }
      }
      await this.client.snapshots.create(machine.id, name);
      if ((await this.settledSnapshot(name, signal)) !== "ready") {
        throw new Error(`boxd could not save snapshot ${name}`);
      }
      return { name, built: true };
    } finally {
      await this.client.machines.delete(machine.id).catch(() => undefined);
    }
  }

  async isRunning(computer: ComputerRef): Promise<boolean> {
    return (await this.status(computer)) === "running";
  }

  async isStopped(computer: ComputerRef): Promise<boolean> {
    const status = await this.status(computer);
    return status === "suspended" || status === "hibernated" || status === "stopped";
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    if (this.prepared.has(id)) return;
    const pending = this.preparations.get(id);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      await this.ensureRunning(id, context.signal);
      // Added now so its certificate, about 20 seconds for a new machine, is ready by the first
      // screen. A machine created from a snapshot does not get proxies passed to create.
      await this.client.machines.proxies
        .create(id, SCREEN_PROXY, SCREEN_PORT)
        .catch(async (error) => {
          if (!(error instanceof (await boxdSdk()).ConflictError))
            throw await providerError(error, id);
        });
      // A computer from the snapshot already has the tools; this only checks for them.
      const result = await this.run(
        id,
        bashCommand([CONFIGURE_WORKSPACE, PREPARE_BOXD_DESKTOP].join("\n")),
        { timeoutMs: PREPARE_TIMEOUT_MS, signal: context.signal },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error("could not prepare boxd computer", {
          cause: new Error(commandFailure(result)),
        });
      }
      if (this.preparations.get(id) !== preparation) {
        throw new Error("boxd computer preparation was invalidated during teardown");
      }
      this.prepared.add(id);
    })().finally(() => {
      if (this.preparations.get(id) === preparation) this.preparations.delete(id);
    });
    this.preparations.set(id, preparation);
    return preparation;
  }

  async *execute(
    computer: ComputerRef,
    requested: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const request = onBotScreen(requested, context, DISPLAY_START);
    if (context.signal.aborted) {
      yield* abortedCommandEvents();
      return;
    }
    const id = this.id(computer);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const argv = sandboxCommandArgv({
      ...request,
      argv: request.argv.length ? request.argv : ["true"],
    })
      .map(shellQuote)
      .join(" ");
    // A command line shows in the machine's process list; values travel in a file instead.
    const environment = shellExportScript(request.env ?? {});
    const envFile = environment ? `${COMMAND_ENV}/${randomUUID()}` : undefined;
    let result: BoxdCommandResult | undefined;
    try {
      if (envFile) {
        await this.client.machines.fs.write(id, envFile, environment, { mode: 0o600 });
      }
      result = await this.run(id, envFile ? sourceEnvironmentCommand(envFile, argv) : argv, {
        cwd: workspaceCwd(WORKSPACE, request.cwd, [HOME]),
        timeoutMs,
        signal: context.signal,
      });
    } finally {
      // The command deletes the file as it starts; this covers a command that never did.
      if (envFile && (!result || result.timedOut || result.aborted)) {
        await this.client.machines.fs.remove(id, envFile).catch(() => undefined);
      }
    }
    if (result.aborted) {
      yield* abortedCommandEvents();
      return;
    }
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.timedOut) {
      yield* timedOutCommandEvents(timeoutMs);
      return;
    }
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.exitCode };
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.desktops.connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, context);
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return this.desktops.sendInput(computer, input, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return this.desktops.observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.desktops.releaseScreen(computer, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    context.signal.throwIfAborted();
    const relative = normalizeWorkspacePath(directory);
    const entries = await this.client.machines.fs.list(
      this.id(computer),
      workspacePath(WORKSPACE, relative),
    );
    return entries
      .map((entry) => ({
        path: normalizeWorkspacePath(path.posix.join(relative, entry.name)),
        kind: entry.isDir ? ("dir" as const) : ("file" as const),
        size: entry.isDir ? 0 : entry.size,
        ...(!entry.isDir && (entry.mode & 0o111) !== 0 ? { executable: true } : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    context.signal.throwIfAborted();
    const maxBytes = options?.maxBytes ?? MAX_FILE_BYTES;
    const content = await this.client.machines.fs.read(
      this.id(computer),
      workspacePath(WORKSPACE, filePath),
      { length: maxBytes + 1 },
    );
    if (content.byteLength > maxBytes) throw new Error(`computer file exceeds ${maxBytes} bytes`);
    return content;
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    context.signal.throwIfAborted();
    await this.write(this.id(computer), file);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile> {
    const id = this.id(computer);
    await this.desktops.stopBrowsers(computer, context);
    const listing = await this.run(id, bashCommand(LIST_WORKSPACE), {
      timeoutMs: LIST_TIMEOUT_MS,
      signal: context.signal,
    });
    if (listing.exitCode !== 0 || listing.timedOut) {
      throw new Error(`could not list boxd workspace (${commandFailure(listing)})`);
    }
    const files = parseWorkspaceListing(listing.stdout).filter(
      (file) => !shouldSkipPortableWorkspaceFile(file.path),
    );
    if (limits && files.length > limits.maxFiles) throw new WorkspaceTooLargeError("files");
    const bytes = files.reduce((total, file) => total + file.size, 0);
    if (files.some((file) => file.size > MAX_FILE_BYTES) || (limits && bytes > limits.maxBytes)) {
      throw new WorkspaceTooLargeError("bytes");
    }
    const batcher = new PortableFileBatcher<(typeof files)[number]>(4, (file) => file.size);
    const flush = async (batch: typeof files) => {
      context.signal.throwIfAborted();
      return Promise.all(batch.map((file) => this.readWorkspaceFile(id, file)));
    };
    for (const file of files) {
      const full = batcher.add(file);
      if (full) for (const read of await flush(full)) if (read) yield read;
    }
    for (const read of await flush(batcher.take())) if (read) yield read;
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    const id = this.id(computer);
    await this.desktops.stopBrowsers(computer, context);
    const batcher = new PortableFileBatcher<PortableFile>(4, (file) => file.content.byteLength);
    const flush = async (batch: PortableFile[]) => {
      context.signal.throwIfAborted();
      await Promise.all(batch.map((file) => this.write(id, file)));
    };
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      const full = batcher.add(file);
      if (full) await flush(full);
    }
    await flush(batcher.take());
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  /** Suspends the machine with its memory and disk; the next command wakes it in milliseconds. */
  async stop(computer: ComputerRef) {
    const id = this.id(computer);
    try {
      const machine = await this.client.machines.get(id);
      if (machine.status === "running") await this.client.machines.pause(id);
    } catch (error) {
      if (error instanceof (await boxdSdk()).NotFoundError) return;
      throw await providerError(error);
    }
  }

  async destroy(computer: ComputerRef, _context: AdapterContext) {
    const id = this.id(computer);
    this.forget(id);
    try {
      await this.client.machines.delete(id);
    } catch (error) {
      if (!(error instanceof (await boxdSdk()).NotFoundError)) throw await providerError(error);
    }
  }

  /** Brings the machine up, starting or waking it as needed, and says whether it was asleep. */
  private async ensureRunning(id: string, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let started = false;
    while (true) {
      signal.throwIfAborted();
      const machine = await this.machine(id);
      if (machine.status === "destroyed" || machine.status === "failed") throw machineGone(id);
      if (machine.status === "stopped") {
        await this.client.machines.start(id).catch(async (error: unknown) => {
          throw await providerError(error, id);
        });
        started = true;
        continue;
      }
      if (
        machine.status === "running" ||
        machine.status === "suspended" ||
        machine.status === "hibernated"
      ) {
        // A command wakes a sleeping machine, and only succeeds once the machine accepts work.
        started ||= machine.status !== "running";
        const probe = await this.run(id, "true", { timeoutMs: 30_000, signal }).catch(
          () => undefined,
        );
        if (probe?.exitCode === 0) return started;
      }
      if (Date.now() > deadline) throw new SandboxUnavailableError();
      await delay(1_000, undefined, { signal });
    }
  }

  /** Runs a command line, buffering its output, until it exits, times out, or is aborted. */
  private async run(
    id: string,
    command: string,
    options: { cwd?: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<BoxdCommandResult> {
    options.signal.throwIfAborted();
    const stream = this.client.machines.streamExec(id, {
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      closeStdin: true,
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let outputBytes = 0;
    let stoppedBy: "timeout" | "abort" | "overflow" | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let stopped!: () => void;
    // A closed call that never reports its end still counts as stopped after a grace period.
    const graceOver = new Promise<undefined>((resolve) => {
      stopped = () => {
        grace ??= setTimeout(resolve, STOP_GRACE_MS, undefined);
      };
    });
    // Closing the call makes boxd end the command's whole process group.
    const stop = (reason: NonNullable<typeof stoppedBy>) => {
      stoppedBy ??= reason;
      stream.close();
      stopped();
    };
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("abort");
    options.signal.addEventListener("abort", onAbort, { once: true });
    const collect = async (queue: AsyncIterable<Uint8Array>, parts: Uint8Array[]) => {
      for await (const chunk of queue) {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) return stop("overflow");
        parts.push(chunk);
      }
    };
    try {
      const settled = await Promise.race([
        Promise.allSettled([
          collect(stream.stdout, stdout),
          collect(stream.stderr, stderr),
          stream.wait(),
        ]),
        graceOver,
      ]);
      if (stoppedBy === "overflow") {
        throw new Error(`boxd command output exceeds ${MAX_OUTPUT_BYTES} bytes`);
      }
      const output = { stdout: decode(stdout), stderr: decode(stderr) };
      if (stoppedBy) {
        const aborted = stoppedBy === "abort";
        return { ...output, exitCode: aborted ? 130 : 124, timedOut: !aborted, aborted };
      }
      const exit = settled?.[2];
      if (!exit || exit.status === "rejected") throw await providerError(exit?.reason, id);
      return { ...output, exitCode: exit.value, timedOut: false, aborted: false };
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  private async readWorkspaceFile(
    id: string,
    file: { path: string; executable: boolean },
  ): Promise<PortableFile | undefined> {
    try {
      const content = await this.client.machines.fs.read(id, workspacePath(WORKSPACE, file.path), {
        length: MAX_FILE_BYTES + 1,
      });
      if (content.byteLength > MAX_FILE_BYTES) throw new WorkspaceTooLargeError("bytes");
      return { path: file.path, executable: file.executable, content };
    } catch (error) {
      // Removed since the listing.
      if (error instanceof (await boxdSdk()).FilesystemError && error.code === "ENOENT")
        return undefined;
      throw error;
    }
  }

  private async write(id: string, file: PortableFile) {
    await this.client.machines.fs.write(id, workspacePath(WORKSPACE, file.path), file.content, {
      mode: file.executable ? 0o700 : 0o600,
    });
  }

  /**
   * The machine's HTTPS proxy for the desktop gateway, once boxd serves it. Every screen and
   * terminal adds its own token.
   */
  private async screenOrigin(id: string, signal: AbortSignal): Promise<string> {
    const cached = this.screens.get(id);
    if (cached) return cached;
    const machine = await this.machine(id);
    const origin = `https://${SCREEN_PROXY}.${machine.name}.${machine.access.domain}`;
    if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(origin)) {
      throw new Error("Invalid boxd screen address");
    }
    const deadline = Date.now() + SCREEN_READY_TIMEOUT_MS;
    while (!(await proxyReady(origin, signal))) {
      if (Date.now() > deadline)
        throw new Error("boxd did not serve the computer's screen in time");
      await delay(1_000, undefined, { signal });
    }
    this.screens.set(id, origin);
    return origin;
  }

  /** The snapshot new computers start from once it is ready. */
  private computerSnapshot(signal: AbortSignal): Promise<string | undefined> {
    return this.baseSnapshot.current(signal, async () => {
      let status: string;
      try {
        status = (await this.client.snapshots.get(BOXD_COMPUTER_SNAPSHOT, this.scope())).status;
      } catch (error) {
        if (!signal.aborted && error instanceof (await boxdSdk()).NotFoundError) return "absent";
        throw error;
      }
      return status === "ready" ? "ready" : status === "pending" ? "saving" : "absent";
    });
  }

  /** The snapshot's status once any save in progress has finished, or undefined when absent. */
  private async settledSnapshot(name: string, signal: AbortSignal) {
    while (true) {
      let status: string;
      try {
        status = (await this.client.snapshots.get(name, this.scope())).status;
      } catch (error) {
        if (error instanceof (await boxdSdk()).NotFoundError) return undefined;
        throw await providerError(error);
      }
      if (status !== "pending") return status;
      await delay(2_000, undefined, { signal });
    }
  }

  private async machine(id: string): Promise<Machine> {
    try {
      return await this.client.machines.get(id);
    } catch (error) {
      throw await providerError(error, id);
    }
  }

  private async status(computer: ComputerRef) {
    try {
      return (await this.client.machines.get(this.id(computer))).status;
    } catch (error) {
      if (error instanceof (await boxdSdk()).NotFoundError) return undefined;
      throw await providerError(error);
    }
  }

  private scope() {
    return this.org ? { org: this.org } : undefined;
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "boxd", providerRef: id, fresh };
  }

  private id(computer: ComputerRef): string {
    return computer.providerRef;
  }

  private forget(id: string): void {
    this.prepared.delete(id);
    this.preparations.delete(id);
    this.screens.delete(id);
  }
}

export async function createBoxdSandboxProvider(config: {
  apiKey: string;
  org?: string;
}): Promise<BoxdSandboxProvider> {
  const { Boxd } = await boxdSdk();
  return new BoxdSandboxProvider(config, new Boxd({ apiKey: config.apiKey }));
}

function machineGone(id: string, cause?: unknown): Error {
  return sandboxNotFoundError(`boxd machine ${id} is gone`, { cause });
}

function isMachineGone(error: unknown): boolean {
  return error instanceof Error && error.name === "SandboxNotFoundError";
}

/** boxd's rate limit and a missing machine, as the errors the computer lifecycle acts on. */
async function providerError(error: unknown, id?: string): Promise<unknown> {
  const { NotFoundError, RateLimitError } = await boxdSdk();
  if (error instanceof RateLimitError) return new SandboxRateLimitError({ cause: error });
  if (id && error instanceof NotFoundError) return machineGone(id, error);
  return error;
}

/** boxd's proxy answers its own readiness path, without waking the machine, once it can route. */
async function proxyReady(origin: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/__boxd/ready`, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    await response.body?.cancel();
    // A proxy from before the readiness path forwards it to the machine, which also means live.
    const ready = response.headers.get("x-boxd-proxy");
    return ready === null || ready === "ready";
  } catch {
    // No certificate for the name yet.
    signal.throwIfAborted();
    return false;
  }
}

function bashCommand(script: string): string {
  return `bash -c ${shellQuote(script)}`;
}

function decode(parts: Uint8Array[]): string {
  return Buffer.concat(parts).toString("utf8");
}

function commandFailure(result: BoxdCommandResult): string {
  if (result.timedOut) return "timed out";
  const last = (result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 300);
  return last ? `exit ${result.exitCode}: ${last}` : `exit ${result.exitCode}`;
}

/** `path\0mode\0size\0` for every workspace file, relative to the workspace. */
const LIST_WORKSPACE = `cd ${shellQuote(WORKSPACE)} && ${workspaceSaveFindCommand()} -printf '%P\\0%m\\0%s\\0'`;

function parseWorkspaceListing(
  listing: string,
): Array<{ path: string; executable: boolean; size: number }> {
  const fields = listing.split("\0");
  const files: Array<{ path: string; executable: boolean; size: number }> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const filePath = fields[index]!;
    const size = Number(fields[index + 2]);
    if (!filePath || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("could not read the boxd workspace listing");
    }
    files.push({
      path: normalizeWorkspacePath(filePath),
      executable: (Number.parseInt(fields[index + 1]!, 8) & 0o111) !== 0,
      size,
    });
  }
  return files;
}

const CONFIGURE_WORKSPACE = [
  `mkdir -p ${shellQuote(BROWSER_PROFILES)}`,
  `chmod 700 ${shellQuote(WORKSPACE)}`,
  `mkdir -p -m 700 ${shellQuote(COMMAND_ENV)} && chmod 700 ${shellQuote(COMMAND_ENV)}`,
].join("\n");

const PREPARE_BOXD_DESKTOP = [PREPARE_LINUX_DESKTOP, INSTALL_LINUX_BROWSER].join("\n");

/** What a computer snapshot captures, in order: the same setup `prepare` repeats, then a check. */
const BOXD_COMPUTER_SETUP = [
  CONFIGURE_WORKSPACE,
  PREPARE_BOXD_DESKTOP,
  VERIFY_LINUX_DESKTOP,
] as const;

export const BOXD_COMPUTER_SNAPSHOT = computerSnapshotName(BOXD_COMPUTER_SETUP);
