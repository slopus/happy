import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  AdapterContext,
  CommandRequest,
  ComputerFileEntry,
  ComputerRef,
  PortableFile,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core";
import { COMPUTER_CACHE_ENV } from "@rakazo/core/node/desktop-runtime";
import {
  normalizeWorkspacePath,
  shellQuote,
  workspaceCwd,
  workspacePath,
} from "./computer-support.js";
import { sandboxCommandArgv } from "./sandbox-command-environment.js";
import { abortedCommandEvents } from "./sandbox-command-events.js";
import {
  shouldSkipPortableWorkspaceFile,
  workspaceSaveFindCommand,
} from "./workspace-save-policy.js";

/** The published computer image's user home, which is also the portable workspace. */
export const COMPUTER_IMAGE_WORKSPACE = "/home/rakazo";
const WORKSPACE = COMPUTER_IMAGE_WORKSPACE;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How long the `timeout` wrapper waits after SIGTERM before it kills the command's process group. */
export const COMMAND_KILL_AFTER_MS = 5_000;
const BULK_TRANSFER_TIMEOUT_MS = 30 * 60_000;

// The pinned Computer image is deliberately immutable at runtime and runs as
// uid 1000 with no privilege escalation. Validate its baked desktop tools
// instead of using the generic sandbox bootstrap, which tries apt via sudo
// when optional scrot is absent. ImageMagick's import is the supported capture
// fallback in this image.
const PREPARE_COMPUTER_IMAGE_DESKTOP = [
  'missing=""',
  'for command in python3 flock Xvfb xdpyinfo x11vnc fluxbox xdotool wmctrl xterm websockify; do command -v "$command" >/dev/null 2>&1 || missing="$missing $command"; done',
  'if ! command -v scrot >/dev/null 2>&1 && ! command -v import >/dev/null 2>&1; then missing="$missing scrot-or-import"; fi',
  'if [ ! -d /usr/share/novnc ] && [ ! -d /opt/noVNC ]; then missing="$missing novnc"; fi',
  'if [ -n "$missing" ]; then echo "computer image is missing required desktop tools:$missing" >&2; exit 1; fi',
].join("\n");

export type RawExecEvent =
  | { type: "stdout" | "stderr"; data: Buffer }
  | { type: "exit"; code: number };

/**
 * Runs an argv in the computer as its image user and streams raw output. A provider's transport
 * finishes with exit 130 after cancellation and 124 when `timeoutMs` (plus a grace) passes.
 */
export type RawExec = (
  computer: ComputerRef,
  command: string[],
  signal: AbortSignal,
  timeoutMs: number,
  stdin?: Readable,
  tty?: boolean,
) => AsyncIterable<RawExecEvent>;

/**
 * Commands, files and workspace transfer for a computer started from the published computer
 * image, over any exec transport. Providers supply the transport and the machine lifecycle.
 */
