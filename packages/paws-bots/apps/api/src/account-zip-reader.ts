import type { FileHandle } from "node:fs/promises";
import { Inflate } from "fflate";

/**
 * Random-access ZIP reading for account imports.
 *
 * The streaming reader this replaces could not tell where a data-descriptor
 * entry ends, so it scanned the raw upload for the next local-header
 * signature — and a zip stored inside the export leaks its inner headers
 * into the stream. This module instead reads the central directory from a
 * spooled file, so every entry is located by its recorded offset and sizes
 * and inflated incrementally from the file. Nothing here loads the whole
 * archive (or a whole entry) into memory: the central directory is parsed
 * through a sliding window, and entry data is read in 16 KiB slices.
 *
 * fflate's own central-directory APIs (`unzipSync`/`unzip`) take the whole
 * archive as one buffer, and `unzipSync` reads the ZIP64 end-of-central-
 * directory count and offset as 32-bit values, so neither is usable for a
 * body that may be up to 4 GiB.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const DATA_DESCRIPTOR = 0x08074b50;
const ZIP64_EXTRA_TAG = 0x0001;

/** An entry failed to parse or to verify; the caller reports it as unreadable. */
export class ZipFormatError extends Error {
  constructor(message = "The file is not a readable Rakazo export.") {
    super(message);
    this.name = "ZipFormatError";
  }
}

// A malicious archive can declare millions of central-directory records;
// each record is an object plus a name and extra-field copy held in memory
// until every record is sorted and validated. Cap the count and the total
// central-directory size before any record is accumulated: a legitimate
// account export holds a few hundred entries at most, so 100,000 entries
// and a 16 MiB directory leave ample headroom.
export const MAX_ARCHIVE_ENTRIES = 100_000;
export const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** One entry, located by the central directory and its local header. */
export type ZipEntry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Offset of the entry's data, past its local header. */
  dataOffset: number;
  /** The data-descriptor flag (bit 3) is set: sizes live after the data. */
  dataDescriptor: boolean;
  /** The entry's sizes came from a ZIP64 extra field (wider descriptor). */
  zip64Sizes: boolean;
};

/** Bounds one read so a single slice never holds a whole entry. */
const READ_SLICE_BYTES = 16 * 1024;
/** The central directory is parsed through windows this size. */
const CENTRAL_DIRECTORY_WINDOW_BYTES = 64 * 1024;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE); pass a previous result to continue a stream. */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous;
  for (let index = 0; index < data.length; index++) {
    const byte = data[index]!;
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}

const u16 = (view: DataView, offset: number) => view.getUint16(offset, true);
const u32 = (view: DataView, offset: number) => view.getUint32(offset, true);
const u64 = (view: DataView, offset: number) => Number(view.getBigUint64(offset, true));

/** Reads exactly `buffer.length` bytes from `position`, or throws.
 * Exported so the importer can stream a spilled entry back to its sink. */
export async function readExact(
  handle: FileHandle,
  position: number,
  buffer: Uint8Array,
): Promise<void> {
  let read = 0;
  while (read < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      read,
      buffer.byteLength - read,
      position + read,
    );
    if (bytesRead === 0) throw new ZipFormatError();
    read += bytesRead;
  }
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  return new TextDecoder(utf8 ? "utf-8" : "windows-1252").decode(bytes);
}

/**
 * Reads ZIP64 values out of an extra field. Only the fields whose 32-bit
 * value is 0xFFFFFFFF are present, in the order uncompressed size,
 * compressed size, local-header offset.
 */
function zip64Values(
  extra: Uint8Array,
  wantUncompressed: boolean,
  wantCompressed: boolean,
  wantOffset: boolean,
): { uncompressed?: number; compressed?: number; offset?: number } {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let at = 0;
  while (at + 4 <= extra.byteLength) {
    const tag = u16(view, at);
    const size = u16(view, at + 2);
    if (tag === ZIP64_EXTRA_TAG) {
      // The field's declared length comes from the uploaded bytes; it must
      // fit inside the extra field itself, or the 8-byte reads below would
      // throw a RangeError instead of a ZipFormatError.
      if (at + 4 + size > extra.byteLength) throw new ZipFormatError();
      let cursor = at + 4;
      const take = () => {
        if (cursor + 8 > at + 4 + size || cursor + 8 > extra.byteLength) {
          throw new ZipFormatError();
        }
        const value = u64(view, cursor);
        cursor += 8;
        return value;
      };
      return {
        ...(wantUncompressed ? { uncompressed: take() } : {}),
        ...(wantCompressed ? { compressed: take() } : {}),
        ...(wantOffset ? { offset: take() } : {}),
      };
    }
    at += 4 + size;
  }
  throw new ZipFormatError();
}

