import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import type * as KubernetesClient from "@kubernetes/client-node";
import type {
  ConfigurationOptions,
  CoreV1Api,
  Exec,
  V1Pod,
  V1PodSpec,
  V1Status,
} from "@kubernetes/client-node";
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
import type { RawExecEvent } from "./exec-computer.js";
import { ExecComputer, COMPUTER_IMAGE_WORKSPACE as WORKSPACE } from "./exec-computer.js";
import { LinuxDesktop, onBotScreen } from "./linux-desktop.js";
import { sandboxNotFoundError } from "./sandbox-errors.js";

const DISPLAY_START = 20;
const DEFAULT_NAMESPACE = "rakazo-sandboxes";
// Same default as the Compose stack. Pin a digest with KUBERNETES_SANDBOX_COMPUTER_IMAGE in
// production so every pod runs the image the API was tested against.
const DEFAULT_COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer:edge";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CONTAINER_NAME = "computer";
// Names the bot that owns a computer pod. A pod carrying another bot's value is
// never reused or replaced.
const BOT_ID_LABEL = "rakazo-bot-id";
const HOME_VOLUME = "home";
const READY_PORT = 6080;
const DESKTOP_PORT_START = 6100;
export interface KubernetesSandboxOptions {
  namespace?: string;
  runtimeClassName?: string;
  computerImage?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  podAnnotations?: Record<string, string>;
  podLabels?: Record<string, string>;
  readyTimeoutMs?: number;
  /**
   * Claim in the sandbox namespace that holds the Rakazo data directory. When
   * set, each Computer mounts only its own `homes/<bot id>` directory at the
   * workspace, so the home persists in place and is never copied in or out.
   * The claim's volume is ReadWriteOnce, so the pod must also be placed with
   * the pods named by `homeColocateNamespace` and `homeColocateLabels`.
   */
  homeClaim?: string;
  homeColocateNamespace?: string;
  homeColocateLabels?: Record<string, string>;
}

export interface KubernetesSandboxSdk {
  core: Pick<CoreV1Api, "createNamespacedPod" | "deleteNamespacedPod" | "readNamespacedPod">;
  exec: Pick<Exec, "exec">;
}

export class KubernetesSandboxProvider implements SandboxProvider {
  private readonly namespace: string;
  private readonly runtimeClassName: string | undefined;
  private readonly computerImage: string;
  private readonly cpuLimit: string | undefined;
  private readonly memoryLimit: string | undefined;
  private readonly podAnnotations: Record<string, string>;
  private readonly podLabels: Record<string, string>;
  private readonly readyTimeoutMs: number;
  private readonly homeClaim: string | undefined;
  private readonly homeColocateNamespace: string | undefined;
  private readonly homeColocateLabels: Record<string, string>;
  private clientsValue: KubernetesSandboxSdk | undefined;
  private readonly shell = new ExecComputer((...exec) => this.execRaw(...exec), "Kubernetes");

  private readonly desktops = new LinuxDesktop({
    environment: async (computer, context) => {
      const pod = await this.readPod(this.podId(computer), context.signal);
      return {
        homeDir: WORKSPACE,
        workspaceDir: WORKSPACE,
        browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
        displayStart: DISPLAY_START,
        portStart: DESKTOP_PORT_START,
        // The relay must use the address family the web pod connects to.
        bindHost: pod?.status?.podIP?.includes(":") ? "::" : "0.0.0.0",
      };
    },
    run: async (computer, command, context) => {
      const result = await this.run(computer, ["bash", "-c", command], context);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    },
    screenUrl: async (computer, port, context) => {
      const pod = await this.readPod(this.podId(computer), context.signal);
      const podIp = pod?.status?.podIP;
      if (!podIp) throw new Error("Kubernetes computer has no pod IP");
      const host = podIp.includes(":") ? `[${podIp}]` : podIp;
      // The web app frames /novnc/ pages with sandbox="allow-scripts", an opaque
      // origin. Stock vnc.html reads localStorage and throws a SecurityError there,
      // leaving a black screen. The image's embed.html is the page the Docker
      // provider serves for the same frame.
      return `http://${host}:${port}/embed.html`;
    },
  });

