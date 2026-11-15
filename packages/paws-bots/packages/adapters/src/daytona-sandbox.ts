import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CreateSandboxFromSnapshotParams, DaytonaConfig, Sandbox } from "@daytona/sdk";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  TerminalRequest,
} from "@rakazo/adapter-kit";
import { abortableDelay, boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { screenSessionKey } from "./computer-screens.js";
import {
  normalizeWorkspacePath,
  shellQuote,
  workspaceCwd,
  workspacePath,
} from "./computer-support.js";
import { PortableFileBatcher } from "./computer-workspace.js";
import { LinuxDesktop, onBotScreen, PREPARE_LINUX_DESKTOP } from "./linux-desktop.js";
import { installPageBrowserCommand } from "./page-browser-install.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { abortedCommandEvents, timedOutCommandEvents } from "./sandbox-command-events.js";
import { isSandboxGoneError, sandboxNotFoundError } from "./sandbox-errors.js";
import { withAbort } from "./web-ssrf.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

const DISPLAY_START = 20;
const DAYTONA_SCREEN_TTL_SECONDS = 3_600;
const DAYTONA_START_TIMEOUT_MS = 120_000;
const DAYTONA_STOP_TIMEOUT_MS = 120_000;
/** Waking an archived sandbox first copies its disk back from object storage. */
const DAYTONA_RESTORE_TIMEOUT_MS = 600_000;
const DAYTONA_POLL_MS = 1_000;
/** How long a cached handle is trusted before Daytona is asked whether the sandbox still runs. */
const DAYTONA_HANDLE_PROBE_MS = 60_000;

export type DaytonaSandbox = Pick<
  Sandbox,
  | "id"
  | "state"
  | "desiredState"
  | "recoverable"
  | "getUserHomeDir"
  | "getWorkDir"
  | "getSignedPreviewUrl"
  | "expireSignedPreviewUrl"
  | "refreshActivity"
  | "refreshData"
  | "start"
  | "recover"
  | "waitUntilStarted"
  | "stop"
  | "delete"
> & {
  process: Pick<Sandbox["process"], "executeCommand">;
  fs: Pick<Sandbox["fs"], "listFiles" | "getFileDetails"> & {
    uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
  };
  computerUse: Pick<Sandbox["computerUse"], "stop">;
};

/** The SDK loads only when Daytona is configured; its enums and errors are read after a call. */
const daytonaSdk = () => import("@daytona/sdk");

export interface DaytonaSandboxSdk {
  create(
    params: CreateSandboxFromSnapshotParams,
    options: { timeout: number },
  ): Promise<DaytonaSandbox>;
  get(sandboxIdOrName: string): Promise<DaytonaSandbox>;
}

export class DaytonaSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly client: DaytonaSandboxSdk;
  private readonly boxes = new Map<string, DaytonaSandbox>();
  private readonly checkedAt = new Map<string, number>();
  private readonly connections = new Map<
    string,
    Promise<{ sandbox: DaytonaSandbox; started: boolean }>
  >();
  private readonly workspaceRoots = new Map<string, string>();
  private readonly prepared = new Set<string>();
  private readonly desktops = new LinuxDesktop({
    environment: async (computer) => {
      const sandbox = await this.box(computer);
      return {
        homeDir: (await sandbox.getUserHomeDir()) ?? "/home/daytona",
        workspaceDir: await this.workspaceRoot(sandbox),
        browserProfilesDir: path.posix.join(await this.workspaceRoot(sandbox), ".browser-profiles"),
        displayStart: DISPLAY_START,
        portStart: 6100,
        // The provider port proxy reaches the isolated sandbox through its network interface.
        bindHost: "0.0.0.0",
      };
    },
    run: async (computer, command, context) => {
      context.signal.throwIfAborted();
      const result = await (await this.box(computer)).process.executeCommand(
        `bash -c ${shellQuote(command)}`,
        undefined,
        undefined,
        boundedSandboxCommandTimeoutMs(undefined) / 1000,
      );
      return { code: result.exitCode, stdout: result.result, stderr: result.result };
    },
    runWithInput: async (computer, command, input, timeoutMs, context) => {
      context.signal.throwIfAborted();
      const sandbox = await this.box(computer);
      const directory = `/tmp/rakazo-page-input-${randomUUID()}`;
      const file = `${directory}/request`;
      const timeout = Math.max(1, Math.ceil(timeoutMs / 1_000));
      const created = await sandbox.process.executeCommand(
        `mkdir -m 700 -- ${shellQuote(directory)}`,
        undefined,
        undefined,
        timeout,
      );
      if (created.exitCode !== 0) throw new Error("Could not prepare browser input");
      try {
        context.signal.throwIfAborted();
        try {
          await sandbox.fs.uploadFile(Buffer.from(input), file, timeout);
        } catch {
          throw new Error("Could not transfer browser input");
        }
        context.signal.throwIfAborted();
        try {
          const result = await sandbox.process.executeCommand(
            `bash -c ${shellQuote(`exec 0< ${shellQuote(file)} || exit 1; rm -f -- ${shellQuote(file)} && rmdir -- ${shellQuote(directory)} || exit 1; ${command}`)}`,
            undefined,
            undefined,
            timeout,
          );
          context.signal.throwIfAborted();
          return { code: result.exitCode, stdout: result.result };
        } catch (error) {
          if (error instanceof (await daytonaSdk()).DaytonaProcessExecutionTimeoutError)
            return { code: 124, stdout: "" };
          context.signal.throwIfAborted();
          throw new Error("Page browser unavailable or interrupted");
        }
      } finally {
        let cleaned = false;
        try {
          const result = await sandbox.process.executeCommand(
            `rm -f -- ${shellQuote(file)} && { rmdir -- ${shellQuote(directory)} 2>/dev/null || test ! -e ${shellQuote(directory)}; }`,
            undefined,
            undefined,
            10,
          );
          cleaned = result.exitCode === 0;
        } catch {}
        if (!cleaned)
          getLogger().warn("sandbox.page_browser", {
            provider: "daytona",
            outcome: "input_cleanup_failed",
          });
      }
    },
    screenUrl: async (computer, port, context) => {
      const preview = await this.screenPreview(
        await this.box(computer),
        screenSessionKey(context),
        port,
      );
      const url = new URL(preview.url);
      url.pathname = "/vnc.html";
      return url.toString();
    },
  });
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly screenPreviews = new Map<
    string,
    { url: string; token: string; expiresAt: number; viewPort: number }
  >();
  private readonly screenPreviewStarts = new Map<
    string,
    Promise<{ url: string; token: string; expiresAt: number; viewPort: number }>
  >();

  /** Optional Daytona snapshot name for new bot computers; unset = server default. */
  private readonly snapshotName: string | undefined;

  constructor(config: { snapshot?: string }, client: DaytonaSandboxSdk) {
    this.snapshotName =
      config.snapshot?.trim() || process.env.DAYTONA_SNAPSHOT?.trim() || undefined;
    this.client = client;
  }

  describe() {
    return {
      id: "daytona",
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
    if (request.providerRef && request.providerKind === "daytona") {
      try {
        const { sandbox, started } = await withAbort(
          this.connect(request.providerRef, true),
          context.signal,
        );
        return this.ref(sandbox, request.botId, false, started);
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
      }
    }

    // The unique name lets a create that fails after Daytona accepted it find and delete the
    // sandbox: it never auto-stops or auto-deletes, so a leaked one bills until removed.
    const name = `rakazo-${randomUUID()}`;
    let sandbox: DaytonaSandbox;
    try {
      sandbox = await this.client.create(
        {
          name,
          ...(this.snapshotName ? { snapshot: this.snapshotName } : {}),
          labels: { botId: request.botId, rakazo: "computer" },
          envVars: { VNC_RESOLUTION: "1280x800" },
          autoStopInterval: 0,
          autoDeleteInterval: -1,
        },
        { timeout: 120 },
      );
    } catch (error) {
      await this.deleteAbandoned(name);
      throw error;
    }
    this.boxes.set(sandbox.id, sandbox);
    this.checkedAt.set(sandbox.id, Date.now());
    return this.ref(sandbox, request.botId, true, false);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "daytona") return false;
    try {
      const sandbox = await withAbort(
        this.client.get(computer.providerRef || computer.id),
        context.signal,
      );
      return sandbox.state === (await daytonaSdk()).SandboxState.STARTED;
    } catch (error) {
      if (await isDaytonaSandboxMissing(error)) return false;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.prepareWorkspace(await withAbort(this.box(computer), context.signal));
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
    const sandbox = await this.box(computer);
    const root = await this.workspaceRoot(sandbox);
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    try {
      const result = await sandbox.process.executeCommand(
        sandboxCommandArgv(request).map(shellQuote).join(" "),
        workspaceCwd(root, request.cwd, ["/home/user", "/home/daytona"]),
        request.env,
        Math.max(1, Math.ceil(timeoutMs / 1_000)),
      );
      if (context.signal.aborted) {
        yield* abortedCommandEvents();
        return;
      }
      if (result.result) yield { type: "stdout", data: result.result };
      yield { type: "exit", code: result.exitCode };
    } catch (error) {
      if (error instanceof (await daytonaSdk()).DaytonaProcessExecutionTimeoutError) {
        yield* timedOutCommandEvents(timeoutMs);
        return;
      }
      throw error;
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
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

  async pageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    return this.desktops.pageBrowser(computer, request, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const sandbox = await this.box(computer);
    const relative = normalizeWorkspacePath(directory);
    const entries = await sandbox.fs.listFiles(
      workspacePath(await this.workspaceRoot(sandbox), relative),
    );
    return entries
      .map((entry) => ({
        path: normalizeWorkspacePath(relative ? `${relative}/${entry.name}` : entry.name),
        kind: entry.isDir ? ("dir" as const) : ("file" as const),
        size: entry.size,
        ...(!entry.isDir && isDaytonaExecutable(entry.mode, entry.permissions)
          ? { executable: true }
          : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const sandbox = await this.box(computer);
    const target = workspacePath(await this.workspaceRoot(sandbox), filePath);
    if (options?.maxBytes !== undefined) {
      const info = await sandbox.fs.getFileDetails(target);
      if (info.size > options.maxBytes) {
        throw new Error(`computer file exceeds ${options.maxBytes} bytes`);
      }
    }
    const content = await sandbox.fs.downloadFile(target);
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, _context: AdapterContext) {
    const sandbox = await this.box(computer);
    await this.writeFiles(sandbox, [file]);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const sandbox = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
    yield* walkDaytonaWorkspace(sandbox, await this.workspaceRoot(sandbox), "", context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const sandbox = await this.box(computer);
    await this.desktops.stopBrowsers(computer, context);
    const batcher = new PortableFileBatcher<PortableFile>(8, (file) => file.content.byteLength);
    const flush = async (batch: PortableFile[]) => {
      if (!batch.length) return;
      await this.writeFiles(sandbox, batch);
    };
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      if (context.signal.aborted) throw context.signal.reason ?? new Error("import aborted");
      const full = batcher.add(file);
      if (full) await flush(full);
    }
    await flush(batcher.take());
    // Browser profiles are imported without opening a shared browser.
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef): Promise<void> {
    await (await this.box(computer)).refreshActivity();
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = await this.findForTeardown(id);
    if (!sandbox) {
      this.forget(id);
      return;
    }
    const previewKeys = [...this.screenPreviews.keys()].filter((key) => key.startsWith(`${id}:`));
    await Promise.all(
      previewKeys.map((previewKey) =>
        this.revokeScreenPreview(sandbox, this.screenPreviews.get(previewKey)),
      ),
    );
    this.forget(id);
    await sandbox.computerUse.stop().catch(() => undefined);
    await stopDaytonaSandbox(sandbox);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = computer.providerRef || computer.id;
    const sandbox = await this.findForTeardown(id);
    if (!sandbox) {
      this.forget(id);
      return;
    }
    const previewKeys = [...this.screenPreviews.keys()].filter((key) => key.startsWith(`${id}:`));
    await Promise.all(
      previewKeys.map((previewKey) =>
        this.revokeScreenPreview(sandbox, this.screenPreviews.get(previewKey)),
      ),
    );
    this.forget(id);
    try {
      await sandbox.delete(120, true);
    } catch (error) {
      // Deletion is idempotent even when the sandbox disappears after lookup.
      if (!(await isDaytonaSandboxMissing(error))) throw error;
    }
  }

  private ref(
    sandbox: DaytonaSandbox,
    botId: string,
    fresh: boolean,
    started: boolean,
  ): ComputerRef {
    return {
      id: sandbox.id,
      botId,
      kind: "daytona",
      providerRef: sandbox.id,
      fresh,
      ...(started ? { started: true } : {}),
    };
  }

  /**
   * Returns a running sandbox, starting it if needed. A cached handle is trusted for a minute,
   * or not at all with `revalidate`; after that Daytona is asked again, so a sandbox deleted or
   * stopped behind our back is noticed instead of failing every later call.
   */
  private async connect(
    id: string,
    revalidate = false,
  ): Promise<{ sandbox: DaytonaSandbox; started: boolean }> {
    const existing = this.boxes.get(id);
    if (
      existing &&
      !revalidate &&
      Date.now() - (this.checkedAt.get(id) ?? 0) < DAYTONA_HANDLE_PROBE_MS
    ) {
      return { sandbox: existing, started: false };
    }
    const pending = this.connections.get(id);
    if (pending) return pending;
    let connection!: Promise<{ sandbox: DaytonaSandbox; started: boolean }>;
    connection = (async () => {
      const sandbox = await this.client.get(id).catch(async (error: unknown) => {
        throw (await isDaytonaSandboxMissing(error)) ? daytonaSandboxGoneError(id, error) : error;
      });
      const started = await startDaytonaSandbox(sandbox);
      if (this.connections.get(id) !== connection) {
        throw new Error("Daytona connection was invalidated during teardown");
      }
      this.boxes.set(id, sandbox);
      this.checkedAt.set(id, Date.now());
      return { sandbox, started };
    })()
      .catch((error: unknown) => {
        if (isSandboxGoneError(error) && this.connections.get(id) === connection) this.forget(id);
        throw error;
      })
      .finally(() => {
        if (this.connections.get(id) === connection) this.connections.delete(id);
      });
    this.connections.set(id, connection);
    return connection;
  }

  private async box(computer: ComputerRef): Promise<DaytonaSandbox> {
    return (await this.connect(computer.providerRef || computer.id)).sandbox;
  }

  private async findForTeardown(id: string): Promise<DaytonaSandbox | undefined> {
    const existing = this.boxes.get(id);
    if (existing) return existing;
    try {
      return await this.client.get(id);
    } catch (error) {
      if (await isDaytonaSandboxMissing(error)) return undefined;
      throw error;
    }
  }

  private async deleteAbandoned(name: string): Promise<void> {
    try {
      await (await this.client.get(name)).delete(60);
    } catch (error) {
      if (!(await isDaytonaSandboxMissing(error))) {
        getLogger().error("delete Daytona sandbox left by a failed create", error);
      }
    }
  }

  private async workspaceRoot(sandbox: DaytonaSandbox): Promise<string> {
    const cached = this.workspaceRoots.get(sandbox.id);
    if (cached) return cached;
    const home = (await sandbox.getUserHomeDir()) ?? (await sandbox.getWorkDir());
    if (!home) throw new Error("Daytona did not report a sandbox home directory");
    const root = path.posix.join(home, "rakazo-home");
    if (this.boxes.get(sandbox.id) === sandbox) this.workspaceRoots.set(sandbox.id, root);
    return root;
  }

  private async prepareWorkspace(sandbox: DaytonaSandbox): Promise<void> {
    if (this.prepared.has(sandbox.id)) return;
    const pending = this.preparations.get(sandbox.id);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      const root = await this.workspaceRoot(sandbox);
      const result = await sandbox.process.executeCommand(`mkdir -p -- ${shellQuote(root)}`);
      if (result.exitCode !== 0) {
        throw new Error(result.result || "could not create Daytona workspace");
      }
      const runtime = await sandbox.process.executeCommand(
        `bash -c ${shellQuote(PREPARE_LINUX_DESKTOP)}`,
        undefined,
        undefined,
        300,
      );
      if (runtime.exitCode !== 0) throw new Error("could not prepare computer desktop tools");
      const pageBrowser = await sandbox.process
        .executeCommand(
          `bash -c ${shellQuote(installPageBrowserCommand())}`,
          undefined,
          undefined,
          120,
        )
        .catch(() => ({ exitCode: 1 }));
      if (pageBrowser.exitCode !== 0)
        getLogger().warn("sandbox.page_browser", {
          provider: "daytona",
          outcome: "install_failed",
        });
      if (this.preparations.get(sandbox.id) !== preparation) {
        throw new Error("Daytona workspace preparation was invalidated during teardown");
      }
      this.prepared.add(sandbox.id);
    })().finally(() => {
      if (this.preparations.get(sandbox.id) === preparation) {
        this.preparations.delete(sandbox.id);
      }
    });
    this.preparations.set(sandbox.id, preparation);
    return preparation;
  }

  private async writeFiles(sandbox: DaytonaSandbox, files: readonly PortableFile[]): Promise<void> {
    if (!files.length) return;
    const root = await this.workspaceRoot(sandbox);
    const directories = new Set(
      files.map((file) => path.posix.dirname(workspacePath(root, file.path))),
    );
    const mkdir = await sandbox.process.executeCommand(
      `mkdir -p -- ${[...directories].map(shellQuote).join(" ")}`,
    );
    if (mkdir.exitCode !== 0) throw new Error(mkdir.result || "could not create file directories");
    await Promise.all(
      files.map((file) =>
        sandbox.fs.uploadFile(
          Buffer.from(file.content.buffer, file.content.byteOffset, file.content.byteLength),
          workspacePath(root, file.path),
        ),
      ),
    );
    const executable = files
      .filter((file) => file.executable)
      .map((file) => shellQuote(workspacePath(root, file.path)));
    if (executable.length) {
      const chmod = await sandbox.process.executeCommand(`chmod 700 -- ${executable.join(" ")}`);
      if (chmod.exitCode !== 0) throw new Error(chmod.result || "could not mark files executable");
    }
  }

  private async screenPreview(sandbox: DaytonaSandbox, screenKey: string, viewPort: number) {
    const previewKey = `${sandbox.id}:${screenKey}:${viewPort}`;
    const cached = this.screenPreviews.get(previewKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
    const pending = this.screenPreviewStarts.get(previewKey);
    if (pending) return pending;
    let start!: Promise<{
      url: string;
      token: string;
      expiresAt: number;
      viewPort: number;
    }>;
    start = sandbox
      .getSignedPreviewUrl(viewPort, DAYTONA_SCREEN_TTL_SECONDS)
      .then(async (preview) => {
        const cachedPreview = {
          url: preview.url,
          token: preview.token,
          expiresAt: Date.now() + DAYTONA_SCREEN_TTL_SECONDS * 1_000,
          viewPort,
        };
        if (this.screenPreviewStarts.get(previewKey) !== start) {
          await sandbox.expireSignedPreviewUrl(viewPort, preview.token).catch(() => undefined);
          throw new Error("Daytona screen preview was invalidated during teardown");
        }
        this.screenPreviews.set(previewKey, cachedPreview);
        return cachedPreview;
      })
      .finally(() => {
        if (this.screenPreviewStarts.get(previewKey) === start) {
          this.screenPreviewStarts.delete(previewKey);
        }
      });
    this.screenPreviewStarts.set(previewKey, start);
    return start;
  }

  private async revokeScreenPreview(
    sandbox: DaytonaSandbox,
    preview: { url: string; token: string; expiresAt: number; viewPort: number } | undefined,
  ): Promise<void> {
    if (!preview) return;
    await sandbox.expireSignedPreviewUrl(preview.viewPort, preview.token).catch(() => undefined);
  }

  private forget(id: string): void {
    this.boxes.delete(id);
    this.checkedAt.delete(id);
    this.connections.delete(id);
    this.workspaceRoots.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
    for (const key of [...this.screenPreviews.keys()]) {
      if (key.startsWith(`${id}:`)) this.screenPreviews.delete(key);
    }
    for (const key of [...this.screenPreviewStarts.keys()]) {
      if (key.startsWith(`${id}:`)) this.screenPreviewStarts.delete(key);
    }
  }
}

export async function createDaytonaSandboxProvider(
  config: DaytonaConfig & { apiKey: string; snapshot?: string },
): Promise<DaytonaSandboxProvider> {
  const { Daytona } = await daytonaSdk();
  const { apiKey, apiUrl, target } = config;
  return new DaytonaSandboxProvider(config, new Daytona({ apiKey, apiUrl, target }));
}

/** Only for calls that address the sandbox itself: get, refresh and delete. */
async function isDaytonaSandboxMissing(error: unknown): Promise<boolean> {
  const { DaytonaGoneError, DaytonaNotFoundError } = await daytonaSdk();
  if (error instanceof DaytonaNotFoundError || error instanceof DaytonaGoneError) return true;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || status === 410;
}

/** Named so the shared isSandboxGoneError recognizes it and the computer is replaced. */
function daytonaSandboxGoneError(id: string, cause?: unknown): Error {
  return sandboxNotFoundError(`Daytona sandbox ${id} is gone`, { cause });
}

async function refreshDaytonaSandbox(sandbox: DaytonaSandbox): Promise<void> {
  try {
    await sandbox.refreshData();
  } catch (error) {
    throw (await isDaytonaSandboxMissing(error))
      ? daytonaSandboxGoneError(sandbox.id, error)
      : error;
  }
}

/**
 * Drives a sandbox to started from whatever state Daytona reports, and returns whether it was
 * not running before. Throws the gone error when Daytona can no longer run it.
 */
async function startDaytonaSandbox(sandbox: DaytonaSandbox): Promise<boolean> {
  const {
    DaytonaBadRequestError,
    DaytonaConflictError,
    DaytonaGoneError,
    DaytonaNotFoundError,
    DaytonaTimeoutError,
    SandboxState,
  } = await daytonaSdk();
  const wasRunning = sandbox.state === SandboxState.STARTED;
  const begun = Date.now();
  let deadline = begun + DAYTONA_START_TIMEOUT_MS;
  let recovered = false;
  const seconds = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
  for (;;) {
    const state = sandbox.state ?? SandboxState.UNKNOWN;
    // Restores get a longer budget, still counted from the start so polling cannot extend it.
    if (state === SandboxState.ARCHIVED || state === SandboxState.RESTORING) {
      deadline = begun + DAYTONA_RESTORE_TIMEOUT_MS;
    }
    try {
      switch (state) {
        case SandboxState.STARTED:
          return !wasRunning;
        case SandboxState.STOPPED:
        case SandboxState.PAUSED:
        case SandboxState.ARCHIVED:
          await sandbox.start(seconds());
          break;
        case SandboxState.ERROR:
        case SandboxState.BUILD_FAILED:
          if (!sandbox.recoverable || recovered) throw daytonaSandboxGoneError(sandbox.id);
          recovered = true;
          await sandbox.recover(seconds());
          break;
        case SandboxState.DESTROYED:
        case SandboxState.DESTROYING:
          throw daytonaSandboxGoneError(sandbox.id);
        case SandboxState.CREATING:
        case SandboxState.RESTORING:
        case SandboxState.STARTING:
        case SandboxState.RESUMING:
        case SandboxState.PENDING_BUILD:
        case SandboxState.BUILDING_SNAPSHOT:
        case SandboxState.PULLING_SNAPSHOT:
        case SandboxState.RESIZING:
        case SandboxState.SNAPSHOTTING:
        case SandboxState.FORKING:
          if (sandbox.desiredState === SandboxState.STARTED) {
            await sandbox.waitUntilStarted(seconds());
          }
          break;
        // Let these settle, then act on the state they land in.
        case SandboxState.STOPPING:
        case SandboxState.ARCHIVING:
        case SandboxState.PAUSING:
        case SandboxState.UNKNOWN:
        case SandboxState.UNKNOWN_DEFAULT_OPEN_API:
          break;
        default: {
          const unexpected: never = state;
          throw new Error(`unexpected Daytona sandbox state ${String(unexpected)}`);
        }
      }
    } catch (error) {
      if (error instanceof DaytonaGoneError) throw daytonaSandboxGoneError(sandbox.id, error);
      // A 400 usually means our cached state was stale, and a 404 can name something other
      // than the sandbox, such as its region. Act on the real state, or fail if it is unchanged.
      if (error instanceof DaytonaBadRequestError || error instanceof DaytonaNotFoundError) {
        await refreshDaytonaSandbox(sandbox);
        if (sandbox.state === state) throw error;
        continue;
      }
      // 409 means another state change is in progress, and a status-less error means a wait
      // saw the sandbox fail. Either way, re-read the state and act on it.
      if (!(error instanceof DaytonaConflictError) && !(await isFailedDaytonaTransition(error))) {
        throw error;
      }
    }
    if (sandbox.state === SandboxState.STARTED) return !wasRunning;
    if (Date.now() >= deadline) {
      throw new DaytonaTimeoutError(`Daytona sandbox ${sandbox.id} is still ${sandbox.state}`);
    }
    await abortableDelay(DAYTONA_POLL_MS);
    await refreshDaytonaSandbox(sandbox);
  }
}

/**
 * Drives a sandbox to a state that no longer runs it. Already stopped, archived, errored and
 * deleted sandboxes have nothing to stop, so teardown succeeds instead of failing every retry.
 */
async function stopDaytonaSandbox(sandbox: DaytonaSandbox): Promise<void> {
  const {
    DaytonaBadRequestError,
    DaytonaConflictError,
    DaytonaGoneError,
    DaytonaNotFoundError,
    DaytonaTimeoutError,
    SandboxState,
  } = await daytonaSdk();
  const deadline = Date.now() + DAYTONA_STOP_TIMEOUT_MS;
  const seconds = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
  try {
    for (;;) {
      const state = sandbox.state ?? SandboxState.UNKNOWN;
      try {
        switch (state) {
          case SandboxState.STOPPED:
          case SandboxState.ARCHIVED:
          case SandboxState.ARCHIVING:
          case SandboxState.ERROR:
          case SandboxState.BUILD_FAILED:
          case SandboxState.DESTROYED:
          case SandboxState.DESTROYING:
            return;
          case SandboxState.STARTED:
          case SandboxState.PAUSED:
            await sandbox.stop(seconds());
            continue;
          // Let these settle, then act on the state they land in.
          case SandboxState.STOPPING:
          case SandboxState.CREATING:
          case SandboxState.RESTORING:
          case SandboxState.STARTING:
          case SandboxState.RESUMING:
          case SandboxState.PAUSING:
          case SandboxState.PENDING_BUILD:
          case SandboxState.BUILDING_SNAPSHOT:
          case SandboxState.PULLING_SNAPSHOT:
          case SandboxState.RESIZING:
          case SandboxState.SNAPSHOTTING:
          case SandboxState.FORKING:
          case SandboxState.UNKNOWN:
          case SandboxState.UNKNOWN_DEFAULT_OPEN_API:
            break;
          default: {
            const unexpected: never = state;
            throw new Error(`unexpected Daytona sandbox state ${String(unexpected)}`);
          }
        }
      } catch (error) {
        if (error instanceof DaytonaGoneError) return;
        // Stale cached state, or a 404 that may name something other than the sandbox.
        if (error instanceof DaytonaBadRequestError || error instanceof DaytonaNotFoundError) {
          await refreshDaytonaSandbox(sandbox);
          if (sandbox.state === state) throw error;
          continue;
        }
        // 409 or a wait that saw the sandbox fail: re-read the state and act on it.
        if (!(error instanceof DaytonaConflictError) && !(await isFailedDaytonaTransition(error))) {
          throw error;
        }
      }
      if (Date.now() >= deadline) {
        throw new DaytonaTimeoutError(`Daytona sandbox ${sandbox.id} is still ${sandbox.state}`);
      }
      await abortableDelay(DAYTONA_POLL_MS);
      await refreshDaytonaSandbox(sandbox);
    }
  } catch (error) {
    if (isSandboxGoneError(error)) return;
    throw error;
  }
}

async function isFailedDaytonaTransition(error: unknown): Promise<boolean> {
  const { DaytonaError, DaytonaTimeoutError } = await daytonaSdk();
  return (
    error instanceof DaytonaError &&
    error.statusCode === undefined &&
    !(error instanceof DaytonaTimeoutError)
  );
}

function isDaytonaExecutable(mode: string, permissions: string): boolean {
  return /x/.test(permissions) || (Number.parseInt(mode, 8) & 0o100) !== 0;
}

async function* walkDaytonaWorkspace(
  sandbox: DaytonaSandbox,
  root: string,
  directory: string,
  context: AdapterContext,
): AsyncIterable<PortableFile> {
  if (context.signal.aborted) throw context.signal.reason ?? new Error("export aborted");
  const entries = await sandbox.fs.listFiles(workspacePath(root, directory));
  const files = entries
    .filter((entry) => !entry.isDir)
    .map((entry) => ({
      entry,
      relative: normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name),
    }))
    .filter(({ relative }) => !shouldSkipPortableWorkspaceFile(relative));
  const directories = entries.filter((entry) => entry.isDir);
  for (const entries of daytonaExportBatches(files)) {
    const batch = await Promise.all(
      entries.map(async ({ entry, relative }) => {
        const content = await sandbox.fs.downloadFile(workspacePath(root, relative));
        return {
          path: relative,
          content: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
          executable: isDaytonaExecutable(entry.mode, entry.permissions),
        };
      }),
    );
    for (const file of batch) yield file;
  }
  for (const entry of directories) {
    const relative = normalizeWorkspacePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (!shouldSkipPortableWorkspaceFile(relative, true)) {
      yield* walkDaytonaWorkspace(sandbox, root, relative, context);
    }
  }
}

function daytonaExportBatches<T extends { entry: { size: number } }>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  const batcher = new PortableFileBatcher<T>(8, (file) => file.entry.size);
  for (const file of files) {
    const full = batcher.add(file);
    if (full?.length) batches.push(full);
  }
  const last = batcher.take();
  if (last.length) batches.push(last);
  return batches;
}
