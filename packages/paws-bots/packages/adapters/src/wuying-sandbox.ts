import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
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
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import {
  SandboxUnavailableError,
  SandboxUnresponsiveError,
  WorkspaceTooLargeError,
} from "@rakazo/adapter-kit";
import { abortableDelay, boundedSandboxCommandTimeoutMs, isRetryableError } from "@rakazo/core";
import { boundedComputerActions, computerObservation } from "./computer-support.js";
import { normalizeDesktopWorkspacePath } from "./desktop-sandbox-paths.js";
import { McpSession } from "./mcp-transport.js";
import { sandboxNotFoundError } from "./sandbox-errors.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";
import type { WuyingControlPlane } from "./wuying-openapi.js";
import { WuyingOpenApi } from "./wuying-openapi.js";

/** The tool namespace the desktop's MCP gateway serves its native system tools under. */
const SYSTEM_TOOLS = "wuying-system-tool__";
const GATEWAY_RECONNECT_MS = 500;
// Only reads can be replayed after a lost response; commands and input may have already run.
const RECONNECTABLE_TOOLS = new Set([
  "env_get",
  "fs_info",
  "fs_list",
  "fs_read",
  "screen_capture",
  "cursor_position",
  "window_active",
  "window_list",
]);

function gatewayCanReconnect(error: unknown) {
  if (error instanceof StreamableHTTPError)
    return error.code === 404 || isRetryableError({ status: error.code });
  if (error instanceof McpError)
    return error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout;
  return error instanceof TypeError;
}

const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 120_000;
const POLL_MS = 3_000;
// The gateway's response budget: reads of at most 32 KiB, command output of at most 16 KiB and
// commands of at most one minute per call. A foreground command stops short of that minute, so
// the gateway's own timeout answers before the MCP client's 60-second one closes the connection.
const READ_CHUNK_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const LIST_LIMIT = 1_000;
// Windows command lines stop at 32,767 characters, including the program and other arguments.
const MAX_ENCODED_COMMAND_CHARS = 30_000;
const OUTPUT_LIMIT = 16 * 1024;
const MAX_COMMAND_MS = 50_000;
const RUN_POLL_MS = 1_000;
/** Output a background command may stream per stream before the rest is dropped. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const HOME_KEY = /^[A-Za-z0-9_-]+$/;
/** Windows has no executable bit, so each home records which of its files carry one. */
const EXECUTABLES_FILE = ".rakazo-executables.json";

/** A tool the gateway ran and refused, with the gateway's error code such as `not_found`. */
export class WuyingToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "WuyingToolError";
  }
}

export interface WuyingToolResult {
  data: unknown;
  images: { data: string; mimeType: string }[];
}

/** Calls one native system tool on the desktop, such as `process_exec` or `screen_capture`. */
export interface WuyingDesktopTools {
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<WuyingToolResult>;
}

export interface WuyingSandboxOptions {
  accessKeyId: string;
  accessKeySecret: string;
  regionId?: string;
  desktopId: string;
  endUserId: string;
  mcpUrl: string;
  mcpToken: string;
  /** Whether another running computer still uses this desktop. */
  referenceInUse?: (computer: ComputerRef) => Promise<boolean>;
}

export function describeWuyingSandbox() {
  return {
    id: "wuying",
    contractVersion: "1",
    adapterVersion: "0.1.0",
    capabilities: {
      graphical: true,
      pty: false,
      snapshots: false,
      takeover: true,
      persistentHome: true,
      multiScreen: false,
    },
  };
}

/** One MCP session to the desktop's gateway, opened on first use and reopened after a failure. */
export class WuyingMcpTools implements WuyingDesktopTools {
  private session?: Promise<McpSession>;

  constructor(private readonly options: { url: string; token: string }) {}

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    const result = await this.request(tool, args, signal);
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
      .trim();
    const structured = result.structuredContent as
      | { data?: unknown; error?: { code?: string; message?: string } }
      | undefined;
    if (result.isError || structured?.error) {
      // Transport and gateway errors can echo the bearer token. Preserve only the error
      // kind needed for file existence checks, never an untrusted message or response body.
      const code = structured?.error?.code === "not_found" ? "not_found" : undefined;
      throw new WuyingToolError(tool, code, `${tool} failed`);
    }
    return {
      data: structured?.data ?? parseData(text),
      images: content.flatMap((item) =>
        item.type === "image" ? [{ data: item.data, mimeType: item.mimeType }] : [],
      ),
    };
  }

  private async request(tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const pending = this.connect(signal);
      let session: McpSession | undefined;
      try {
        session = await pending;
        return await session.callTool(`${SYSTEM_TOOLS}${tool}`, args, { signal });
      } catch (error) {
        const broken = gatewayCanReconnect(error);
        // Every bot's calls share the connection, so one cancelled or refused call keeps it.
        if (session && broken) {
          // Another failed call may have already replaced this connection.
          if (this.session === pending) this.session = undefined;
          void session.close();
        }
        signal.throwIfAborted();
        if (attempt === 0 && (!session || RECONNECTABLE_TOOLS.has(tool)) && broken) {
          await abortableDelay(GATEWAY_RECONNECT_MS, signal);
          continue;
        }
        throw new SandboxUnresponsiveError(
          session
            ? `The computer did not answer ${tool}`
            : "The computer gateway could not be reached",
        );
      }
    }
  }

  private connect(signal: AbortSignal) {
    this.session ??= (async () => {
      const session = new McpSession({ name: "rakazo-wuying" });
      await session.connectRemote({
        url: this.options.url,
        headerPolicy: { headers: { Authorization: `Bearer ${this.options.token}` } },
        signal,
      });
      return session;
    })();
    const pending = this.session;
    pending.catch(() => {
      if (this.session === pending) this.session = undefined;
    });
    return pending;
  }
}

