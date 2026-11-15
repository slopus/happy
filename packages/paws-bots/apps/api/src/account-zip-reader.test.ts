import { randomUUID } from "node:crypto";
import { open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { describe, expect, it } from "vitest";
import { incompressibleBytes } from "./account-import.test-support.js";
import { crc32, inflateEntry, parseZipArchive, ZipFormatError } from "./account-zip-reader.js";

async function withArchive<T>(
  bytes: Uint8Array,
  run: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>,
): Promise<T> {
  const file = path.join(tmpdir(), `rakazo-zip-reader-test-${randomUUID()}`);
  await writeFile(file, bytes);
  const handle = await open(file, "r+");
  try {
    return await run(handle);
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}

function buildArchive(
  files: Array<[name: string, content: string | Uint8Array, stored?: boolean]>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, content, stored] of files) {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const entry = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    entry.push(data, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

async function inflateAll(
  handle: Awaited<ReturnType<typeof open>>,
  name: string,
): Promise<Uint8Array> {
  const entries = await parseZipArchive(handle);
  const entry = entries.find((candidate) => candidate.name === name)!;
  const chunks: Uint8Array[] = [];
  await inflateEntry(handle, entry, (data) => {
    if (data.length) chunks.push(data);
  });
  return Buffer.concat(chunks);
}

/**
 * Rewrites an entry's recorded uncompressed size in the central directory
 * and its data descriptor, leaving the compressed size and checksum alone,
 * so the recorded sizes agree with each other but not with the actual data.
 */
async function falsifyUncompressedSize(
  bytes: Uint8Array,
  name: string,
  falseSize: number,
): Promise<Uint8Array> {
  const mutated = new Uint8Array(bytes);
  const view = new DataView(mutated.buffer);
  const entries = await withArchive(bytes, (handle) => parseZipArchive(handle));
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`no entry named ${name}`);
  // Data descriptor: right after the entry's data; signed descriptors carry
  // the uncompressed size 12 bytes in, unsigned ones 8 bytes in.
  const descriptor = entry.dataOffset + entry.compressedSize;
  const signed = view.getUint32(descriptor, true) === 0x08074b50;
  view.setUint32(descriptor + (signed ? 12 : 8), falseSize, true);
  // Central directory record: walk the records from the end of central
  // directory, which sits 22 bytes from the end (no comment in our fixtures).
  const eocd = bytes.length - 22;
  let at = view.getUint32(eocd + 16, true);
  while (view.getUint32(at, true) === 0x02014b50) {
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const recordName = new TextDecoder().decode(mutated.subarray(at + 46, at + 46 + nameLength));
    if (recordName === name) {
      view.setUint32(at + 24, falseSize, true);
      return mutated;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`no central directory record named ${name}`);
}

/** A minimal ZIP64 archive, built by hand: one stored file, ZIP64 end of
 * central directory + locator, ZIP64 extra fields in both headers.
 * With `truncateLocalExtra` / `truncateCentralExtra`, that header's extra
 * field declares two 8-byte ZIP64 values but holds only one, so its declared
 * end runs past its actual bytes. */
function buildZip64Archive(
  options: { truncateLocalExtra?: boolean; truncateCentralExtra?: boolean } = {},
): Uint8Array {
  const name = new TextEncoder().encode("a.txt");
  const data = new TextEncoder().encode("hi");
  const crc = crc32(data);
  const buildExtra = (truncate: boolean | undefined): Uint8Array => {
    const extra = new Uint8Array(truncate ? 12 : 20);
    const extraView = new DataView(extra.buffer);
    extraView.setUint16(0, 0x0001, true);
    extraView.setUint16(2, 16, true);
    extraView.setBigUint64(4, 2n, true);
    if (!truncate) extraView.setBigUint64(12, 2n, true);
    return extra;
  };
  const localExtra = buildExtra(options.truncateLocalExtra);
  const centralExtra = buildExtra(options.truncateCentralExtra);
  const local = new Uint8Array(30 + name.length + localExtra.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 45, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, 0xffffffff, true);
  localView.setUint32(22, 0xffffffff, true);
  localView.setUint16(26, name.length, true);
  localView.setUint16(28, localExtra.length, true);
  local.set(name, 30);
  local.set(localExtra, 30 + name.length);
  local.set(data, 30 + name.length + localExtra.length);
  const cdOffset = local.length;
  const cd = new Uint8Array(46 + name.length + centralExtra.length);
  const cdView = new DataView(cd.buffer);
  cdView.setUint32(0, 0x02014b50, true);
  cdView.setUint16(4, 45, true);
  cdView.setUint16(6, 45, true);
  cdView.setUint32(16, crc, true);
  cdView.setUint32(20, 0xffffffff, true);
  cdView.setUint32(24, 0xffffffff, true);
  cdView.setUint16(28, name.length, true);
  cdView.setUint16(30, centralExtra.length, true);
  cdView.setUint32(42, 0, true);
  cd.set(name, 46);
  cd.set(centralExtra, 46 + name.length);
  const zip64EocdOffset = cdOffset + cd.length;
  const zip64Eocd = new Uint8Array(56);
  const zip64View = new DataView(zip64Eocd.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  zip64View.setBigUint64(4, 44n, true);
  zip64View.setUint16(12, 45, true);
  zip64View.setUint16(14, 45, true);
  zip64View.setBigUint64(24, 1n, true);
  zip64View.setBigUint64(32, 1n, true);
  zip64View.setBigUint64(40, BigInt(cd.length), true);
  zip64View.setBigUint64(48, BigInt(cdOffset), true);
  const locatorOffset = zip64EocdOffset + zip64Eocd.length;
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(zip64EocdOffset), true);
  locatorView.setUint32(16, 1, true);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 0xffff, true);
  eocdView.setUint16(10, 0xffff, true);
  eocdView.setUint32(12, 0xffffffff, true);
  eocdView.setUint32(16, 0xffffffff, true);
  const out = new Uint8Array(
    local.length + cd.length + zip64Eocd.length + locator.length + eocd.length,
  );
  out.set(local, 0);
  out.set(cd, cdOffset);
  out.set(zip64Eocd, zip64EocdOffset);
  out.set(locator, locatorOffset);
  out.set(eocd, locatorOffset + locator.length);
  return out;
}

/**
 * Builds an archive of many empty stored entries by hand (no compression),
 * so the entry-count budget can be exercised without a slow build. Counts
 * above 65,535 need the ZIP64 end of central directory, so this always
 * writes one.
 */
function buildManyEmptyEntries(count: number): Uint8Array {
  const encoder = new TextEncoder();
  const names = Array.from({ length: count }, (_, index) => encoder.encode(`file-${index}.txt`));
  const localSize = names.reduce((sum, name) => sum + 30 + name.length, 0);
  const cdSize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(localSize + cdSize + 56 + 20 + 22);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const name of names) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0, true);
    view.setUint32(at + 14, 0, true);
    view.setUint32(at + 18, 0, true);
    view.setUint32(at + 22, 0, true);
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true);
    bytes.set(name, at + 30);
    at += 30 + name.length;
  }
  const cdOffset = at;
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 10, 0, true);
    view.setUint32(at + 16, 0, true);
    view.setUint32(at + 20, 0, true);
    view.setUint32(at + 24, 0, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint32(at + 42, offsets[index]!, true);
    bytes.set(name, at + 46);
    at += 46 + name.length;
  }
  const zip64EocdOffset = at;
  view.setUint32(at, 0x06064b50, true);
  view.setBigUint64(at + 4, 44n, true);
  view.setUint16(at + 12, 45, true);
  view.setUint16(at + 14, 45, true);
  view.setUint32(at + 16, 0, true);
  view.setUint32(at + 20, 0, true);
  view.setBigUint64(at + 24, BigInt(count), true);
  view.setBigUint64(at + 32, BigInt(count), true);
  view.setBigUint64(at + 40, BigInt(cdSize), true);
  view.setBigUint64(at + 48, BigInt(cdOffset), true);
  at += 56;
  view.setUint32(at, 0x07064b50, true);
  view.setUint32(at + 4, 0, true);
  view.setBigUint64(at + 8, BigInt(zip64EocdOffset), true);
  view.setUint32(at + 16, 1, true);
  at += 20;
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, 0xffff, true);
  view.setUint16(at + 10, 0xffff, true);
  view.setUint32(at + 12, 0xffffffff, true);
  view.setUint32(at + 16, 0xffffffff, true);
  return bytes;
}

