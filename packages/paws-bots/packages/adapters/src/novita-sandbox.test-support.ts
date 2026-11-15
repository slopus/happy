import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  SandboxNotFoundError,
  TimeoutError,
} from "novita-sandbox";
import { parse } from "shell-quote";
import { vi } from "vitest";
import { desktopCommandResponder, simpleCommand } from "./linux-desktop.test-support.js";
import type {
  NovitaApi,
  NovitaCommandHandle,
  NovitaDesktop,
  NovitaRunningInfo,
} from "./novita-sandbox.js";
import { NovitaSandboxProvider, novitaSdk } from "./novita-sandbox.js";
import { NOVITA_COMPUTER_TEMPLATE } from "./novita-template.js";
import type { CommandResult, RemoteDesktop, RemoteDesktopSdk } from "./remote-desktop-sandbox.js";

const EMULATOR_KEY = "test-novita-key";
const PAUSED = "502: This error is likely due to sandbox timeout.";

interface EmulatedProcess {
  command: string;
  settle(outcome: { result: CommandResult } | { error: Error }): void;
}

interface EmulatedComputer {
  state: "running" | "paused";
  template: string;
  metadata: Record<string, string>;
  lifecycle: unknown;
  timeoutMs: number;
  envdAccessToken: string;
  files: Map<string, { content: Uint8Array; mode: number }>;
  processes: Set<EmulatedProcess>;
  respond: ReturnType<typeof desktopCommandResponder>;
}

/**
 * In-memory Novita SDK: the desktop/sandbox lifecycle calls, GET-only handle construction,
 * background command handles, files, and the SDK's own error classes, so the real adapter's
 * translation, cancellation, and safety-stop paths run offline. Its shell understands only what
 * the adapter sends: desktop runtime scripts, chmod, `env`, `echo`, and `printenv`.
 */
export class NovitaEmulator implements NovitaApi {
  readonly computers = new Map<string, EmulatedComputer>();
  readonly templates = new Set([NOVITA_COMPUTER_TEMPLATE]);
  /** Every request the adapter made, in order, without credentials. */
  readonly requests: string[] = [];
  /** The only key accepted; change it to emulate a revoked key. */
  apiKey = EMULATOR_KEY;
  /** Commands matching this never exit on their own; they end on kill or their deadline. */
  hangs: (command: string) => boolean = () => false;
  /** How many upcoming calls of each kind fail with a transport error. */
  readonly faults = { startEvents: 0, commandKills: 0, sandboxKills: 0, pauses: 0 };
  private sequence = 0;

  desktop: NovitaApi["desktop"] = {
    create: async (template, options) => {
      this.requests.push(`create ${template}`);
      this.authorize(options.apiKey);
      if (!this.templates.has(template)) throw new Error(`404: template ${template} not found`);
      const id = `novita-${++this.sequence}`;
      this.computers.set(id, {
        state: "running",
        template,
        metadata: options.metadata,
        lifecycle: options.lifecycle,
        timeoutMs: options.timeoutMs,
        envdAccessToken: `envd-${id}`,
        files: new Map(),
        processes: new Set(),
        respond: desktopCommandResponder(),
      });
      return this.handle(id);
    },
    connect: async (id, options) => {
      this.requests.push(`connect ${id}`);
      this.authorize(options.apiKey);
      const computer = this.require(id);
      computer.state = "running";
      computer.timeoutMs = options.timeoutMs;
      return this.handle(id);
    },
  };

  sandbox: NovitaApi["sandbox"] = {
    setTimeout: async (id, timeoutMs) => this.setTimeout(id, timeoutMs),
    pause: async (id, options) => {
      this.requests.push(`pause ${id}${options.sync ? " sync" : ""}`);
      const computer = this.require(id);
      if (this.faults.pauses > 0) {
        this.faults.pauses--;
        throw new Error("pause unavailable");
      }
      computer.state = "paused";
      return true;
    },
    getInfo: async (id) => {
      this.requests.push(`info ${id}`);
      return { state: this.require(id).state };
    },
    kill: async (id) => {
      this.requests.push(`kill ${id}`);
      if (this.faults.sandboxKills > 0) {
        this.faults.sandboxKills--;
        throw new Error("delete unavailable");
      }
      const computer = this.computers.get(id);
      if (!computer) return false;
      for (const process of computer.processes)
        process.settle({ error: new Error("sandbox deleted") });
      this.computers.delete(id);
      return true;
    },
  };

  async getFullInfo(id: string): Promise<NovitaRunningInfo> {
    this.requests.push(`info ${id}`);
    const computer = this.require(id);
    return {
      sandboxId: id,
      state: computer.state,
      sandboxDomain: "sandbox.test",
      envdVersion: "0.4.0",
      envdAccessToken: computer.envdAccessToken,
      trafficAccessToken: `traffic-${id}`,
    };
  }

