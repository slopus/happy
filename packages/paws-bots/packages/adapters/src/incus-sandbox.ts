import { randomUUID, X509Certificate } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConnectionOptions } from "node:tls";
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
import { COMPUTER_CACHE_ENV } from "@rakazo/core/node/desktop-runtime";
import { getLogger } from "@rakazo/logging";
import { Agent, request as httpRequest } from "undici";
import WebSocket from "ws";
import type { RawExecEvent } from "./exec-computer.js";
import {
  COMMAND_KILL_AFTER_MS,
  ExecComputer,
  COMPUTER_IMAGE_WORKSPACE as WORKSPACE,
} from "./exec-computer.js";
import { LinuxDesktop, onBotScreen } from "./linux-desktop.js";
import { sandboxNotFoundError } from "./sandbox-errors.js";

const DISPLAY_START = 20;
const DESKTOP_PORT_START = 6100;
// The image's own noVNC gateway listens here once its startup script has finished.
const READY_PORT = 6080;
const DEFAULT_PROJECT = "default";
// Pin a release tag or digest with INCUS_SANDBOX_COMPUTER_IMAGE in production.
const DEFAULT_COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer:edge";
// The Docker computer's default ceilings, in Incus units.
const DEFAULT_CPU_LIMIT = "2";
const DEFAULT_MEMORY_LIMIT = "2GiB";
const DEFAULT_PROCESS_LIMIT = "2048";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
// The first computer on a server downloads the image, which can take minutes.
const CREATE_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
const OPERATION_WAIT_SECONDS = 20;
// Closing an exec's websockets kills only the command itself, so a cancelled command is sent
// SIGTERM first. The `timeout` wrapper passes it to the whole process group and kills the group
// if it is still there after its kill-after delay, so the streams stay open past that.
const TERMINATE_GRACE_MS = COMMAND_KILL_AFTER_MS + 2_000;
// The uid and gid the computer image declares (`USER 1000:1000`). Incus runs the start
// command and exec as root unless told otherwise, so both set it explicitly.
const IMAGE_USER = 1000;
// The computer image's own command (its Dockerfile CMD). The instance starts it without privilege
// escalation, as Docker and Kubernetes computers start, which a restricted project cannot set on
// the container itself.
const IMAGE_COMMAND = "/usr/bin/env -u LD_PRELOAD /usr/local/bin/rakazo-computer";
// Names the bot that owns an instance. An instance carrying another bot's value is never
// reused or replaced.
const BOT_ID_KEY = "user.rakazo-bot-id";

export interface IncusSandboxOptions {
  /** HTTPS address of the Incus API, such as `https://incus.example.test:8443`. */
  url: string;
  clientCert: string;
  clientKey: string;
  /** The server's own certificate. When set, the provider trusts exactly this certificate. */
  serverCert?: string;
  project?: string;
  computerImage?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  processLimit?: string;
  readyTimeoutMs?: number;
}

export interface IncusResponse {
  metadata: unknown;
  /** Set for background operations, such as `/1.0/operations/<id>`. */
  operation?: string;
}

export interface IncusSocket {
  send(data: Buffer | string): Promise<void>;
  /** A normal close, which also ends the command's input. */
  close(): void;
}

export interface IncusSocketHandlers {
  message(data: Buffer, binary: boolean): void;
  close(): void;
  error(error: Error): void;
}

/** The two calls the provider makes to the Incus API. Tests supply an in-memory server. */
export interface IncusClient {
  /** Resolves a successful response and rejects with `IncusError` for an error response. */
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<IncusResponse>;
  /** Opens an operation websocket and resolves once it is connected. */
  websocket(path: string, handlers: IncusSocketHandlers): Promise<IncusSocket>;
}

export class IncusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "IncusError";
  }
}

interface IncusInstance {
  name?: string;
  status?: string;
  ephemeral?: boolean;
  config?: Record<string, string>;
  state?: {
    network?: Record<
      string,
      { addresses?: { family?: string; address?: string; scope?: string }[] }
    >;
  };
}

