import { CommandExitError, InstaboxError, InstaboxQuotaError } from "@insforge/instabox-sdk";
import { parse } from "shell-quote";
import type {
  InstaboxApi,
  InstaboxCommandResult,
  InstaboxJob,
  InstaboxMachine,
  InstaboxRunOptions,
  InstaboxSpec,
} from "./instabox-sandbox.js";
import { InstaboxSandboxProvider, instaboxSdk } from "./instabox-sandbox.js";
import { desktopCommandResponder, simpleCommand } from "./linux-desktop.test-support.js";

interface EmulatedComputer {
  state: "running" | "suspended";
  spec: InstaboxSpec;
  template: string;
  metadata: Record<string, string>;
  files: Map<string, { content: Uint8Array; mode: number }>;
  published: Set<number>;
  respond: ReturnType<typeof desktopCommandResponder>;
}

/**
 * In-memory instabox SDK: the sandbox lifecycle, commands (foreground and background jobs), files,
 * published ports, and the SDK's own error classes, so the real adapter's translation runs
 * offline. Its shell understands only what the adapter sends: desktop runtime scripts, the home
 * link, mkdir, find, stat, chmod, `env`, `echo`, and `printenv`.
 */
export class InstaboxEmulator implements InstaboxApi {
  readonly computers = new Map<string, EmulatedComputer>();
  /** Every request the adapter made, in order. */
  readonly requests: string[] = [];
  /** Every command the adapter ran, in order. */
  readonly commands: string[] = [];
  /** Commands matching this never exit on their own; they end on kill, abort, or their deadline. */
  hangs: (command: string) => boolean = () => false;
  /** Commands matching this exit 1. */
  fails: (command: string) => boolean = () => false;
  /** Upcoming calls that the API refuses with 429. */
  rateLimited = 0;
  /** Jobs whose kill was attempted after their wait gave up. */
  readonly killedJobs: string[] = [];
  /** Each `job.kill`. An Error rejects; false means every process had already exited. */
  jobKill: () => boolean | Error = () => true;
  /** The sizes the account's plan offers, as `vcpus/memMiB`; the first is the default. */
  allowedSpecs = ["4/8192", "8/16384", "16/32768"];
  /** A resize whose restart fails: the computer starts again at its old size. */
  resizeFails = false;
  /** Thrown by the next resize request before any change, as an API or transport failure is. */
  resizeError: Error | undefined;
  private sequence = 0;

  async create(
    template: string,
    metadata: Record<string, string>,
    spec?: InstaboxSpec,
  ): Promise<InstaboxMachine> {
    this.request(`create ${template}${spec ? ` ${spec.vcpus}/${spec.memMiB}` : ""}`);
    if (spec) this.offered(spec);
    const [vcpus, memMiB] = this.allowedSpecs[0]!.split("/").map(Number);
    const id = `m_test${++this.sequence}`;
    this.computers.set(id, {
      state: "running",
      spec: spec ?? { vcpus: vcpus!, memMiB: memMiB! },
      template,
      metadata,
      files: new Map(),
      published: new Set(),
      respond: desktopCommandResponder(),
    });
    return this.machine(id);
  }

  async connect(id: string, resume: boolean): Promise<InstaboxMachine> {
    this.request(`connect ${id}${resume ? " resume" : ""}`);
    const computer = this.require(id);
    if (resume) computer.state = "running";
    return this.machine(id);
  }

  async kill(id: string): Promise<boolean> {
    this.request(`kill ${id}`);
    return this.computers.delete(id);
  }

  private request(name: string) {
    this.requests.push(name);
    if (this.rateLimited > 0) {
      this.rateLimited--;
      throw new InstaboxError("Too many requests", { status: 429, code: "rate_limited" });
    }
  }

  private offered(spec: InstaboxSpec) {
    if (!this.allowedSpecs.includes(`${spec.vcpus}/${spec.memMiB}`))
      throw new InstaboxQuotaError("this plan does not offer that size", {
        status: 400,
        code: "spec_not_allowed",
      });
  }

  private require(id: string): EmulatedComputer {
    const computer = this.computers.get(id);
    if (!computer) throw new InstaboxError("machine not found", { status: 404, code: "not_found" });
    return computer;
  }

  /** instabox wakes a paused computer for a command or a file request. */
  private awake(id: string): EmulatedComputer {
    const computer = this.require(id);
    computer.state = "running";
    return computer;
  }

