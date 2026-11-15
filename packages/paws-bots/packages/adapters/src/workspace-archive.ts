import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type {
  PortableFile,
  StreamedPortableFile,
  WorkspaceExportLimits,
} from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { normalizeWorkspacePath } from "./computer-support.js";

const BLOCK = 512;
/** Extended headers carry a path and a size; anything near this size is not one tar wrote. */
const MAX_PAX_HEADER_BYTES = 1024 * 1024;
/** Larger files are streamed to the caller instead of held in memory. */
const MAX_HELD_FILE_BYTES = 5 * 1024 * 1024;
/** tar pads its end to a whole record (10 KiB by default); more after it is not padding. */
const MAX_TRAILING_BYTES = 1024 * 1024;
/** Header bytes allowed per file on top of its contents: its header and a long-path header. */
const HEADER_BYTES_PER_FILE = 16 * 1024;

/**
 * The most a workspace within `limits` can decompress to, so nothing in the archive, not even
 * entries the reader skips, can make it decompress more than the save allows.
 */
function decompressedBudget(limits: WorkspaceExportLimits): number {
  return limits.maxBytes + (limits.maxFiles + 1) * HEADER_BYTES_PER_FILE + MAX_TRAILING_BYTES;
}

/**
 * Reads the regular files of a gzipped POSIX (pax or ustar) tar stream, one at a time, with their
 * executable bit; a file over 5 MiB comes as a stream to read before the next. The archive comes
 * from a computer the user controls, so nothing in it is trusted: headers must checksum, every
 * path stays relative to the workspace, links and other special entries are never followed, it
 * never decompresses past what `limits` allow, and an archive that ends before its end marker or
 * whose gzip stream is cut short fails instead of yielding a partial workspace.
 */
export async function* readWorkspaceArchive(
  gzipped: AsyncIterable<Uint8Array>,
  limits?: WorkspaceExportLimits,
): AsyncGenerator<PortableFile | StreamedPortableFile> {
  const gunzip = createGunzip();
  const piping = pipeline(Readable.from(gzipped, { objectMode: false }), gunzip);
  // A failure also ends the gunzip stream with that error, which the reader reports.
  piping.catch(() => undefined);
  const reader = new ByteReader(
    gunzip[Symbol.asyncIterator](),
    limits ? decompressedBudget(limits) : Number.POSITIVE_INFINITY,
  );
  try {
    yield* readTar(reader);
  } finally {
    gunzip.destroy();
  }
}

async function* readTar(reader: ByteReader): AsyncGenerator<PortableFile | StreamedPortableFile> {
  let extended: { path?: string; size?: number } = {};
  while (true) {
    const block = await reader.read(BLOCK, true);
    if (!block) throw new Error("Workspace archive ended early");
    if (block.every((byte) => byte === 0)) {
      await reader.drain();
      return;
    }
    const header = parseHeader(block);
    // An extended header describes the entry after it, never another extended header.
    const size =
      header.type === "x" || header.type === "g" ? header.size : (extended.size ?? header.size);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    switch (header.type) {
      case "x": {
        if (size > MAX_PAX_HEADER_BYTES) throw new Error("Workspace archive header is too large");
        const data = await reader.read(size);
        await reader.skip(padding);
        extended = parsePaxRecords(Buffer.from(data));
        continue;
      }
      case "0":
      case "7": {
        const path = archivePath(extended.path ?? header.name);
        const executable = (header.mode & 0o111) !== 0 ? { executable: true } : {};
        extended = {};
        if (size <= MAX_HELD_FILE_BYTES) {
          const content = await reader.read(size);
          await reader.skip(padding);
          yield { path, content, ...executable };
          continue;
        }
        const body = new EntryBody(reader, size);
        yield { path, body, ...executable };
        // Whatever the caller left unread is skipped, so the next header is read in place.
        await body.close();
        await reader.skip(padding);
        continue;
      }
      // tar is told to store hard links as files; a link entry would drop that file's content.
      case "1":
        throw new Error("Workspace archive contains a hard link");
      // GNU long names and sparse files only appear outside the pax format the export asks for.
      case "K":
      case "L":
      case "S":
        throw new Error("Workspace archive uses an unsupported tar extension");
      default:
        // Directories, symbolic links, devices and global headers carry no workspace file.
        await reader.skip(size + padding);
        if (header.type !== "g") extended = {};
    }
  }
}

function parseHeader(block: Uint8Array) {
  const bytes = Buffer.from(block.buffer, block.byteOffset, block.byteLength);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (bytes[index] ?? 0);
  }
  if (parseNumber(bytes, 148, 8) !== sum) throw new Error("Workspace archive header is corrupt");
  if (bytes.toString("latin1", 257, 262) !== "ustar") {
    throw new Error("Workspace archive is not a POSIX tar archive");
  }
  const name = text(bytes, 0, 100);
  // Only POSIX ustar ("ustar\0") headers have a name prefix; GNU's use that space for times.
  const prefix = bytes[262] === 0 ? text(bytes, 345, 155) : "";
  const type = bytes[156] === 0 ? "0" : String.fromCharCode(bytes[156] ?? 0);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: parseNumber(bytes, 100, 8),
    size: parseNumber(bytes, 124, 12),
    type,
  };
}