interface IncusOperationEntry {
  id?: string;
  status_code?: number;
  resources?: { instances?: string[] };
}

interface IncusOperation {
  status?: string;
  status_code?: number;
  err?: string;
  metadata?: { fds?: Record<string, string>; return?: number } | null;
}

export class IncusSandboxProvider implements SandboxProvider {
  private readonly project: string;
  private readonly computerImage: string;
  private readonly cpuLimit: string;
  private readonly memoryLimit: string;
  private readonly processLimit: string;
  private readonly readyTimeoutMs: number;
  private readonly client: IncusClient;
  private readonly shell = new ExecComputer((...exec) => this.execRaw(...exec), "Incus");

  private readonly desktops = new LinuxDesktop({
    environment: async (computer, context) => {
      const address = await this.address(computer, context.signal);
      return {
        homeDir: WORKSPACE,
        workspaceDir: WORKSPACE,
        browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
        displayStart: DISPLAY_START,
        portStart: DESKTOP_PORT_START,
        // The relay must use the address family the web service connects to.
        bindHost: address.includes(":") ? "::" : "0.0.0.0",
      };
    },
    run: async (computer, command, context) =>
      this.shell.run(computer, ["bash", "-c", command], context),
    screenUrl: async (computer, port, context) => {
      const address = await this.address(computer, context.signal);
      const host = address.includes(":") ? `[${address}]` : address;
      // The image's embed.html works in the sandboxed screen frame; see the Kubernetes provider.
      return `http://${host}:${port}/embed.html`;
    },
  });

  constructor(options: IncusSandboxOptions, client?: IncusClient) {
    this.project = options.project?.trim() || DEFAULT_PROJECT;
    this.computerImage = options.computerImage?.trim() || DEFAULT_COMPUTER_IMAGE;
    this.cpuLimit = options.cpuLimit?.trim() || DEFAULT_CPU_LIMIT;
    this.memoryLimit = options.memoryLimit?.trim() || DEFAULT_MEMORY_LIMIT;
    this.processLimit = options.processLimit?.trim() || DEFAULT_PROCESS_LIMIT;
    this.readyTimeoutMs =
      Number.isSafeInteger(options.readyTimeoutMs) && (options.readyTimeoutMs ?? 0) > 0
        ? options.readyTimeoutMs!
        : DEFAULT_READY_TIMEOUT_MS;
    this.client = client ?? new IncusHttpClient(options);
  }

  describe() {
    return {
      id: "incus",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
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
    const { signal } = context;
    signal.throwIfAborted();
    if (request.providerKind === "incus" && request.providerRef) {
      const name = request.providerRef;
      const existing = await this.instance(name, signal);
      if (existing) this.assertOwner(existing, name, request.botId);
      if (existing?.status === "Running") {
        await this.waitForReady(name, request.botId, context);
        return { id: name, botId: request.botId, kind: "incus", providerRef: name, fresh: false };
      }
      // A stopped instance deletes itself; remove one that failed. Its replacement gets a new
      // name, so nothing here waits for it to go.
      if (existing) await this.remove(name, signal).catch(() => {});
    }
    await this.removeOrphans(request.botId, request.providerRef, signal);
    // A new name for every start, as the Daytona provider does: a later start never adopts an
    // instance that an abandoned one created, so that one can be deleted without a race.
    const name = `rakazo-${randomUUID()}`;
    await this.create(name, request.botId, signal);
    try {
      await this.waitForReady(name, request.botId, context);
    } catch (error) {
      await this.remove(name, AbortSignal.timeout(STOP_TIMEOUT_MS)).catch(() => {});
      throw error;
    }
    return { id: name, botId: request.botId, kind: "incus", providerRef: name, fresh: true };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "incus") return false;
    const instance = await this.instance(instanceName(computer), context.signal);
    return instance?.status === "Running";
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await this.shell.prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    requested: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* this.shell.execute(computer, onBotScreen(requested, context, DISPLAY_START), context);
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    return this.desktops.connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    // As on Kubernetes: the API already holds the human control token, and a new run may
    // supersede the bot's screen fence while the human keeps control of the same instance.
    return this.desktops.connectTerminal(computer, request, {
      ...context,
      screenLeaseId: undefined,
    });
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    try {
      await this.desktops.setScreenControl(computer, interactive, context, controlToken);
    } catch (error) {
      throw await this.goneOr(instanceName(computer), error);
    }
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

  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    return this.shell.listFiles(computer, directory, context);
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    return this.shell.readFile(computer, filePath, context, options);
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    await this.shell.writeFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    await this.desktops.stopBrowsers(computer, context);
    yield* this.shell.exportWorkspace(computer, context);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    await this.desktops.stopBrowsers(computer, context);
    await this.shell.importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    const observation = await this.observe(computer, context);
    return { id: observation.frameId, createdAt: observation.capturedAt };
  }

