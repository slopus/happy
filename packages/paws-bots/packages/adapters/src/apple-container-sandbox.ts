import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
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
import type { RawExecEvent } from "./exec-computer.js";
import { ExecComputer, COMPUTER_IMAGE_WORKSPACE as WORKSPACE } from "./exec-computer.js";
import { LinuxDesktop, onBotScreen } from "./linux-desktop.js";
import { sandboxNotFoundError } from "./sandbox-errors.js";

const DISPLAY_START = 20;
const DESKTOP_PORT_START = 6100;
const READY_PORT = 6080;
const DEFAULT_COMPUTER_IMAGE = "ghcr.io/elie222/rakazo/computer:edge";
const DEFAULT_CPUS = "2";
const DEFAULT_MEMORY = "2g";
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 60_000;
// The first computer downloads the image (about 600 MB compressed).
const CREATE_TIMEOUT_MS = 15 * 60_000;
const IMAGE_USER = "1000";
const IMAGE_COMMAND = ["/usr/bin/env", "-u", "LD_PRELOAD", "/usr/local/bin/rakazo-computer"];
const BOT_ID_LABEL = "rakazo.bot-id";
const KIND = "local-vm";

export interface AppleContainerSandboxOptions {
  /** The `container` CLI. The desktop app points this at its bundled copy. */
  cli?: string;
  computerImage?: string;
  cpus?: string;
  memory?: string;
  readyTimeoutMs?: number;
}

interface ContainerRecord {
  configuration?: { id?: string; labels?: Record<string, string> };
  status?: {
    state?: string;
    networks?: { ipv4Address?: string; ipv4Gateway?: string; network?: string }[];
  };
}

/**
 * The VM's own firewall: the public IPv4 internet and DNS on the gateway out, nothing to the Mac,
 * the LAN, link-local, CGNAT or multicast, and no IPv6 beyond neighbour discovery, since global
 * IPv6 addresses would reach the Mac and the LAN directly; in, only the host to the screen ports.
 */
export function localVmFirewall(gateway: string): string {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)) throw new Error(`invalid VM gateway ${gateway}`);
  return `add table inet rakazo
delete table inet rakazo
table inet rakazo {
  chain output {
    type filter hook output priority filter; policy accept;
    oif "lo" accept
    ct state established,related accept
    ip daddr ${gateway} meta l4proto { tcp, udp } th dport 53 accept
    ip daddr ${gateway} reject
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } reject
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
    meta nfproto ipv6 reject
  }
  chain input {
    type filter hook input priority filter; policy drop;
    iif "lo" accept
    ct state established,related accept
    ip saddr ${gateway} tcp dport { ${READY_PORT}, ${DESKTOP_PORT_START} } accept
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept
  }
}
`;
}

/**
 * Each computer is one lightweight Linux VM started from the published computer image by
 * Apple's `container` runtime (Virtualization.framework), on a network of its own so computers
 * cannot reach each other. No Docker, supervisor or socket is involved; the API, worker and web
 * reach the screen gateway on the VM's address, as with Incus.
 */
export class AppleContainerSandboxProvider implements SandboxProvider {
  private readonly cli: string;
  private readonly computerImage: string;
  private readonly cpus: string;
  private readonly memory: string;
  private readonly readyTimeoutMs: number;
  private readonly shell = new ExecComputer((...exec) => this.execRaw(...exec), "VM");

  private readonly desktops = new LinuxDesktop({
    environment: async () => ({
      homeDir: WORKSPACE,
      workspaceDir: WORKSPACE,
      browserProfilesDir: `${WORKSPACE}/.browser-profiles`,
      displayStart: DISPLAY_START,
      portStart: DESKTOP_PORT_START,
      bindHost: "0.0.0.0",
    }),
    run: async (computer, command, context) =>
      this.shell.run(computer, ["bash", "-c", command], context),
    screenUrl: async (computer, port, context) =>
      `http://${await this.address(computer, context.signal)}:${port}/embed.html`,
  });

