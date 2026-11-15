import path from "node:path";
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
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { COMPUTER_CACHE_ENV } from "@rakazo/core/node/desktop-runtime";
import type * as Railway from "railway";
import type { ConnectOptions, Sandbox, SandboxStatus } from "railway";
import WebSocket from "ws";
import { z } from "zod";
import { computerIdleSleepEnabled, sandboxIdleMs } from "./computer-idle.js";
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
} from "./linux-desktop.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { abortedCommandEvents } from "./sandbox-command-events.js";
import { readBodyCapped } from "./web-ssrf.js";
import {
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindCommand,
} from "./workspace-save-policy.js";

const DISPLAY_START = 1;
const WORKSPACE = "/home/rakazo";
const SCREEN_PORT = 6080;
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const GONE_STATUSES = new Set<SandboxStatus>(["DESTROYED", "DESTROYING", "FAILED"]);
// The SDK waits five minutes for RUNNING; a record still creating well past that is stuck.
const CREATING_STALE_MS = 10 * 60_000;
// Railway's longest finite idle timeout on any plan.
const MAX_IDLE_TIMEOUT_MINUTES = 120;

export interface RailwaySandboxOptions {
  token: string;
  environmentId: string;
  maxWorkspaceFileBytes?: string;
  region?: string;
}