function text(bytes: Buffer, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
}

/** An octal field, or a base-256 one as GNU tar writes for large values. */
function parseNumber(bytes: Buffer, offset: number, length: number): number {
  const field = bytes.subarray(offset, offset + length);
  if ((field[0] ?? 0) & 0x80) {
    if ((field[0] ?? 0) & 0x40) throw new Error("Workspace archive header is corrupt");
    let value = (field[0] ?? 0) & 0x3f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw new Error("Workspace archive header is corrupt");
    return value;
  }
  const digits = field
    .toString("latin1")
    .replace(/[\0 ]+$/, "")
    .replace(/^ +/, "");
  if (!/^[0-7]*$/.test(digits)) throw new Error("Workspace archive header is corrupt");
  return digits ? Number.parseInt(digits, 8) : 0;
}

/** `<length> <key>=<value>\n` records, where the length counts the whole record in bytes. */
function parsePaxRecords(data: Buffer): { path?: string; size?: number } {
  const records: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number(data.toString("latin1", offset, space));
    const end = offset + length;
    if (
      space === -1 ||
      !/^\d+$/.test(data.toString("latin1", offset, space)) ||
      end > data.length ||
      end <= space + 1 ||
      data[end - 1] !== 0x0a
    ) {
      throw new Error("Workspace archive header is corrupt");
    }
    const record = data.toString("utf8", space + 1, end - 1);
    const equals = record.indexOf("=");
    if (equals === -1) throw new Error("Workspace archive header is corrupt");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key === "path") records.path = value;
    else if (key === "size") {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("Workspace archive header is corrupt");
      }
      records.size = Number(value);
    } else if (key.startsWith("GNU.sparse.")) {
      throw new Error("Workspace archive uses an unsupported tar extension");
    }
    offset = end;
  }
  return records;
}

/** A workspace-relative path; tar stores the export's names as `./name`. */
function archivePath(name: string): string {
  const relative = normalizeWorkspacePath(name.replace(/^(?:\.\/+)+/, ""));
  if (!relative) throw new Error("Workspace archive contains a file without a name");
  return relative;
}

/** One file's bytes straight from the archive, readable only until the export moves on. */
class EntryBody implements AsyncIterable<Uint8Array> {
  private closed = false;

  constructor(
    private readonly reader: ByteReader,
    private remaining: number,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (this.remaining > 0 || this.closed) {
      if (this.closed) throw new Error("Workspace archive file was read after the next one");
      const chunk = await this.reader.next(this.remaining);
      this.remaining -= chunk.byteLength;
      yield chunk;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reader.skip(this.remaining);
    this.remaining = 0;
  }
}

/** Exact-length reads over a byte stream, failing when it ends mid-read. */
class ByteReader {
  private current: Buffer = Buffer.alloc(0);
  private total = 0;

  constructor(
    private readonly source: AsyncIterator<Buffer>,
    private readonly budget: number,
  ) {}

  async read(size: number): Promise<Uint8Array>;
  async read(size: number, endOk: true): Promise<Uint8Array | undefined>;
  async read(size: number, endOk = false): Promise<Uint8Array | undefined> {
    // Memory follows the bytes that arrived, never a size the header merely claims.
    const parts: Buffer[] = [];
    let filled = 0;
    while (filled < size) {
      if (!(await this.fill())) {
        if (endOk && filled === 0) return undefined;
        throw new Error("Workspace archive ended early");
      }
      const part = this.current.subarray(0, Math.min(size - filled, this.current.length));
      parts.push(part);
      filled += part.length;
      this.current = this.current.subarray(part.length);
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /** Up to `max` bytes, as many as have arrived. */
  async next(max: number): Promise<Uint8Array> {
    if (!(await this.fill())) throw new Error("Workspace archive ended early");
    const chunk = this.current.subarray(0, Math.min(max, this.current.length));
    this.current = this.current.subarray(chunk.length);
    return chunk;
  }

  async skip(size: number): Promise<void> {
    let left = size;
    while (left > 0) {
      if (!(await this.fill())) throw new Error("Workspace archive ended early");
      const skipped = Math.min(left, this.current.length);
      left -= skipped;
      this.current = this.current.subarray(skipped);
    }
  }

  /** Reads the rest so gunzip checks the stream's length and checksum; only padding may remain. */
  async drain(): Promise<void> {
    let trailing = this.current.length;
    this.current = Buffer.alloc(0);
    while (await this.fill()) {
      trailing += this.current.length;
      if (trailing > MAX_TRAILING_BYTES)
        throw new Error("Workspace archive has data after its end");
      this.current = Buffer.alloc(0);
    }
  }

  private async fill(): Promise<boolean> {
    while (!this.current.length) {
      const next = await this.source.next();
      if (next.done) return false;
      this.total += next.value.length;
      if (this.total > this.budget) throw new WorkspaceTooLargeError("bytes");
      this.current = next.value;
    }
    return true;
  }
}