  constructor(options: AppleContainerSandboxOptions = {}) {
    this.cli = options.cli?.trim() || "container";
    this.computerImage = options.computerImage?.trim() || DEFAULT_COMPUTER_IMAGE;
    this.cpus = options.cpus?.trim() || DEFAULT_CPUS;
    this.memory = options.memory?.trim() || DEFAULT_MEMORY;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  describe() {
    return {
      id: KIND,
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
    if (request.providerKind === KIND && request.providerRef) {
      const name = request.providerRef;
      const existing = await this.inspect(name, signal);
      if (existing) this.assertOwner(existing, name, request.botId);
      if (existing?.status?.state === "running") {
        try {
          await this.lockDown(name, signal);
        } catch (error) {
          await this.remove(name).catch(() => {});
          throw error;
        }
        await this.waitForReady(name, request.botId, context);
        return { id: name, botId: request.botId, kind: KIND, providerRef: name, fresh: false };
      }
      if (existing) await this.remove(name).catch(() => {});
    }
    await this.removeOrphans(request.botId, request.providerRef, signal);
    const name = `rakazo-${randomUUID()}`;
    try {
      await this.cliRun(["network", "create", name], signal);
      await this.cliRun(this.runArgs(name, request.botId), signal, {
        timeoutMs: CREATE_TIMEOUT_MS,
      });
      await this.lockDown(name, signal);
      await this.waitForReady(name, request.botId, context);
    } catch (error) {
      await this.remove(name).catch(() => {});
      throw error;
    }
    return { id: name, botId: request.botId, kind: KIND, providerRef: name, fresh: true };
  }

  /** The `container run` argv: a VM of its own on its own network, running as the image user. */
  runArgs(name: string, botId: string): string[] {
    const environment = { ...COMPUTER_CACHE_ENV, VNC_RESOLUTION: "1280x800" };
    return [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      name,
      "--label",
      `${BOT_ID_LABEL}=${botId}`,
      "--cpus",
      this.cpus,
      "--memory",
      this.memory,
      "--shm-size",
      "1g",
      "--uid",
      IMAGE_USER,
      "--gid",
      IMAGE_USER,
      "--cap-drop",
      "ALL",
      // Only root execs get it, to load the firewall; uid 1000 runs with no new privileges.
      "--cap-add",
      "CAP_NET_ADMIN",
      ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--entrypoint",
      "setpriv",
      this.computerImage,
      "--no-new-privs",
      "--",
      ...IMAGE_COMMAND,
    ];
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    if (computer.kind !== KIND) return false;
    return (
      (await this.inspect(containerName(computer), context.signal))?.status?.state === "running"
    );
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

  connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return this.desktops.connectScreen(computer, request, context) as Promise<ScreenSession>;
  }

  connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    return this.desktops.connectTerminal(computer, request, {
      ...context,
      screenLeaseId: undefined,
    });
  }

  setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    return this.desktops.setScreenControl(computer, interactive, context, controlToken);
  }

  sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    return this.desktops.sendInput(computer, input, context);
  }

  observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    return this.desktops.observe(computer, context);
  }

  act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return this.desktops.act(computer, request, context);
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    return this.desktops.releaseScreen(computer, context);
  }

  listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    return this.shell.listFiles(computer, directory, context);
  }

  readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    return this.shell.readFile(computer, filePath, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.shell.writeFile(computer, file, context);
  }

  async *exportWorkspace(computer: ComputerRef, context: AdapterContext) {
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

  /** Computers are removed when they stop; the saved workspace is the persistence. */
  async stop(computer: ComputerRef): Promise<void> {
    await this.removeOwned(containerName(computer), computer.botId);
  }

  async destroy(computer: ComputerRef): Promise<void> {
    await this.removeOwned(containerName(computer), computer.botId);
  }

  private async removeOwned(name: string, botId: string) {
    const existing = await this.inspect(name, AbortSignal.timeout(CLI_TIMEOUT_MS));
    if (existing) this.assertOwner(existing, name, botId);
    await this.remove(name);
  }

  private async removeOrphans(botId: string, keep: string | undefined, signal: AbortSignal) {
    let records: ContainerRecord[];
    try {
      records = JSON.parse(
        (await this.cliRun(["ls", "--all", "--format", "json"], signal)).stdout || "[]",
      );
    } catch (error) {
      signal.throwIfAborted();
      getLogger().warn("list VM computers left by earlier starts", { error });
      return;
    }
    for (const record of records) {
      const id = record.configuration?.id;
      if (!id || id === keep || record.configuration?.labels?.[BOT_ID_LABEL] !== botId) continue;
      await this.remove(id).catch((error) =>
        getLogger().warn("remove VM computer left by an earlier start", { error }),
      );
    }
  }

  /** Removes the VM and its network; either may already be gone. */
  private async remove(name: string) {
    try {
      await this.cliRun(["rm", "--force", name], AbortSignal.timeout(CLI_TIMEOUT_MS), {
        allowFailure: true,
      });
    } finally {
      await this.cliRun(["network", "rm", name], AbortSignal.timeout(CLI_TIMEOUT_MS), {
        allowFailure: true,
      });
    }
  }

  /** Loads the firewall as root and checks it is in place; the caller removes the VM on failure. */
  private async lockDown(name: string, signal: AbortSignal) {
    const gateway = (await this.inspect(name, signal))?.status?.networks?.[0]?.ipv4Gateway;
    if (!gateway) throw new Error(`VM computer ${name} has no network gateway`);
    const asRoot = async (args: string[], input?: string) => {
      const result = await this.cliRun(["exec", "--uid", "0", "--gid", "0", ...args], signal, {
        allowFailure: true,
        input,
      });
      if (result.code !== 0) {
        throw new Error(
          `VM computer ${name} could not lock down its network; local-vm needs a computer image with nft: ${result.stderr.trim() || `exit ${result.code}`}`,
        );
      }
    };
    await asRoot(["--interactive", name, "nft", "-f", "-"], localVmFirewall(gateway));
    await asRoot([name, "nft", "list", "table", "inet", "rakazo"]);
  }

  private assertOwner(record: ContainerRecord, name: string, botId: string) {
    if (record.configuration?.labels?.[BOT_ID_LABEL] !== botId) {
      throw new Error(`VM computer ${name} belongs to another bot`);
    }
  }

  private async waitForReady(name: string, botId: string, context: AdapterContext) {
    const deadline = Date.now() + this.readyTimeoutMs;
    const computer: ComputerRef = { id: name, botId, kind: KIND, providerRef: name };
    while (true) {
      const probe = await this.shell
        .run(computer, ["bash", "-c", `: </dev/tcp/127.0.0.1/${READY_PORT}`], context, 10_000)
        .catch(() => undefined);
      if (probe?.code === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `VM computer ${name} did not become ready within ${this.readyTimeoutMs} ms`,
        );
      }
      await sleep(500, undefined, { signal: context.signal });
    }
  }

  private async inspect(name: string, signal: AbortSignal): Promise<ContainerRecord | undefined> {
    const result = await this.cliRun(["inspect", name], signal, { allowFailure: true });
    if (result.code !== 0) {
      if (/not found/i.test(result.stderr)) return undefined;
      throw new Error(`container inspect failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return (JSON.parse(result.stdout || "[]") as ContainerRecord[])[0];
  }

  private async address(computer: ComputerRef, signal: AbortSignal): Promise<string> {
    const name = containerName(computer);
    const record = await this.inspect(name, signal);
    if (!record) throw sandboxNotFoundError(`VM computer ${name} no longer exists`);
    const address = record.status?.networks?.[0]?.ipv4Address?.split("/")[0];
    if (!address) throw new Error("VM computer has no network address");
    return address;
  }

  /** Runs the CLI to completion. A non-zero exit throws unless `allowFailure`. */
  private cliRun(
    args: string[],
    signal: AbortSignal,
    {
      timeoutMs = CLI_TIMEOUT_MS,
      allowFailure = false,
      input,
    }: { timeoutMs?: number; allowFailure?: boolean; input?: string } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, args, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        const result = { code: code ?? 1, stdout, stderr };
        if (result.code !== 0 && !allowFailure) {
          reject(new Error(`container ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`));
        } else resolve(result);
      });
    });
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
    const push = (event: RawExecEvent) => {
      if (done) return;
      queue.push(event);
      if (event.type === "exit") done = true;
      wake?.();
      wake = undefined;
    };
    const child = spawn(
      this.cli,
      [
        "exec",
        "--interactive",
        ...(tty ? ["--tty"] : []),
        "--uid",
        IMAGE_USER,
        "--gid",
        IMAGE_USER,
        "--workdir",
        WORKSPACE,
        containerName(computer),
        "setpriv",
        "--no-new-privs",
        "--",
        ...command,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stop = (code: number, message: string) => {
      push({ type: "stderr", data: Buffer.from(message) });
      push({ type: "exit", code });
      child.kill("SIGTERM");
    };
    const abort = () => stop(130, "command aborted\n");
    const timer = setTimeout(
      () => stop(124, `command timed out after ${timeoutMs} ms\n`),
      timeoutMs + 10_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => push({ type: "stdout", data }));
    child.stderr.on("data", (data: Buffer) => push({ type: "stderr", data }));
    child.once("error", (error) => stop(127, `${error.message}\n`));
    child.once("close", (code) => push({ type: "exit", code: code ?? 1 }));
    child.stdin.on("error", () => {});
    if (stdin) stdin.pipe(child.stdin);
    else child.stdin.end();
    try {
      if (signal.aborted) abort();
      while (!done || queue.length) {
        if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
        while (queue.length) yield queue.shift()!;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      stdin?.unpipe(child.stdin);
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}

function containerName(computer: ComputerRef): string {
  return computer.providerRef || computer.id;
}
