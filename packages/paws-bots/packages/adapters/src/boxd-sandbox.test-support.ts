import path from "node:path";
import type {
  ExecStream,
  FsEntry,
  FsWriteData,
  Machine,
  MachineCreateParams,
  MachineStatus,
  Snapshot,
} from "@boxd-sh/sdk";
import { ConflictError, FilesystemError, NotFoundError } from "@boxd-sh/sdk";
import { parse } from "shell-quote";
import type { BoxdSandboxClient } from "./boxd-sandbox.js";
import { BOXD_COMPUTER_SNAPSHOT, BoxdSandboxProvider } from "./boxd-sandbox.js";
import { desktopCommandResponder, simpleCommand } from "./linux-desktop.test-support.js";

export const BOXD_WORKSPACE = "/home/boxd/rakazo-home";

interface FakeMachine {
  id: string;
  name: string;
  status: MachineStatus;
  params: MachineCreateParams;
  files: Map<string, { content: Uint8Array; mode: number }>;
  proxies: Map<string, number>;
}

interface CommandResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** boxd's machines, files, snapshots, and commands in memory; commands are scripted, not run. */
export class FakeBoxd {
  readonly machines = new Map<string, FakeMachine>();
  readonly snapshots = new Map<string, Snapshot["status"]>();
  /** Every command line the adapter sent, with the machine it ran on. */
  readonly commands: Array<{ id: string; command: string; cwd?: string }> = [];
  /** Commands still running, so a test can see a timeout or abort end them. */
  readonly running = new Set<string>();
  readonly calls: string[] = [];
  /** Errors the next calls of a method throw, in order. */
  readonly failures = new Map<string, unknown[]>();
  private readonly desktop = desktopCommandResponder();
  private created = 0;

  client(): BoxdSandboxClient {
    return {
      machines: {
        create: async (params: MachineCreateParams) => {
          this.call("create");
          if ([...this.machines.values()].some((machine) => machine.name === params.name)) {
            throw new ConflictError("a machine with that name already exists", 6);
          }
          if (params.fromSnapshot && this.snapshots.get(params.fromSnapshot) !== "ready") {
            throw new NotFoundError(`snapshot ${params.fromSnapshot} not found`, 5);
          }
          const id = `machine-${++this.created}`;
          const machine: FakeMachine = {
            id,
            name: params.name ?? id,
            status: "running",
            params,
            files: new Map(),
            proxies: new Map(),
          };
          this.machines.set(id, machine);
          return this.record(machine);
        },
        get: async (id: string) => {
          this.call("get");
          return this.record(this.machine(id));
        },
        delete: async (id: string) => {
          this.call("delete");
          this.machines.delete(this.machine(id).id);
        },
        start: async (id: string) => {
          this.call("start");
          this.machine(id).status = "running";
        },
        pause: async (id: string) => {
          this.call("pause");
          this.machine(id).status = "suspended";
          return { suspendUs: 1 };
        },
        streamExec: (id, params) => this.exec(id, params),
        proxies: {
          create: async (id: string, name: string, port: number) => {
            this.call("proxies.create");
            const machine = this.machine(id);
            if (machine.proxies.has(name)) {
              throw new ConflictError(`proxy '${name}' already exists for VM '${machine.name}'`, 6);
            }
            machine.proxies.set(name, port);
            return { name, port };
          },
        },
        fs: {
          read: async (id, filePath, options) => {
            this.call("fs.read");
            const file = this.machine(id).files.get(String(filePath));
            if (!file) throw new FilesystemError(`${filePath}: not found`, "not_found");
            return file.content.slice(0, options?.length ?? file.content.byteLength);
          },
          write: async (id, filePath, data, options) => {
            this.call("fs.write");
            const machine = this.machine(id);
            const existing = machine.files.get(String(filePath));
            const content = await bytes(data);
            machine.files.set(String(filePath), {
              content,
              mode: options?.mode ?? existing?.mode ?? 0o644,
            });
            return entry(String(filePath), "file", content.byteLength, options?.mode ?? 0o644);
          },
          list: async (id, directory) => {
            this.call("fs.list");
            const root = String(directory);
            const children = new Map<string, FsEntry>();
            for (const [filePath, file] of this.machine(id).files) {
              if (!filePath.startsWith(`${root}/`)) continue;
              const [child, ...rest] = filePath.slice(root.length + 1).split("/");
              const childPath = `${root}/${child}`;
              children.set(
                childPath,
                rest.length
                  ? entry(childPath, "directory", 4096, 0o755)
                  : entry(childPath, "file", file.content.byteLength, file.mode),
              );
            }
            if (!children.size) throw new FilesystemError(`${root}: not found`, "not_found");
            return [...children.values()];
          },
          remove: async (id, filePath) => {
            this.call("fs.remove");
            if (!this.machine(id).files.delete(String(filePath))) {
              throw new FilesystemError(`${filePath}: not found`, "not_found");
            }
          },
        },
      },
      snapshots: {
        create: async (machine: string, name: string) => {
          this.call("snapshots.create");
          this.machine(machine);
          this.snapshots.set(name, "ready");
          return { name } as Awaited<ReturnType<BoxdSandboxClient["snapshots"]["create"]>>;
        },
        get: async (name: string) => {
          this.call("snapshots.get");
          const status = this.snapshots.get(name);
          if (!status) throw new NotFoundError(`snapshot ${name} not found`, 5);
          return { name, status } as Snapshot;
        },
      },
    } as BoxdSandboxClient;
  }