export class RailwaySandboxProvider implements SandboxProvider {
  billsWhileRunning(): boolean {
    return true;
  }

  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: WORKSPACE,
      workspaceDir: WORKSPACE,
      browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
      displayStart: DISPLAY_START,
      portStart: SCREEN_PORT,
      // The provider port proxy reaches the isolated sandbox through its network interface.
      bindHost: "0.0.0.0",
    }),
    run: async (computer, command, context) => {
      const result = await this.run(computer, command, context);
      return { code: result.timedOut ? 124 : (result.exitCode ?? 1), ...result };
    },
    screenUrl: async (computer, port, context) => {
      const sandbox = await this.connect(computer, context);
      const domain = sandbox.domains.find((entry) => entry.port === port);
      if (!domain) throw new Error("Railway computer has no screen domain");
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.up\.railway\.app$/i.test(domain.domain))
        throw new Error("Invalid Railway screen domain");
      return `https://${domain.domain}/vnc.html`;
    },
  });

  private readonly options: ConnectOptions;

  private readonly maxWorkspaceFileBytes: number;

  private readonly region: string | undefined;

  constructor({ maxWorkspaceFileBytes, region, ...options }: RailwaySandboxOptions) {
    this.maxWorkspaceFileBytes = z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .default(64 * 1024 * 1024)
      .parse(maxWorkspaceFileBytes);
    this.region = region;
    // Node's native WebSocket can recurse when the SDK closes a failed handshake.
    this.options = {
      ...options,
      endpoint: RAILWAY_API,
      tcpProxyWsEndpoint: "wss://ssh.railway.com:2226/ws/exec",
      verbose: false,
      fetch: railwayFetch,
      webSocketImpl: RailwayWebSocket,
    };
  }

  describe() {
    return {
      id: "railway",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: true,
        takeover: true,
        persistentHome: false,
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
    const railway = await loadRailway();
    context.signal.throwIfAborted();
    if (request.providerRef && request.providerKind === "railway") {
      try {
        const sandbox = await this.lookup(
          this.ref(request.providerRef, request.botId, false),
          context,
        );
        if (sandbox.status === "RUNNING" && sandbox.networkIsolation === "PRIVATE")
          return this.ref(sandbox.id, request.botId, false);
        if (
          sandbox.status === "CREATING" &&
          Date.now() - Date.parse(sandbox.createdAt) < CREATING_STALE_MS
        )
          throw new Error("Railway computer is still starting");
        // Replace stuck, ended, and non-PRIVATE sandboxes; the portable home restores the workspace.
        await remove(railway, sandbox);
      } catch (error) {
        if (!(error instanceof railway.SandboxNotFoundError)) throw error;
      }
    }
    let sandbox: Sandbox;
    let createdId: string | undefined;
    const create = (idleTimeoutMinutes?: number) =>
      railway.Sandbox.create({
        ...this.options,
        fetch: async (input, init) => {
          // Finish the bounded request so cancellation cannot hide a created sandbox's ID.
          const response = await railwayFetch(input, init, (id) => {
            createdId = id;
          });
          context.signal.throwIfAborted();
          return response;
        },
        ...(idleTimeoutMinutes !== undefined && { idleTimeoutMinutes }),
        // Railway public domains require the sandbox to join the private network.
        networkIsolation: "PRIVATE",
        domains: [{ port: SCREEN_PORT }],
        ...(this.region && { region: this.region }),
      });
    try {
      try {
        sandbox = await create(railwayIdleTimeoutMinutes());
      } catch (error) {
        // Trial and Free plans allow 1-5 minutes and never 0, and Railway does not document how
        // it words that rejection. Retry with the plan default unless a retry cannot help.
        if (createdId || context.signal.aborted || !retriesWithoutIdleTimeout(railway, error))
          throw error;
        sandbox = await create();
        // biome-ignore lint/suspicious/noConsole: Operators need to know idle work can be lost.
        console.warn(
          "[railway] created the sandbox with the plan's idle timeout, which can destroy idle computers before they are saved",
        );
      }
      createdId = sandbox.id;
      assertPrivateNetwork(sandbox);
    } catch (error) {
      if (
        error instanceof railway.SandboxFailedError ||
        (error instanceof railway.SandboxTimeoutError && error.resource === "sandbox")
      ) {
        createdId = error.id;
      }
      if (createdId) await this.destroy(this.ref(createdId, request.botId, true), context);
      throw error;
    }
    if (context.signal.aborted) {
      await this.destroy(this.ref(sandbox.id, request.botId, true), context);
      context.signal.throwIfAborted();
    }
    return this.ref(sandbox.id, request.botId, true);
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const { SandboxNotFoundError } = await loadRailway();
    try {
      const sandbox = await this.lookup(computer, context);
      // Provisioning replaces a sandbox without PRIVATE networking.
      return sandbox.status === "RUNNING" && sandbox.networkIsolation === "PRIVATE";
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return false;
      throw error;
    }
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.checked(computer, PREPARE_RAILWAY_DESKTOP, context, 300_000);
  }

  async *execute(
    computer: ComputerRef,
    requested: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const request = onBotScreen(requested, context, DISPLAY_START);
    try {
      const sandbox = await this.connect(computer, context);
      const result = await sandbox.exec(sandboxCommandArgv(request).map(shellQuote).join(" "), {
        cwd: workspaceCwd(WORKSPACE, request.cwd),
        env: { ...COMPUTER_CACHE_ENV, ...request.env },
        timeoutSec: boundedSandboxCommandTimeoutMs(request.timeoutMs) / 1_000,
        maxOutputBytes: MAX_RESPONSE_BYTES,
        signal: context.signal,
      });
      if (result.truncated)
        throw new Error(`Railway command output exceeds ${MAX_RESPONSE_BYTES} bytes`);
      if (result.stdout) yield { type: "stdout", data: result.stdout };
      if (result.stderr) yield { type: "stderr", data: result.stderr };
      yield { type: "exit", code: result.timedOut ? 124 : (result.exitCode ?? 1) };
    } catch (error) {
      if (!context.signal.aborted) throw error;
      yield* abortedCommandEvents();
    }
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
    const sandbox = await this.connect(computer, context);
    const relative = normalizeWorkspacePath(directory);
    const entries = await sandbox.files.list(workspacePath(WORKSPACE, relative));
    return entries.map((entry) => ({
      path: normalizeWorkspacePath(path.posix.join(relative, entry.name)),
      kind: entry.isDir ? "dir" : "file",
      size: entry.size,
      ...(!entry.isDir && (entry.mode & 0o111) !== 0 ? { executable: true } : {}),
    }));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const sandbox = await this.connect(computer, context);
    const content = await sandbox.files.read(workspacePath(WORKSPACE, filePath), {
      format: "bytes",
      length: (options?.maxBytes ?? this.maxWorkspaceFileBytes) + 1,
    });
    const maxBytes = options?.maxBytes ?? this.maxWorkspaceFileBytes;
    if (content.byteLength > maxBytes) {
      throw new Error(`computer file exceeds ${maxBytes} bytes`);
    }
    return content;
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    const sandbox = await this.connect(computer, context);
    await sandbox.files.write(workspacePath(WORKSPACE, file.path), file.content, {
      mode: file.executable ? 0o700 : 0o600,
    });
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
    await this.desktops.stopBrowsers(computer, context);
    const result = await this.run(
      computer,
      [
        "set -euo pipefail",
        `cd ${shellQuote(WORKSPACE)}`,
        `${workspaceSaveFindCommand()} -print0 | while IFS= read -r -d "" entry; do`,
        '  if [ -x "$entry" ]; then mode=700; else mode=600; fi',
        `  printf '%s\\0%s\\0%s\\0' "\${entry#./}" "$mode" "$(wc -c < "$entry")"`,
        "done",
      ].join("\n"),
      context,
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new Error("could not list Railway workspace");
    const entries = result.stdout.split("\0");
    const sandbox = await this.connect(computer, context);
    const { SandboxFileNotFoundError } = await loadRailway();
    type ExportFile = { path: string; executable: boolean; size: number };
    const batches: ExportFile[][] = [];
    const batcher = new PortableFileBatcher<ExportFile>(4, (file) => file.size);
    for (let index = 0; index + 2 < entries.length; index += 3) {
      const filePath = entries[index];
      const mode = entries[index + 1];
      if (!filePath || !mode || shouldSkipPortableWorkspaceFile(filePath)) continue;
      const size = Number(entries[index + 2]);
      if (!Number.isSafeInteger(size) || size < 0 || size > this.maxWorkspaceFileBytes)
        throw new Error(
          `Railway workspace file exceeds ${this.maxWorkspaceFileBytes} bytes or has an invalid size`,
        );
      const full = batcher.add({
        path: filePath,
        size,
        executable: (Number.parseInt(mode, 8) & 0o111) !== 0,
      });
      if (full?.length) batches.push(full);
    }
    const last = batcher.take();
    if (last.length) batches.push(last);
    const growing: Array<{ path: string; executable: boolean }> = [];
    for (const files of batches) {
      context.signal.throwIfAborted();
      const batch = await Promise.all(
        files.map(async (file) => {
          try {
            const content = await sandbox.files.read(workspacePath(WORKSPACE, file.path), {
              format: "bytes",
              length: file.size + 1,
            });
            if (content.byteLength > this.maxWorkspaceFileBytes)
              throw new Error(`Railway workspace file exceeds ${this.maxWorkspaceFileBytes} bytes`);
            if (content.byteLength > file.size) {
              growing.push({ path: file.path, executable: file.executable });
              return undefined;
            }
            return { path: file.path, executable: file.executable, content };
          } catch (error) {
            if (error instanceof SandboxFileNotFoundError) return undefined;
            throw error;
          }
        }),
      );
      for (const file of batch) if (file) yield file;
    }
    // Changed files no longer fit their reserved batch; read them one at a time.
    for (const file of growing) {
      context.signal.throwIfAborted();
      try {
        const content = await sandbox.files.read(workspacePath(WORKSPACE, file.path), {
          format: "bytes",
          length: this.maxWorkspaceFileBytes + 1,
        });
        if (content.byteLength > this.maxWorkspaceFileBytes)
          throw new Error(`Railway workspace file exceeds ${this.maxWorkspaceFileBytes} bytes`);
        yield { ...file, content };
      } catch (error) {
        if (!(error instanceof SandboxFileNotFoundError)) throw error;
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    await this.desktops.stopBrowsers(computer, context);
    const sandbox = await this.connect(computer, context);
    // SDK uploads default to 0644; the private parent also protects interrupted restores.
    const privacy = await sandbox.exec(`chmod 700 -- ${shellQuote(WORKSPACE)}`, {
      timeoutSec: 30,
      signal: context.signal,
    });
    if (privacy.exitCode !== 0 || privacy.timedOut)
      throw new Error("could not protect Railway workspace permissions");
    const batcher = new PortableFileBatcher<PortableFile>(4, (file) => file.content.byteLength);
    const permissions = new Map<number, string[]>([
      [0o600, []],
      [0o700, []],
    ]);
    const flush = async (batch: PortableFile[]) => {
      context.signal.throwIfAborted();
      // Passing mode makes the SDK open an exec connection for every file.
      await Promise.all(
        batch.map((file) => sandbox.files.write(workspacePath(WORKSPACE, file.path), file.content)),
      );
    };
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      context.signal.throwIfAborted();
      const full = batcher.add(file);
      if (full) await flush(full);
      const target = workspacePath(WORKSPACE, file.path);
      permissions.get(file.executable ? 0o700 : 0o600)?.push(target);
    }
    await flush(batcher.take());
    for (const [mode, paths] of permissions) {
      for (let offset = 0; offset < paths.length; offset += 64) {
        const result = await sandbox.exec(
          `chmod ${mode.toString(8)} -- ${paths
            .slice(offset, offset + 64)
            .map(shellQuote)
            .join(" ")}`,
          { timeoutSec: 30, signal: context.signal },
        );
        if (result.exitCode !== 0 || result.timedOut)
          throw new Error("could not restore Railway workspace permissions");
      }
    }
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  async keepAlive(computer: ComputerRef) {
    const railway = await loadRailway();
    const sandbox = usable(
      railway,
      await connectSandbox(railway, computer.providerRef, this.options),
    );
    try {
      await sandbox.heartbeat();
    } catch (error) {
      throw goneError(railway, error, sandbox.id, sandbox.environmentId);
    }
  }

  async stop(computer: ComputerRef, context: AdapterContext) {
    // Railway has no suspend operation. Core checkpoints the portable home before stopping.
    await this.destroy(computer, context);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext) {
    const railway = await loadRailway();
    try {
      // Cleanup must still run when provisioning or preparation was canceled.
      await remove(railway, await connectSandbox(railway, computer.providerRef, this.options));
    } catch (error) {
      if (!(error instanceof railway.SandboxNotFoundError)) throw error;
    }
  }

  private async connect(computer: ComputerRef, context: AdapterContext) {
    const sandbox = await this.lookup(computer, context);
    return usable(await loadRailway(), sandbox);
  }

  private async lookup(computer: ComputerRef, context: AdapterContext) {
    context.signal.throwIfAborted();
    return connectSandbox(await loadRailway(), computer.providerRef, {
      ...this.options,
      fetch: (input, init) =>
        railwayFetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, context.signal]) : context.signal,
        }),
    });
  }

  private async run(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
    timeoutMs = 120_000,
  ) {
    const sandbox = await this.connect(computer, context);
    return sandbox.exec(`bash -c ${shellQuote(command)}`, {
      env: COMPUTER_CACHE_ENV,
      timeoutSec: timeoutMs / 1_000,
      maxOutputBytes: MAX_RESPONSE_BYTES,
      signal: context.signal,
    });
  }

  private async checked(
    computer: ComputerRef,
    command: string,
    context: AdapterContext,
    timeoutMs: number,
  ) {
    const result = await this.run(computer, command, context, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw new Error(result.stderr || "could not prepare Railway computer");
    }
  }

  private ref(id: string, botId: string, fresh: boolean): ComputerRef {
    return { id, botId, kind: "railway", providerRef: id, fresh };
  }
}