export class ExecComputer {
  constructor(
    private readonly exec: RawExec,
    /** Names the provider in error messages. */
    private readonly label: string,
  ) {}

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const command = [
      "set -eu",
      `mkdir -p -- ${shellQuote(WORKSPACE)} ${shellQuote(`${WORKSPACE}/.browser-profiles`)}`,
      PREPARE_COMPUTER_IMAGE_DESKTOP,
    ].join("\n");
    const result = await this.run(computer, ["bash", "-c", command], context, 300_000);
    if (result.code !== 0) {
      throw new Error(result.stderr || `could not prepare ${this.label} computer`);
    }
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (context.signal.aborted) {
      yield* abortedCommandEvents();
      return;
    }
    const timeoutMs = boundedSandboxCommandTimeoutMs(request.timeoutMs);
    const command = commandRequestArgv(request, timeoutMs);
    const decoders = {
      stdout: new TextDecoder(),
      stderr: new TextDecoder(),
    };
    for await (const event of this.exec(
      computer,
      command,
      context.signal,
      timeoutMs,
      undefined,
      request.pty === true,
    )) {
      if (event.type === "exit") {
        const stdoutTail = decoders.stdout.decode();
        const stderrTail = decoders.stderr.decode();
        if (stdoutTail) yield { type: "stdout", data: stdoutTail };
        if (stderrTail) yield { type: "stderr", data: stderrTail };
        yield event;
        continue;
      }
      const data = decoders[event.type].decode(event.data, { stream: true });
      if (data) yield { type: event.type, data };
    }
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const relative = normalizeWorkspacePath(directory);
    const target = workspacePath(WORKSPACE, relative);
    const result = await this.run(
      computer,
      ["find", target, "-mindepth", "1", "-maxdepth", "1", "-printf", "%P\\0%y\\0%s\\0%m\\0"],
      context,
    );
    if (result.code !== 0) throw new Error(result.stderr || "could not list computer files");
    const fields = result.stdout.split("\0");
    const entries: ComputerFileEntry[] = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const name = fields[index];
      const kind = fields[index + 1];
      const size = Number(fields[index + 2]);
      const mode = Number.parseInt(fields[index + 3] ?? "", 8);
      if (!name || (kind !== "d" && kind !== "f") || !Number.isSafeInteger(size)) continue;
      entries.push({
        path: normalizeWorkspacePath(path.posix.join(relative, name)),
        kind: kind === "d" ? "dir" : "file",
        size,
        ...(kind === "f" && (mode & 0o111) !== 0 ? { executable: true } : {}),
      });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const target = workspacePath(WORKSPACE, filePath);
    const maxBytes = options?.maxBytes ?? MAX_FILE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid file size limit");
    const size = await this.run(computer, ["stat", "-c", "%s", "--", target], context);
    if (size.code !== 0) throw new Error(size.stderr || "could not inspect computer file");
    if (Number(size.stdout.trim()) > maxBytes) {
      throw new Error(`computer file exceeds ${maxBytes} bytes`);
    }
    const result = await this.collect(computer, ["cat", "--", target], context, maxBytes + 1);
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8") || "could not read computer file");
    }
    if (result.stdout.byteLength > maxBytes) {
      throw new Error(`computer file exceeds ${maxBytes} bytes`);
    }
    return new Uint8Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    const target = workspacePath(WORKSPACE, file.path);
    const command = [
      "bash",
      "-c",
      [
        "set -eu",
        'target="$1"',
        'mode="$2"',
        'directory=$(dirname -- "$target")',
        'mkdir -p -- "$directory"',
        'temporary=$(mktemp "$directory/.rakazo-write.XXXXXX")',
        "trap 'rm -f -- \"$temporary\"' EXIT",
        'cat >"$temporary"',
        'chmod "$mode" -- "$temporary"',
        'mv -f -- "$temporary" "$target"',
        "trap - EXIT",
      ].join("\n"),
      "rakazo-write",
      target,
      file.executable ? "700" : "600",
    ];
    const result = await this.collect(
      computer,
      command,
      context,
      1024 * 1024,
      Readable.from(Buffer.from(file.content)),
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8") || "could not write computer file");
    }
  }

  /** The caller quiesces the desktop browsers first so profile databases are consistent. */
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    // One exec streams the whole home as a tar archive. Per-file execs cost a
    // round trip each, which took minutes for a restored home.
    const listing = await this.run(
      computer,
      [
        "bash",
        "-c",
        `cd ${shellQuote(WORKSPACE)} && ${workspaceSaveFindCommand()} -printf '%P\\0'`,
      ],
      context,
    );
    if (listing.code !== 0) {
      throw new Error(listing.stderr || "could not list computer workspace");
    }
    const names = listing.stdout
      .split("\0")
      .filter((name) => name && !shouldSkipPortableWorkspaceFile(name));
    if (names.length === 0) return;
    const reader = new TarReader(MAX_FILE_BYTES);
    const list = Buffer.from(names.map((name) => `${name}\0`).join(""));
    let code = 1;
    let stderr = "";
    // Kata can stall large stdout while exec also has stdin attached. Stage the
    // NUL-delimited file list separately so the archive exec only reads stdout.
    const listPath = `/tmp/rakazo-workspace-${randomUUID()}`;
    try {
      const staged = await this.collect(
        computer,
        ["bash", "-c", 'umask 077; cat > "$1"', "rakazo-export-list", listPath],
        context,
        1024 * 1024,
        Readable.from([list]),
        BULK_TRANSFER_TIMEOUT_MS,
      );
      if (staged.code !== 0)
        throw new Error(staged.stderr.toString("utf8") || "could not stage workspace file list");
      for await (const event of this.exec(
        computer,
        withTimeout(
          [
            "tar",
            "--format=pax",
            "--hard-dereference",
            "-c",
            "-C",
            WORKSPACE,
            "--null",
            "--no-recursion",
            "-T",
            listPath,
            "-f",
            "-",
          ],
          BULK_TRANSFER_TIMEOUT_MS,
        ),
        context.signal,
        BULK_TRANSFER_TIMEOUT_MS,
      )) {
        if (event.type === "exit") code = event.code;
        else if (event.type === "stderr") stderr += event.data.toString("utf8");
        else {
          for (const file of reader.push(event.data)) {
            context.signal.throwIfAborted();
            yield file;
          }
        }
      }
    } finally {
      await this.run(
        computer,
        ["rm", "-f", "--", listPath],
        {
          ...context,
          signal: AbortSignal.timeout(10_000),
        },
        10_000,
      );
    }
    if (code !== 0) throw new Error(stderr || "could not export computer workspace");
    reader.finish();
  }

  /** The caller quiesces the desktop browsers first, as for export. */
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    // One exec extracts a tar stream; see exportWorkspace.
    const signal = context.signal;
    async function* archive(): AsyncIterable<Buffer> {
      for await (const file of files) {
        if (shouldSkipPortableWorkspaceFile(file.path)) continue;
        signal.throwIfAborted();
        workspacePath(WORKSPACE, file.path);
        yield* encodeTarEntry(normalizeWorkspacePath(file.path), file.content, file.executable);
      }
      yield TAR_END;
    }
    const result = await this.collect(
      computer,
      ["tar", "-x", "-C", WORKSPACE, "--no-same-owner", "-f", "-"],
      context,
      1024 * 1024,
      Readable.from(archive()),
      BULK_TRANSFER_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8") || "could not import computer workspace");
    }
  }

  async run(
    computer: ComputerRef,
    command: string[],
    context: AdapterContext,
    timeoutMs = boundedSandboxCommandTimeoutMs(undefined),
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await this.collect(
      computer,
      command,
      context,
      MAX_FILE_BYTES,
      undefined,
      timeoutMs,
    );
    return {
      code: result.code,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  async collect(
    computer: ComputerRef,
    command: string[],
    context: AdapterContext,
    maxOutputBytes: number,
    stdin?: Readable,
    timeoutMs = boundedSandboxCommandTimeoutMs(undefined),
  ): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let code = 1;
    for await (const event of this.exec(
      computer,
      withTimeout(command, timeoutMs),
      context.signal,
      timeoutMs,
      stdin,
    )) {
      if (event.type === "exit") {
        code = event.code;
        continue;
      }
      outputBytes += event.data.byteLength;
      if (outputBytes > maxOutputBytes)
        throw new Error(`${this.label} command output is too large`);
      (event.type === "stdout" ? stdout : stderr).push(event.data);
    }
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  }
}