/**
 * The gateway reads output as UTF-8, while Windows consoles default to the system code page
 * (GBK on Chinese systems). PowerShell commands switch their output to UTF-8 first.
 */
function utf8Output(argv: string[]): string[] {
  const command = argv.indexOf("-Command");
  if (!/^(powershell|pwsh)(\.exe)?$/i.test(argv[0] ?? "") || command < 0) return argv;
  if (command + 1 >= argv.length) return argv;
  const next = [...argv];
  next[command + 1] =
    `[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;${argv[command + 1]}`;
  return next;
}

/** One argument quoted the way Windows' CommandLineToArgvW reads it back. */
export function quoteWindowsArgument(argument: string) {
  if (argument && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let slashes = 0;
  for (const char of argument) {
    if (char === "\\") {
      slashes += 1;
      continue;
    }
    quoted += "\\".repeat(char === '"' ? slashes * 2 + 1 : slashes) + char;
    slashes = 0;
  }
  return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

// Key names as computer tools send them (X11 keysyms and common aliases), lowercased, mapped to
// the gateway's own names and to SendKeys codes.
const NAMED_KEYS: Record<string, { native?: string; sendKeys: string }> = {
  return: { native: "Enter", sendKeys: "{ENTER}" },
  enter: { native: "Enter", sendKeys: "{ENTER}" },
  kp_enter: { native: "Enter", sendKeys: "{ENTER}" },
  backspace: { native: "Backspace", sendKeys: "{BS}" },
  tab: { native: "Tab", sendKeys: "{TAB}" },
  escape: { native: "Escape", sendKeys: "{ESC}" },
  esc: { native: "Escape", sendKeys: "{ESC}" },
  space: { native: "Space", sendKeys: " " },
  delete: { native: "Delete", sendKeys: "{DEL}" },
  del: { native: "Delete", sendKeys: "{DEL}" },
  home: { native: "Home", sendKeys: "{HOME}" },
  end: { native: "End", sendKeys: "{END}" },
  up: { native: "Up", sendKeys: "{UP}" },
  down: { native: "Down", sendKeys: "{DOWN}" },
  left: { native: "Left", sendKeys: "{LEFT}" },
  right: { native: "Right", sendKeys: "{RIGHT}" },
  prior: { native: "PageUp", sendKeys: "{PGUP}" },
  page_up: { native: "PageUp", sendKeys: "{PGUP}" },
  pageup: { native: "PageUp", sendKeys: "{PGUP}" },
  next: { native: "PageDown", sendKeys: "{PGDN}" },
  page_down: { native: "PageDown", sendKeys: "{PGDN}" },
  pagedown: { native: "PageDown", sendKeys: "{PGDN}" },
  insert: { sendKeys: "{INS}" },
};
const MODIFIERS: Record<string, { native: string; sendKeys?: string }> = {
  ctrl: { native: "Control", sendKeys: "^" },
  control: { native: "Control", sendKeys: "^" },
  control_l: { native: "Control", sendKeys: "^" },
  control_r: { native: "Control", sendKeys: "^" },
  shift: { native: "Shift", sendKeys: "+" },
  shift_l: { native: "Shift", sendKeys: "+" },
  shift_r: { native: "Shift", sendKeys: "+" },
  alt: { native: "Alt", sendKeys: "%" },
  alt_l: { native: "Alt", sendKeys: "%" },
  alt_r: { native: "Alt", sendKeys: "%" },
  // SendKeys has no Windows key, so it can only be pressed alone.
  super: { native: "Meta" },
  super_l: { native: "Meta" },
  meta: { native: "Meta" },
  win: { native: "Meta" },
  cmd: { native: "Meta" },
};

/**
 * One key press as the gateway's key name when it is a single key, or as a SendKeys string when
 * it needs modifiers held. Keys also arrive as `ctrl+a` in the key itself.
 */
export function windowsKeyChord(
  key: string,
  modifiers: readonly string[] = [],
): { native: string; sendKeys?: undefined } | { native?: undefined; sendKeys: string } {
  const parts = [...modifiers, ...(key.length > 1 ? key.split("+") : [key])]
    .map((part) => part.trim())
    .filter(Boolean);
  const main = parts.pop();
  if (!main) throw new Error("No key to press");
  const held = parts.map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier key: ${part}`);
    return modifier;
  });
  const lower = main.toLowerCase();
  const fn = /^f([1-9]|1[0-6])$/.exec(lower);
  const named = NAMED_KEYS[lower] ?? (fn ? { sendKeys: `{F${fn[1]}}` } : undefined);
  const modifierOnly = MODIFIERS[lower];
  if (!held.length) {
    if (modifierOnly) return { native: modifierOnly.native };
    if (named?.native) return { native: named.native };
    if (main.length === 1) return { native: main };
  }
  if (held.some((modifier) => !modifier.sendKeys) || modifierOnly)
    throw new Error("This key combination is not available on Windows computers");
  let code: string;
  if (named) code = named.sendKeys;
  else if (main.length === 1 && /^[\x20-\x7e]$/.test(main))
    // SendKeys reads these characters as syntax, and a capital letter as Shift plus the letter.
    code = /[+^%~(){}[\]]/.test(main) ? `{${main}}` : main.toLowerCase();
  else throw new Error(`Unknown key: ${main}`);
  return { sendKeys: `${held.map((modifier) => modifier.sendKeys).join("")}${code}` };
}

/** A PowerShell single-quoted string literal. PowerShell also closes one on curly single quotes. */
export function psLiteral(value: string) {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** Runs a UTF-8 script file without the execution policy that gates `-File`. */
function psRunFile(path: string) {
  return `Invoke-Expression (Get-Content -Raw -Encoding UTF8 -LiteralPath ${psLiteral(path)})`;
}

const HIDDEN_POWERSHELL = ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"];

/**
 * Starts the command with its output redirected to files and records its exit code last, so a
 * caller can read the output while it runs and knows it ended once the exit file exists.
 */
function backgroundRunScript(
  program: string,
  args: string[],
  paths: { cwd: string; out: string; err: string; exit: string },
) {
  const commandLine = args.map(quoteWindowsArgument).join(" ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$code = 127",
    "try {",
    `  $p = Start-Process -FilePath ${psLiteral(program)}${commandLine ? ` -ArgumentList ${psLiteral(commandLine)}` : ""} -WorkingDirectory ${psLiteral(paths.cwd)} -RedirectStandardOutput ${psLiteral(paths.out)} -RedirectStandardError ${psLiteral(paths.err)} -NoNewWindow -PassThru`,
    // Reading the handle first keeps ExitCode available after the wait.
    "  $null = $p.Handle",
    "  $p.WaitForExit()",
    "  $code = $p.ExitCode",
    "} catch {",
    `  [IO.File]::WriteAllText(${psLiteral(paths.err)}, $_.Exception.Message)`,
    "}",
    `[IO.File]::WriteAllText(${psLiteral(`${paths.exit}.tmp`)}, [string]$code)`,
    `Move-Item -LiteralPath ${psLiteral(`${paths.exit}.tmp`)} -Destination ${psLiteral(paths.exit)}`,
  ].join("\r\n");
}

function parseData(text: string): unknown {
  try {
    return (JSON.parse(text) as { data?: unknown }).data;
  } catch {
    return undefined;
  }
}

interface ScreenScale {
  x: number;
  y: number;
}

interface PointerDown {
  x: number;
  y: number;
  button: "left" | "right";
}

/**
 * A bot computer on one Wuying cloud desktop. The ECD control plane powers it on and off and
 * issues screen logins; commands, files, screen and input go through the desktop's MCP gateway.
 * The desktop's disk persists, so each computer's home is a folder under the user profile.
 */
export class WuyingSandboxProvider implements SandboxProvider {
  private profile?: Promise<string>;
  private readonly scales = new Map<string, ScreenScale>();
  private readonly pointers = new Map<string, PointerDown>();
  /** Background commands still running, by the run that started them. */
  private readonly runApps = new Map<string, Set<string>>();

  constructor(
    private readonly options: Pick<
      WuyingSandboxOptions,
      "desktopId" | "endUserId" | "referenceInUse"
    > & {
      regionId: string;
    },
    private readonly control: WuyingControlPlane,
    private readonly tools: WuyingDesktopTools,
  ) {}

  static fromOptions(options: WuyingSandboxOptions) {
    const regionId = options.regionId?.trim() || "cn-hangzhou";
    return new WuyingSandboxProvider(
      {
        desktopId: options.desktopId,
        endUserId: options.endUserId,
        regionId,
        referenceInUse: options.referenceInUse,
      },
      new WuyingOpenApi({
        accessKeyId: options.accessKeyId,
        accessKeySecret: options.accessKeySecret,
        regionId,
      }),
      new WuyingMcpTools({ url: options.mcpUrl, token: options.mcpToken }),
    );
  }

  describe() {
    return describeWuyingSandbox();
  }

  billsWhileRunning() {
    return true;
  }

  async provision(
    request: { botId: string; homePath: string; providerRef?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    if (!HOME_KEY.test(request.botId)) throw new Error("computer home key is not portable");
    const started = await this.ensureRunning(context.signal);
    const home = await this.home(request.botId, context.signal);
    const existed = await this.exists(home, context.signal);
    return {
      id: this.options.desktopId,
      botId: request.botId,
      kind: "wuying",
      providerRef: this.options.desktopId,
      // A reference to another desktop (the configured one changed) starts over in this one.
      fresh:
        !existed ||
        (request.providerRef !== undefined && request.providerRef !== this.options.desktopId),
      started,
    };
  }

  /** Every command, short or long, ends with its execute call, so nothing outlives a run. */
  async inspectBackgroundWork(): Promise<"idle"> {
    return "idle";
  }

  async cancelRunWork(
    _computer: ComputerRef,
    _computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    const apps = this.runApps.get(runId);
    if (!apps) return;
    await Promise.all(
      [...apps].map((appId) =>
        this.tools
          .call("app_stop", { app_id: appId, force: true }, context.signal)
          .catch(() => undefined),
      ),
    );
  }

  ownsReference(computer: Pick<ComputerRef, "kind" | "providerRef">) {
    return computer.kind === "wuying" && computer.providerRef === this.options.desktopId;
  }

  async isRunning(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId) return false;
    return (await this.control.desktopStatus(this.options.desktopId, context.signal)) === "Running";
  }

  async isStopped(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId) return false;
    return (await this.control.desktopStatus(this.options.desktopId, context.signal)) === "Stopped";
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.mkdirs(await this.home(computer.botId, context.signal), context.signal);
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    return {
      platform: "win32",
      home: await this.home(computer.botId, context.signal),
      shell: "powershell.exe",
    };
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ): Promise<string[]> {
    if (request.action === "ensure") {
      for (const directory of request.paths) {
        await this.mkdirs(await this.target(computer, directory, context.signal), context.signal);
      }
      return [];
    }
    const parents = request.action === "list" ? ["bots", ".browser-profiles"] : [request.parent];
    const entries: string[] = [];
    for (const parent of parents) {
      if (parent !== "bots" && parent !== ".browser-profiles")
        throw new Error("Path escapes the computer workspace");
      const directory = await this.target(computer, parent, context.signal);
      if (!(await this.exists(directory, context.signal))) continue;
      if (request.action === "list") {
        for (const entry of await this.list(directory, context.signal))
          entries.push(`${parent}/${entry.name}`);
        continue;
      }
      const pattern = parent === "bots" ? /^[A-Za-z0-9_-]+$/ : /^chromium-bot-[0-9a-f]{32}$/;
      if (request.names.some((name) => !pattern.test(name)))
        throw new Error("Path escapes the computer workspace");
      for (const name of request.names) {
        await this.tools.call(
          "fs_delete",
          { path: `${directory}\\${name}`, recursive: true },
          context.signal,
        );
      }
    }
    return entries;
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const [program = "cmd.exe", ...args] = utf8Output(
      request.argv.length ? request.argv : ["cmd.exe", "/c", "echo ready"],
    );
    const cwd = request.cwd
      ? await this.target(computer, request.cwd, context.signal)
      : await this.home(computer.botId, context.signal);
    await this.mkdirs(cwd, context.signal);
    const env = { ...request.env };
    // The gateway's environment overlay has no unset; an empty value is the closest it offers.
    for (const name of request.unsetEnv ?? []) env[name] = "";
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    if (timeoutMs > MAX_COMMAND_MS) {
      yield* this.executeInBackground({ program, args, cwd, env, timeoutMs }, context);
      return;
    }
    const { data } = await this.tools.call(
      "process_exec",
      {
        program,
        args,
        cwd,
        env,
        output_limit: OUTPUT_LIMIT,
        timeout_ms: timeoutMs,
      },
      context.signal,
    );
    const result = data as {
      stdout?: string;
      stderr?: string;
      exit_code?: number | null;
      status?: string;
      truncated?: boolean;
    };
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    if (result.truncated) yield { type: "stderr", data: "\n[output truncated at 16 KiB]\n" };
    if (result.status === "timed_out" || result.status === "timeout") {
      yield { type: "stderr", data: "command timed out" };
      yield { type: "exit", code: 124 };
      return;
    }
    yield { type: "exit", code: typeof result.exit_code === "number" ? result.exit_code : 1 };
  }

  /**
   * A command allowed more than the gateway's one-minute call runs detached: its output goes to
   * files that are read back every second, which also streams it while it runs.
   */
  private async *executeInBackground(
    command: {
      program: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
    },
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const { signal } = context;
    const dir = `${await this.userProfile(signal)}\\rakazo\\.runs\\${randomUUID()}`;
    const paths = {
      cwd: command.cwd,
      out: `${dir}\\stdout`,
      err: `${dir}\\stderr`,
      exit: `${dir}\\exit`,
    };
    await this.mkdirs(dir, signal);
    let { program, args } = command;
    const script = args.indexOf("-Command");
    if (/^(powershell|pwsh)(\.exe)?$/i.test(program) && script >= 0 && script + 1 < args.length) {
      // Encoded, the command needs no quoting and keeps the exit code -Command gives it in the
      // foreground. Only one too long for a command line goes through a file, which loses that.
      const encoded = Buffer.from(args[script + 1] ?? "", "utf16le").toString("base64");
      const encodedArgs = [
        ...args.slice(0, script),
        "-EncodedCommand",
        encoded,
        ...args.slice(script + 2),
      ];
      if ([program, ...encodedArgs].join(" ").length <= MAX_ENCODED_COMMAND_CHARS) {
        args = encodedArgs;
      } else {
        await this.tools.call(
          "fs_write",
          {
            path: `${dir}\\command.ps1`,
            data: args[script + 1],
            encoding: "utf8",
            overwrite: true,
          },
          signal,
        );
        args = [...args.slice(0, script + 1), psRunFile(`${dir}\\command.ps1`)];
      }
    }
    await this.tools.call(
      "fs_write",
      {
        path: `${dir}\\run.ps1`,
        data: backgroundRunScript(program, args, paths),
        encoding: "utf8",
        overwrite: true,
      },
      signal,
    );
    program = "powershell.exe";
    const { data } = await this.tools.call(
      "app_start",
      {
        program,
        args: [...HIDDEN_POWERSHELL, "-Command", psRunFile(`${dir}\\run.ps1`)],
        cwd: command.cwd,
        env: command.env,
      },
      signal,
    );
    const appId = (data as { app_id?: string }).app_id;
    if (!appId) throw new SandboxUnresponsiveError("The computer did not start the command");
    const runId = context.runId;
    if (runId) {
      const apps = this.runApps.get(runId) ?? new Set<string>();
      apps.add(appId);
      this.runApps.set(runId, apps);
    }
    const streams = {
      stdout: { path: paths.out, offset: 0, decoder: new TextDecoder() },
      stderr: { path: paths.err, offset: 0, decoder: new TextDecoder() },
    };
    const drain = async function* (
      this: WuyingSandboxProvider,
      final: boolean,
    ): AsyncIterable<ProcessEvent> {
      for (const type of ["stdout", "stderr"] as const) {
        const stream = streams[type];
        let text = "";
        while (stream.offset < MAX_STREAM_BYTES) {
          const chunk = await this.readChunk(stream.path, stream.offset, signal);
          if (!chunk.length) break;
          stream.offset += chunk.length;
          text += stream.decoder.decode(chunk, { stream: true });
          if (chunk.length < READ_CHUNK_BYTES) break;
        }
        if (final) text += stream.decoder.decode();
        if (text) yield { type, data: text };
      }
    };
    const deadline = Date.now() + command.timeoutMs;
    let finished = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        const exited = await this.exists(paths.exit, signal);
        yield* drain.call(this, exited);
        if (exited) {
          finished = true;
          const code = Number.parseInt(
            Buffer.from(await this.readChunk(paths.exit, 0, signal)).toString("utf8"),
            10,
          );
          if (
            streams.stdout.offset >= MAX_STREAM_BYTES ||
            streams.stderr.offset >= MAX_STREAM_BYTES
          )
            yield { type: "stderr", data: "\n[output truncated at 8 MiB]\n" };
          yield { type: "exit", code: Number.isSafeInteger(code) ? code : 1 };
          return;
        }
        if (Date.now() >= deadline) {
          yield { type: "stderr", data: "command timed out" };
          yield { type: "exit", code: 124 };
          return;
        }
        await sleep(RUN_POLL_MS, undefined, { signal });
      }
    } finally {
      if (runId) this.runApps.get(runId)?.delete(appId);
      // Stopping and cleanup must not use the run's signal, which may be what ended it.
      const cleanup = AbortSignal.timeout(15_000);
      if (!finished) {
        await this.tools
          .call("app_stop", { app_id: appId, force: true }, cleanup)
          .catch(() => undefined);
      }
      await this.tools
        .call("fs_delete", { path: dir, recursive: true }, cleanup)
        .catch(() => undefined);
    }
  }

  /**
   * The gateway presses one key per call and releases it before the next, so a chord goes to
   * Windows' own SendKeys from a windowless script that leaves the foreground window focused.
   */
  private async sendKeys(keys: string, signal: AbortSignal) {
    const dir = `${await this.userProfile(signal)}\\rakazo\\.runs\\${randomUUID()}`;
    const done = `${dir}\\done`;
    await this.mkdirs(dir, signal);
    try {
      await this.tools.call(
        "fs_write",
        {
          path: `${dir}\\keys.vbs`,
          data: [
            `CreateObject("WScript.Shell").SendKeys "${keys.replace(/"/g, '""')}"`,
            `CreateObject("Scripting.FileSystemObject").CreateTextFile("${done}").Close`,
          ].join("\r\n"),
          encoding: "utf8",
          overwrite: true,
        },
        signal,
      );
      await this.tools.call(
        "app_start",
        { program: "wscript.exe", args: ["//B", "//Nologo", `${dir}\\keys.vbs`] },
        signal,
      );
      const deadline = Date.now() + 10_000;
      while (!(await this.exists(done, signal))) {
        if (Date.now() >= deadline) throw new SandboxUnresponsiveError("The keys were not sent");
        await sleep(200, undefined, { signal });
      }
    } finally {
      await this.tools
        .call("fs_delete", { path: dir, recursive: true }, AbortSignal.timeout(15_000))
        .catch(() => undefined);
    }
  }

  /** Up to one gateway read of a file from an offset; a file not written yet reads as empty. */
  private async readChunk(path: string, offset: number, signal: AbortSignal) {
    try {
      const { data } = await this.tools.call(
        "fs_read",
        { path, encoding: "base64", offset, max_bytes: READ_CHUNK_BYTES },
        signal,
      );
      return Buffer.from((data as { data?: string }).data ?? "", "base64");
    } catch (error) {
      if (error instanceof WuyingToolError && error.code === "not_found") return Buffer.alloc(0);
      throw error;
    }
  }

  /**
   * The Web SDK in the app's own page draws the screen, so the session is a `wuying:` reference
   * the app turns into that page. The login code inside it works once and expires in minutes.
   */
  async connectScreen(
    computer: ComputerRef,
    _request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    if (computer.providerRef !== this.options.desktopId) return this.noScreen();
    const authCode = await this.control.authCode(this.options.endUserId, context.signal);
    const url = new URL("wuying://desktop");
    url.searchParams.set("desktop_id", this.options.desktopId);
    url.searchParams.set("region_id", this.options.regionId);
    url.searchParams.set("auth_code", authCode);
    return { url: url.toString(), mimeType: "text/html", close: async () => undefined };
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    await this.apply(computer, input, context.signal);
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const [capture, cursor, active] = await Promise.all([
      this.tools.call("screen_capture", {}, context.signal),
      this.tools.call("cursor_position", {}, context.signal).catch(() => undefined),
      this.tools.call("window_active", {}, context.signal).catch(() => undefined),
    ]);
    const image = capture.images[0];
    const info = capture.data as {
      image?: { width?: number; height?: number };
      source?: { width?: number; height?: number };
    };
    if (!image) throw new SandboxUnresponsiveError("The computer returned no screenshot");
    const width = info.image?.width ?? info.source?.width ?? 1;
    const height = info.image?.height ?? info.source?.height ?? 1;
    // The preview may be scaled down; actions arrive in its coordinates and map back here.
    const scale = {
      x: (info.source?.width ?? width) / width,
      y: (info.source?.height ?? height) / height,
    };
    this.scales.set(computer.providerRef, scale);
    const point = cursor?.data as { x?: number; y?: number } | undefined;
    const window = active?.data as { window_id?: string; title?: string } | undefined;
    return computerObservation(Uint8Array.from(Buffer.from(image.data, "base64")), {
      mimeType: image.mimeType === "image/png" ? "image/png" : "image/jpeg",
      width,
      height,
      ...(typeof point?.x === "number" && typeof point.y === "number"
        ? { cursor: { x: Math.round(point.x / scale.x), y: Math.round(point.y / scale.y) } }
        : {}),
      ...(window?.window_id
        ? {
            activeWindow: {
              id: window.window_id,
              ...(window.title ? { title: window.title } : {}),
            },
          }
        : {}),
    });
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    const actions = boundedComputerActions(request.actions);
    for (const action of actions) await this.apply(computer, action, context.signal);
    if (request.observe === false) return { completed: actions.length };
    if (request.settleMs) await sleep(Math.min(request.settleMs, 5_000), undefined, context);
    return { completed: actions.length, observation: await this.observe(computer, context) };
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeDesktopWorkspacePath(directory, "win32");
    const target = await this.target(computer, relative, context.signal);
    const executables = await this.executables(computer, context.signal);
    return (await this.list(target, context.signal)).flatMap((entry) => {
      if (!relative && entry.name === EXECUTABLES_FILE) return [];
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return [
        {
          path,
          kind: entry.kind,
          size: entry.size,
          ...(entry.kind === "file" && executables.has(path) ? { executable: true } : {}),
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
    const target = await this.target(computer, filePath, context.signal);
    const limit = Math.min(options?.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const { data } = await this.tools.call(
        "fs_read",
        { path: target, encoding: "base64", offset, max_bytes: READ_CHUNK_BYTES },
        context.signal,
      );
      const read = data as {
        data?: string;
        bytes_read?: number;
        size?: number;
        truncated?: boolean;
      };
      if ((read.size ?? 0) > limit) throw new Error(`computer file exceeds ${limit} bytes`);
      const chunk = Buffer.from(read.data ?? "", "base64");
      chunks.push(chunk);
      offset += chunk.length;
      if (!read.truncated || chunk.length === 0) break;
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    if (file.content.byteLength > MAX_FILE_BYTES)
      throw new Error(`computer file exceeds ${MAX_FILE_BYTES} bytes`);
    const target = await this.target(computer, file.path, context.signal);
    await this.mkdirs(target.slice(0, target.lastIndexOf("\\")), context.signal);
    await this.tools.call(
      "fs_write",
      {
        path: target,
        data: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
        overwrite: true,
      },
      context.signal,
    );
    const path = normalizeDesktopWorkspacePath(file.path, "win32");
    const executables = await this.executables(computer, context.signal);
    if (executables.has(path) === Boolean(file.executable)) return;
    if (file.executable) executables.add(path);
    else executables.delete(path);
    await this.tools.call(
      "fs_write",
      {
        path: await this.target(computer, EXECUTABLES_FILE, context.signal),
        data: JSON.stringify([...executables].sort()),
        encoding: "utf8",
        overwrite: true,
      },
      context.signal,
    );
  }

  private async executables(computer: ComputerRef, signal: AbortSignal) {
    const manifest = await this.target(computer, EXECUTABLES_FILE, signal);
    if (!(await this.exists(manifest, signal))) return new Set<string>();
    const { data } = await this.tools.call(
      "fs_read",
      { path: manifest, encoding: "utf8", max_bytes: READ_CHUNK_BYTES },
      signal,
    );
    try {
      const parsed: unknown = JSON.parse((data as { data?: string }).data ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : []);
    } catch {
      return new Set<string>();
    }
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ): AsyncIterable<PortableFile> {
    const files: ComputerFileEntry[] = [];
    let bytes = 0;
    const executables = await this.executables(computer, context.signal);
    const walk = async (relative: string) => {
      const directory = await this.target(computer, relative, context.signal);
      const entries = await this.list(
        directory,
        context.signal,
        () => new WorkspaceTooLargeError("files"),
      );
      for (const { name, kind, size } of entries) {
        if (!relative && name === EXECUTABLES_FILE) continue;
        const path = relative ? `${relative}/${name}` : name;
        // The same caches and dependency folders every other computer leaves out of a save.
        if (shouldSkipPortableWorkspaceFile(path, kind === "dir")) continue;
        if (kind === "dir") {
          await walk(path);
          continue;
        }
        if (size > MAX_FILE_BYTES) throw new WorkspaceTooLargeError("bytes");
        bytes += size;
        files.push({ path, kind, size, ...(executables.has(path) ? { executable: true } : {}) });
        if (limits && bytes > limits.maxBytes) throw new WorkspaceTooLargeError("bytes");
        if (limits && files.length > limits.maxFiles) throw new WorkspaceTooLargeError("files");
      }
    };
    await walk("");
    for (const file of files) {
      yield {
        path: file.path,
        content: await this.readFile(computer, file.path, context),
        ...(file.executable ? { executable: true } : {}),
      };
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(): Promise<never> {
    throw new Error("Snapshots are not available on Wuying computers");
  }

  /** Computers share the desktop, so it powers off only when the last one stops. */
  async stop(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId) return;
    if (await this.options.referenceInUse?.(computer)) return;
    const status = await this.control.desktopStatus(this.options.desktopId, context.signal);
    if (status === "Stopped" || status === null) return;
    if (status !== "Stopping")
      await this.control.stopDesktop(this.options.desktopId, context.signal);
    await this.waitFor("Stopped", STOP_TIMEOUT_MS, context.signal);
    // A computer that started on the desktop while it powered off needs it back on.
    if (await this.options.referenceInUse?.(computer)) {
      await this.control.startDesktop(this.options.desktopId, context.signal);
      await this.waitFor("Running", START_TIMEOUT_MS, context.signal);
    }
  }

  /** The desktop belongs to the account, so only this computer's home folder is removed. */
  async destroy(computer: ComputerRef, context: AdapterContext) {
    if (computer.providerRef !== this.options.desktopId || !HOME_KEY.test(computer.botId)) return;
    const status = await this.control.desktopStatus(this.options.desktopId, context.signal);
    if (status !== "Running") return;
    const home = await this.home(computer.botId, context.signal);
    if (await this.exists(home, context.signal)) {
      await this.tools.call("fs_delete", { path: home, recursive: true }, context.signal);
    }
  }

  private noScreen(): ScreenSession {
    return { url: null, mimeType: "text/html", close: async () => undefined };
  }

  /** Starts the desktop when it is off. True when this call started it. */
  private async ensureRunning(signal: AbortSignal) {
    const status = await this.control.desktopStatus(this.options.desktopId, signal);
    if (status === null) {
      throw sandboxNotFoundError("Wuying desktop not found");
    }
    if (status === "Running") return false;
    if (status === "Stopping") await this.waitFor("Stopped", STOP_TIMEOUT_MS, signal);
    if (status !== "Starting" && status !== "Pending")
      await this.control.startDesktop(this.options.desktopId, signal);
    await this.waitFor("Running", START_TIMEOUT_MS, signal);
    return true;
  }

  private async waitFor(wanted: "Running" | "Stopped", timeoutMs: number, signal: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.control.desktopStatus(this.options.desktopId, signal)) === wanted) return;
      if (Date.now() >= deadline) throw new SandboxUnavailableError();
      await sleep(POLL_MS, undefined, { signal });
    }
  }

  private async home(homeKey: string, signal: AbortSignal) {
    if (!HOME_KEY.test(homeKey)) throw new Error("computer home key is not portable");
    return `${await this.userProfile(signal)}\\rakazo\\${homeKey}`;
  }

  private userProfile(signal: AbortSignal) {
    this.profile ??= this.tools
      .call("env_get", { name: "USERPROFILE" }, signal)
      .then(({ data }) => {
        const value = (data as { value?: string } | undefined)?.value;
        if (!value || !/^[A-Za-z]:\\/.test(value))
          throw new Error("The computer has no user profile folder");
        return value.replace(/\\+$/, "");
      });
    const pending = this.profile;
    pending.catch(() => {
      if (this.profile === pending) this.profile = undefined;
    });
    return pending;
  }

  /** A workspace-relative path as an absolute Windows path inside this computer's home. */
  private async target(computer: ComputerRef, relative: string, signal: AbortSignal) {
    const normalized = normalizeDesktopWorkspacePath(relative, "win32");
    const home = await this.home(computer.botId, signal);
    return normalized ? `${home}\\${normalized.replace(/\//g, "\\")}` : home;
  }

  private async exists(target: string, signal: AbortSignal) {
    try {
      await this.tools.call("fs_info", { path: target }, signal);
      return true;
    } catch (error) {
      if (error instanceof WuyingToolError && error.code === "not_found") return false;
      throw error;
    }
  }

  /** fs_mkdir makes one level, so walk down from the profile creating what is missing. */
  private async mkdirs(target: string, signal: AbortSignal) {
    if (await this.exists(target, signal)) return;
    const profile = await this.userProfile(signal);
    if (!target.toLowerCase().startsWith(`${profile.toLowerCase()}\\`))
      throw new Error("Path escapes the computer workspace");
    let current = profile;
    for (const segment of target.slice(profile.length + 1).split("\\")) {
      current = `${current}\\${segment}`;
      if (!(await this.exists(current, signal)))
        await this.tools.call("fs_mkdir", { path: current }, signal);
    }
  }

  private async list(
    directory: string,
    signal: AbortSignal,
    overflow = () => new Error(`computer folder has more than ${LIST_LIMIT} entries`),
  ) {
    const { data } = await this.tools.call(
      "fs_list",
      { path: directory, limit: LIST_LIMIT },
      signal,
    );
    const listing = data as {
      entries?: { kind?: string; path?: string; size?: number }[];
      truncated?: boolean;
    };
    if (listing.truncated) throw overflow();
    return (listing.entries ?? []).flatMap((entry) => {
      const name = entry.path?.split("\\").pop();
      if (!name || entry.kind === "symlink") return [];
      return [
        {
          name,
          kind: entry.kind === "directory" ? ("dir" as const) : ("file" as const),
          size: entry.kind === "directory" ? 0 : (entry.size ?? 0),
        },
      ];
    });
  }

  private native(computer: ComputerRef, x: number, y: number) {
    const scale = this.scales.get(computer.providerRef) ?? { x: 1, y: 1 };
    return { x: Math.round(x * scale.x), y: Math.round(y * scale.y) };
  }

  private async apply(computer: ComputerRef, action: ComputerAction, signal: AbortSignal) {
    if (action.kind === "wait") {
      await sleep(Math.min(Math.max(action.ms, 0), 5_000), undefined, { signal });
      return;
    }
    if (action.kind === "clipboard") {
      await this.tools.call("input_text", { text: action.text }, signal);
      return;
    }
    if (action.kind === "key") {
      const chord = windowsKeyChord(action.key, action.modifiers);
      if (chord.sendKeys !== undefined) await this.sendKeys(chord.sendKeys, signal);
      else await this.tools.call("input_keyboard", { key: chord.native, action: "press" }, signal);
      return;
    }
    if (action.kind === "pointer") {
      const at = this.native(computer, action.x, action.y);
      if (action.type === "down") {
        this.pointers.set(computer.providerRef, { ...at, button: action.button ?? "left" });
        await this.tools.call("input_mouse", { action: "move", ...at }, signal);
        return;
      }
      if (action.type === "up") {
        // The gateway has no separate button press and release; down then up is a drag or a click.
        const down = this.pointers.get(computer.providerRef);
        this.pointers.delete(computer.providerRef);
        const moved = down && (down.x !== at.x || down.y !== at.y);
        await this.tools.call(
          "input_mouse",
          moved
            ? { action: "drag", button: down.button, x: down.x, y: down.y, to_x: at.x, to_y: at.y }
            : { action: "click", button: down?.button ?? "left", ...at },
          signal,
        );
        return;
      }
      await this.tools.call(
        "input_mouse",
        action.type === "move"
          ? { action: "move", ...at }
          : { action: "click", button: action.button ?? "left", ...at },
        signal,
      );
      return;
    }
    if (action.kind === "scroll") {
      if (action.direction === "left" || action.direction === "right")
        throw new Error("Horizontal scrolling is not available on this computer");
      const amount = Math.max(1, Math.min(Math.round(action.amount ?? 3), 20));
      await this.tools.call(
        "input_mouse",
        {
          action: "scroll",
          scroll: action.direction === "up" ? amount : -amount,
          ...(action.x !== undefined && action.y !== undefined
            ? this.native(computer, action.x, action.y)
            : {}),
        },
        signal,
      );
      return;
    }
    if (action.kind === "open") {
      const target = await this.target(computer, action.path, signal);
      await this.tools.call("app_start", { program: "explorer.exe", args: [target] }, signal);
      return;
    }
    if (action.kind === "launch") {
      await this.tools.call(
        "app_start",
        { program: action.application, args: action.uri ? [action.uri] : [] },
        signal,
      );
      return;
    }
    const { data } = await this.tools.call("window_list", {}, signal);
    const wanted = action.application.toLowerCase();
    const windows =
      (data as { windows?: { window_id?: string; title?: string; visible?: boolean }[] }).windows ??
      [];
    const match = windows.find(
      (window) => window.visible !== false && window.title?.toLowerCase().includes(wanted),
    );
    if (match?.window_id) {
      await this.tools.call(
        "window_update",
        { window_id: match.window_id, action: "activate" },
        signal,
      );
      return;
    }
    await this.tools.call(
      "app_start",
      { program: action.application, args: action.uri ? [action.uri] : [] },
      signal,
    );
  }
}