describe("account zip reader", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("parses entries in local-header order with their recorded sizes", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n"],
      ["spaces/s1/homes/b1/a.md", "hello"],
    ]);
    await withArchive(bytes, async (handle) => {
      const entries = await parseZipArchive(handle);
      expect(entries.map((entry) => [entry.name, entry.method, entry.uncompressedSize])).toEqual([
        ["manifest.json", 8, 2],
        ["spaces/s1/records.jsonl", 8, 5],
        ["spaces/s1/homes/b1/a.md", 8, 5],
      ]);
      expect(entries.every((entry) => entry.dataDescriptor)).toBe(true);
    });
  });

  it("inflates deflated and stored entries to their exact bytes", async () => {
    const stored = incompressibleBytes(1024);
    const bytes = buildArchive([
      ["deflated.txt", "hello".repeat(1000)],
      ["stored.bin", stored, true],
    ]);
    await withArchive(bytes, async (handle) => {
      expect(Buffer.from(await inflateAll(handle, "deflated.txt")).toString()).toBe(
        "hello".repeat(1000),
      );
      expect(Buffer.from(await inflateAll(handle, "stored.bin"))).toEqual(Buffer.from(stored));
    });
  });

  it("reads a ZIP64 archive", async () => {
    await withArchive(buildZip64Archive(), async (handle) => {
      const entries = await parseZipArchive(handle);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        name: "a.txt",
        method: 0,
        compressedSize: 2,
        uncompressedSize: 2,
        zip64Sizes: true,
      });
      expect(Buffer.from(await inflateAll(handle, "a.txt")).toString()).toBe("hi");
    });
  });

  it("rejects bytes that are not a zip and a truncated zip", async () => {
    const bytes = buildArchive([["manifest.json", "{}"]]);
    await expect(
      withArchive(new TextEncoder().encode("hello"), (handle) => parseZipArchive(handle)),
    ).rejects.toBeInstanceOf(ZipFormatError);
    await expect(
      withArchive(bytes.subarray(0, bytes.byteLength / 2), (handle) => parseZipArchive(handle)),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects an entry whose inflated bytes fail the recorded checksum", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n"],
    ]);
    const entries = await withArchive(bytes, (handle) => parseZipArchive(handle));
    const target = entries[1]!;
    const corrupted = new Uint8Array(bytes);
    corrupted[target.dataOffset] = corrupted[target.dataOffset]! ^ 0xff;
    await expect(
      withArchive(corrupted, (handle) => inflateAll(handle, "spaces/s1/records.jsonl")),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects an entry whose local header disagrees with the central directory", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n"],
    ]);
    const corrupted = new Uint8Array(bytes);
    // The second entry's local header starts at its data offset minus its
    // name length minus 30; flip a byte of the name itself.
    const entries = await withArchive(bytes, (handle) => parseZipArchive(handle));
    const target = entries[1]!;
    corrupted[target.localHeaderOffset + 30] = corrupted[target.localHeaderOffset + 30]! ^ 0xff;
    await expect(
      withArchive(corrupted, (handle) => parseZipArchive(handle)),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects a central directory record whose ZIP64 extra field is truncated", async () => {
    // The field declares two 8-byte values but holds only one; reading the
    // second must fail as a format error, not a RangeError.
    await expect(
      withArchive(buildZip64Archive({ truncateCentralExtra: true }), (handle) =>
        inflateAll(handle, "a.txt"),
      ),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects a local header whose ZIP64 extra field is truncated", async () => {
    await expect(
      withArchive(buildZip64Archive({ truncateLocalExtra: true }), (handle) =>
        inflateAll(handle, "a.txt"),
      ),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects an entry whose recorded size disagrees with its actual data", async () => {
    // "line\n" is 5 bytes; the central directory and descriptor both claim 4,
    // with the checksum over the actual 5 bytes.
    const bytes = buildArchive([["spaces/s1/records.jsonl", "line\n"]]);
    const mutated = await falsifyUncompressedSize(bytes, "spaces/s1/records.jsonl", 4);
    await expect(
      withArchive(mutated, (handle) => inflateAll(handle, "spaces/s1/records.jsonl")),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects a stored entry whose recorded size disagrees with its actual data", async () => {
    const bytes = buildArchive([["spaces/s1/records.jsonl", "line\n", true]]);
    const mutated = await falsifyUncompressedSize(bytes, "spaces/s1/records.jsonl", 4);
    await expect(
      withArchive(mutated, (handle) => inflateAll(handle, "spaces/s1/records.jsonl")),
    ).rejects.toBeInstanceOf(ZipFormatError);
  });

  it("rejects an archive with more entries than the metadata budget allows", async () => {
    // The reader caps archives at 100,000 entries; one more must be refused
    // before every record is accumulated, sorted, and validated.
    const bytes = buildManyEmptyEntries(100_001);
    await expect(withArchive(bytes, (handle) => parseZipArchive(handle))).rejects.toBeInstanceOf(
      ZipFormatError,
    );
  });

  it("accepts an archive at exactly the entry budget", async () => {
    const bytes = buildManyEmptyEntries(100_000);
    await withArchive(bytes, async (handle) => {
      expect(await parseZipArchive(handle)).toHaveLength(100_000);
    });
  });

  it("rejects an archive whose central directory exceeds the metadata budget", async () => {
    // Few entries, but names long enough to push the central directory past
    // its 16 MiB budget.
    const longName = "n".repeat(60_000);
    const entries: [string, Uint8Array][] = Array.from(
      { length: 300 },
      (_, index): [string, Uint8Array] => [`${longName}-${index}`, new Uint8Array(0)],
    );
    const bytes = await buildArchive(entries);
    await expect(withArchive(bytes, (handle) => parseZipArchive(handle))).rejects.toBeInstanceOf(
      ZipFormatError,
    );
  });

  it("drains inflated output between compressed-input reads", async () => {
    // An entry spanning many compressed slices must be flushed in bounded
    // batches, not queued whole in memory.
    const payload = incompressibleBytes(512 * 1024);
    const bytes = buildArchive([["spaces/s1/records.jsonl", payload, false]]);
    let flushCalls = 0;
    let maxPendingBytes = 0;
    await withArchive(bytes, async (handle) => {
      const entries = await parseZipArchive(handle);
      const pending: Uint8Array[] = [];
      await inflateEntry(
        handle,
        entries[0]!,
        (data) => {
          pending.push(data);
        },
        async () => {
          flushCalls += 1;
          maxPendingBytes = Math.max(
            maxPendingBytes,
            pending.reduce((sum, chunk) => sum + chunk.byteLength, 0),
          );
          pending.length = 0;
        },
      );
    });
    expect(flushCalls).toBeGreaterThan(1);
    expect(maxPendingBytes).toBeLessThan(1024 * 1024);
  });
});
