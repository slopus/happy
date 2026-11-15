import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { fileHandlePath } from "./file-handle-path.js";
import { isContained } from "./home.js";
import {
  isTaggedCacheDirectory,
  shouldSkipPortableWorkspaceFile,
  WORKSPACE_SAVE_LIMITS,
} from "./workspace-save-policy.js";

/**
 * A home as one byte stream, so a revision is a single stored object however many files it
 * holds. The format has only two entry kinds, directories and regular files, so links, devices
 * and other special files cannot be expressed, let alone restored:
 *
 *   magic "RKZH\x01"
 *   entry*: kind u8 (1 dir, 2 file) | path length u16 | UTF-8 path
 *           files add: mode u16 (permission bits) | size u64 | bytes
 *   end:    kind u8 0
 *
 * Paths are relative, use "/", and have no empty, "." or ".." segments. Unpacking checks all of
 * this again, plus duplicate entries, sizes and counts, because file names and contents are
 * written by bots.
 */

const MAGIC = Buffer.from("RKZH\x01", "latin1");
const END = 0;
const DIRECTORY = 1;
const FILE = 2;
const READ_CHUNK = 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_SEGMENT_BYTES = 255;

export interface HomeArchiveLimits {
  /** Total file bytes in one home. */
  maxBytes: number;
  /** Files and directories in one home. */
  maxEntries: number;
}

/** Read bounds retain compatibility with homes saved before the save limit was lowered. */
export const DEFAULT_HOME_ARCHIVE_LIMITS: HomeArchiveLimits = {
  maxBytes: 100 * 1024 ** 3,
  maxEntries: 2_000_000,
};

export class HomeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomeArchiveError";
  }
}

/**
 * Streams the directory at `root` as an archive. Links are followed only when they resolve
 * inside the home (as local checkouts copy them); anything else that is not a directory or a
 * regular file is left out. A file that shrinks while it is read fails the whole archive.
 */
export async function* packHome(
  root: string,
  limits: HomeArchiveLimits = DEFAULT_HOME_ARCHIVE_LIMITS,
): AsyncGenerator<Buffer> {
  limits = {
    maxBytes: Math.min(limits.maxBytes, WORKSPACE_SAVE_LIMITS.maxBytes),
    maxEntries: limits.maxEntries,
  };
  const resolvedRoot = await realpath(root);
  const counts = { bytes: 0, entries: 0, files: 0 };
  async function* entries() {
    yield MAGIC;
    yield* packDirectory(resolvedRoot, resolvedRoot, "", new Set([resolvedRoot]), counts, limits);
    yield Buffer.from([END]);
  }
  // Entry headers are tiny; batching keeps a home of many small files to few, large writes.
  let held: Buffer[] = [];
  let length = 0;
  for await (const part of entries()) {
    held.push(part);
    length += part.length;
    if (length >= READ_CHUNK) {
      yield Buffer.concat(held);
      held = [];
      length = 0;
    }
  }
  if (length) yield Buffer.concat(held);
}

async function* packDirectory(
  root: string,
  directory: string,
  prefix: string,
  visited: Set<string>,
  counts: { bytes: number; entries: number; files: number },
  limits: HomeArchiveLimits,
): AsyncGenerator<Buffer> {
  const entries = await readdir(directory).catch(skipVanished([] as string[]));
  for (const name of entries.sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!isArchivePath(relative)) continue;
    const resolved = await realpath(path.join(directory, name)).catch(skipVanished(undefined));
    if (!resolved || !isContained(root, resolved) || resolved === root) continue;
    const info = await lstat(resolved).catch(skipVanished(undefined));
    if (!info || shouldSkipPortableWorkspaceFile(relative, info.isDirectory())) continue;
    if (info.isDirectory()) {
      if (visited.has(resolved) || (await isTaggedCacheDirectory(resolved))) continue;
      countEntry(counts, 0, limits);
      yield entryHeader(DIRECTORY, relative);
      yield* packDirectory(
        root,
        resolved,
        relative,
        new Set([...visited, resolved]),
        counts,
        limits,
      );
    } else if (info.isFile()) {
      if (++counts.files > WORKSPACE_SAVE_LIMITS.maxFiles)
        throw new WorkspaceTooLargeError("files");
      const handle = await openContained(root, resolved);
      if (!handle) continue;
      try {
        const opened = await handle.stat();
        countEntry(counts, opened.size, limits);
        const header = entryHeader(FILE, relative);
        const meta = Buffer.alloc(10);
        meta.writeUInt16BE(opened.mode & 0o777, 0);
        meta.writeBigUInt64BE(BigInt(opened.size), 2);
        yield Buffer.concat([header, meta]);
        yield* readExactly(handle, opened.size);
      } finally {
        await handle.close();
      }
    }
  }
}

/**
 * Entries removed, or replaced by a link or socket, between listing and opening are left out,
 * as are dangling links. Any other error (permissions, out of file handles, I/O) fails the save
 * rather than storing a home with files silently missing.
 */
function skipVanished<T>(fallback: T) {
  return (error: NodeJS.ErrnoException): T => {
    if (["ENOENT", "ENOTDIR", "ELOOP", "ENXIO"].includes(error.code ?? "")) return fallback;
    throw error;
  };
}