/**
 * Railway destroys an idle sandbox, so it must outlast the checkpointing idle sleep. When no
 * finite timeout can, Railway never idles it out and Rakazo's own idle sleep stops it.
 */
function railwayIdleTimeoutMinutes() {
  if (!computerIdleSleepEnabled()) return 0;
  const minutes = Math.ceil((sandboxIdleMs() * 1.5) / 60_000);
  return minutes <= MAX_IDLE_TIMEOUT_MINUTES ? minutes : 0;
}

let railwayModule: Promise<typeof Railway> | undefined;

/** Deferred so deployments that never select this provider do not load the SDK at boot. */
function loadRailway(): Promise<typeof Railway> {
  railwayModule ??= import("railway");
  return railwayModule;
}

async function connectSandbox(railway: typeof Railway, id: string, options: ConnectOptions) {
  try {
    return await railway.Sandbox.connect(id, options);
  } catch (error) {
    throw goneError(railway, error, id, options.environmentId ?? "");
  }
}

/** Ended sandboxes are gone: a heartbeat cannot revive them. */
function usable(railway: typeof Railway, sandbox: Sandbox) {
  if (GONE_STATUSES.has(sandbox.status))
    throw new railway.SandboxNotFoundError({
      id: sandbox.id,
      environmentId: sandbox.environmentId,
    });
  assertPrivateNetwork(sandbox);
  return sandbox;
}