  private machine(id: string): InstaboxMachine {
    return {
      sandboxId: id,
      getInfo: async () => {
        this.request(`info ${id}`);
        const { state, spec } = this.require(id);
        return { state, machine: { spec: { ...spec } } };
      },
      pause: async () => {
        this.request(`pause ${id}`);
        this.require(id).state = "suspended";
      },
      // The server stops, resizes and starts the computer; a failed start goes back to the old size.
      resize: async (spec) => {
        this.request(`resize ${id} ${spec.vcpus}/${spec.memMiB}`);
        const computer = this.require(id);
        if (this.resizeError) throw this.resizeError;
        this.offered(spec);
        computer.state = "running";
        // The SDK's error for a failed operation: no HTTP status, the operation named.
        if (this.resizeFails)
          throw new InstaboxError("no host has room for that size", {
            code: "no_capacity",
            operationId: "op_resize",
          });
        computer.spec = { ...spec };
      },
      commands: { run: async (command, options) => this.run(id, command, options) },
      files: {
        read: async (path) => {
          this.request(`read ${path}`);
          const file = this.awake(id).files.get(path);
          if (!file)
            throw new InstaboxError(`${path} not found`, { status: 404, code: "not_found" });
          return new Uint8Array(file.content);
        },
        write: async (path, data) => {
          this.request(`write ${path}`);
          this.awake(id).files.set(path, { content: new Uint8Array(data), mode: 0o644 });
        },
      },
      ports: {
        publish: async (port) => {
          this.request(`publish ${id} ${port}`);
          this.require(id).published.add(port);
          return { url: `https://${port}-${id.slice(2)}.instabox.test` };
        },
      },
    };
  }

  private async run(
    id: string,
    command: string,
    options: InstaboxRunOptions,
  ): Promise<InstaboxCommandResult | InstaboxJob> {
    this.request(`run ${id}${options.background ? " background" : ""}`);
    const computer = this.awake(id);
    this.commands.push(command);
    if (options.background) {
      let killed = false;
      return {
        wait: async ({ timeoutMs, signal }) => {
          if (this.hangs(command)) {
            await settle(timeoutMs, signal, () => killed);
            if (signal?.aborted) throw new InstaboxError("aborted", { code: "aborted" });
            throw new InstaboxError("job is still running", { code: "job_wait_timeout" });
          }
          return this.finish(computer, command, options.envs ?? {});
        },
        kill: async () => {
          this.killedJobs.push(command);
          const outcome = this.jobKill();
          if (outcome instanceof Error) throw outcome;
          if (!outcome) return false;
          killed = true;
          return true;
        },
      };
    }
    if (this.hangs(command)) {
      await settle(options.timeoutMs, options.signal, () => false);
      if (options.signal?.aborted) throw new InstaboxError("aborted", { code: "aborted" });
      throw new CommandExitError({
        stdout: "",
        stderr: "",
        exitCode: 124,
        timedOut: true,
        truncated: false,
      });
    }
    return this.finish(computer, command, options.envs ?? {});
  }

  /** The SDK throws for a non-zero exit, carrying the whole result. */
  private finish(computer: EmulatedComputer, command: string, envs: Record<string, string>) {
    const result = this.shell(computer, command, envs);
    if (result.exitCode !== 0)
      throw new CommandExitError({ ...result, timedOut: false, truncated: false });
    return { ...result, timedOut: false };
  }

  private shell(computer: EmulatedComputer, command: string, envs: Record<string, string>) {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (this.fails(command)) return { exitCode: 1, stdout: "", stderr: "permission denied\n" };
    const desktop = computer.respond(command);
    if (desktop) return desktop;
    if (command.includes("ln -s")) return ok();
    const parsed = parse(command, (name) => envs[name] ?? "");
    const argv = parsed.filter((token): token is string => typeof token === "string");
    if (argv[0] === "mkdir") return ok();
    if (argv[0] === "chmod") {
      for (const path of argv.slice(3)) {
        const file = computer.files.get(path);
        if (file) file.mode = argv[1] === "700" ? 0o700 : 0o644;
      }
      return ok();
    }
    if (argv[0] === "stat") {
      const file = computer.files.get(argv.at(-1)!);
      if (!file) return { exitCode: 1, stdout: "", stderr: "stat: No such file or directory\n" };
      return ok(`${file.content.byteLength} ${file.mode.toString(8)}\n`);
    }
    if (argv[0] === "find") return ok(listing(computer, argv[1]!));
    // Scripts with shell operators are setup the emulator has no state for.
    if (argv.length !== parsed.length || argv[0] === "bash") return ok();
    const { exitCode = 0, stdout = "" } = simpleCommand(argv, envs);
    return { exitCode, stdout, stderr: "" };
  }
}

/** `find -printf '%y %s %m %f\0'` over the emulated files, directories implied by their paths. */
function listing(computer: EmulatedComputer, directory: string): string {
  const entries = new Map<string, string>();
  for (const [path, file] of computer.files) {
    if (!path.startsWith(`${directory}/`)) continue;
    const [name, ...rest] = path.slice(directory.length + 1).split("/");
    entries.set(
      name!,
      rest.length
        ? `d 4096 755 ${name}`
        : `f ${file.content.byteLength} ${file.mode.toString(8)} ${name}`,
    );
  }
  return [...entries.values()].map((entry) => `${entry}\0`).join("");
}

/** Resolves at the deadline, on abort, or once killed. */
async function settle(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  killed: () => boolean,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs ?? 60_000);
    const poll = setInterval(() => killed() && done(), 5);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The real instabox adapter, SDK translation included, over the in-memory emulator. */
export function emulatedInstabox(emulator = new InstaboxEmulator()) {
  const provider = () =>
    new InstaboxSandboxProvider(
      { apiKey: "test-instabox-key" },
      instaboxSdk(
        "test-instabox-key",
        async (id) => {
          emulator.requests.push(`fence ${id}`);
        },
        async () => emulator,
      ),
    );
  return { emulator, provider };
}
