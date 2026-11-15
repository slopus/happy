import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BoatApi,
  Sandbox as BoatMachine,
  Command200Response,
  CommandResponse,
  FileUrlResponse,
  SandboxStateEnum,
  SandboxTypeEnum,
  SavedSnapshot,
} from "@boatdev/sdk";
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
  StreamedPortableFile,
  TerminalRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import {
  SandboxDamagedError,
  SandboxRateLimitError,
  SandboxSizeUnavailableError,
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import type { ComputerSize } from "@rakazo/contracts";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import {
  BoatApiError,
  BoatRequestGate,
  boatResponseError,
  boatSdk,
  callerSignal,
  wrapBoatCall,
} from "./boat-errors.js";
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
  LinuxDesktop,
  onBotScreen,
  PREPARE_LINUX_DESKTOP,
  VERIFY_LINUX_DESKTOP,
} from "./linux-desktop.js";
import { installChromeUseCommand, installPageBrowserCommand } from "./page-browser-install.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { abortedCommandEvents, timedOutCommandEvents } from "./sandbox-command-events.js";
import { isSandboxGoneError, sandboxNotFoundError } from "./sandbox-errors.js";
import { shellExportScript, sourceEnvironmentCommand } from "./sandbox-shell-environment.js";
import { withAbort } from "./web-ssrf.js";
import { readWorkspaceArchive } from "./workspace-archive.js";
import {
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindCommand,
} from "./workspace-save-policy.js";

const DISPLAY_START = 20;
const BOAT_API_BASE = "https://boat.dev/api/v1";
const BOAT_HOME = "/home/user";
const BOAT_WORKSPACE = `${BOAT_HOME}/rakazo-home`;
const BOAT_BROWSER_PROFILES = `${BOAT_WORKSPACE}/.browser-profiles`;
/** Outside the workspace so checkpoints never carry it. Boat runs every command as `user`. */
const BOAT_COMMAND_ENV = "/home/user/.rakazo-command-env";
/** Where an export archives the workspace; outside it for the same reason. */
const BOAT_ARCHIVE_PREFIX = "/tmp/rakazo-workspace-archive-";
const BOAT_READY_TIMEOUT_MS = 5 * 60_000;
const BOAT_RECOVER_POLL_MAX_MS = 15_000;
/**
 * Status polls start fast so short waits stay quick, then slow to this. Every Boat request from
 * this host counts against one per-IP budget.
 */
const BOAT_POLL_MAX_MS = 5_000;
/** The output of a finished detached command keeps at most this much of each stream's end. */
const BOAT_COMMAND_TAIL_BYTES = 1_000_000;
const BOAT_API_COMMAND_TIMEOUT_SECONDS = 600;
const BOAT_TTL_SECONDS = 2 * 60 * 60;
const BOAT_DELETE_TIMEOUT_MS = 60_000;
const BOAT_GONE_CHECK_TIMEOUT_MS = 10_000;
/**
 * Without these, a call Boat never answers waits out Node's five-minute header timeout. Resumes
 * usually answer within seconds; a slow one that is cut off keeps going, and the next resume
 * waits on it.
 */
const BOAT_GET_TIMEOUT_MS = 60_000;
const BOAT_RESUME_TIMEOUT_MS = 2 * 60_000;
/** Archiving runs detached: Node's fetch drops a response with no headers after 300 seconds. */
const BOAT_ARCHIVE_TIMEOUT_MS = 9 * 60_000;
/** A whole workspace downloads as one archive, so it gets longer than a single file. */
const BOAT_ARCHIVE_TRANSFER_TIMEOUT_MS = 30 * 60_000;
const BOAT_INLINE_FILE_MAX_BYTES = 5 * 1024 * 1024;
const BOAT_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
const BOAT_TRANSFER_TIMEOUT_MS = 5 * 60_000;
/** Boat archives an abandoned build sandbox soon after a crashed build. */
const BOAT_SNAPSHOT_BUILD_TTL_SECONDS = 30 * 60;

/** Boat's machine type for each computer size: 4, 8 and 16 vCPUs with 8, 16 and 32 GB. */
const BOAT_MACHINE_TYPES: Record<ComputerSize, SandboxTypeEnum> = {
  standard: "default",
  large: "large",
  xlarge: "xlarge",
};

const BOAT_API_METHODS = [
  "artifactRaw",
  "attachCommandRaw",
  "command",
  "commandStatus",
  "create",
  "createDownloadUrl",
  "createUploadUrl",
  "get",
  "getSavedSnapshot",
  "hostPort",
  "recover",
  "resume",
  "saveSavedSnapshot",
  "stop",
  "update",
  "writeFile",
] as const;

/** The Boat API surface the adapter uses. Failures are the SDK's raw `ResponseError`s. */
export type BoatSandboxSdk = Pick<BoatApi, (typeof BOAT_API_METHODS)[number]> & {
  /** Resolves once the sandbox no longer exists, including when it never did. */
  deleteSandbox(sandboxId: string): Promise<void>;
};

const RUNNABLE_STATES = new Set<SandboxStateEnum>(["ready", "idle", "running"]);
const BOAT_NOT_RUNNING_CODES = new Set([
  "sandbox_not_ready",
  "machine_not_running",
  "sandbox_resuming",
]);
const BOAT_RECOVER_WAIT_CODES = new Set([
  "sandbox_is_reachable",
  "too_soon",
  "recover_unsupported",
  "reset_failed",
]);