type CentralDirectory = {
  entries: number;
  size: number;
  offset: number;
};

/** Locates the end-of-central-directory record and returns its directory. */
async function readCentralDirectory(
  handle: FileHandle,
  fileSize: number,
): Promise<CentralDirectory> {
  if (fileSize < 22) throw new ZipFormatError();
  // The comment can be up to 64 KiB, and the ZIP64 locator + record sit
  // directly before the end-of-central-directory record.
  const tailSize = Math.min(fileSize, 65535 + 22 + 20 + 56);
  const tail = new Uint8Array(tailSize);
  await readExact(handle, fileSize - tailSize, tail);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let at = tailSize - 22; at >= 0; at--) {
    if (u32(view, at) !== END_OF_CENTRAL_DIRECTORY) continue;
    // The record is only the real one if its comment ends at the file end.
    if (at + 22 + u16(view, at + 20) === tailSize) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipFormatError();
  const endOffset = fileSize - tailSize + end;
  const disk = u16(view, end + 4);
  const directoryDisk = u16(view, end + 6);
  let entries = u16(view, end + 10);
  let size = u32(view, end + 12);
  let offset = u32(view, end + 16);
  const zip64 =
    entries === 0xffff ||
    u16(view, end + 8) === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff;
  if (disk !== 0 || directoryDisk !== 0) throw new ZipFormatError();
  if (zip64) {
    // The plain values are sentinels; the real ones live in the ZIP64
    // record the locator points at, directly before this record.
    if (endOffset < 20) throw new ZipFormatError();
    const locator = new Uint8Array(20);
    await readExact(handle, endOffset - 20, locator);
    const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
    if (u32(locatorView, 0) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) throw new ZipFormatError();
    const recordOffset = u64(locatorView, 8);
    const record = new Uint8Array(56);
    await readExact(handle, recordOffset, record);
    const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (u32(recordView, 0) !== ZIP64_END_OF_CENTRAL_DIRECTORY) throw new ZipFormatError();
    entries = u64(recordView, 32);
    size = u64(recordView, 40);
    offset = u64(recordView, 48);
  }
  if (
    !Number.isSafeInteger(entries) ||
    !Number.isSafeInteger(size) ||
    !Number.isSafeInteger(offset)
  )
    throw new ZipFormatError();
  // Enforce the metadata budget before any record is accumulated: an
  // archive over either bound is refused here, not after its records have
  // been read, sorted, and validated.
  if (entries > MAX_ARCHIVE_ENTRIES || size > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new ZipFormatError();
  }
  if (offset + size > fileSize) throw new ZipFormatError();
  return { entries, size, offset };
}

function parseCentralRecord(
  view: DataView,
  at: number,
): {
  entry: Omit<ZipEntry, "dataOffset" | "dataDescriptor"> & { extra: Uint8Array };
  length: number;
} {
  if (u32(view, at) !== CENTRAL_HEADER) throw new ZipFormatError();
  const flags = u16(view, at + 8);
  const method = u16(view, at + 10);
  const crc = u32(view, at + 16);
  let compressedSize = u32(view, at + 20);
  let uncompressedSize = u32(view, at + 24);
  const nameLength = u16(view, at + 28);
  const extraLength = u16(view, at + 30);
  const commentLength = u16(view, at + 32);
  const disk = u16(view, at + 34);
  let localHeaderOffset = u32(view, at + 42);
  const bytes = new Uint8Array(
    view.buffer,
    view.byteOffset + at,
    46 + nameLength + extraLength + commentLength,
  );
  const name = decodeName(bytes.subarray(46, 46 + nameLength), (flags & 0x800) !== 0);
  // Copy the extra field: the record is a view into a sliding window buffer
  // that the parser reuses, and keeping the view would pin the window.
  const extra = bytes.slice(46 + nameLength, 46 + nameLength + extraLength);
  // Only the size sentinels matter for the data descriptor's width: the
  // descriptor carries 8-byte sizes exactly when the sizes needed ZIP64.
  const zip64Sizes = compressedSize === 0xffffffff || uncompressedSize === 0xffffffff;
  if (zip64Sizes || localHeaderOffset === 0xffffffff) {
    const values = zip64Values(
      extra,
      uncompressedSize === 0xffffffff,
      compressedSize === 0xffffffff,
      localHeaderOffset === 0xffffffff,
    );
    if (values.uncompressed !== undefined) uncompressedSize = values.uncompressed;
    if (values.compressed !== undefined) compressedSize = values.compressed;
    if (values.offset !== undefined) localHeaderOffset = values.offset;
  }
  if (disk !== 0 || (flags & 1) !== 0 || (method !== 0 && method !== 8)) throw new ZipFormatError();
  return {
    entry: {
      name,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      zip64Sizes,
      extra,
    },
    length: 46 + nameLength + extraLength + commentLength,
  };
}