async function remove(railway: typeof Railway, sandbox: Sandbox) {
  // Only CREATING and RUNNING sandboxes count toward Railway's per-environment cap.
  if (GONE_STATUSES.has(sandbox.status)) return;
  try {
    await sandbox.destroy();
  } catch (error) {
    if (
      !(
        goneError(railway, error, sandbox.id, sandbox.environmentId) instanceof
        railway.SandboxNotFoundError
      )
    )
      throw error;
  }
}

function goneError(railway: typeof Railway, error: unknown, id: string, environmentId: string) {
  return hasRailwayErrorCode(railway, error, "NOT_FOUND")
    ? new railway.SandboxNotFoundError({ id, environmentId })
    : error;
}

/**
 * Only a rejection Railway answered proves nothing was created. A lost reply or a server error
 * can hide a created sandbox that a retry would leak, and is not a plan rejecting the timeout.
 */
function retriesWithoutIdleTimeout(railway: typeof Railway, error: unknown) {
  return (
    error instanceof railway.RailwayGraphQLError &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 403 &&
    !hasRailwayErrorCode(railway, error, "LIMIT_EXCEEDED") &&
    !hasRailwayErrorCode(railway, error, "UNAUTHORIZED")
  );
}

function hasRailwayErrorCode(railway: typeof Railway, error: unknown, code: string) {
  return (
    error instanceof railway.RailwayGraphQLError &&
    error.errors.some((item) => item.extensions?.code === code)
  );
}