  async setTimeout(id: string, timeoutMs: number): Promise<void> {
    this.requests.push(`timeout ${id}`);
    const computer = this.require(id);
    // Novita answers a paused sandbox's timeout change as a missing one.
    if (computer.state !== "running") throw new SandboxNotFoundError(`Sandbox ${id} not found`);
    computer.timeoutMs = timeoutMs;
  }

  attach(info: Parameters<NovitaApi["attach"]>[0]): NovitaDesktop {
    if (this.computers.get(info.sandboxId)?.envdAccessToken !== info.envdAccessToken)
      throw new AuthenticationError("Invalid envd access token");
    return this.handle(info.sandboxId);
  }

  /** Commands still running (or suspended by a pause) on a computer. */
  live(id: string): string[] {
    return [...(this.computers.get(id)?.processes ?? [])].map((process) => process.command);
  }

  private authorize(apiKey: string) {
    if (apiKey !== this.apiKey) throw new AuthenticationError("Invalid API key");
  }

  private require(id: string): EmulatedComputer {
    const computer = this.computers.get(id);
    if (!computer) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
    return computer;
  }

  private running(id: string): EmulatedComputer {
    const computer = this.require(id);
    if (computer.state !== "running") throw new TimeoutError(PAUSED);
    return computer;
  }

  private file(id: string, path: string) {
    const file = this.running(id).files.get(path);
    if (!file) throw new FileNotFoundError(`Path ${path} not found`);
    return file;
  }

  private handle(id: string): NovitaDesktop {
    return {
      sandboxId: id,
      getHost: (port) => `${port}-${id}.sandbox.test`,
      setTimeout: async (timeoutMs) => {
        this.running(id).timeoutMs = timeoutMs;
      },
      commands: { run: async (command, options) => this.start(id, command, options) },
      files: {
        makeDir: async () => {
          this.running(id);
          return true;
        },
        list: async (path) => {
          const entries = new Map<
            string,
            { name: string; type: string; size: number; mode: number }
          >();
          for (const [filePath, file] of this.running(id).files) {
            if (!filePath.startsWith(`${path}/`)) continue;
            const [name, ...rest] = filePath.slice(path.length + 1).split("/");
            entries.set(name!, {
              name: name!,
              type: rest.length ? "dir" : "file",
              size: rest.length ? 0 : file.content.byteLength,
              mode: rest.length ? 0o755 : file.mode,
            });
          }
          return [...entries.values()];
        },
        getInfo: async (path) => {
          const file = this.file(id, path);
          return {
            name: path.split("/").at(-1)!,
            type: "file",
            size: file.content.byteLength,
            mode: file.mode,
          };
        },
        read: async (path) => new Uint8Array(this.file(id, path).content),
        write: async (batch) => {
          const { files } = this.running(id);
          for (const file of batch)
            files.set(file.path, { content: new Uint8Array(file.data), mode: 0o600 });
          return batch.map((file) => ({ path: file.path }));
        },
      },
    };
  }

  private start(
    id: string,
    command: string,
    options: Parameters<NovitaDesktop["commands"]["run"]>[1],
  ): NovitaCommandHandle {
    const computer = this.running(id);
    let settled!: (outcome: { result: CommandResult } | { error: Error }) => void;
    const outcome = new Promise<{ result: CommandResult } | { error: Error }>((resolve) => {
      settled = resolve;
    });
    let timer: NodeJS.Timeout | undefined;
    const process: EmulatedProcess = {
      command,
      settle: (value) => {
        clearTimeout(timer);
        computer.processes.delete(process);
        settled(value);
      },
    };
    computer.processes.add(process);
    if (this.hangs(command)) {
      // The deadline ends the SDK's wait, not the remote process.
      if (options.timeoutMs)
        timer = setTimeout(
          () => settled({ error: new TimeoutError("deadline_exceeded: command timeout") }),
          options.timeoutMs,
        );
    } else {
      process.settle({ result: this.shell(computer, command, options.envs ?? {}) });
    }
    if (this.faults.startEvents > 0) {
      this.faults.startEvents--;
      throw new TimeoutError("start event timed out");
    }
    return {
      get stdout() {
        return "";
      },
      wait: async () => {
        const value = await outcome;
        if ("error" in value) throw value.error;
        if (value.result.exitCode !== 0) throw new CommandExitError(value.result);
        return value.result;
      },
      kill: async () => {
        if (this.faults.commandKills > 0) {
          this.faults.commandKills--;
          throw new Error("kill unavailable");
        }
        process.settle({ result: { exitCode: 137, stdout: "", stderr: "" } });
        return true;
      },
      disconnect: async () => undefined,
    };
  }