/**
 * Reads and validates the central directory, returning entries in
 * local-header order — the order the bytes actually appear in the file,
 * which is what "manifest first" means. The directory itself may list
 * them in any order.
 */
export async function parseZipArchive(handle: FileHandle): Promise<ZipEntry[]> {
  const { size: fileSize } = await handle.stat();
  const directory = await readCentralDirectory(handle, fileSize);
  const entries: Array<ZipEntry & { extra: Uint8Array }> = [];
  let position = directory.offset;
  const end = directory.offset + directory.size;
  let pending = new Uint8Array(0);
  while (position < end || pending.length > 0) {
    if (position < end) {
      const want = Math.min(CENTRAL_DIRECTORY_WINDOW_BYTES, end - position);
      const chunk = new Uint8Array(want);
      await readExact(handle, position, chunk);
      position += want;
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      pending = joined;
    }
    const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
    let consumed = 0;
    while (consumed + 46 <= pending.length) {
      if (u32(view, consumed) !== CENTRAL_HEADER) throw new ZipFormatError();
      const nameLength = u16(view, consumed + 28);
      const extraLength = u16(view, consumed + 30);
      const commentLength = u16(view, consumed + 32);
      const length = 46 + nameLength + extraLength + commentLength;
      if (consumed + length > pending.length) break;
      const parsed = parseCentralRecord(view, consumed);
      if (parsed.length !== length) throw new ZipFormatError();
      if (entries.length >= directory.entries) throw new ZipFormatError();
      entries.push({ ...parsed.entry, dataOffset: -1, dataDescriptor: false });
      consumed += length;
    }
    pending = pending.subarray(consumed);
    if (position >= end && pending.length > 0) throw new ZipFormatError();
  }
  if (entries.length !== directory.entries) throw new ZipFormatError();
  entries.sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (index > 0 && entry.localHeaderOffset <= entries[index - 1]!.localHeaderOffset)
      throw new ZipFormatError();
    await validateLocalHeader(handle, fileSize, entry, directory.offset);
    const nextOffset =
      index + 1 < entries.length ? entries[index + 1]!.localHeaderOffset : directory.offset;
    if (entry.dataOffset + entry.compressedSize > nextOffset) throw new ZipFormatError();
  }
  return entries.map(({ extra: _extra, ...entry }) => entry);
}

async function validateLocalHeader(
  handle: FileHandle,
  fileSize: number,
  entry: ZipEntry & { extra: Uint8Array },
  directoryOffset: number,
): Promise<void> {
  const header = new Uint8Array(30);
  if (entry.localHeaderOffset + 30 > fileSize) throw new ZipFormatError();
  await readExact(handle, entry.localHeaderOffset, header);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (u32(view, 0) !== LOCAL_HEADER) throw new ZipFormatError();
  const flags = u16(view, 6);
  const method = u16(view, 8);
  if (flags !== entry.flags || method !== entry.method) throw new ZipFormatError();
  const nameLength = u16(view, 26);
  const extraLength = u16(view, 28);
  const nameBytes = new Uint8Array(nameLength);
  await readExact(handle, entry.localHeaderOffset + 30, nameBytes);
  if (decodeName(nameBytes, (flags & 0x800) !== 0) !== entry.name) throw new ZipFormatError();
  entry.dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (entry.dataOffset > fileSize) throw new ZipFormatError();
  entry.dataDescriptor = (flags & 8) !== 0;
  if (!entry.dataDescriptor) {
    const crc = u32(view, 14);
    let compressedSize = u32(view, 18);
    let uncompressedSize = u32(view, 22);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      const extra = new Uint8Array(extraLength);
      await readExact(handle, entry.localHeaderOffset + 30 + nameLength, extra);
      const values = zip64Values(
        extra,
        uncompressedSize === 0xffffffff,
        compressedSize === 0xffffffff,
        false,
      );
      if (values.uncompressed !== undefined) uncompressedSize = values.uncompressed;
      if (values.compressed !== undefined) compressedSize = values.compressed;
    }
    if (
      crc !== entry.crc ||
      compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize
    )
      throw new ZipFormatError();
  }
  if (entry.dataOffset + entry.compressedSize > fileSize) throw new ZipFormatError();
  if (entry.dataOffset + entry.compressedSize > directoryOffset) throw new ZipFormatError();
  if (entry.dataDescriptor) await validateDataDescriptor(handle, fileSize, entry);
}