function commandRequestArgv(request: CommandRequest, timeoutMs: number): string[] {
  const cwd = workspaceCwd(WORKSPACE, request.cwd);
  const environment = Object.entries({ ...COMPUTER_CACHE_ENV, ...request.env }).map(
    ([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`invalid environment name ${name}`);
      return `${name}=${value}`;
    },
  );
  return [
    "bash",
    "-c",
    'cd -- "$1" && shift && exec env "$@"',
    "rakazo-exec",
    cwd,
    ...environment,
    ...withTimeout(sandboxCommandArgv(request), timeoutMs),
  ];
}

function withTimeout(command: string[], timeoutMs: number): string[] {
  return [
    "timeout",
    "--signal=TERM",
    `--kill-after=${COMMAND_KILL_AFTER_MS / 1_000}s`,
    `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`,
    ...command,
  ];
}

const TAR_BLOCK = 512;
// Exec transports frame each stdin chunk; a whole large file can close the connection.
const TAR_BODY_CHUNK_BYTES = 256 * 1024;
const TAR_END = Buffer.alloc(TAR_BLOCK * 2);

function tarHeader(name: string, type: string, size: number, mode: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function* tarBody(content: Uint8Array): Iterable<Buffer> {
  for (let offset = 0; offset < content.byteLength; offset += TAR_BODY_CHUNK_BYTES) {
    const length = Math.min(TAR_BODY_CHUNK_BYTES, content.byteLength - offset);
    yield Buffer.from(content.buffer, content.byteOffset + offset, length);
  }
  const padding = (TAR_BLOCK - (content.byteLength % TAR_BLOCK)) % TAR_BLOCK;
  if (padding) yield Buffer.alloc(padding);
}

/** One regular file as ustar blocks, with a PAX path record when the name does not fit. */
export function* encodeTarEntry(
  name: string,
  content: Uint8Array,
  executable?: boolean,
): Iterable<Buffer> {
  if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
    const body = paxRecord("path", name);
    yield tarHeader("PaxHeader", "x", body.byteLength, 0o644);
    yield* tarBody(body);
  }
  yield tarHeader(name, "0", content.byteLength, executable ? 0o700 : 0o600);
  yield* tarBody(content);
}