  /** Instances are ephemeral: Incus deletes one as soon as it stops. */
  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.removeOwned(instanceName(computer), computer.botId);
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.removeOwned(instanceName(computer), computer.botId);
  }

  private async removeOwned(name: string, botId: string): Promise<void> {
    const signal = AbortSignal.timeout(STOP_TIMEOUT_MS);
    const instance = await this.instance(name, signal);
    if (!instance) return;
    this.assertOwner(instance, name, botId);
    await this.remove(name, signal);
  }

  /**
   * Removes this bot's instances other than its stored one, such as one whose start died before
   * its name was saved. The caller's claim on the computer means no other start is using them.
   * This never blocks a start; every start that creates an instance tries again.
   */
  private async removeOrphans(
    botId: string,
    keep: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    // The filter language has no quoting for other characters; bot ids use none of them.
    if (!/^[A-Za-z0-9_-]+$/.test(botId)) return;
    let instances: IncusInstance[];
    try {
      const filter = encodeURIComponent(`config.${BOT_ID_KEY} eq ${botId}`);
      const { metadata } = await this.request(
        "GET",
        `/1.0/instances?recursion=1&filter=${filter}`,
        signal,
      );
      instances = (metadata ?? []) as IncusInstance[];
    } catch (error) {
      signal.throwIfAborted();
      getLogger().warn("list Incus instances left by earlier starts", { error });
      return;
    }
    for (const instance of instances) {
      if (!instance.name || instance.name === keep || instance.config?.[BOT_ID_KEY] !== botId)
        continue;
      await this.remove(instance.name, signal).catch((error) => {
        signal.throwIfAborted();
        getLogger().warn("remove Incus instance left by an earlier start", { error });
      });
    }
  }

  private instanceSpec(name: string, botId: string) {
    const environment = { ...COMPUTER_CACHE_ENV, VNC_RESOLUTION: "1280x800" };
    return {
      name,
      type: "container",
      // Deleted when it stops, like a Kubernetes pod; the saved workspace is the persistence.
      ephemeral: true,
      start: true,
      source: { type: "image", protocol: "oci", ...ociImageSource(this.computerImage) },
      config: {
        [BOT_ID_KEY]: botId,
        "limits.cpu": this.cpuLimit,
        "limits.memory": this.memoryLimit,
        "limits.processes": this.processLimit,
        // Set here so a profile cannot loosen them. An isolated id map gives each computer its
        // own unprivileged host uid range, apart from other computers and instances.
        "security.privileged": "false",
        "security.nesting": "false",
        "security.idmap.isolated": "true",
        // Enforced like the Docker computer's `User`, instead of trusting the image's
        // `USER`: a custom image without one would start its command as the container's
        // root.
        "oci.uid": String(IMAGE_USER),
        "oci.gid": String(IMAGE_USER),
        "oci.entrypoint": `setpriv --no-new-privs -- ${IMAGE_COMMAND}`,
        ...Object.fromEntries(
          Object.entries(environment).map(([key, value]) => [`environment.${key}`, value]),
        ),
      },
    };
  }

  private assertOwner(instance: IncusInstance, name: string, botId: string) {
    if (instance.config?.[BOT_ID_KEY] !== botId) {
      throw new Error(`Incus instance ${name} belongs to another bot`);
    }
  }

  private async create(name: string, botId: string, signal: AbortSignal): Promise<void> {
    let accepted: IncusResponse | undefined;
    try {
      // Not cancelled with the caller: Incus may accept the request either way, and its answer
      // names the operation to clean up after.
      accepted = await this.request(
        "POST",
        "/1.0/instances",
        new AbortController().signal,
        this.instanceSpec(name, botId),
      );
      signal.throwIfAborted();
      expectSuccess(await this.waitOperation(accepted, signal, CREATE_TIMEOUT_MS));
    } catch (error) {
      // A refusal Incus answered created nothing. Anything else may have, and Incus goes on
      // creating after a caller gives up.
      if (accepted || !(error instanceof IncusError)) void this.discard(name, accepted);
      throw error;
    }
  }

  /**
   * Deletes the instance of a start that failed or was abandoned, once Incus has finished with it.
   * No later start uses its name, so this cannot remove a computer in use.
   */
  private async discard(name: string, accepted: IncusResponse | undefined): Promise<void> {
    const deadline = AbortSignal.timeout(CREATE_TIMEOUT_MS);
    try {
      const creating = accepted ?? (await this.creation(name, deadline));
      if (creating) await this.waitOperation(creating, deadline, CREATE_TIMEOUT_MS);
      await this.remove(name, AbortSignal.timeout(STOP_TIMEOUT_MS));
    } catch (error) {
      getLogger().error("delete Incus instance left by a failed start", error);
    }
  }

  /** The running operation creating `name`, when the request's answer was lost. */
  private async creation(name: string, signal: AbortSignal): Promise<IncusResponse | undefined> {
    const { metadata } = await this.request("GET", "/1.0/operations?recursion=1", signal);
    const target = instancePath(name);
    const operation = Object.values((metadata ?? {}) as Record<string, IncusOperationEntry[]>)
      .flat()
      .find(
        (entry) =>
          (entry.status_code ?? 0) < 200 &&
          entry.resources?.instances?.some((path) => path.split("?")[0] === target),
      );
    return operation?.id
      ? { metadata: {}, operation: `/1.0/operations/${operation.id}` }
      : undefined;
  }

  private async waitForReady(name: string, botId: string, context: AdapterContext): Promise<void> {
    const { signal } = context;
    const deadline = Date.now() + this.readyTimeoutMs;
    const computer: ComputerRef = { id: name, botId, kind: "incus", providerRef: name };
    while (true) {
      const instance = await this.instance(name, signal);
      if (!instance) throw new Error(`Incus instance ${name} disappeared while starting`);
      if (instance.status === "Error") throw new Error(`Incus instance ${name} failed to start`);
      if (instance.status === "Running" && instanceAddress(instance)) {
        const probe = await this.shell
          .run(computer, ["bash", "-c", `: </dev/tcp/127.0.0.1/${READY_PORT}`], context, 10_000)
          .catch(() => undefined);
        if (probe?.code === 0) return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Incus instance ${name} did not become ready within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(500, undefined, { signal });
    }
  }

  /** Stops the instance, which deletes an ephemeral one, and deletes anything left. */
  private async remove(name: string, signal: AbortSignal): Promise<void> {
    const path = instancePath(name);
    try {
      const stopping = await this.request("PUT", `${path}/state`, signal, {
        action: "stop",
        force: true,
      });
      await this.waitOperation(stopping, signal);
    } catch (error) {
      if (isIncusStatus(error, 404)) return;
      // An instance that is already stopped refuses to stop; the delete below settles it.
    }
    if (!(await this.instance(name, signal))) return;
    try {
      const deleting = await this.request("DELETE", path, signal);
      expectSuccess(await this.waitOperation(deleting, signal));
    } catch (error) {
      if (!isIncusStatus(error, 404)) throw error;
    }
  }

  private async instance(name: string, signal: AbortSignal): Promise<IncusInstance | undefined> {
    try {
      return (await this.request("GET", `${instancePath(name)}?recursion=1`, signal))
        .metadata as IncusInstance;
    } catch (error) {
      if (isIncusStatus(error, 404)) return undefined;
      throw error;
    }
  }

  private async address(computer: ComputerRef, signal: AbortSignal): Promise<string> {
    const name = instanceName(computer);
    const instance = await this.instance(name, signal);
    if (!instance) throw sandboxGone(name);
    const address = instanceAddress(instance);
    if (!address) throw new Error("Incus computer has no network address");
    return address;
  }

  /** Reports a confirmed missing or stopped instance as gone, and anything else as it was. */
  private async goneOr(name: string, error: unknown): Promise<unknown> {
    let instance: IncusInstance | undefined;
    try {
      instance = await this.instance(name, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch {
      return error;
    }
    return instance?.status === "Running" ? error : sandboxGone(name, error);
  }

  private request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    signal: AbortSignal,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<IncusResponse> {
    return this.client.request(
      method,
      withProject(path, this.project),
      body,
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
  }

  private async waitOperation(
    response: IncusResponse,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<IncusOperation> {
    const path = operationPath(response);
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (true) {
      const { metadata } = await this.request(
        "GET",
        `${path}/wait?timeout=${OPERATION_WAIT_SECONDS}`,
        signal,
        undefined,
        (OPERATION_WAIT_SECONDS + 10) * 1_000,
      );
      const operation = (metadata ?? {}) as IncusOperation;
      if ((operation.status_code ?? 0) >= 200) return operation;
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`Incus operation ${path} did not finish in time`);
      }
    }
  }

  private async *execRaw(
    computer: ComputerRef,
    command: string[],
    signal: AbortSignal,
    timeoutMs: number,
    stdin?: Readable,
    tty = false,
  ): AsyncIterable<RawExecEvent> {
    const name = instanceName(computer);
    const queue: RawExecEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let exited = false;
    let failure: unknown;
    const connecting: Promise<IncusSocket>[] = [];
    let control: Promise<IncusSocket> | undefined;
    const requests = new AbortController();
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const push = (event: RawExecEvent) => {
      if (done) return;
      queue.push(event);
      notify();
    };
    const finish = (code: number) => {
      if (done) return;
      queue.push({ type: "exit", code });
      done = true;
      notify();
    };
    const fail = (error: unknown) => {
      if (done) return;
      failure = error;
      done = true;
      notify();
    };
    const abort = () => {
      push({ type: "stderr", data: Buffer.from("command aborted\n") });
      finish(130);
    };
    const timeout = setTimeout(() => {
      push({ type: "stderr", data: Buffer.from(`command timed out after ${timeoutMs} ms\n`) });
      finish(124);
    }, timeoutMs + 10_000);
    signal.addEventListener("abort", abort, { once: true });
    // A failing input stream (for example a workspace iterator that throws)
    // would otherwise leave the command waiting for input until the timeout.
    stdin?.on("error", fail);

    let operation = "";
    const connect = (secret: string, handlers: Partial<IncusSocketHandlers>) => {
      const socket = this.client.websocket(
        withProject(`${operation}/websocket?secret=${encodeURIComponent(secret)}`, this.project),
        {
          message: handlers.message ?? (() => {}),
          close: handlers.close ?? (() => {}),
          error: fail,
        },
      );
      connecting.push(socket);
      return socket;
    };

    const session = async () => {
      let started: IncusResponse;
      try {
        started = await this.request("POST", `${instancePath(name)}/exec`, requests.signal, {
          // Commands do not descend from the image's command, so each sets this itself.
          command: ["setpriv", "--no-new-privs", "--", ...command],
          "wait-for-websocket": true,
          interactive: tty,
          user: IMAGE_USER,
          group: IMAGE_USER,
          cwd: WORKSPACE,
          ...(tty ? { width: 120, height: 40 } : {}),
        });
      } catch (error) {
        throw await this.goneOr(name, error);
      }
      operation = operationPath(started);
      const fds = (started.metadata as IncusOperation | undefined)?.metadata?.fds ?? {};
      /** Connects one of the exec's streams; `ended` settles when its output is complete. */
      const stream = (
        fd: string,
        message?: (data: Buffer, binary: boolean, end: () => void) => void,
      ) => {
        const secret = fds[fd];
        if (!secret) throw new Error(`Incus exec did not offer stream ${fd}`);
        let end!: () => void;
        const ended = new Promise<void>((resolve) => (end = resolve));
        const socket = connect(secret, {
          ...(message ? { message: (data, binary) => message(data, binary, end) } : {}),
          close: end,
        });
        return { socket, ended };
      };
      let outputs: Promise<unknown>;
      if (tty) {
        // One stream carries both directions. Incus marks the end of output with an empty
        // text frame and finishes the command once the client closes that stream.
        const terminal = stream("0", (data, binary, end) => {
          if (data.byteLength) push({ type: "stdout", data });
          else if (!binary) end();
        });
        control = stream("control").socket;
        const [input] = await Promise.all([terminal.socket, control]);
        outputs = terminal.ended.then(() => input.close());
      } else {
        const out = stream("1", (data) => data.byteLength && push({ type: "stdout", data }));
        const err = stream("2", (data) => data.byteLength && push({ type: "stderr", data }));
        control = stream("control").socket;
        const [input] = await Promise.all([stream("0").socket, out.socket, err.socket, control]);
        outputs = Promise.all([out.ended, err.ended]);
        if (stdin) {
          for await (const chunk of stdin) {
            if (done) return;
            await input.send(Buffer.from(chunk as Uint8Array));
          }
        }
        // Closing the input stream is how the command sees the end of its input.
        input.close();
      }
      await outputs;
      const result = await this.waitOperation(started, requests.signal);
      exited = true;
      finish(exitCode(result));
    };

    try {
      if (signal.aborted) abort();
      else session().catch(fail);
      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
        while (queue.length) yield queue.shift()!;
      }
      if (failure) throw failure;
    } finally {
      done = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      requests.abort();
      stdin?.destroy();
      void closeStreams(connecting, exited ? undefined : control);
    }
  }
}

/**
 * Closes an exec's streams, including any still connecting. A command that has not finished is
 * sent SIGTERM first, and its streams stay open while the timeout wrapper stops its process group.
 */
async function closeStreams(
  connecting: Promise<IncusSocket>[],
  control: Promise<IncusSocket> | undefined,
): Promise<void> {
  const opened = (await Promise.allSettled(connecting)).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (control) {
    await control
      .then((socket) => socket.send(JSON.stringify({ command: "signal", signal: 15 })))
      .catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, TERMINATE_GRACE_MS).unref());
  }
  for (const socket of opened) socket.close();
}