async function validateDataDescriptor(
  handle: FileHandle,
  fileSize: number,
  entry: ZipEntry,
): Promise<void> {
  // The descriptor is 12 bytes (CRC + sizes), or 16 with its signature;
  // ZIP64 entries carry 8-byte sizes instead of 4-byte ones.
  const wide = entry.zip64Sizes;
  const probe = new Uint8Array(wide ? 24 : 16);
  const dataEnd = entry.dataOffset + entry.compressedSize;
  if (dataEnd + probe.length > fileSize) throw new ZipFormatError();
  await readExact(handle, dataEnd, probe);
  const view = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
  const signed = u32(view, 0) === DATA_DESCRIPTOR;
  const at = signed ? 4 : 0;
  const crc = u32(view, at);
  const compressedSize = wide ? u64(view, at + 4) : u32(view, at + 4);
  const uncompressedSize = wide ? u64(view, at + 12) : u32(view, at + 8);
  if (
    crc !== entry.crc ||
    compressedSize !== entry.compressedSize ||
    uncompressedSize !== entry.uncompressedSize
  )
    throw new ZipFormatError();
}

/**
 * Inflates one entry from the file, calling `onData` for each output
 * chunk. The entry's bytes are verified against its recorded CRC and its
 * recorded uncompressed size; a mismatch, a corrupt deflate stream, or a
 * truncated entry throws `ZipFormatError`. Throws from `onData` abort the
 * inflation at once. `onFlush`, when given, runs after each compressed-input
 * slice is pushed, so the caller can drain the output in bounded batches
 * instead of queueing a whole entry; a throw from it aborts the inflation
 * and reaches the caller unchanged.
 */
export async function inflateEntry(
  handle: FileHandle,
  entry: ZipEntry,
  onData: (chunk: Uint8Array, final: boolean) => void,
  onFlush?: () => Promise<void>,
): Promise<void> {
  let crc = 0;
  let emitted = 0;
  if (entry.method === 0) {
    let remaining = entry.compressedSize;
    let offset = entry.dataOffset;
    if (remaining === 0) {
      onData(new Uint8Array(0), true);
      await onFlush?.();
    } else {
      while (remaining > 0) {
        const want = Math.min(READ_SLICE_BYTES, remaining);
        const chunk = new Uint8Array(want);
        await readExact(handle, offset, chunk);
        crc = crc32(chunk, crc);
        emitted += want;
        remaining -= want;
        offset += want;
        onData(chunk, remaining === 0);
        await onFlush?.();
      }
    }
  } else {
    const inflate = new Inflate();
    let sawFinal = false;
    // A throw from onData (a limit breach) must reach the caller unchanged
    // and stop the inflation at once — it is not a corrupt deflate stream.
    let aborted: unknown = null;
    inflate.ondata = (data, final) => {
      if (aborted !== null) return;
      try {
        crc = crc32(data, crc);
        emitted += data.length;
        if (final) sawFinal = true;
        onData(data, final);
      } catch (error) {
        aborted = error;
        throw error;
      }
    };
    // A throw from onFlush must also reach the caller unchanged, not become
    // a format error; routing it through `aborted` keeps both paths alike.
    const flush = async () => {
      try {
        await onFlush?.();
      } catch (error) {
        aborted = error;
        throw error;
      }
    };
    let remaining = entry.compressedSize;
    let offset = entry.dataOffset;
    try {
      if (remaining === 0) {
        inflate.push(new Uint8Array(0), true);
        await flush();
      } else {
        while (remaining > 0) {
          const want = Math.min(READ_SLICE_BYTES, remaining);
          const chunk = new Uint8Array(want);
          await readExact(handle, offset, chunk);
          remaining -= want;
          offset += want;
          inflate.push(chunk, remaining === 0);
          await flush();
        }
      }
    } catch {
      if (aborted !== null) throw aborted;
      throw new ZipFormatError();
    }
    if (aborted !== null) throw aborted;
    if (!sawFinal) throw new ZipFormatError();
  }
  // The recorded size is attacker-controlled, but the emitted bytes are not:
  // an entry that inflates to a different size than recorded is corrupt,
  // even when its checksum and data descriptor agree with the record.
  if (emitted !== entry.uncompressedSize) throw new ZipFormatError();
  if (crc !== entry.crc) throw new ZipFormatError();
}