function paxRecord(key: string, value: string): Buffer {
  const rest = Buffer.from(` ${key}=${value}\n`);
  let length = rest.byteLength + 1;
  while (String(length).length + rest.byteLength !== length) {
    length = String(length).length + rest.byteLength;
  }
  return Buffer.concat([Buffer.from(String(length)), rest]);
}

/** Incremental reader for the regular files in a ustar/PAX stream. */
export class TarReader {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private chunkIndex = 0;
  private chunkOffset = 0;
  private pending:
    | { name: string; mode: number; size: number; kind: "file" | "pax" | "skip" }
    | undefined;
  private paxPath: string | undefined;
  private ended = false;

  constructor(private readonly maxFileBytes: number) {}

  push(chunk: Buffer): PortableFile[] {
    if (this.ended) return [];
    if (chunk.byteLength) {
      this.chunks.push(chunk);
      this.bufferedBytes += chunk.byteLength;
    }
    const files: PortableFile[] = [];
    while (!this.ended) {
      if (!this.pending) {
        if (this.bufferedBytes < TAR_BLOCK) break;
        const header = this.read(TAR_BLOCK);
        if (header.every((byte) => byte === 0)) {
          this.ended = true;
          this.chunks = [];
          this.bufferedBytes = 0;
          break;
        }
        this.pending = this.parseHeader(header);
      }
      const { size } = this.pending;
      const padded = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
      if (this.bufferedBytes < padded) break;
      const body = this.read(size);
      this.read(padded - size);
      const { kind, name, mode } = this.pending;
      this.pending = undefined;
      if (kind === "pax") this.paxPath = parsePaxPath(body) ?? this.paxPath;
      else if (kind === "file") {
        files.push({
          path: normalizeWorkspacePath(name),
          content: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
          ...((mode & 0o111) !== 0 ? { executable: true } : {}),
        });
      }
    }
    return files;
  }

  /** Copy each archive byte once, rather than recopying a growing file on every packet. */
  private read(size: number): Buffer {
    const result = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const chunk = this.chunks[this.chunkIndex]!;
      const count = Math.min(size - written, chunk.byteLength - this.chunkOffset);
      chunk.copy(result, written, this.chunkOffset, this.chunkOffset + count);
      written += count;
      this.chunkOffset += count;
      if (this.chunkOffset === chunk.byteLength) {
        this.chunkIndex += 1;
        this.chunkOffset = 0;
      }
    }
    this.bufferedBytes -= size;
    if (this.chunkIndex) {
      this.chunks = this.chunks.slice(this.chunkIndex);
      this.chunkIndex = 0;
    }
    return result;
  }

  finish(): void {
    if (this.pending) throw new Error("workspace archive ended inside a file");
  }

  private parseHeader(header: Buffer) {
    const field = (start: number, length: number) =>
      header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const mode = Number.parseInt(field(100, 8).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid workspace archive");
    const type = field(156, 1) || "0";
    const prefix = field(345, 155);
    const base = field(0, 100);
    const name = this.paxPath ?? (prefix ? `${prefix}/${base}` : base);
    if (type === "x") return { name, mode, size, kind: "pax" as const };
    if (type !== "0") return { name, mode, size, kind: "skip" as const };
    this.paxPath = undefined;
    if (size > this.maxFileBytes)
      throw new Error(`computer file exceeds ${this.maxFileBytes} bytes`);
    return { name, mode, size, kind: "file" as const };
  }
}

function parsePaxPath(body: Buffer): string | undefined {
  let offset = 0;
  while (offset < body.byteLength) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) return undefined;
    const length = Number(body.toString("utf8", offset, space));
    if (!Number.isSafeInteger(length) || length <= 0) return undefined;
    const record = body.toString("utf8", space + 1, offset + length - 1);
    if (record.startsWith("path=")) return record.slice(5);
    offset += length;
  }
  return undefined;
}