/** undici for requests and ws for exec streams, both authenticated by the client certificate. */
class IncusHttpClient implements IncusClient {
  private readonly base: URL;
  private readonly tls: ConnectionOptions;
  private agent: Agent | undefined;
  private socketAgent: HttpsAgent | undefined;

  constructor(options: IncusSandboxOptions) {
    this.base = new URL(options.url);
    if (this.base.protocol !== "https:") throw new Error("the Incus API address must use https");
    this.tls = incusTlsOptions(options);
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<IncusResponse> {
    this.agent ??= new Agent({ connect: this.tls });
    const response = await httpRequest(new URL(path, this.base), {
      method,
      dispatcher: this.agent,
      signal,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const text = await response.body.text();
    let parsed: {
      type?: string;
      error?: string;
      error_code?: number;
      metadata?: unknown;
      operation?: string;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new IncusError(`Incus returned HTTP ${response.statusCode}`, response.statusCode);
    }
    if (parsed.type === "error" || response.statusCode >= 400) {
      throw new IncusError(
        parsed.error || `Incus returned HTTP ${response.statusCode}`,
        parsed.error_code || response.statusCode,
      );
    }
    return { metadata: parsed.metadata, operation: parsed.operation || undefined };
  }

  websocket(path: string, handlers: IncusSocketHandlers): Promise<IncusSocket> {
    const url = new URL(path, this.base);
    url.protocol = "wss:";
    return new Promise((resolve, reject) => {
      this.socketAgent ??= new HttpsAgent(this.tls);
      const socket = new WebSocket(url, {
        agent: this.socketAgent,
        handshakeTimeout: REQUEST_TIMEOUT_MS,
      });
      let open = false;
      socket.on("message", (data, binary) => handlers.message(toBuffer(data), binary));
      socket.on("close", () => handlers.close());
      socket.on("error", (error) => (open ? handlers.error(error) : reject(error)));
      socket.once("open", () => {
        open = true;
        resolve({
          send: (data) =>
            new Promise((sent, failed) =>
              socket.send(data, (error) => (error ? failed(error) : sent())),
            ),
          close: () => {
            if (socket.readyState === WebSocket.OPEN) socket.close(1000);
            else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          },
        });
      });
    });
  }
}

/** Client certificate authentication, and an exact pin of the server certificate when given. */
export function incusTlsOptions(
  options: Pick<IncusSandboxOptions, "clientCert" | "clientKey" | "serverCert">,
): ConnectionOptions {
  const serverCert = options.serverCert?.trim();
  if (!serverCert) return { cert: options.clientCert, key: options.clientKey };
  // Incus generates a self-signed certificate whose names rarely match the address clients
  // use. Trust exactly that certificate, as `incus remote add` does.
  const pinned = new X509Certificate(serverCert).raw;
  return {
    cert: options.clientCert,
    key: options.clientKey,
    ca: serverCert,
    checkServerIdentity: (_host, peer) =>
      peer.raw?.equals(pinned)
        ? undefined
        : new Error("the Incus server presented a different certificate than the configured one"),
  };
}

/** Splits a registry image reference into the OCI server and image name Incus expects. */
export function ociImageSource(image: string): { server: string; alias: string } {
  const slash = image.indexOf("/");
  const registry = slash > 0 ? image.slice(0, slash) : "";
  if (registry.includes(".") || registry.includes(":") || registry === "localhost") {
    return { server: `https://${registry}`, alias: image.slice(slash + 1) };
  }
  return { server: "https://docker.io", alias: image };
}

function instanceName(computer: ComputerRef): string {
  return computer.providerRef || computer.id;
}

function instancePath(name: string): string {
  return `/1.0/instances/${encodeURIComponent(name)}`;
}

function withProject(path: string, project: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`;
}

function operationPath(response: IncusResponse): string {
  const path = response.operation;
  if (!path || !/^\/1\.0\/operations\/[A-Za-z0-9-]+$/.test(path)) {
    throw new Error("Incus did not return an operation");
  }
  return path;
}

function expectSuccess(operation: IncusOperation) {
  if (operation.status_code !== 200) {
    throw new Error(
      operation.err || `Incus operation ended with ${operation.status ?? "no status"}`,
    );
  }
}

function exitCode(operation: IncusOperation): number {
  const code = operation.metadata?.return;
  if (Number.isSafeInteger(code) && code! >= 0 && code! <= 255) return code!;
  return operation.status_code === 200 ? 0 : 1;
}

/** The instance's first global IPv4 address, or its first global IPv6 address. */
function instanceAddress(instance: IncusInstance): string | undefined {
  const addresses = Object.entries(instance.state?.network ?? {})
    .filter(([device]) => device !== "lo")
    .flatMap(([, network]) => network.addresses ?? [])
    .filter((entry) => entry.scope === "global" && entry.address);
  return (
    addresses.find((entry) => entry.family === "inet")?.address ??
    addresses.find((entry) => entry.family === "inet6")?.address
  );
}

function isIncusStatus(error: unknown, status: number): boolean {
  return error instanceof IncusError && error.status === status;
}

function sandboxGone(name: string, cause?: unknown): Error {
  return sandboxNotFoundError(`Incus computer ${name} no longer exists`, { cause });
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