  constructor(options: KubernetesSandboxOptions = {}, clients?: KubernetesSandboxSdk) {
    this.namespace = options.namespace?.trim() || DEFAULT_NAMESPACE;
    this.runtimeClassName = options.runtimeClassName?.trim() || undefined;
    this.computerImage = options.computerImage?.trim() || DEFAULT_COMPUTER_IMAGE;
    this.cpuLimit = options.cpuLimit?.trim() || undefined;
    this.memoryLimit = options.memoryLimit?.trim() || undefined;
    this.podAnnotations = { ...options.podAnnotations };
    this.podLabels = { ...options.podLabels };
    this.readyTimeoutMs = positiveInteger(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    this.homeClaim = options.homeClaim?.trim() || undefined;
    this.homeColocateNamespace = options.homeColocateNamespace?.trim() || undefined;
    this.homeColocateLabels = { ...options.homeColocateLabels };
    if (
      this.homeClaim &&
      (!this.homeColocateNamespace || Object.keys(this.homeColocateLabels).length === 0)
    ) {
      throw new Error("a mounted Kubernetes home requires a pod-affinity namespace and labels");
    }
    this.clientsValue = clients;
  }

  describe() {
    return {
      id: "kubernetes",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: true,
        snapshots: true,
        takeover: true,
        persistentHome: this.homeClaim !== undefined,
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
    const podName =
      request.providerKind === "kubernetes" && request.providerRef
        ? request.providerRef
        : podNameForBot(request.botId);
    let pod = await this.readPod(podName, context.signal);
    if (pod && pod.metadata?.labels?.[BOT_ID_LABEL] !== request.botId) {
      throw new Error(`Kubernetes pod ${podName} belongs to another bot`);
    }

    if (pod?.metadata?.deletionTimestamp) {
      await this.waitForDeletion(podName, context.signal);
      pod = undefined;
    }

    // Keep an unmounted live pod until the normal checkpoint and stop save its files.
    // The next fresh pod will mount that saved home.
    if (pod && isTerminalPod(pod)) {
      await this.deletePod(podName);
      await this.waitForDeletion(podName, context.signal);
      pod = undefined;
    }

    let fresh = false;
    if (!pod) {
      try {
        await (await this.clients()).core.createNamespacedPod({
          namespace: this.namespace,
          body: this.pod(podName, request.botId),
        });
        fresh = true;
      } catch (error) {
        if (!isApiStatus(error, 409)) throw error;
        const existing = await this.readPod(podName, context.signal);
        if (existing?.metadata?.labels?.[BOT_ID_LABEL] !== request.botId) {
          throw new Error(`Kubernetes pod ${podName} belongs to another bot`);
        }
      }
    }

    try {
      await this.waitForReady(podName, context.signal);
    } catch (error) {
      if (fresh) await this.deletePod(podName).catch(() => undefined);
      throw error;
    }
    return {
      id: podName,
      botId: request.botId,
      kind: "kubernetes",
      providerRef: podName,
      fresh,
    };
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "kubernetes") return false;
    const pod = await this.readPod(this.podId(computer), context.signal);
    return pod?.status?.phase === "Running" && !pod.metadata?.deletionTimestamp;
  }

  async hasMountedHome(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== "kubernetes") return false;
    // Checked even with no claim configured: a pod started with one still mounts the home
    // until it stops, and exporting over that directory would delete its live files.
    const pod = await this.readPod(this.podId(computer), context.signal);
    return !!pod && podMountsHome(pod, computer.botId, this.homeClaim);
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
    // The API has already required the live human control token. Attach the
    // terminal to that controlled display without trying to replace the bot
    // run's screen fence: a new chat run may legitimately supersede the fence
    // while the human keeps control of the same persistent Kubernetes pod.
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
      let pod: V1Pod | undefined;
      try {
        pod = await this.readPod(this.podId(computer), context.signal);
      } catch {
        throw error;
      }
      if (pod && !isTerminalPod(pod) && !pod.metadata?.deletionTimestamp) throw error;
      throw sandboxGone(this.podId(computer), error);
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

  async stop(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.deletePod(this.podId(computer));
  }

  async destroy(computer: ComputerRef, _context: AdapterContext): Promise<void> {
    await this.deletePod(this.podId(computer));
  }

  private async clients(): Promise<KubernetesSandboxSdk> {
    if (this.clientsValue) return this.clientsValue;
    const kubernetes = await loadKubernetes();
    if (this.clientsValue) return this.clientsValue;
    const config = new kubernetes.KubeConfig();
    config.loadFromDefault();
    this.clientsValue = {
      core: config.makeApiClient(kubernetes.CoreV1Api),
      exec: new kubernetes.Exec(config),
    };
    return this.clientsValue;
  }

  private pod(name: string, botId: string): V1Pod {
    const limits = {
      ...(this.cpuLimit ? { cpu: this.cpuLimit } : {}),
      ...(this.memoryLimit ? { memory: this.memoryLimit } : {}),
    };
    return {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name,
        namespace: this.namespace,
        annotations: this.podAnnotations,
        labels: {
          ...this.podLabels,
          "app.kubernetes.io/name": "rakazo-computer",
          [BOT_ID_LABEL]: botId,
        },
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 10,
        ...(this.homeClaim ? this.homeSpec(botId) : {}),
        ...(this.runtimeClassName ? { runtimeClassName: this.runtimeClassName } : {}),
        containers: [
          {
            name: CONTAINER_NAME,
            image: this.computerImage,
            env: [
              ...Object.entries(COMPUTER_CACHE_ENV).map(([name, value]) => ({ name, value })),
              { name: "VNC_RESOLUTION", value: "1280x800" },
            ],
            ports: [{ name: "screen", containerPort: READY_PORT, protocol: "TCP" }],
            // Matches the Docker computer: no capabilities, no privilege escalation, default seccomp.
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              seccompProfile: { type: "RuntimeDefault" },
            },
            readinessProbe: {
              tcpSocket: { port: READY_PORT },
              initialDelaySeconds: 1,
              periodSeconds: 1,
              timeoutSeconds: 1,
              failureThreshold: Math.ceil(this.readyTimeoutMs / 1_000),
            },
            ...(this.homeClaim
              ? {
                  volumeMounts: [
                    { name: HOME_VOLUME, mountPath: WORKSPACE, subPath: homeSubPath(botId) },
                  ],
                }
              : {}),
            ...(Object.keys(limits).length ? { resources: { limits } } : {}),
          },
        ],
      },
    };
  }

  private homeSpec(botId: string): Pick<V1PodSpec, "volumes" | "securityContext" | "affinity"> {
    homeSubPath(botId);
    return {
      volumes: [{ name: HOME_VOLUME, persistentVolumeClaim: { claimName: this.homeClaim! } }],
      // The Computer image runs as uid 1000, the owner of the application data.
      securityContext: { fsGroup: 1000, fsGroupChangePolicy: "OnRootMismatch" },
      affinity: {
        podAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            {
              namespaces: [this.homeColocateNamespace!],
              labelSelector: { matchLabels: this.homeColocateLabels },
              topologyKey: "kubernetes.io/hostname",
            },
          ],
        },
      },
    };
  }

  private podId(computer: ComputerRef): string {
    return computer.providerRef || computer.id;
  }

  private async readPod(name: string, signal: AbortSignal): Promise<V1Pod | undefined> {
    try {
      return await this.request(signal, (core, options) =>
        core.readNamespacedPod({ name, namespace: this.namespace }, options),
      );
    } catch (error) {
      if (isApiStatus(error, 404)) return undefined;
      throw error;
    }
  }

  private async request<T>(
    signal: AbortSignal,
    call: (core: KubernetesSandboxSdk["core"], options: ConfigurationOptions) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const request = Promise.all([loadKubernetes(), this.clients()]).then(
      ([{ Observable }, clients]) =>
        call(clients.core, {
          middlewareMergeStrategy: "append",
          middleware: [
            {
              pre: (request) => {
                request.setSignal(requestSignal);
                return new Observable(Promise.resolve(request));
              },
              post: (response) => new Observable(Promise.resolve(response)),
            },
          ],
        }),
    );
    const result = await abortableRequest(request, requestSignal);
    signal.throwIfAborted();
    return result;
  }

  private async waitForReady(name: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (true) {
      const pod = await this.readPod(name, signal);
      if (!pod) throw new Error(`Kubernetes pod ${name} disappeared while starting`);
      if (pod.metadata?.deletionTimestamp) throw sandboxGone(name);
      if (isTerminalPod(pod)) {
        throw new Error(`Kubernetes pod ${name} entered phase ${pod.status?.phase ?? "Unknown"}`);
      }
      if (
        pod.status?.phase === "Running" &&
        pod.status.conditions?.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        )
      ) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Kubernetes pod ${name} did not become ready within ${this.readyTimeoutMs} ms`,
        );
      }
      await abortableDelay(500, signal);
    }
  }

  private async waitForDeletion(name: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (await this.readPod(name, signal)) {
      if (Date.now() >= deadline) throw new Error(`Kubernetes pod ${name} was not deleted`);
      await abortableDelay(500, signal);
    }
  }

  private async deletePod(name: string): Promise<void> {
    try {
      // Cancellation must not skip cleanup, so only the request deadline bounds it.
      await this.request(AbortSignal.timeout(REQUEST_TIMEOUT_MS), (core, options) =>
        core.deleteNamespacedPod(
          {
            name,
            namespace: this.namespace,
            gracePeriodSeconds: 0,
            propagationPolicy: "Background",
          },
          options,
        ),
      );
    } catch (error) {
      if (!isApiStatus(error, 404)) throw error;
    }
  }

  private async run(
    computer: ComputerRef,
    command: string[],
    context: AdapterContext,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.shell.run(computer, command, context);
  }

  private async *execRaw(
    computer: ComputerRef,
    command: string[],
    signal: AbortSignal,
    timeoutMs: number,
    stdin?: Readable,
    tty = false,
  ): AsyncIterable<RawExecEvent> {
    const queue: RawExecEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    let socket: Awaited<ReturnType<KubernetesSandboxSdk["exec"]["exec"]>> | undefined;
    let settled!: () => void;
    const completed = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const push = (event: RawExecEvent) => {
      if (done) return;
      queue.push(event);
      wake?.();
      wake = undefined;
    };
    const finish = (code: number) => {
      if (done) return;
      queue.push({ type: "exit", code });
      done = true;
      settled();
      wake?.();
      wake = undefined;
    };
    const fail = (error: unknown) => {
      if (done) return;
      failure = error;
      done = true;
      settled();
      wake?.();
      wake = undefined;
    };
    const stdout = new PassThrough();
    const stderr = tty ? undefined : new PassThrough();
    stdout.on("data", (data: Buffer) => push({ type: "stdout", data: Buffer.from(data) }));
    stderr?.on("data", (data: Buffer) => push({ type: "stderr", data: Buffer.from(data) }));
    const abort = () => {
      socket?.close();
      push({ type: "stderr", data: Buffer.from("command aborted\n") });
      finish(130);
    };
    const timeout = setTimeout(() => {
      socket?.close();
      push({
        type: "stderr",
        data: Buffer.from(`command timed out after ${timeoutMs} ms\n`),
      });
      finish(124);
    }, timeoutMs + 10_000);
    signal.addEventListener("abort", abort, { once: true });
    // A failing input stream (for example a workspace iterator that throws)
    // would otherwise leave the exec waiting for input until the timeout.
    stdin?.on("error", fail);
    try {
      if (signal.aborted) {
        abort();
      } else {
        const connecting = this.clients().then((clients) =>
          clients.exec.exec(
            this.namespace,
            this.podId(computer),
            CONTAINER_NAME,
            command,
            stdout,
            stderr ?? null,
            stdin ?? null,
            tty,
            (status) => finish(exitCode(status)),
          ),
        );
        await Promise.race([
          connecting.then(
            (connected) => {
              socket = connected;
              if (done) {
                connected.close();
                return;
              }
              connected.onclose = () => finish(1);
              connected.onerror = (event) => fail(execSocketError(event));
            },
            (event) => fail(execSocketError(event)),
          ),
          completed,
        ]);
      }
      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
        while (queue.length) yield queue.shift()!;
      }
      if (failure) {
        if (failure instanceof Error && /Unexpected server response: 404\b/.test(failure.message)) {
          let pod: V1Pod | undefined;
          try {
            pod = await this.readPod(this.podId(computer), signal);
          } catch {
            throw failure;
          }
          if (!pod || isTerminalPod(pod) || pod.metadata?.deletionTimestamp) {
            throw sandboxGone(this.podId(computer), failure);
          }
        }
        throw failure;
      }
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      socket?.close();
      stdin?.destroy();
      stdout.destroy();
      stderr?.destroy();
    }
  }
}

/** A socket reports failure with an event whose fields are not enumerable, so it logs as `{}`. */
function execSocketError(event: unknown): unknown {
  const { error, message } = event as { error?: unknown; message?: string };
  return event instanceof Error ? event : (error ?? new Error(message || "Kubernetes exec failed"));
}

let kubernetesModule: Promise<typeof KubernetesClient> | undefined;

/** Deferred so deployments that never select this provider do not load the SDK at boot. */
function loadKubernetes(): Promise<typeof KubernetesClient> {
  kubernetesModule ??= import("@kubernetes/client-node");
  return kubernetesModule;
}

function podNameForBot(botId: string): string {
  const normalized = botId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `rakazo-${normalized || "bot"}-${hash}`;
}

/** The data directory holds `homes/<bot id>`; a bot id must name exactly one folder. */
function homeSubPath(botId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error("invalid bot id for a mounted home");
  return `homes/${botId}`;
}

/** With no claim configured, any claim counts, so pods started with one keep their mount. */
function podMountsHome(pod: V1Pod, homeKey: string, claimName: string | undefined): boolean {
  const claims = new Set(
    pod.spec?.volumes?.flatMap((entry) => {
      const claim = entry.persistentVolumeClaim?.claimName;
      return claim && (!claimName || claim === claimName) ? [entry.name] : [];
    }),
  );
  const container = pod.spec?.containers?.find((entry) => entry.name === CONTAINER_NAME);
  return (
    container?.volumeMounts?.some(
      (mount) =>
        claims.has(mount.name) &&
        mount.mountPath === WORKSPACE &&
        mount.subPath === `homes/${homeKey}`,
    ) === true
  );
}

function sandboxGone(name: string, cause?: unknown): Error {
  return sandboxNotFoundError(`Kubernetes computer ${name} no longer exists`, { cause });
}

function isTerminalPod(pod: V1Pod): boolean {
  return pod.status?.phase === "Failed" || pod.status?.phase === "Succeeded";
}

function exitCode(status: V1Status): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((entry) => entry.reason === "ExitCode");
  const code = Number(cause?.message);
  return Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code : 1;
}

function isApiStatus(error: unknown, code: number): boolean {
  // ApiException carries the HTTP status as `code`.
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

/** Bound setup as well as transport, including authentication before the HTTP request starts. */
function abortableRequest<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Kubernetes request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => done(signal.reason ?? new Error("Kubernetes operation aborted"));
    function done(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