function assertPrivateNetwork(sandbox: Sandbox) {
  if (sandbox.networkIsolation !== "PRIVATE")
    throw new Error(
      "Railway live screen requires PRIVATE networking; recreate the computer before use",
    );
}

class RailwayWebSocket extends WebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { maxPayload: MAX_RESPONSE_BYTES, handshakeTimeout: 30_000 });
  }
}

async function railwayFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  onCreated?: (id: string) => void,
): Promise<Response> {
  if (String(input) !== RAILWAY_API) throw new Error("Invalid Railway API endpoint");
  const deadline = AbortSignal.timeout(30_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(input, { ...init, signal, redirect: "error" });
  const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, signal);
  let body: { data?: { sandboxCreate?: { id?: unknown } }; errors?: unknown[] };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    throw new Error("Invalid Railway API response");
  }
  // GraphQL can return a created resource alongside errors. Preserve its ID before
  // sanitizing the response so a failed create can still clean it up.
  const createdId = body.data?.sandboxCreate?.id;
  if (typeof createdId === "string") onCreated?.(createdId);
  // Never attach upstream error bodies (which may echo credentials) to SDK errors. Keep only a
  // coarse code so a missing sandbox or a full sandbox cap stays distinguishable.
  const failed = !response.ok || body.errors?.length || !body.data;
  const code = failed ? railwayErrorCode(body.errors?.[0]) : undefined;
  return new Response(
    code
      ? JSON.stringify({
          errors: [{ message: `Railway API request failed (${code})`, extensions: { code } }],
        })
      : new Uint8Array(bytes),
    {
      status: response.status,
      headers: { "content-type": "application/json" },
    },
  );
}

const RailwayErrorItem = z
  .object({
    message: z.string().catch(""),
    extensions: z
      .object({
        code: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
          .optional()
          .catch(undefined),
      })
      .optional()
      .catch(undefined),
  })
  .catch({ message: "" });

function railwayErrorCode(error: unknown) {
  const { message, extensions } = RailwayErrorItem.parse(error);
  // An out-of-range idle timeout may name a maximum; keep it from reading as the sandbox cap.
  if (/\bidle\b/i.test(message)) return "IDLE_TIMEOUT_REJECTED";
  if (/\bnot found\b/i.test(message)) return "NOT_FOUND";
  if (/\b(?:not authori[sz]ed|unauthori[sz]ed|forbidden)\b/i.test(message)) return "UNAUTHORIZED";
  if (/\b(?:limit|quota|maximum)\b/i.test(message)) return "LIMIT_EXCEEDED";
  return extensions?.code ?? "REQUEST_FAILED";
}

const PREPARE_RAILWAY_DESKTOP = [
  "set -eu",
  "exec 9>/tmp/rakazo-prepare.lock; flock -w 300 9",
  PREPARE_LINUX_DESKTOP,
  INSTALL_LINUX_BROWSER,
  `mkdir -p ${WORKSPACE}/.browser-profiles`,
].join("\n");
