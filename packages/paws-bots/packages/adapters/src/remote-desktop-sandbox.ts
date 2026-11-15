import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import type { ComputerSize } from "@rakazo/contracts";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { sandboxIdleMs } from "./computer-idle.js";
import {
  normalizeWorkspacePath,
  shellQuote,
  workspaceCwd,
  workspacePath,
} from "./computer-support.js";
import { PortableFileBatcher } from "./computer-workspace.js";
import { LinuxDesktop, onBotScreen, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { isSandboxGoneError, sandboxNotFoundError } from "./sandbox-errors.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

const DISPLAY_START = 20;
const REMOTE_WORKSPACE = "/home/user/rakazo-home";
const REMOTE_BROWSER_PROFILES = `${REMOTE_WORKSPACE}/.browser-profiles`;

/** Common boundary used by the E2B, Novita and instabox desktop SDKs. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CommandStartOpts {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface EntryInfo {
  name: string;
  type?: string;
  size: number;
  mode: number;
}

export interface RemoteDesktop {
  readonly sandboxId: string;
  readonly trafficAccessToken?: string;
  setTimeout(timeoutMs: number): Promise<void>;
  getHost(port: number): string;
  commands: {
    run(
      command: string,
      options: CommandStartOpts & { background?: false },
    ): Promise<CommandResult>;
  };
  files: {
    makeDir(path: string): Promise<boolean>;
    list(path: string, options: { signal?: AbortSignal }): Promise<EntryInfo[]>;
    getInfo(path: string, options: { signal?: AbortSignal }): Promise<EntryInfo>;
    read(path: string, options: { format: "bytes"; signal?: AbortSignal }): Promise<Uint8Array>;
    write(
      files: Array<{ path: string; data: ArrayBuffer }>,
      options: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

export interface RemoteDesktopSdk {
  /** `size` is the plan's size for a new computer; an SDK without sizes ignores it. */
  create(
    template: string,
    options: ReturnType<typeof remoteDesktopCreateOptions>,
    size?: ComputerSize,
  ): Promise<RemoteDesktop>;
  /**
   * Moves a stopped or paused computer to `size` before it starts; a running one keeps its size.
   * Throws `SandboxSizeUnavailableError` when the computer cannot start at that size.
   */
  resize?(id: string, size: ComputerSize, options: { apiKey: string }): Promise<void>;
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<RemoteDesktop>;
  connectRunning?(
    id: string,
    options: { apiKey: string; timeoutMs: number },
  ): Promise<RemoteDesktop>;
  keepAlive?(id: string, options: { apiKey: string; timeoutMs: number }): Promise<void>;
  /** Reads the sandbox's status without resuming it. */
  isRunning?(id: string, options: { apiKey: string; signal: AbortSignal }): Promise<boolean>;
  pause(id: string, options: { apiKey: string }): Promise<unknown>;
  kill(id: string, options: { apiKey: string }): Promise<boolean>;
}

export function remoteDesktopCreateOptions(botId: string, apiKey: string) {
  return {
    apiKey,
    timeoutMs: sandboxIdleMs(),
    metadata: { botId, rakazo: "computer" },
    resolution: [1280, 800] as [number, number],
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
  };
}

// How the SDKs report a sandbox that is not running. Sandboxes pause on timeout, so this usually
// means paused rather than deleted; only a failed resume proves the sandbox is gone. Newer SDKs
// name the error instead, including one for a sandbox they could not reach to check.
const SANDBOX_NOT_RUNNING_NAMES = new Set([
  "SandboxNotFoundError",
  "SandboxNotRunningError",
  "SandboxUnreachableError",
]);
const SANDBOX_NOT_RUNNING =
  /likely due to sandbox timeout|killed or reached its end of life|probably not running anymore/i;

// The SDK's wording for a command that outlived its own timeoutMs (gRPC DeadlineExceeded).
const COMMAND_DEADLINE = /^deadline_exceeded|exceeding 'timeoutMs'/;

function isSandboxNotRunning(error: unknown): boolean {
  return (
    error instanceof Error &&
    (SANDBOX_NOT_RUNNING_NAMES.has(error.name) || SANDBOX_NOT_RUNNING.test(error.message))
  );
}