  private shell(
    computer: EmulatedComputer,
    command: string,
    envs: Record<string, string>,
  ): CommandResult {
    const desktop = computer.respond(command);
    if (desktop) return desktop;
    const parsed = parse(command, (name) => envs[name] ?? "");
    const argv = parsed.filter((token): token is string => typeof token === "string");
    if (argv[0] === "chmod") {
      for (const path of argv.slice(3)) {
        const file = computer.files.get(path);
        if (file) file.mode = argv[1] === "700" ? 0o700 : 0o600;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    // Scripts with shell operators are setup the emulator has no state for.
    if (argv.length !== parsed.length || argv[0] === "bash")
      return { exitCode: 0, stdout: "", stderr: "" };
    const { exitCode = 0, stdout = "" } = simpleCommand(argv, envs);
    return { exitCode, stdout, stderr: "" };
  }
}

/** The real Novita adapter, SDK translation included, over the in-memory emulator. */
export function emulatedNovita(emulator = new NovitaEmulator()) {
  const fenced: string[] = [];
  const onUnsafeStop = async (providerRef: string) => {
    fenced.push(providerRef);
  };
  const provider = (apiKey = EMULATOR_KEY) =>
    new NovitaSandboxProvider(
      { apiKey },
      novitaSdk(apiKey, onUnsafeStop, async () => emulator),
    );
  return { emulator, fenced, provider };
}

export function fakeNovita() {
  const machines = new Map<string, { desktop: RemoteDesktop; paused: boolean }>();
  let sequence = 0;
  const sdk: RemoteDesktopSdk = {
    create: vi.fn(async () => {
      const id = `novita-${++sequence}`;
      const files = new Map<string, { content: Uint8Array; mode: number }>();
      const respond = desktopCommandResponder();
      const running = () => {
        if (!machines.has(id)) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
        if (machines.get(id)!.paused)
          throw new TimeoutError("502: This error is likely due to sandbox timeout.");
      };
      const fileAt = (path: string) => {
        running();
        const file = files.get(path);
        if (!file) throw new FileNotFoundError(`Path ${path} not found`);
        return file;
      };
      const desktop: RemoteDesktop = {
        sandboxId: id,
        getHost: (port) => `${port}-${id}.sandbox.test`,
        setTimeout: vi.fn(async () => running()),
        commands: {
          run: vi.fn(async (command) => {
            running();
            if (command.startsWith("chmod 700 --")) {
              for (const [path, file] of files)
                if (command.includes(`'${path}'`)) file.mode = 0o700;
            }
            return (
              respond(command) ?? {
                exitCode: 0,
                stdout: command.includes("'echo' 'graphical-ok'") ? "graphical-ok\n" : "",
                stderr: "",
              }
            );
          }),
        },
        files: {
          makeDir: vi.fn(async () => {
            running();
            return true;
          }),
          list: vi.fn(async (path) => {
            running();
            const entries = new Map<
              string,
              { name: string; type: string; size: number; mode: number }
            >();
            for (const [filePath, file] of files) {
              if (!filePath.startsWith(`${path}/`)) continue;
              const relative = filePath.slice(path.length + 1);
              const name = relative.split("/")[0]!;
              const dir = relative.includes("/");
              entries.set(name, {
                name,
                type: dir ? "dir" : "file",
                size: dir ? 0 : file.content.byteLength,
                mode: file.mode,
              });
            }
            return [...entries.values()];
          }),
          getInfo: vi.fn(async (path) => {
            const file = fileAt(path);
            return {
              name: path.split("/").at(-1)!,
              type: "file",
              size: file.content.byteLength,
              mode: file.mode,
            };
          }),
          read: vi.fn(async (path) => fileAt(path).content),
          write: vi.fn(async (batch) => {
            running();
            for (const file of batch)
              files.set(file.path, { content: new Uint8Array(file.data), mode: 0o600 });
          }),
        },
      };
      machines.set(id, { desktop, paused: false });
      return desktop;
    }),
    connect: vi.fn(async (id) => {
      const machine = machines.get(id);
      if (!machine) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
      machine.paused = false;
      return machine.desktop;
    }),
    pause: vi.fn(async (id) => {
      const machine = machines.get(id);
      if (!machine) throw new SandboxNotFoundError(`Sandbox ${id} not found`);
      machine.paused = true;
    }),
    kill: vi.fn(async (id) => machines.delete(id)),
  };
  const provider = new NovitaSandboxProvider({ apiKey: "test-novita-key" }, sdk);
  return { provider, sdk, machines };
}