/** Opens a regular file and checks the opened object, not the name, is inside the home. */
async function openContained(root: string, file: string): Promise<FileHandle | undefined> {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch(skipVanished(undefined));
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile() || !isContained(root, await fileHandlePath(handle.fd))) {
      await handle.close();
      return undefined;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function* readExactly(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
  let remaining = size;
  let position = 0;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(READ_CHUNK, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) throw new HomeArchiveError("A home file shrank while it was saved");
    position += bytesRead;
    remaining -= bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function entryHeader(kind: number, relative: string) {
  const name = Buffer.from(relative, "utf8");
  const header = Buffer.alloc(3);
  header.writeUInt8(kind, 0);
  header.writeUInt16BE(name.length, 1);
  return Buffer.concat([header, name]);
}

function countEntry(
  counts: { bytes: number; entries: number },
  bytes: number,
  limits: HomeArchiveLimits,
) {
  counts.entries += 1;
  counts.bytes += bytes;
  if (counts.entries > limits.maxEntries) throw new WorkspaceTooLargeError("files");
  if (counts.bytes > limits.maxBytes) throw new WorkspaceTooLargeError("bytes");
}

/** A relative path made only of ordinary segments. */
function isArchivePath(relative: string) {
  const bytes = Buffer.byteLength(relative, "utf8");
  if (bytes === 0 || bytes > MAX_PATH_BYTES || relative.includes("\0")) return false;
  return relative
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        Buffer.byteLength(segment, "utf8") <= MAX_SEGMENT_BYTES,
    );
}

/**
 * Writes an archive into `dest`, an empty directory the caller just created. Only directories
 * and regular files are created, files never replace anything (O_EXCL), and nothing is written
 * through a link because the archive cannot create one. Throws on any malformed entry.
 */
export async function unpackHome(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  limits: HomeArchiveLimits = DEFAULT_HOME_ARCHIVE_LIMITS,
): Promise<void> {
  await readArchive(source, limits, {
    directory: async (relative) => {
      if (shouldSkipPortableWorkspaceFile(relative, true)) return;
      await mkdir(path.join(dest, relative), { recursive: true, mode: 0o700 });
    },
    file: async (relative, mode, body) => {
      if (shouldSkipPortableWorkspaceFile(relative)) {
        for await (const _chunk of body);
        return;
      }
      const target = path.join(dest, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        for await (const chunk of body) {
          for (let offset = 0; offset < chunk.length; ) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
            offset += bytesWritten;
          }
        }
        await handle.chmod(mode | 0o600);
      } finally {
        await handle.close();
      }
    },
  });
}

/** Reads and checks a whole archive without writing anything, to verify an upload. */
export async function checkHomeArchive(
  source: AsyncIterable<Uint8Array>,
  limits: HomeArchiveLimits = DEFAULT_HOME_ARCHIVE_LIMITS,
): Promise<{ entries: number; bytes: number }> {
  return readArchive(source, limits, {
    directory: async () => undefined,
    file: async (_relative, _mode, body) => {
      for await (const _chunk of body);
    },
  });
}

async function readArchive(
  source: AsyncIterable<Uint8Array>,
  limits: HomeArchiveLimits,
  sink: {
    directory(relative: string): Promise<void>;
    file(relative: string, mode: number, body: AsyncIterable<Buffer>): Promise<void>;
  },
): Promise<{ entries: number; bytes: number }> {
  const reader = new ByteReader(source);
  if (!(await reader.read(MAGIC.length)).equals(MAGIC))
    throw new HomeArchiveError("Not a home archive");
  const counts = { bytes: 0, entries: 0 };
  const seen = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (;;) {
    const kind = (await reader.read(1))[0];
    if (kind === END) break;
    if (kind !== DIRECTORY && kind !== FILE)
      throw new HomeArchiveError("Home archive has an unsupported entry");
    const length = (await reader.read(2)).readUInt16BE(0);
    let relative: string;
    try {
      relative = decoder.decode(await reader.read(length));
    } catch {
      throw new HomeArchiveError("Home archive has a path that is not UTF-8");
    }
    if (!isArchivePath(relative)) throw new HomeArchiveError("Home archive path is not allowed");
    if (seen.has(relative)) throw new HomeArchiveError("Home archive repeats an entry");
    seen.add(relative);
    if (kind === DIRECTORY) {
      countEntry(counts, 0, limits);
      await sink.directory(relative);
      continue;
    }
    const meta = await reader.read(10);
    const size = meta.readBigUInt64BE(2);
    if (size > BigInt(limits.maxBytes)) throw new WorkspaceTooLargeError("bytes");
    countEntry(counts, Number(size), limits);
    await sink.file(relative, meta.readUInt16BE(0) & 0o777, reader.stream(Number(size)));
  }
  if (!(await reader.atEnd())) throw new HomeArchiveError("Home archive has trailing data");
  return counts;
}

/** Exact-length reads over a chunked stream, without holding more than one chunk. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private pending = Buffer.alloc(0);

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    while (this.pending.length === 0) {
      const next = await this.iterator.next();
      if (next.done) return false;
      this.pending = Buffer.from(next.value);
    }
    return true;
  }

  async read(length: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of this.stream(length)) parts.push(part);
    return Buffer.concat(parts);
  }

  async *stream(length: number): AsyncGenerator<Buffer> {
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.fill())) throw new HomeArchiveError("Home archive is truncated");
      const take = Math.min(remaining, this.pending.length);
      const part = this.pending.subarray(0, take);
      this.pending = this.pending.subarray(take);
      remaining -= take;
      yield part;
    }
  }

  async atEnd(): Promise<boolean> {
    return !(await this.fill());
  }
}