function statusCode(error: unknown): unknown {
  return error instanceof Error ? (error as { statusCode?: unknown }).statusCode : undefined;
}

function isTemplateMissingError(error: unknown): boolean {
  return error instanceof Error && (statusCode(error) === 404 || /^404:/.test(error.message));
}

export class RemoteDesktopSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/user",
      workspaceDir: REMOTE_WORKSPACE,
      browserProfilesDir: REMOTE_BROWSER_PROFILES,
      displayStart: DISPLAY_START,
      portStart: 6100,
      // The provider port proxy reaches the isolated sandbox through its network interface.
      bindHost: "0.0.0.0",
    }),
    run: async (computer, command, context) => {
      const result = await this.runSetupCommand(computer, command, context.signal);
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async (computer, port) =>
      `https://${(await this.box(computer)).getHost(port)}/vnc.html`,
  });
  private readonly boxes = new Map<string, RemoteDesktop>();
  private readonly connections = new Map<string, Promise<RemoteDesktop>>();
  private readonly lastTouchedAt = new Map<string, number>();

  constructor(
    private readonly config: {
      id: "e2b" | "novita" | "instabox";
      label: string;
      apiKey: string;
      sdk: RemoteDesktopSdk;
      template: string;
      fallbackTemplate?: string;
      isTimeoutError: (error: unknown) => boolean;
    },
  ) {}

  describe() {
    return {
      id: this.config.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: true,
        multiScreen: true,
      },
    };
  }

  private async box(computer: ComputerRef, resume = false): Promise<RemoteDesktop> {
    const id = sandboxId(computer);
    const existing = this.boxes.get(id);
    if (existing) {
      const lastTouched = this.lastTouchedAt.get(id) ?? 0;
      // Fresh enough that the command keepalive's first extension lands before the timeout.
      if (!(resume && this.config.sdk.connectRunning) && Date.now() - lastTouched < extendEveryMs())
        return existing;
      try {
        await existing.setTimeout(sandboxIdleMs());
        this.lastTouchedAt.set(id, Date.now());
        return existing;
      } catch {
        // Paused, killed, mid-pause (409) or past the plan's lifetime: the handle is unusable
        // either way. Reconnecting resumes it, or proves it gone.
        this.drop(id, existing);
      }
    }
    return this.connect(id, resume);
  }

  private connect(id: string, resume = false): Promise<RemoteDesktop> {
    const cached = this.boxes.get(id);
    if (cached) return Promise.resolve(cached);
    const pending = this.connections.get(id);
    if (pending) return pending;
    let connection!: Promise<RemoteDesktop>;
    const connect = resume
      ? this.config.sdk.connect
      : (this.config.sdk.connectRunning ?? this.config.sdk.connect);
    connection = connect(id, { apiKey: this.config.apiKey, timeoutMs: sandboxIdleMs() })
      .catch((error: unknown) => {
        throw isBeingKilled(error) ? sandboxGoneError(this.config.label, id, error) : error;
      })
      .then((connected) => {
        if (this.connections.get(id) !== connection) {
          throw new Error("computer connection stopped during teardown");
        }
        this.boxes.set(connected.sandboxId, connected);
        this.lastTouchedAt.set(connected.sandboxId, Date.now());
        return connected;
      })
      .finally(() => {
        if (this.connections.get(id) === connection) this.connections.delete(id);
      });
    this.connections.set(id, connection);
    return connection;
  }

  /**
   * The provider answers for a paused sandbox the way it does for a deleted one. Resume it so callers
   * keep the sandbox; the resume itself throws if the sandbox is really gone.
   */
  private async recover(
    computer: ComputerRef,
    desktop: RemoteDesktop,
    error: unknown,
  ): Promise<unknown> {
    if (!isSandboxNotRunning(error)) return error;
    const id = sandboxId(computer);
    // stop() or destroy() forgot this handle on purpose; resuming it would undo them.
    if (this.boxes.get(id) !== desktop && !this.boxes.has(id) && !this.connections.has(id)) {
      return new Error("computer stopped during the request");
    }
    this.drop(id, desktop);
    await this.connect(id);
    return new Error("computer was not running and has been resumed; try again");
  }

  private async use<T>(
    computer: ComputerRef,
    work: (desktop: RemoteDesktop) => Promise<T>,
  ): Promise<T> {
    const desktop = await this.box(computer);
    try {
      return await work(desktop);
    } catch (error) {
      throw await this.recover(computer, desktop, error);
    }
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      size?: ComputerSize;
    },
    _context: AdapterContext,
  ): Promise<ComputerRef> {
    if (request.providerRef && request.providerKind === this.config.id) {
      try {
        if (request.size && this.config.sdk.resize) {
          await this.config.sdk.resize(request.providerRef, request.size, {
            apiKey: this.config.apiKey,
          });
        }
        const desktop = await this.box(
          {
            id: request.providerRef,
            providerRef: request.providerRef,
            kind: this.config.id,
            botId: request.botId,
          },
          true,
        );
        return {
          id: desktop.sandboxId,
          botId: request.botId,
          kind: this.config.id,
          providerRef: desktop.sandboxId,
          fresh: false,
        };
      } catch (error) {
        this.boxes.delete(request.providerRef);
        // A transport failure says nothing about the workspace still on the server.
        if (!isSandboxGoneError(error)) throw error;
      }
    }
    const desktop = await this.createDesktop(
      remoteDesktopCreateOptions(request.botId, this.config.apiKey),
      request.size,
    );
    this.boxes.set(desktop.sandboxId, desktop);
    this.lastTouchedAt.set(desktop.sandboxId, Date.now());
    return {
      id: desktop.sandboxId,
      botId: request.botId,
      kind: this.config.id,
      providerRef: desktop.sandboxId,
      fresh: true,
    };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== this.config.id || !this.config.sdk.isRunning) return false;
    try {
      return await this.config.sdk.isRunning(sandboxId(computer), {
        apiKey: this.config.apiKey,
        signal: context.signal,
      });
    } catch (error) {
      if (isSandboxGoneError(error)) return false;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    if (computer.fresh)
      await this.use(computer, (desktop) => desktop.files.makeDir(REMOTE_WORKSPACE));
    const result = await this.runSetupCommand(computer, PREPARE_LINUX_DESKTOP, context.signal);
    if (result.exitCode !== 0)
      throw new Error(result.stderr || "could not prepare computer desktop tools");
  }

  async *execute(
    computer: ComputerRef,
    requested: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const request = onBotScreen(requested, context, DISPLAY_START);
    const result = await this.run(computer, sandboxCommandArgv(request).map(shellQuote).join(" "), {
      cwd: workspaceCwd(REMOTE_WORKSPACE, request.cwd, ["/home/user"]),
      envs: request.env,
      signal: context.signal,
      timeoutMs: boundedSandboxCommandTimeoutMs(request.timeoutMs),
    });
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.exitCode };
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.withTrafficAccess(
      computer,
      await this.desktops.connectScreen(computer, request, context),
    );
  }
  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.withTrafficAccess(
      computer,
      await this.desktops.connectTerminal(computer, request, context),
    );
  }
  /** Restricted E2B sandboxes require this header; a missing token stays off the request. */
  private withTrafficAccess<T extends { url: string | null }>(
    computer: ComputerRef,
    session: T,
  ): T & { headers?: Record<string, string> } {
    if (this.config.id !== "e2b") return session;
    const token = this.boxes.get(sandboxId(computer))?.trafficAccessToken;
    if (!token) return session;
    return { ...session, headers: { "e2b-traffic-access-token": token } };
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }
  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }
  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }
  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const entries = await this.use(computer, (desktop) =>
      desktop.files.list(workspacePath(REMOTE_WORKSPACE, relative), { signal: context.signal }),
    );
    return entries.flatMap((entry) => {
      if (entry.type !== "file" && entry.type !== "dir") return [];
      return [
        {
          path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
          kind: entry.type,
          size: entry.size,
          ...(entry.type === "file" && entry.mode & 0o100 ? { executable: true } : {}),
        },
      ];
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const target = workspacePath(REMOTE_WORKSPACE, filePath);
    return this.use(computer, async (desktop) => {
      if (options?.maxBytes !== undefined) {
        const info = await desktop.files.getInfo(target, { signal: context.signal });
        if (info.size > options.maxBytes) {
          throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
        }
      }
      const content = await desktop.files.read(target, { format: "bytes", signal: context.signal });
      // The file can grow between the size check and the read.
      if (options?.maxBytes !== undefined && content.byteLength > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
      return content;
    });
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.use(computer, (desktop) => writeRemoteFiles(desktop, [file], context));
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const desktop = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
    try {
      yield* keepingAwake(desktop, walkRemoteWorkspace(desktop, "", context));
    } catch (error) {
      throw await this.recover(computer, desktop, error);
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    await this.desktops.stopBrowsers(computer, context);
    const batcher = new PortableFileBatcher<PortableFile>(32, (file) => file.content.byteLength);
    const flush = async (batch: PortableFile[]) => {
      if (!batch.length) return;
      await this.use(computer, (desktop) => writeRemoteFiles(desktop, batch, context));
    };
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      const full = batcher.add(file);
      if (full) await flush(full);
    }
    await flush(batcher.take());
    // Imported browser profiles remain dormant until their owning bot needs a desktop.
  }

  async snapshot(computer: ComputerRef, _context: AdapterContext) {
    const observation = await this.observe(computer, _context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    if (this.config.sdk.keepAlive) {
      await this.config.sdk.keepAlive(sandboxId(computer), {
        apiKey: this.config.apiKey,
        timeoutMs: sandboxIdleMs(),
      });
      return;
    }
    // Force box()'s probe: extend the timeout, or reconnect, which resumes the sandbox and
    // throws when it is gone or the key no longer works.
    this.lastTouchedAt.delete(sandboxId(computer));
    await this.box(computer);
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = sandboxId(computer);
    this.forget(id);
    // A failed pause leaves the sandbox running and billing, so the caller must know.
    await this.config.sdk.pause(id, { apiKey: this.config.apiKey });
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = sandboxId(computer);
    this.forget(id);
    // Killing by id never resumes a paused sandbox; false means it was already gone.
    await this.config.sdk.kill(id, { apiKey: this.config.apiKey });
  }

  /** Prefer the right-sized template; an account that has not built it keeps the stock one. */
  private async createDesktop(
    options: ReturnType<typeof remoteDesktopCreateOptions>,
    size: ComputerSize | undefined,
  ): Promise<RemoteDesktop> {
    const create = (template: string) =>
      size
        ? this.config.sdk.create(template, options, size)
        : this.config.sdk.create(template, options);
    try {
      return await create(this.config.template);
    } catch (error) {
      if (!this.config.fallbackTemplate || !isTemplateMissingError(error)) throw error;
      getLogger().warn(
        `${this.config.label} computer template is not built; using the stock desktop template`,
        {
          template: this.config.template,
        },
      );
      return create(this.config.fallbackTemplate);
    }
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.connections.delete(id);
    this.lastTouchedAt.delete(id);
  }

  /** Drop a failed handle unless a reconnect has already replaced it. */
  private drop(id: string, desktop: RemoteDesktop): void {
    if (this.boxes.get(id) !== desktop) return;
    this.boxes.delete(id);
    this.lastTouchedAt.delete(id);
  }

  private runSetupCommand(
    computer: ComputerRef,
    command: string,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    // The SDK's outer login shell can fail its logout hook under `set -e`, even after `exit 0`.
    return this.run(computer, `bash -c ${shellQuote(command)}`, {
      ...(signal ? { signal } : {}),
      timeoutMs: boundedSandboxCommandTimeoutMs(undefined),
    });
  }

  /**
   * Run with an explicit timeout (the SDK default is 60s), holding the sandbox awake throughout.
   * A non-zero exit or the command's own deadline is a result, not an error.
   */
  private run(
    computer: ComputerRef,
    command: string,
    options: CommandStartOpts & { background?: false; timeoutMs: number },
  ): Promise<CommandResult> {
    return this.use(computer, async (desktop) => {
      try {
        return await whileAwake(desktop, desktop.commands.run(command, options));
      } catch (error) {
        if (
          this.config.isTimeoutError(error) &&
          error instanceof Error &&
          COMMAND_DEADLINE.test(error.message)
        ) {
          const message = `command timed out after ${options.timeoutMs} ms\n`;
          return { exitCode: 124, stdout: "", stderr: message, error: message };
        }
        const result = (error as { result?: CommandResult }).result;
        if (result) return result;
        throw error;
      }
    });
  }
}

async function writeRemoteFiles(
  desktop: RemoteDesktop,
  files: readonly PortableFile[],
  context: AdapterContext,
) {
  if (!files.length) return;
  await desktop.files.write(
    files.map((file) => ({
      path: workspacePath(REMOTE_WORKSPACE, file.path),
      data: toArrayBuffer(file.content),
    })),
    { signal: context.signal },
  );
  const executable = files
    .filter((file) => file.executable)
    .map((file) => shellQuote(workspacePath(REMOTE_WORKSPACE, file.path)));
  if (executable.length) {
    await desktop.commands.run(`chmod 700 -- ${executable.join(" ")}`, {
      signal: context.signal,
    });
  }
}

/**
 * Reading a large workspace can outlast the idle window, and the provider pauses the sandbox mid-read
 * when it does. Extend the timeout until the reader finishes.
 */
export async function* keepingAwake<T>(
  desktop: Pick<RemoteDesktop, "setTimeout">,
  items: AsyncIterable<T>,
): AsyncIterable<T> {
  await desktop.setTimeout(sandboxIdleMs()).catch(() => undefined);
  const stop = extendPeriodically(desktop);
  try {
    yield* items;
  } finally {
    stop();
  }
}

/** The provider timeout is an absolute deadline that command activity does not move. */
async function whileAwake<T>(
  desktop: Pick<RemoteDesktop, "setTimeout">,
  work: Promise<T>,
): Promise<T> {
  const stop = extendPeriodically(desktop);
  try {
    return await work;
  } finally {
    stop();
  }
}

function extendPeriodically(desktop: Pick<RemoteDesktop, "setTimeout">): () => void {
  const idleMs = sandboxIdleMs();
  // A failed extension surfaces through the work itself once the provider pauses the sandbox.
  const timer = setInterval(
    () => void desktop.setTimeout(idleMs).catch(() => undefined),
    extendEveryMs(),
  );
  return () => clearInterval(timer);
}

/** A third of the idle window, so a handle box() returns outlives the first extension. */
function extendEveryMs(): number {
  return Math.min(60_000, sandboxIdleMs() / 3);
}

async function* walkRemoteWorkspace(
  desktop: RemoteDesktop,
  directory: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  const entries = await desktop.files.list(workspacePath(REMOTE_WORKSPACE, directory), {
    signal: context.signal,
  });
  const files: Array<{ relative: string; mode: number }> = [];
  const directories: string[] = [];
  for (const entry of entries) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (shouldSkipPortableWorkspaceFile(relative, entry.type === "dir")) continue;
    if (entry.type === "dir") directories.push(relative);
    else if (entry.type === "file") files.push({ relative, mode: entry.mode });
  }
  for (let index = 0; index < files.length; index += 8) {
    const batch = await Promise.all(
      files.slice(index, index + 8).map(async ({ relative, mode }) => {
        const content = await desktop.files
          .read(workspacePath(REMOTE_WORKSPACE, relative), {
            format: "bytes",
            signal: context.signal,
          })
          .catch((error) => {
            if (relative.startsWith(".browser-profiles/")) return undefined;
            throw error;
          });
        if (!content) return undefined;
        return { path: relative, content, executable: Boolean(mode & 0o100) };
      }),
    );
    for (const file of batch) {
      if (file) yield file;
    }
  }
  for (const relative of directories) yield* walkRemoteWorkspace(desktop, relative, context);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sandboxId(computer: ComputerRef): string {
  return computer.providerRef || computer.id;
}

function isBeingKilled(error: unknown): boolean {
  return error instanceof Error && statusCode(error) === 409 && /kill/i.test(error.message);
}

/** Named so isSandboxGoneError lets callers replace the sandbox. */
function sandboxGoneError(label: string, id: string, cause: unknown): Error {
  return sandboxNotFoundError(`${label} sandbox ${id} is being deleted`, { cause });
}