  machine(id: string): FakeMachine {
    const machine =
      this.machines.get(id) ?? [...this.machines.values()].find((entry) => entry.name === id);
    if (!machine) throw new NotFoundError(`machine ${id} not found`, 5);
    return machine;
  }

  private call(name: string) {
    this.calls.push(name);
    const failure = this.failures.get(name)?.shift();
    if (failure) throw failure;
  }

  private record(machine: FakeMachine): Machine {
    return {
      id: machine.id,
      name: machine.name,
      status: machine.status,
      access: {
        domain: "boxd.test",
        url: `https://${machine.name}.boxd.test`,
        sshPort: null,
        desktopUrl: "",
      },
    } as Machine;
  }

  private exec(id: string, params: { command: string | string[]; cwd?: string }): ExecStream {
    this.call("streamExec");
    const machine = this.machine(id);
    const command = String(params.command);
    this.commands.push({ id, command, ...(params.cwd ? { cwd: params.cwd } : {}) });
    const output = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    let finish!: (code: number) => void;
    let fail!: (error: unknown) => void;
    const exited = new Promise<number>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const key = `${id}:${this.commands.length}`;
    // A command wakes a suspended or hibernated machine; a stopped one has to be started.
    if (machine.status === "stopped") {
      fail(new ConflictError(`machine ${machine.name} is stopped`, 9));
      return this.stream(exited, output, () => undefined);
    }
    machine.status = "running";
    const result = this.shell(machine, command);
    if (result === "forever") {
      this.running.add(key);
    } else {
      if (result.stdout) output.stdout.push(Buffer.from(result.stdout));
      if (result.stderr) output.stderr.push(Buffer.from(result.stderr));
      finish(result.exitCode ?? 0);
    }
    return this.stream(exited, output, () => {
      this.running.delete(key);
      fail(new Error("cancelled"));
    });
  }

  /** Output arrives once the command ends, as boxd's buffered streams deliver it to the adapter. */
  private stream(
    exited: Promise<number>,
    output: { stdout: Uint8Array[]; stderr: Uint8Array[] },
    close: () => void,
  ): ExecStream {
    const queue = (parts: Uint8Array[]) => ({
      async *[Symbol.asyncIterator]() {
        await exited.catch(() => undefined);
        yield* parts;
      },
    });
    return {
      stdout: queue(output.stdout),
      stderr: queue(output.stderr),
      wait: () => exited,
      close,
    } as unknown as ExecStream;
  }

  private shell(machine: FakeMachine, wrapped: string): CommandResult | "forever" {
    // Desktop, setup, and listing scripts arrive as `bash -c <script>`.
    const tokens = parse(wrapped);
    const command =
      tokens[0] === "bash" && tokens[1] === "-c" && typeof tokens[2] === "string"
        ? tokens[2]
        : wrapped;
    const desktop = this.desktop(command);
    if (desktop) return desktop;
    if (command.includes("find . -regextype")) return this.listing(machine);
    // `exec 3< FILE || exit 1; rm -f -- FILE; eval "$(cat <&3 || echo exit 1)" || exit 1; exec 3<&-; argv`
    const sourced = command.match(
      /^exec 3< ('[^']*') \|\| exit 1; rm -f -- \1; eval "\$\(cat <&3 \|\| echo exit 1\)" \|\| exit 1; exec 3<&-; ([\s\S]*)$/,
    );
    let env: Record<string, string> = {};
    let argvText = command;
    if (sourced) {
      const envFile = String(parse(sourced[1]!)[0]);
      const file = machine.files.get(envFile);
      if (!file) return { exitCode: 1, stderr: "No such file or directory\n" };
      machine.files.delete(envFile);
      env = {};
      for (const token of parse(Buffer.from(file.content).toString("utf8"))) {
        if (typeof token !== "string" || token === "export") continue;
        const [name, ...value] = token.split("=");
        env[name!] = value.join("=");
      }
      argvText = sourced[2]!;
    }
    const parsed = parse(argvText);
    const argv = parsed.filter((token): token is string => typeof token === "string");
    if (argv[0] === "sleep") return "forever";
    if (argv[0] === "fail") return { exitCode: Number(argv[1] ?? 1), stderr: `${argv[2] ?? ""}\n` };
    // Scripts with shell operators are setup the fake has no state for.
    if (argv.length !== parsed.length) return {};
    return simpleCommand(argv, env);
  }

  private listing(machine: FakeMachine): CommandResult {
    let stdout = "";
    for (const [filePath, file] of [...machine.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!filePath.startsWith(`${BOXD_WORKSPACE}/`)) continue;
      const relative = filePath.slice(BOXD_WORKSPACE.length + 1);
      stdout += `${relative}\0${(file.mode & 0o777).toString(8)}\0${file.content.byteLength}\0`;
    }
    return { stdout };
  }
}

function entry(filePath: string, type: "file" | "directory", size: number, mode: number): FsEntry {
  return {
    name: path.posix.basename(filePath),
    path: filePath,
    type,
    targetType: type,
    isDir: type === "directory",
    isFile: type === "file",
    isSymlink: false,
    size,
    mode,
  } as FsEntry;
}

async function bytes(data: FsWriteData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data.slice();
  const parts: Uint8Array[] = [];
  for await (const part of data as AsyncIterable<Uint8Array>) parts.push(part);
  return Buffer.concat(parts);
}

/** The real boxd adapter over an in-memory boxd, with its desktop snapshot already saved. */
export function fakeBoxdProvider(boxd = new FakeBoxd()): BoxdSandboxProvider {
  if (!boxd.snapshots.size) boxd.snapshots.set(BOXD_COMPUTER_SNAPSHOT, "ready");
  return new BoxdSandboxProvider({}, boxd.client());
}