interface BoatCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export class BoatSandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly client: BoatSandboxSdk;
  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/user",
      workspaceDir: BOAT_WORKSPACE,
      browserProfilesDir: BOAT_BROWSER_PROFILES,
      displayStart: DISPLAY_START,
      portStart: 6100,
      // The provider port proxy reaches the isolated sandbox through its network interface.
      bindHost: "0.0.0.0",
    }),
    run: async (computer, command, context) => {
      const result = await this.runCommand(
        this.id(computer),
        `bash -c ${shellQuote(command)}`,
        undefined,
        120_000,
        context.signal,
      );
      return {
        code: result.timedOut ? 124 : result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    screenUrl: async (computer, port, context) => {
      const id = this.id(computer);
      const hosted = await this.whenRunnable(id, context.signal, () =>
        this.client.hostPort(
          { sandboxId: id, hostPortRequest: { port, _public: false } },
          { signal: context.signal },
        ),
      );
      if (!hosted.url) throw new Error("Boat did not return a desktop URL");
      const url = new URL(hosted.url);
      if (
        url.protocol !== "https:" ||
        !url.hostname.endsWith(".on.boat.dev") ||
        !url.searchParams.get("_token")
      )
        throw new Error("Boat desktop URL is not protected");
      url.pathname = "/vnc.html";
      return url.toString();
    },
    runWithInput: async (computer, command, input, timeoutMs, context) => {
      const id = this.id(computer);
      const inputFile = `${BOAT_COMMAND_ENV}/${randomUUID()}`;
      let removed = false;
      try {
        await this.writePrivateFile(id, inputFile, input, context.signal);
        const result = await this.runCommand(
          id,
          `exec 0< ${shellQuote(inputFile)} || exit 1; rm -f -- ${shellQuote(inputFile)}; ${command}`,
          undefined,
          timeoutMs,
          context.signal,
        );
        removed = !result.timedOut;
        return { code: result.timedOut ? 124 : result.exitCode, stdout: result.stdout };
      } finally {
        if (!removed) {
          await this.rawCommand(id, `rm -f -- ${shellQuote(inputFile)}`, 10).catch(() => undefined);
        }
      }
    },
  });
  private readonly pendingProvisions = new Map<string, Promise<ComputerRef>>();
  private readonly prepared = new Set<string>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly baseSnapshot = new BaseSnapshotCache({
    provider: "boat",
    name: BOAT_COMPUTER_SNAPSHOT,
    build: () => this.buildComputerSnapshot(),
    warnMissingOnce: true,
  });

  constructor(config: { apiKey: string; apiUrl?: string }, api?: BoatSandboxSdk) {
    const gate = new BoatRequestGate();
    this.client = boatClient(api ?? createBoatSdk(config, gate), config.apiKey, gate);
  }

  describe() {
    return {
      id: "boat",
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
      savedAt?: Date;
      size?: ComputerSize;
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const reconnecting = request.providerRef && request.providerKind === "boat";
    const key = reconnecting ? request.providerRef! : `new:${request.botId}`;
    const pending = this.pendingProvisions.get(key);
    if (pending) return pending;
    let provision!: Promise<ComputerRef>;
    provision = this.provisionOnce(request, context).finally(() => {
      if (this.pendingProvisions.get(key) === provision) this.pendingProvisions.delete(key);
    });
    this.pendingProvisions.set(key, provision);
    return provision;
  }

  private async provisionOnce(
    request: {
      botId: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
      savedAt?: Date;
      size?: ComputerSize;
    },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    const type = request.size ? BOAT_MACHINE_TYPES[request.size] : undefined;
    if (request.providerRef && request.providerKind === "boat") {
      try {
        const started = await this.ensureRunnable(request.providerRef, context.signal, {
          savedAt: request.savedAt,
          type,
        });
        return { ...this.ref(request.providerRef, request.botId, false), started };
      } catch (error) {
        if (!isSandboxGoneError(error)) throw error;
        this.forget(request.providerRef);
      }
    }

    const create = (from?: string) =>
      this.client.create(
        {
          createSandboxRequest: {
            ttlSeconds: BOAT_TTL_SECONDS,
            noEnv: true,
            env: {
              RAKAZO_BOT_ID: request.botId,
              RAKAZO_SANDBOX: "computer",
            },
            ...(from ? { from } : {}),
            ...(type ? { type } : {}),
          },
        },
        { signal: context.signal },
      );
    const from = await this.computerSnapshot(context.signal);
    let created: Awaited<ReturnType<typeof create>>;
    try {
      created = await create(from);
    } catch (error) {
      if (!from || !(error instanceof BoatApiError) || error.code !== "snapshot_not_found") {
        throw boatSizeError(error);
      }
      // Removed from the account since this process saw it; rebuild it and install as before.
      this.baseSnapshot.lost();
      created = await create().catch((failure: unknown) => {
        throw boatSizeError(failure);
      });
    }
    return this.ref(created.sandbox.id, request.botId, true);
  }

  /**
   * Builds the saved snapshot new computers start from, unless it is already ready: a fresh
   * sandbox with no account environment and no bot data, with the desktop tools installed
   * and checked. The build sandbox is deleted afterwards.
   */
  async buildComputerSnapshot(
    signal: AbortSignal = AbortSignal.timeout(BASE_SNAPSHOT_BUILD_TIMEOUT_MS),
  ): Promise<{ name: string; built: boolean }> {
    const name = BOAT_COMPUTER_SNAPSHOT;
    // A save already in progress, from another process or an earlier run, may finish it.
    if ((await this.settledSnapshot(name, signal))?.status === "ready") {
      return { name, built: false };
    }
    const { sandbox } = await this.client.create(
      { createSandboxRequest: { ttlSeconds: BOAT_SNAPSHOT_BUILD_TTL_SECONDS, noEnv: true } },
      { signal },
    );
    try {
      await this.ensureRunnable(sandbox.id, signal);
      for (const command of BOAT_COMPUTER_SETUP) {
        const result = await this.runCommand(sandbox.id, command, undefined, 15 * 60_000, signal);
        if (result.exitCode !== 0 || result.timedOut) {
          throw new Error("could not prepare the Boat computer snapshot", {
            cause: new Error(commandFailure(result)),
          });
        }
      }
      await this.client.saveSavedSnapshot(
        { savedSnapshotSaveRequest: { sandboxId: sandbox.id, name } },
        { signal },
      );
      const snapshot = await this.settledSnapshot(name, signal);
      if (snapshot?.status !== "ready") {
        throw new Error(`Boat could not save snapshot ${name}`, {
          cause: snapshot?.error ? new Error(snapshot.error) : undefined,
        });
      }
      return { name, built: true };
    } finally {
      await this.client.deleteSandbox(sandbox.id).catch(() => undefined);
    }
  }

  /** The saved snapshot once any save in progress has finished, or undefined when absent. */
  private async settledSnapshot(
    name: string,
    signal: AbortSignal,
  ): Promise<SavedSnapshot | undefined> {
    for (let pause = 2_000; ; pause = nextPoll(pause)) {
      const snapshot = await this.savedSnapshot(name, signal);
      if (snapshot?.status !== "saving") return snapshot;
      await delay(pause, undefined, { signal });
    }
  }

  /** The snapshot a new computer starts from, once it is ready. */
  private computerSnapshot(signal: AbortSignal): Promise<string | undefined> {
    return this.baseSnapshot.current(signal, async () => {
      const snapshot = await this.savedSnapshot(BOAT_COMPUTER_SNAPSHOT, signal);
      return snapshot?.status === "ready"
        ? "ready"
        : snapshot?.status === "saving"
          ? "saving"
          : "absent";
    });
  }

  private async savedSnapshot(
    name: string,
    signal: AbortSignal,
  ): Promise<SavedSnapshot | undefined> {
    try {
      return (await this.client.getSavedSnapshot({ name }, { signal })).snapshot;
    } catch (error) {
      if (error instanceof BoatApiError && error.response.status === 404) return undefined;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    if (this.prepared.has(id)) return;
    const pending = this.preparations.get(id);
    if (pending) return pending;
    let preparation!: Promise<void>;
    preparation = (async () => {
      await this.ensureRunnable(id, context.signal);
      const result = await this.runCommand(
        id,
        configureBoatWorkspaceCommand(),
        undefined,
        60_000,
        context.signal,
      );
      // Creating two directories outlasting a minute means the machine stopped answering.
      if (result.timedOut)
        throw new SandboxUnresponsiveError("could not prepare Boat workspace (timed out)");
      if (result.exitCode !== 0) {
        throw new Error(`could not prepare Boat workspace (${commandFailure(result)})`);
      }
      const runtime = await this.runCommand(
        id,
        PREPARE_LINUX_DESKTOP,
        undefined,
        180_000,
        context.signal,
      );
      if (runtime.exitCode !== 0 || runtime.timedOut)
        throw new Error("could not prepare computer desktop tools", {
          cause: new Error(commandFailure(runtime)),
        });
      const pageBrowser = await this.runCommand(
        id,
        installPageBrowserCommand(),
        undefined,
        120_000,
        context.signal,
      );
      // Without it the page tools fall back to the desktop tools, which still work.
      if (pageBrowser.exitCode !== 0 || pageBrowser.timedOut)
        getLogger().warn("sandbox.page_browser", {
          provider: "boat",
          outcome: "install_failed",
          error: commandFailure(pageBrowser),
        });
      if (this.preparations.get(id) !== preparation) {
        throw new Error("Boat workspace preparation was invalidated during teardown");
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
    // Boat's command API has no env field, and command text shows in `ps` and Boat's logs.
    const environment = shellExportScript(request.env ?? {});
    const envFile = environment ? `${BOAT_COMMAND_ENV}/${randomUUID()}` : undefined;
    let envFileRemoved = !envFile;
    try {
      if (envFile) await this.writePrivateFile(id, envFile, environment, context.signal);
      const result = await this.runCommand(
        id,
        envFile ? sourceEnvironmentCommand(envFile, argv) : argv,
        path.posix.relative(BOAT_HOME, workspaceCwd(BOAT_WORKSPACE, request.cwd, [BOAT_HOME])),
        timeoutMs,
        context.signal,
      );
      envFileRemoved = !envFile || !result.timedOut;
      if (context.signal.aborted) {
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
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        yield* abortedCommandEvents();
        return;
      }
      throw error;
    } finally {
      // The command removes the file as it starts; this covers a command that never did.
      if (!envFileRemoved) {
        await this.rawCommand(id, `rm -f -- ${shellQuote(envFile!)}`, 10).catch(() => undefined);
      }
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.authenticatedScreen(await this.desktops.connectScreen(computer, request, context));
  }
  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.authenticatedScreen(
      await this.desktops.connectTerminal(computer, request, context),
    );
  }
  /** Boat's query token bootstraps a browser cookie through a redirect. Keep it server-side. */
  private authenticatedScreen<T extends { url: string | null }>(
    session: T,
  ): T & { headers?: Record<string, string> } {
    if (!session.url) return session;
    const url = new URL(session.url);
    const token = url.searchParams.get("_token");
    if (!token || !/^[a-zA-Z0-9_-]+$/.test(token))
      throw new Error("Boat desktop URL is not protected");
    url.searchParams.delete("_token");
    const socket = new URL(url.searchParams.get("path")!, url);
    socket.searchParams.delete("_token");
    url.searchParams.set("path", `${socket.pathname}${socket.search}`);
    return { ...session, url: url.toString(), headers: { cookie: `_port_auth=${token}` } };
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
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const result = await this.runCommand(
      this.id(computer),
      listBoatFilesCommand(workspacePath(BOAT_WORKSPACE, relative)),
      undefined,
      60_000,
      context.signal,
    );
    // The file browser can ask for a folder deleted since it last listed.
    if (result.exitCode === BOAT_LISTING_MISSING && !result.timedOut) return [];
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`could not list Boat workspace (${commandStatus(result)})`);
    }
    return parseBoatFileEntries(Buffer.from(result.stdout, "base64"));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    return this.readRemoteFile(
      this.id(computer),
      workspacePath(BOAT_WORKSPACE, filePath),
      context.signal,
      options?.maxBytes,
    );
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.writeFiles(this.id(computer), [file], context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile | StreamedPortableFile> {
    const id = this.id(computer);
    await this.desktops.stopBrowsers(computer, context);
    // One archive, not a request per file: Boat rate limits every API call by IP, and a
    // workspace can hold thousands of files.
    const archive = `${BOAT_ARCHIVE_PREFIX}${randomUUID()}.tar.gz`;
    try {
      const result = await this.runCommand(
        id,
        archiveBoatWorkspaceCommand(archive, { limits }),
        undefined,
        BOAT_ARCHIVE_TIMEOUT_MS,
        context.signal,
        true,
      );
      if (!result.timedOut && result.exitCode === BOAT_ARCHIVE_TOO_MANY_FILES) {
        throw new WorkspaceTooLargeError("files");
      }
      if (!result.timedOut && result.exitCode === BOAT_ARCHIVE_TOO_MANY_BYTES) {
        throw new WorkspaceTooLargeError("bytes");
      }
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error(`could not archive Boat workspace (${commandStatus(result)})`);
      }
      const response = await this.signedDownload(
        id,
        archive,
        context.signal,
        BOAT_ARCHIVE_TRANSFER_TIMEOUT_MS,
      );
      if (!response.body) throw new Error("Boat returned an empty workspace archive");
      for await (const file of readWorkspaceArchive(response.body, limits)) {
        if (!shouldSkipPortableWorkspaceFile(file.path)) yield file;
      }
    } finally {
      await this.rawCommand(id, `rm -f -- ${shellQuote(archive)}`, 10).catch(() => undefined);
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    const id = this.id(computer);
    await this.desktops.stopBrowsers(computer, context);
    // A restore can land on a computer that kept its disk, which can hold read-only files such as
    // git packs, and Boat's file API cannot replace a read-only file.
    const writable = await this.runCommand(
      id,
      BOAT_WRITABLE_WORKSPACE_COMMAND,
      undefined,
      60_000,
      context.signal,
    );
    if (writable.timedOut)
      throw new Error("could not prepare Boat workspace for restore (timed out)");
    const batcher = new PortableFileBatcher<PortableFile>(8, (file) => file.content.byteLength);
    const flush = async (batch: PortableFile[]) => {
      if (!batch.length) return;
      await this.writeFiles(id, batch, context);
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
    await this.client.update({
      sandboxId: this.id(computer),
      updateSandboxRequest: { ttlSeconds: BOAT_TTL_SECONDS },
    });
  }

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "boat") return false;
    try {
      // Its caller retries an unread status itself, so a rate limit's wait is cut short here.
      const { sandbox } = await this.client.get(
        { sandboxId: this.id(computer) },
        {
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(BOAT_GONE_CHECK_TIMEOUT_MS),
          ]),
        },
      );
      return RUNNABLE_STATES.has(sandbox.state);
    } catch (error) {
      if (isSandboxGoneError(error)) return false;
      throw error;
    }
  }

  async isStopped(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    try {
      const { sandbox } = await this.client.get(
        { sandboxId: this.id(computer) },
        { signal: context.signal },
      );
      return sandbox.state === "archived" && !sandbox.dataExpiredAt;
    } catch (error) {
      if (isSandboxGoneError(error)) return false;
      throw error;
    }
  }

  /**
   * Boat saves the disk before it archives, and refuses the stop while that save keeps failing,
   * leaving the sandbox running. With `discardUnsaved` such a stop is forced, which keeps Boat's
   * last good snapshot.
   */
  async stop(
    computer: ComputerRef,
    context: AdapterContext,
    options?: { discardUnsaved?: boolean },
  ): Promise<void> {
    const id = this.id(computer);
    try {
      const { sandbox } = await this.client.get({ sandboxId: id }, { signal: context.signal });
      // A cancelled sandbox never got a machine, so there is nothing to stop.
      if (sandbox.state === "cancelled") return;
      if (sandbox.state !== "archived" && sandbox.state !== "archiving") {
        await this.client.stop({ sandboxId: id }, { signal: context.signal });
      }
      let forced = false;
      await this.waitForState(id, new Set(["archived"]), context, async (current) => {
        if (forced || !options?.discardUnsaved || current.stop?.status !== "failing") return;
        logRecovery("force_stop", "stop_refused");
        await this.client.stop(
          { sandboxId: id, stopRequest: { force: true } },
          { signal: context.signal },
        );
        forced = true;
      });
    } catch (error) {
      if (!isSandboxGoneError(error)) throw error;
    } finally {
      this.forget(id);
    }
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    const id = this.id(computer);
    try {
      await this.client.deleteSandbox(id);
    } catch (error) {
      // Another API key created this sandbox, so this key can never delete it. Retrying cannot
      // help, so the computer is removed here and the sandbox is left to its creator.
      if (!(error instanceof BoatApiError && error.code === "api_key_action_forbidden"))
        throw error;
      getLogger().warn("sandbox.destroy", { provider: "boat", outcome: "not_owned" });
    } finally {
      this.forget(id);
    }
  }

  /**
   * Waits until the sandbox can run commands, resuming or recovering it on the way. Throws a
   * gone error when Boat cannot bring it back, so the caller replaces it from its checkpoint.
   * Returns whether this call started it.
   *
   * A sandbox in `error` follows Boat's documented order: recover it and wait for it to answer;
   * if it still does not, force-stop it to its last good snapshot and resume that. It is gone
   * instead when it has no snapshot, or when the caller's saved workspace is at least as new,
   * since a replacement restores that save in full. The rollback happens only on `reconnect`,
   * before anything runs on the sandbox; elsewhere it is reported unavailable until then. On
   * `reconnect`, a stopped sandbox whose snapshot is older than the saved workspace is gone too.
   */
  private async ensureRunnable(
    id: string,
    signal?: AbortSignal,
    reconnect?: { savedAt?: Date; type?: SandboxTypeEnum },
  ): Promise<boolean> {
    let deadline = Date.now() + BOAT_READY_TIMEOUT_MS;
    let started = false;
    let recovering = false;
    let forced = false;
    let pause = 500;
    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Boat preparation aborted");
      }
      const { sandbox } = await this.client.get({ sandboxId: id }, { signal });
      if (RUNNABLE_STATES.has(sandbox.state)) {
        if (recovering) logRecovery(forced ? "resumed" : "answered");
        return started;
      }
      // `cancelled` is terminal, and a stopped sandbox whose data Boat deleted cannot resume.
      if (sandbox.state === "cancelled" || sandbox.dataExpiredAt) throw boatSandboxGone(id);
      if (sandbox.state === "archived" && !started) {
        // A stop forced past a failing save, or one whose last save failed, keeps an older
        // snapshot than the workspace the caller saved since; that save wins.
        const snapshotAt = sandbox.snapshotCompletedAt;
        if (reconnect?.savedAt && snapshotAt && reconnect.savedAt > snapshotAt) {
          logRecovery("gone", "checkpoint_newer");
          throw boatSandboxGone(id);
        }
        // Only a reconnect moves the sandbox to another size; other wakes keep the one it has.
        await this.resume(id, signal, reconnect?.type);
        started = true;
      } else if (sandbox.state === "error" && !recovering) {
        logRecovery("wait", await this.recover(id, signal, reconnect?.type));
        recovering = started = true;
      }
      if (Date.now() >= deadline) {
        if (sandbox.state !== "error") {
          throw new SandboxUnavailableError({
            cause: new Error(`Boat ${id} did not become ready`),
          });
        }
        const snapshotAt = sandbox.snapshotCompletedAt;
        if (forced || !snapshotAt) {
          logRecovery("gone", forced ? "resume_failed" : "no_snapshot");
          throw boatSandboxGone(id);
        }
        if (!reconnect) {
          logRecovery("deferred");
          throw new SandboxUnavailableError({ cause: new Error(`Boat ${id} is not answering`) });
        }
        if (reconnect.savedAt && reconnect.savedAt >= snapshotAt) {
          logRecovery("gone", "checkpoint_newer");
          throw boatSandboxGone(id);
        }
        // Read just now and still not answering, so the stop cannot cut off live work.
        logRecovery("force_stop");
        await this.client.stop({ sandboxId: id, stopRequest: { force: true } }, { signal });
        forced = true;
        started = false;
        deadline = Date.now() + BOAT_READY_TIMEOUT_MS;
      }
      // A recovering machine usually answers within 1-2 minutes; back off further while it reboots.
      pause = nextPoll(pause, sandbox.state === "error" ? BOAT_RECOVER_POLL_MAX_MS : undefined);
      await delay(pause, undefined, { signal });
    }
  }

  /**
   * Boat archives a sandbox by itself when its TTL runs out, and then refuses work with
   * `sandbox_not_ready` without running it; a machine that stopped underneath it answers
   * `machine_not_running`, and one still waking answers `sandbox_resuming`. Wake or recover
   * it and try once more.
   */
  private async whenRunnable<Result>(
    id: string,
    signal: AbortSignal | undefined,
    call: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await call();
    } catch (error) {
      if (!notRunning(error)) throw error;
      await this.ensureRunnable(id, signal);
      try {
        return await call();
      } catch (retryError) {
        // Boat reported the machine up, then refused again; a later attempt finds it settled.
        if (notRunning(retryError)) throw new SandboxUnavailableError({ cause: retryError });
        throw retryError;
      }
    }
  }

  private async resume(id: string, signal?: AbortSignal, type?: SandboxTypeEnum): Promise<void> {
    try {
      await this.client.resume(
        {
          sandboxId: id,
          resumeRequest: { noEnv: true, ttlSeconds: BOAT_TTL_SECONDS, ...(type ? { type } : {}) },
        },
        { signal },
      );
    } catch (error) {
      // Another job's resume is already bringing it up; the caller waits for that one.
      if (!(error instanceof BoatApiError) || error.code !== "sandbox_resuming")
        throw boatSizeError(error);
    }
  }

  /**
   * Boat's documented way out of the `error` state: power-cycle the machine, or resume. Returns
   * Boat's reason when it refused and the caller can only wait for the sandbox to answer.
   */
  private async recover(
    id: string,
    signal?: AbortSignal,
    type?: SandboxTypeEnum,
  ): Promise<string | undefined> {
    try {
      await this.client.recover({ sandboxId: id }, { signal });
    } catch (error) {
      if (!(error instanceof BoatApiError) || error.response.status !== 409) throw error;
      if (error.code === "no_machine") {
        await this.resume(id, signal, type);
        return error.code;
      }
      // Already answering again, or an earlier recover is still running. A machine Boat cannot
      // power-cycle, or whose power-cycle failed, can still answer again by itself.
      if (error.code && BOAT_RECOVER_WAIT_CODES.has(error.code)) return error.code;
      throw error;
    }
  }

  private async waitForState(
    id: string,
    states: Set<BoatMachine["state"]>,
    context: AdapterContext,
    onWait?: (sandbox: BoatMachine) => Promise<void>,
  ): Promise<BoatMachine> {
    const deadline = Date.now() + BOAT_READY_TIMEOUT_MS;
    for (let pause = 1_000; ; pause = nextPoll(pause)) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("Boat wait aborted");
      const response = await this.client.get({ sandboxId: id }, { signal: context.signal });
      if (states.has(response.sandbox.state)) return response.sandbox;
      if (response.sandbox.state === "error") throw new Error(`Boat ${id} entered the error state`);
      await onWait?.(response.sandbox);
      // A transition Boat has not finished in time is a delay on its side; the caller retries.
      if (Date.now() >= deadline)
        throw new SandboxUnresponsiveError(`Boat ${id} did not reach ${[...states].join("/")}`);
      await delay(pause, undefined, { signal: context.signal });
    }
  }

  /** Writes a file only `user` can read, into the command environment directory. */
  private async writePrivateFile(
    id: string,
    file: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Preparation makes the private directory; repeat it for commands that skipped preparation.
    if (!this.prepared.has(id)) {
      const result = await this.runCommand(
        id,
        commandEnvDirectoryCommand(),
        undefined,
        60_000,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(`could not prepare Boat command environment (${commandFailure(result)})`);
      }
    }
    await this.whenRunnable(id, signal, () =>
      this.client.writeFile(
        {
          sandboxId: id,
          fileWriteRequest: {
            path: file,
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          },
        },
        { signal },
      ),
    );
  }

  private async writeFiles(
    id: string,
    files: readonly PortableFile[],
    context: AdapterContext,
  ): Promise<void> {
    if (!files.length) return;
    await Promise.all(
      files.map((file) =>
        file.content.byteLength > BOAT_INLINE_FILE_MAX_BYTES
          ? this.uploadFile(id, file, context)
          : this.whenRunnable(id, context.signal, () =>
              this.client.writeFile(
                {
                  sandboxId: id,
                  fileWriteRequest: {
                    path: workspacePath(BOAT_WORKSPACE, file.path),
                    content: Buffer.from(file.content).toString("base64"),
                    encoding: "base64",
                  },
                },
                { signal: context.signal },
              ),
            ),
      ),
    );
    const executable = files.map(
      (file) =>
        `${file.executable ? "700" : "600"} ${shellQuote(workspacePath(BOAT_WORKSPACE, file.path))}`,
    );
    const result = await this.runCommand(
      id,
      executable.map((entry) => `chmod ${entry}`).join(" && "),
      undefined,
      60_000,
      context.signal,
    );
    if (result.exitCode !== 0) {
      throw new Error(`could not set Boat file permissions (${commandFailure(result)})`);
    }
  }

  private async uploadFile(id: string, file: PortableFile, context: AdapterContext): Promise<void> {
    context.signal.throwIfAborted();
    const filePath = workspacePath(BOAT_WORKSPACE, file.path);
    const signed = await this.whenRunnable(id, context.signal, () =>
      this.client.createUploadUrl(
        { sandboxId: id, fileUrlRequest: { path: filePath } },
        { signal: context.signal },
      ),
    );
    const url = signedFileUrl(signed, "upload", filePath);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(BOAT_TRANSFER_TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        // A view, not a copy: a large file is held in memory once.
        body: file.content as Uint8Array<ArrayBuffer>,
        headers: { "Content-Type": "application/octet-stream" },
        credentials: "omit",
        redirect: "error",
        signal,
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new SandboxUnresponsiveError("Boat file upload failed");
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw transferError("upload", response.status);
  }

  private async readRemoteFile(
    id: string,
    filePath: string,
    signal?: AbortSignal,
    maxBytes?: number,
    listedSize?: number,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of this.remoteFileChunks(id, filePath, signal, maxBytes, listedSize)) {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const content = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return content;
  }

  /** Streams a file in the chunks it arrives in; stopping early cancels the download. */
  private async *remoteFileChunks(
    id: string,
    filePath: string,
    signal?: AbortSignal,
    maxBytes?: number,
    listedSize?: number,
  ): AsyncGenerator<Uint8Array> {
    const response = await this.fileResponse(id, filePath, signal, maxBytes, listedSize);
    const reader = response.body?.getReader();
    let finished = false;
    let size = 0;
    try {
      if (maxBytes !== undefined && Number(response.headers.get("content-length")) > maxBytes) {
        throw new Error(`computer file exceeds ${maxBytes} bytes`);
      }
      if (!reader) {
        finished = true;
        return;
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (maxBytes !== undefined && size > maxBytes) {
          throw new Error(`computer file exceeds ${maxBytes} bytes`);
        }
        yield value;
      }
      finished = true;
    } finally {
      if (!finished) await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }

  /**
   * The JSON/base64 file endpoint rejects files over 5 MiB and the artifact route files over
   * 50 MiB, and Boat's proxy cuts the artifact route off after about 75 seconds. A file listed
   * over 5 MiB, a larger one, or one the artifact route could not send in time streams from a
   * short-lived URL the sandbox serves itself.
   */
  private async fileResponse(
    id: string,
    filePath: string,
    signal: AbortSignal | undefined,
    maxBytes: number | undefined,
    listedSize = 0,
  ) {
    if (listedSize <= BOAT_INLINE_FILE_MAX_BYTES) {
      try {
        const { raw } = await this.whenRunnable(id, signal, () =>
          this.client.artifactRaw(
            { sandboxId: id, path: filePath },
            signal ? { signal } : undefined,
          ),
        );
        return raw;
      } catch (error) {
        if (isArtifactTooLarge(error)) {
          if (maxBytes !== undefined && maxBytes < BOAT_ARTIFACT_MAX_BYTES) {
            throw new Error(`computer file exceeds ${maxBytes} bytes`);
          }
        } else if (!(error instanceof SandboxUnresponsiveError)) throw error;
      }
    }
    return this.signedDownload(id, filePath, signal);
  }

  private async signedDownload(
    id: string,
    filePath: string,
    signal: AbortSignal | undefined,
    timeoutMs = BOAT_TRANSFER_TIMEOUT_MS,
  ): Promise<Response> {
    signal?.throwIfAborted();
    const signed = await this.whenRunnable(id, signal, () =>
      this.client.createDownloadUrl(
        { sandboxId: id, fileUrlRequest: { path: filePath } },
        signal ? { signal } : undefined,
      ),
    );
    const url = signedFileUrl(signed, "download", filePath);
    const timeout = AbortSignal.timeout(timeoutMs);
    const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: downloadSignal,
      });
    } catch {
      if (downloadSignal.aborted) throw downloadSignal.reason;
      throw new SandboxUnresponsiveError("Boat file download failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw transferError("download", response.status);
    }
    return response;
  }

  private async runCommand(
    id: string,
    command: string,
    cwd: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    background = false,
  ): Promise<BoatCommandResult> {
    const marker = `/tmp/rakazo-command-${randomUUID()}.completed-124`;
    const wrapped = timeoutCommand(command, timeoutMs, marker);
    const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    const detached = background || timeoutSeconds + 5 > BOAT_API_COMMAND_TIMEOUT_SECONDS;
    try {
      const response = await this.whenRunnable(id, signal, () =>
        this.client.command(
          {
            sandboxId: id,
            commandRequest: {
              command: wrapped,
              cwd,
              ...(detached
                ? { detached: true }
                : {
                    timeoutSeconds: Math.min(timeoutSeconds + 5, BOAT_API_COMMAND_TIMEOUT_SECONDS),
                  }),
            },
          },
          signal ? { signal } : undefined,
        ),
      );
      const result = isFinishedCommand(response)
        ? commandResponse(response)
        : await this.waitForCommand(id, response.processId, timeoutMs + 10_000, signal);
      if (result.exitCode !== 0 && systemDamaged(result.stderr)) {
        // The next start checks it again rather than trust an earlier preparation.
        this.prepared.delete(id);
        await this.logDamaged(id);
        throw new SandboxDamagedError({ cause: new Error(commandFailure(result)) });
      }
      if (result.exitCode !== 124 || result.timedOut) return result;
      const completed = await this.rawCommand(id, `test -f ${shellQuote(marker)}`, 10);
      if (completed.exitCode === 0) {
        await this.rawCommand(id, `rm -f -- ${shellQuote(marker)}`, 10).catch(() => undefined);
        return result;
      }
      return { ...result, timedOut: true };
    } catch (error) {
      // A detached command outlives a follow that failed, so it is stopped too.
      if (detached || signal?.aborted || isAbortError(error)) {
        await this.terminateCommand(id, marker).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * What Boat says about a machine that cannot start programs. A restore that never finished
   * (`hydrated` false long after a start) or saves that keep failing point at Boat's storage.
   */
  private async logDamaged(id: string): Promise<void> {
    const sandbox = await this.client
      .get({ sandboxId: id }, { signal: AbortSignal.timeout(BOAT_GONE_CHECK_TIMEOUT_MS) })
      .then(({ sandbox }) => sandbox)
      .catch(() => undefined);
    getLogger().warn("sandbox.damaged", {
      provider: "boat",
      ...(sandbox
        ? {
            state: sandbox.state,
            hydrated: sandbox.hydrated,
            lastSnapshotStatus: sandbox.lastSnapshotStatus ?? undefined,
            stopStatus: sandbox.stop?.status,
            health: sandbox.health,
          }
        : {}),
    });
  }

  /** Waits for a detached command on its output stream, or by polling when that is unavailable. */
  private async waitForCommand(
    id: string,
    processId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BoatCommandResult> {
    const deadline = Date.now() + timeoutMs;
    return (
      (await this.followCommand(id, processId, deadline, signal)) ??
      this.pollCommand(id, processId, deadline, signal)
    );
  }

  /**
   * The command's result from Boat's output stream, which costs one request per ten minutes.
   * Undefined at the deadline, or when Boat refused or ended the stream without the command's
   * exit; status polls then stop the command or read how it ended.
   */
  private async followCommand(
    id: string,
    processId: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<BoatCommandResult | undefined> {
    const { FetchError, followCommand } = await boatSdk();
    const timeout = AbortSignal.timeout(Math.max(deadline - Date.now(), 0));
    const output = { stdout: "", stderr: "" };
    try {
      for await (const frame of followCommand(
        // The helper only attaches; this client's attach waits out Boat's rate limit.
        this.client as Pick<BoatApi, "attachCommandRaw"> as BoatApi,
        id,
        processId,
        { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
      )) {
        if (frame.type === "stdout" || frame.type === "stderr") {
          output[frame.type] = utf8Tail(`${output[frame.type]}${frame.data ?? ""}`);
        } else if (frame.type === "exit") {
          return { ...output, exitCode: frame.exitCode ?? 1, timedOut: false };
        } else if (frame.type === "error") {
          return undefined;
        }
      }
    } catch (error) {
      // A rate limit, or the SDK's own idle timer ending the attach (on its request, or while it
      // waits at the request gate), leaves the command to status polls too.
      const unavailable =
        timeout.aborted ||
        error instanceof BoatApiError ||
        error instanceof SandboxRateLimitError ||
        isAbortError(error instanceof FetchError ? error.cause : error);
      if (signal?.aborted || !unavailable) throw error;
    }
    return undefined;
  }

  private async pollCommand(
    id: string,
    processId: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<BoatCommandResult> {
    for (let pause = 500; ; pause = nextPoll(pause)) {
      if (signal?.aborted) throw signal.reason ?? new Error("command aborted");
      const status = await this.client.commandStatus(
        { sandboxId: id, processId, tailBytes: BOAT_COMMAND_TAIL_BYTES },
        signal ? { signal } : undefined,
      );
      if (!status.running) {
        return {
          stdout: status.stdout,
          stderr: status.stderr,
          exitCode: status.exitCode ?? 1,
          timedOut: false,
        };
      }
      if (Date.now() >= deadline) {
        const pid = status.pid ?? processId;
        await this.rawCommand(
          id,
          `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null || true`,
          10,
        ).catch(() => undefined);
        return { stdout: status.stdout, stderr: status.stderr, exitCode: 124, timedOut: true };
      }
      await delay(pause, undefined, signal ? { signal } : undefined);
    }
  }

  private async terminateCommand(id: string, marker: string): Promise<void> {
    const pattern = marker.replace("rakazo", "[r]akazo");
    await this.rawCommand(
      id,
      `pkill -TERM -f ${shellQuote(pattern)} 2>/dev/null || true; sleep 0.2; pkill -KILL -f ${shellQuote(pattern)} 2>/dev/null || true`,
      10,
    );
  }

  private async rawCommand(id: string, command: string, timeoutSeconds: number) {
    // Bounds the wait for a rate-limited Boat too, so cancellation cleanup cannot hang on it.
    const response = await this.client.command(
      { sandboxId: id, commandRequest: { command, timeoutSeconds } },
      { signal: AbortSignal.timeout(timeoutSeconds * 1_000 + 5_000) },
    );
    if (!isFinishedCommand(response)) {
      return this.waitForCommand(id, response.processId, timeoutSeconds * 1_000 + 5_000);
    }
    return commandResponse(response);
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "boat", providerRef: id, fresh };
  }

  private id(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private forget(id: string): void {
    this.pendingProvisions.delete(id);
    this.prepared.delete(id);
    this.preparations.delete(id);
  }
}

/** Why a setup command failed, without its full output: a timeout, or the exit code and last line. */
function commandFailure(result: BoatCommandResult): string {
  if (result.timedOut) return "timed out";
  const last = (result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 300);
  return last ? `exit ${result.exitCode}: ${last}` : `exit ${result.exitCode}`;
}

/**
 * Boat's runner starts each command with `systemd-run` and sources the machine's environment
 * before our command line runs. These failures come from that, so the machine's system files are
 * missing or broken; the command itself never started.
 */
const BOAT_SYSTEM_DAMAGED =
  /^(?:Executable not found in \$PATH: "systemd-run"|ENOENT: no such file or directory, posix_spawn 'systemd-run'|environment: line \d+: \/usr\/bin\/[\w.-]+: cannot execute: required file not found)$/m;

function systemDamaged(stderr: string): boolean {
  return BOAT_SYSTEM_DAMAGED.test(stderr);
}

/** How a listing command ended. Its output is file names, never an error message. */
function commandStatus(result: BoatCommandResult): string {
  if (result.timedOut) return "timed out";
  if (result.exitCode === BOAT_LISTING_UNREADABLE) return "an entry could not be read";
  const reasons = errorReasons(result.stderr);
  return reasons ? `exit ${result.exitCode}: ${reasons}` : `exit ${result.exitCode}`;
}

/**
 * The system errors find and tar ended with, such as `No space left on device`, without the
 * workspace paths they name.
 */
function errorReasons(stderr: string): string {
  const reasons = new Set<string>();
  for (const line of stderr.split("\n")) {
    const reason = line.slice(line.lastIndexOf(": ") + 2).trim();
    if (line.includes(": ") && /^[A-Za-z][A-Za-z /]{0,79}$/.test(reason)) reasons.add(reason);
  }
  return [...reasons].slice(0, 3).join("; ");
}

/** Each step of bringing back a sandbox that stopped answering; none is a failure by itself. */
function logRecovery(
  step: "wait" | "answered" | "deferred" | "force_stop" | "resumed" | "gone",
  reason?: string,
): void {
  getLogger().warn("sandbox.recover", { provider: "boat", step, ...(reason ? { reason } : {}) });
}

/** A signed transfer Boat failed on its side is an outage there, like any other Boat call. */
function transferError(direction: "upload" | "download", status: number): Error {
  const message = `Boat file ${direction} failed (HTTP ${status})`;
  return status >= 500 ? new SandboxUnresponsiveError(message) : new Error(message);
}

/** Boat deletes a stopped sandbox's data after 14 days but keeps the record; it cannot resume. */
/** Named so the shared `isSandboxGoneError` lets callers replace it from its last checkpoint. */
function boatSandboxGone(sandboxId: string, cause?: unknown): Error {
  return sandboxNotFoundError(`Boat sandbox ${sandboxId} is gone`, { cause });
}

/** Turns raw SDK failures into actionable errors, rate limits, and gone sandboxes. */
function boatClient(api: BoatSandboxSdk, apiKey: string, gate: BoatRequestGate): BoatSandboxSdk {
  const boatCall = <Args extends unknown[], Result>(
    call: (...args: Args) => Promise<Result>,
    idempotent = false,
    timeoutMs?: number,
  ) => wrapBoatCall(call, apiKey, idempotent, gate, timeoutMs);
  const get = boatCall(api.get.bind(api), true, BOAT_GET_TIMEOUT_MS);
  const sandboxCall = <Args extends [{ sandboxId: string }, ...unknown[]], Result>(
    call: (...args: Args) => Promise<Result>,
    idempotent = false,
    timeoutMs?: number,
  ) => {
    const wrapped = boatCall(call, idempotent, timeoutMs);
    return async (...args: Args): Promise<Result> => {
      try {
        return await wrapped(...args);
      } catch (error) {
        const { sandboxId } = args[0];
        if (!(error instanceof BoatApiError)) throw error;
        // Boat keeps the record of a sandbox whose snapshot data it deleted, but cannot resume it.
        // A 404 can mean a missing file in a live sandbox; only a missing sandbox counts as gone.
        if (
          error.code === "snapshot_data_expired" ||
          (error.response.status === 404 &&
            (await sandboxMissing(get, sandboxId, callerSignal(args[1]))))
        ) {
          throw boatSandboxGone(sandboxId, error);
        }
        throw error;
      }
    };
  };
  // Observe the provider call itself: provisioning can succeed while later setup fails,
  // and background probes or file operations can resume a provider-expired computer too.
  const startCall =
    <Args extends unknown[], Result>(
      operation: "create" | "resume" | "recover",
      call: (...args: Args) => Promise<Result>,
    ) =>
    async (...args: Args): Promise<Result> => {
      const started = performance.now();
      try {
        const result = await call(...args);
        getLogger().info("sandbox.start", {
          provider: "boat",
          operation,
          outcome: "accepted",
          durationMs: Math.round(performance.now() - started),
        });
        return result;
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        // Another caller's resume is already waking it; the caller waits for it to be ready.
        if (error instanceof BoatApiError && error.code === "sandbox_resuming") {
          getLogger().info("sandbox.start", {
            provider: "boat",
            operation,
            outcome: "in_progress",
            durationMs,
          });
          throw error;
        }
        getLogger().warn("sandbox.start", {
          provider: "boat",
          operation,
          outcome: error instanceof SandboxRateLimitError ? "rate_limited" : "failed",
          durationMs,
          error,
        });
        throw error;
      }
    };
  // Reads, URL grants, TTL updates, and whole-file writes are safe to send twice.
  return {
    artifactRaw: sandboxCall(api.artifactRaw.bind(api), true),
    attachCommandRaw: sandboxCall(api.attachCommandRaw.bind(api), true),
    command: sandboxCall(api.command.bind(api)),
    commandStatus: sandboxCall(api.commandStatus.bind(api), true),
    create: startCall("create", boatCall(api.create.bind(api))),
    createDownloadUrl: sandboxCall(api.createDownloadUrl.bind(api), true),
    createUploadUrl: sandboxCall(api.createUploadUrl.bind(api), true),
    get: sandboxCall(api.get.bind(api), true, BOAT_GET_TIMEOUT_MS),
    getSavedSnapshot: boatCall(api.getSavedSnapshot.bind(api), true),
    hostPort: sandboxCall(api.hostPort.bind(api), true),
    recover: startCall("recover", sandboxCall(api.recover.bind(api))),
    resume: startCall("resume", sandboxCall(api.resume.bind(api), true, BOAT_RESUME_TIMEOUT_MS)),
    saveSavedSnapshot: boatCall(api.saveSavedSnapshot.bind(api)),
    stop: sandboxCall(api.stop.bind(api)),
    update: sandboxCall(api.update.bind(api), true),
    writeFile: sandboxCall(api.writeFile.bind(api), true),
    deleteSandbox: boatCall(api.deleteSandbox.bind(api)),
  };
}

function createBoatSdk(
  config: { apiKey: string; apiUrl?: string },
  gate: BoatRequestGate,
): BoatSandboxSdk {
  const apiUrl = (config.apiUrl ?? BOAT_API_BASE).replace(/\/$/, "");
  // The SDK loads on the first call, so a process without Boat configured never loads it.
  let api: Promise<BoatApi> | undefined;
  const loadApi = () =>
    (api ??= boatSdk().then(
      ({ BoatApi, Configuration }) =>
        new BoatApi(
          new Configuration({
            basePath: apiUrl,
            accessToken: config.apiKey,
            // The SDK defaults to its own HTTP/2 client; keep requests on the runtime fetch.
            fetchApi: (input, init) => fetch(input, init),
          }),
        ),
    ));
  const methods = Object.fromEntries(
    BOAT_API_METHODS.map((name) => [
      name,
      async (...args: unknown[]) => {
        const loaded = await loadApi();
        return (loaded[name] as (...args: unknown[]) => unknown).apply(loaded, args);
      },
    ]),
  ) as Pick<BoatApi, (typeof BOAT_API_METHODS)[number]>;
  return Object.assign(methods, {
    deleteSandbox: async (sandboxId: string) => {
      const url = `${apiUrl}/sandboxes/${encodeURIComponent(sandboxId)}`;
      const headers = { Authorization: `Bearer ${config.apiKey}` };
      const signal = AbortSignal.timeout(BOAT_DELETE_TIMEOUT_MS);
      try {
        await withAbort(gate.wait(signal), signal);
        const response = await fetch(url, {
          method: "DELETE",
          headers: {
            ...headers,
            "X-Ascii-Confirm-Delete": sandboxId,
          },
          signal,
        });
        if (response.status === 404) return;
        if (!response.ok) {
          throw await boatResponseError(response, config.apiKey, signal);
        }
        for (let pause = 500; !signal.aborted; pause = nextPoll(pause)) {
          await withAbort(gate.wait(signal), signal);
          const status = await fetch(url, { headers, signal });
          if (status.status === 404) return;
          if (!status.ok) {
            throw await boatResponseError(status, config.apiKey, signal);
          }
          await withAbort(delay(pause), signal);
        }
      } catch (error) {
        if (!signal.aborted || error !== signal.reason) throw error;
      }
      throw new Error(`Boat ${sandboxId} was not deleted within 60 seconds`);
    },
  });
}

/** The end of `text` within the byte budget a status poll reads, never splitting a character. */
function utf8Tail(text: string): string {
  if (text.length * 3 <= BOAT_COMMAND_TAIL_BYTES) return text;
  const bytes = Buffer.from(text);
  if (bytes.length <= BOAT_COMMAND_TAIL_BYTES) return text;
  let start = bytes.length - BOAT_COMMAND_TAIL_BYTES;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString();
}

/** Boat refusing a machine type becomes the neutral size error; anything else is unchanged. */
function notRunning(error: unknown): error is BoatApiError {
  return error instanceof BoatApiError && BOAT_NOT_RUNNING_CODES.has(error.code ?? "");
}

function boatSizeError(error: unknown): unknown {
  if (!(error instanceof BoatApiError)) return error;
  if (error.code === "machine_class_plan_required") {
    return new SandboxSizeUnavailableError("not_offered", { cause: error });
  }
  if (error.code === "type_too_small") {
    return new SandboxSizeUnavailableError("too_small", { cause: error });
  }
  return error;
}

function nextPoll(pause: number, max = BOAT_POLL_MAX_MS): number {
  return Math.min(pause * 2, max);
}

async function sandboxMissing(
  get: (request: { sandboxId: string }, init: RequestInit) => Promise<unknown>,
  sandboxId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const timeout = AbortSignal.timeout(BOAT_GONE_CHECK_TIMEOUT_MS);
  try {
    await get({ sandboxId }, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return false;
  } catch (error) {
    return error instanceof BoatApiError && error.response.status === 404;
  }
}

function timeoutCommand(command: string, timeoutMs: number, marker: string): string {
  const seconds = Math.max(timeoutMs / 1_000, 0.001);
  const completionScript =
    '"$@"; status=$?; if [ "$status" -eq 124 ]; then : > "$0"; fi; exit "$status"';
  return [
    "timeout",
    "--kill-after=1s",
    `${seconds}s`,
    "sh",
    "-c",
    completionScript,
    marker,
    "bash",
    "-lc",
    command,
  ]
    .map(shellQuote)
    .join(" ");
}

function isFinishedCommand(response: Command200Response): response is CommandResponse {
  return response.type === "command.finished";
}

function commandResponse(response: CommandResponse): BoatCommandResult {
  return {
    stdout: response.stdout,
    stderr: response.stderr,
    exitCode: response.exitCode ?? 1,
    timedOut: response.timedOut,
  };
}

function configureBoatWorkspaceCommand(): string {
  return `mkdir -p ${shellQuote(BOAT_BROWSER_PROFILES)} && ${commandEnvDirectoryCommand()}`;
}

/**
 * What a computer snapshot captures, in order: the same setup `prepare` repeats, then a check.
 * The page browser's own files are left to `prepare`, so changing them never rebuilds this.
 */
const BOAT_COMPUTER_SETUP = [
  configureBoatWorkspaceCommand(),
  PREPARE_LINUX_DESKTOP,
  installChromeUseCommand(),
  VERIFY_LINUX_DESKTOP,
] as const;

export const BOAT_COMPUTER_SNAPSHOT = computerSnapshotName(BOAT_COMPUTER_SETUP);

/** Only `user` may list or read command environment files. */
function commandEnvDirectoryCommand(): string {
  const directory = shellQuote(BOAT_COMMAND_ENV);
  return `mkdir -p -m 700 ${directory} && chmod 700 ${directory}`;
}

/**
 * One NUL-terminated record per entry, so any file name survives: type, size, mode, path. A
 * single `find` walks the tree; a subprocess per entry made a large workspace outlast the
 * listing timeout.
 */
const BOAT_LISTING_FORMAT = "%y\\t%s\\t%m\\t%p\\0";
/** Exit status of a listing that met an entry it could not read. */
const BOAT_LISTING_UNREADABLE = 3;

/**
 * Runs `find` with its records on fd 3 and its errors captured. It exits 1 for any error, but
 * an entry that vanished mid-walk leaves the rest of the listing intact, as do the `skippable`
 * errors a caller names. Anything else, such as an unreadable entry or a listing it could not
 * finish writing, fails the listing.
 */
function boatListingWalk(
  find: string,
  skippable: string[] = [],
  format = BOAT_LISTING_FORMAT,
): string {
  const tolerated = ["No such file or directory", ...skippable]
    .map((error) => `-e ${shellQuote(`${error}$`)}`)
    .join(" ");
  return [
    `errors=$(${find} -printf '${format}' 2>&1 >&3 3>&-)`,
    "status=$?",
    'if [ "$status" -eq 1 ]; then',
    `  if ! printf '%s\\n' "$errors" | grep -qv ${tolerated}; then status=0;`,
    `  elif printf '%s\\n' "$errors" | grep -q 'Permission denied$'; then status=${BOAT_LISTING_UNREADABLE}; fi`,
    "fi",
    'if [ "$status" -ne 0 ]; then printf \'%s\\n\' "$errors" >&2; fi',
    'exit "$status"',
  ].join("\n");
}

/** Exit status of a listing whose folder is not there. */
const BOAT_LISTING_MISSING = 2;

/** Lists a directory's files and folders, following links as the file browser shows them. */
function listBoatFilesCommand(directory: string): string {
  return [
    "set -o pipefail",
    `directory=${shellQuote(directory)}`,
    `test -d "$directory" || exit ${BOAT_LISTING_MISSING}`,
    "{",
    "exec 3>&1",
    // A link that loops is left out, like a broken one.
    boatListingWalk('find -L "$directory" -mindepth 1 -maxdepth 1 \\( -type f -o -type d \\)', [
      "Too many levels of symbolic links",
    ]),
    "} | base64 -w0",
  ].join("\n");
}

/** Gives the owner write access to everything in the workspace; find does not follow links. */
export const BOAT_WRITABLE_WORKSPACE_COMMAND = `find ${shellQuote(BOAT_WORKSPACE)} \\( -type f -o -type d \\) ! -perm -0200 -exec chmod u+w -- {} + 2>/dev/null || true`;

/** tar reports these for a file that vanished or changed while it was archived. */
const BOAT_ARCHIVE_TOLERATED_ERRORS = [
  "No such file or directory",
  "File removed before we read it",
  "file changed as we read it",
  "padding with zeros",
  "Exiting with failure status due to previous errors",
];

/** Exit statuses of an archive command that refused a workspace over the export's limits. */
const BOAT_ARCHIVE_TOO_MANY_FILES = 4;
const BOAT_ARCHIVE_TOO_MANY_BYTES = 5;

/**
 * Writes every regular workspace file, without the browser caches exports skip, to one gzipped
 * pax tar at `archive`. The same walk as a listing chooses the files, and a workspace over
 * `limits` is refused from that walk before anything is archived. tar stores hard links as
 * files and symbolic links are never selected. A file that vanished or changed mid-archive is
 * tolerated as the listing tolerates one that vanished mid-walk; any other error fails it.
 */
export function archiveBoatWorkspaceCommand(
  archive: string,
  options: { limits?: WorkspaceExportLimits; workspace?: string } = {},
): string {
  const { limits, workspace = BOAT_WORKSPACE } = options;
  const tolerated = BOAT_ARCHIVE_TOLERATED_ERRORS.map(
    (error) => `-e ${shellQuote(`${error}$`)}`,
  ).join(" ");
  const cleanup = 'rm -f -- "$archive.list" "$archive.sizes" "$archive.errors"';
  return [
    `archive=${shellQuote(archive)}`,
    // Archives an interrupted export left behind.
    `find /tmp -maxdepth 1 -name '${path.basename(BOAT_ARCHIVE_PREFIX)}*' -mmin +60 -delete 2>/dev/null`,
    `cd ${shellQuote(workspace)} || exit 2`,
    'exec 3> "$archive.list" || exit 2',
    // Names start with `./`, so tar never reads one as an option.
    "(",
    boatListingWalk(
      // Excluded home content is neither counted toward the limits nor read.
      `${workspaceSaveFindCommand()} -fprintf "$archive.sizes" '%s\\n'`,
      [],
      "%p\\0",
    ),
    `) || { status=$?; ${cleanup}; exit "$status"; }`,
    "exec 3>&-",
    ...(limits
      ? [
          `if [ "$(wc -l < "$archive.sizes")" -gt ${Math.floor(limits.maxFiles)} ]; then ${cleanup}; exit ${BOAT_ARCHIVE_TOO_MANY_FILES}; fi`,
          `if [ "$(awk '{ total += $1 } END { printf "%.0f", total }' "$archive.sizes")" -gt ${Math.floor(limits.maxBytes)} ]; then ${cleanup}; exit ${BOAT_ARCHIVE_TOO_MANY_BYTES}; fi`,
        ]
      : []),
    'tar --create --format=pax --null --no-recursion --hard-dereference --files-from="$archive.list" --use-compress-program="gzip -1" --file="$archive" 2> "$archive.errors"',
    "status=$?",
    'if [ "$status" -eq 1 ]; then status=0;',
    `elif [ "$status" -eq 2 ] && ! grep -qv ${tolerated} "$archive.errors"; then status=0;`,
    `elif grep -q 'Permission denied$' "$archive.errors"; then status=${BOAT_LISTING_UNREADABLE}; fi`,
    'if [ "$status" -ne 0 ]; then cat "$archive.errors" >&2; fi',
    cleanup,
    'exit "$status"',
  ].join("\n");
}

function parseBoatFileEntries(listing: Uint8Array): ComputerFileEntry[] {
  return Buffer.from(listing)
    .toString("utf8")
    .split("\0")
    .flatMap((record): ComputerFileEntry[] => {
      const match = /^([fd])\t(\d+)\t([0-7]+)\t(.+)$/s.exec(record);
      if (!match) return [];
      const [, type, size, mode, absolute = ""] = match;
      if (!absolute.startsWith(`${BOAT_WORKSPACE}/`)) return [];
      const kind = type === "d" ? "dir" : "file";
      return [
        {
          path: normalizeWorkspacePath(absolute.slice(BOAT_WORKSPACE.length + 1)),
          kind,
          size: Number(size),
          ...(kind === "file" && (Number.parseInt(mode ?? "0", 8) & 0o111) !== 0
            ? { executable: true }
            : {}),
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Boat's file capability URLs are secrets. Confine them to Boat's sandbox hosts; callers never
 * forward API credentials, follow redirects, or expose transport errors containing them.
 */
function signedFileUrl(
  signed: FileUrlResponse,
  direction: "upload" | "download",
  filePath: string,
): URL {
  const invalid = () => new Error(`Boat returned an invalid file ${direction} URL`);
  let url: URL;
  try {
    url = new URL(signed.url);
  } catch {
    throw invalid();
  }
  if (
    !signed.ok ||
    signed.type !== `file.${direction}_url` ||
    signed.method !== (direction === "upload" ? "PUT" : "GET") ||
    signed.path !== filePath ||
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".on.boat.dev") ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash
  )
    throw invalid();
  return url;
}

/** The artifact route refuses files over its size cap with this error. */
function isArtifactTooLarge(error: unknown): boolean {
  return (
    error instanceof BoatApiError &&
    (error.response.status === 413 ||
      (error.response.status === 400 && error.code === "artifact_failed"))
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
}
