import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { AccountImportDeps, ArchiveEntry, ArchiveSink } from "./account-import.js";
import {
  ACCOUNT_IMPORT_LIMITS,
  AccountImportError,
  importAccount,
  parseEntryName,
  readArchive,
  remapIds,
  SPOOL_PREFIX,
} from "./account-import.js";
import {
  buildArchive,
  chunked,
  incompressibleBytes,
  manifestFor,
} from "./account-import.test-support.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "ada@example.com",
  isDeploymentOwner: false,
};

/** Every rejection here must happen before anything is written. */
const untouched = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`dependency touched: ${String(property)}`);
    },
  },
);
const deps = {
  prisma: untouched,
  sandbox: untouched,
  home: untouched,
  jobs: untouched,
  artifacts: untouched,
  dataDir: "/nonexistent",
  maxArtifactBytes: 1024,
} as unknown as AccountImportDeps;

const importBytes = (bytes: Uint8Array) => importAccount(deps, actor, chunked(bytes));

class RecordingSink implements ArchiveSink {
  readonly files: Array<{ entry: ArchiveEntry; text: string; bytes: Uint8Array }> = [];
  private chunks: Uint8Array[] = [];
  async open(entry: ArchiveEntry) {
    this.files.push({ entry, text: "", bytes: new Uint8Array(0) });
    this.chunks = [];
  }
  async write(chunk: Uint8Array) {
    this.chunks.push(chunk);
  }
  async close() {
    const bytes = Buffer.concat(this.chunks);
    this.files.at(-1)!.text = bytes.toString("utf8");
    this.files.at(-1)!.bytes = bytes;
  }
}

/** A fresh directory for one test's spool files, removed afterwards. */
async function spoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rakazo-account-import-test-"));
}

/** Rewrites an archive's central directory with its records in reverse order. */
function reverseCentralDirectory(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error("fixture has no EOCD");
  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const records: Uint8Array[] = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("fixture central directory");
    const length =
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
    records.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  const rewritten = new Uint8Array(bytes);
  let at = cdOffset;
  for (const record of records.reverse()) {
    rewritten.set(record, at);
    at += record.byteLength;
  }
  return rewritten;
}

/** Flips the recorded checksum of the second central-directory record. */
function corruptCrc(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error("fixture has no EOCD");
  const cdOffset = view.getUint32(eocd + 16, true);
  const firstLength =
    46 +
    view.getUint16(cdOffset + 28, true) +
    view.getUint16(cdOffset + 30, true) +
    view.getUint16(cdOffset + 32, true);
  const second = cdOffset + firstLength;
  if (view.getUint32(second, true) !== 0x02014b50) throw new Error("fixture central directory");
  const rewritten = new Uint8Array(bytes);
  new DataView(rewritten.buffer).setUint32(
    second + 16,
    view.getUint32(second + 16, true) ^ 1,
    true,
  );
  return rewritten;
}

const limits = { ...ACCOUNT_IMPORT_LIMITS, artifactBytes: 1024 };

describe("account import archive", () => {
  it("rejects another format", async () => {
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify({ ...manifestFor([]), format: "other-export" })],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("not a readable Rakazo export");
  });

  it("rejects a newer version", async () => {
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify({ ...manifestFor([]), version: 2 })],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("newer version of Rakazo");
  });

  it("rejects an archive that does not start with the manifest", async () => {
    const bytes = buildArchive([
      ["spaces/s1/records.jsonl", ""],
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name: "Home" }]))],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("not a readable Rakazo export");
  });

  it("rejects bytes that are not a zip, and a truncated zip", async () => {
    await expect(importBytes(new TextEncoder().encode("hello"))).rejects.toThrow(
      "not a readable Rakazo export",
    );
    const name = Array.from({ length: 4000 }, (_, i) => i.toString(36)).join("");
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name }]))],
    ]);
    await expect(importBytes(bytes.subarray(0, bytes.byteLength / 2))).rejects.toThrow(
      "not a readable Rakazo export",
    );
  });

  it.each([
    "spaces/s1/homes/b1/../../../etc/passwd",
    "spaces/s1/homes/b1/./notes.md",
    "/etc/passwd",
    "spaces//records.jsonl",
    "spaces/s1/artifacts/a1/extra",
    "spaces/s1/homes/b1",
    "spaces/s1/homes/b1/dir\\..\\x",
    "other/s1/records.jsonl",
    "manifest.json",
  ])("rejects the entry name %s", (name) => {
    expect(() => parseEntryName(name, 1)).toThrow(AccountImportError);
  });

  it("parses the documented layout", () => {
    expect(parseEntryName("manifest.json", 0)).toEqual({ kind: "manifest" });
    expect(parseEntryName("spaces/s1/records.jsonl", 1)).toEqual({
      kind: "records",
      spaceId: "s1",
    });
    expect(parseEntryName("spaces/s1/artifacts/a1", 2)).toEqual({
      kind: "artifact",
      spaceId: "s1",
      artifactId: "a1",
    });
    expect(parseEntryName("spaces/s1/homes/b1/notes/today.md", 3)).toEqual({
      kind: "home",
      spaceId: "s1",
      botId: "b1",
      path: "notes/today.md",
    });
    expect(parseEntryName("spaces/s1/executables.json", 4)).toEqual({
      kind: "executables",
      spaceId: "s1",
    });
  });

  it("rejects path traversal in an archive before writing anything", async () => {
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name: "Home" }]))],
      ["spaces/s1/homes/b1/../../escape.sh", "echo"],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("unexpected file");
  });

  it("rejects an oversized manifest", async () => {
    const bytes = buildArchive([
      [
        "manifest.json",
        JSON.stringify({ ...manifestFor([]), padding: "x".repeat(2 * 1024 * 1024) }),
      ],
    ]);
    await expect(importBytes(bytes)).rejects.toThrow("too large");
  });

  it("stops an artifact over the artifact limit while inflating", async () => {
    const sink = new RecordingSink();
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", ""],
      ["spaces/s1/artifacts/a1", "x".repeat(1025)],
    ]);
    await expect(readArchive(chunked(bytes), limits, sink)).rejects.toThrow(
      "An artifact in the export exceeds",
    );
    expect(sink.files.at(-1)?.entry.kind).not.toBe("artifact");
  });

  it("stops a workspace file over the home file limit", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/homes/b1/big.bin", new Uint8Array(ACCOUNT_IMPORT_LIMITS.homeFileBytes + 1)],
    ]);
    await expect(
      readArchive(chunked(bytes, 64 * 1024), limits, new RecordingSink()),
    ).rejects.toThrow("A workspace file in the export exceeds");
  });

  it("stops a zip bomb at the unpacked limit", async () => {
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "\n".repeat(4 * 1024 * 1024)],
    ]);
    await expect(
      readArchive(chunked(bytes), { ...limits, unpackedBytes: 1024 * 1024 }, new RecordingSink()),
    ).rejects.toThrow("too large");
  });

  it("imports a nested zip as an opaque home file", async () => {
    const inner = buildArchive([
      ["f0.bin", incompressibleBytes(64 * 1024)],
      ["f1.bin", incompressibleBytes(64 * 1024)],
      ["f2.bin", incompressibleBytes(64 * 1024)],
      ["f3.bin", incompressibleBytes(64 * 1024)],
    ]);
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name: "Home" }]))],
      ["spaces/s1/records.jsonl", ""],
      ["spaces/s1/homes/b1/archive.zip", inner],
    ]);
    const sink = new RecordingSink();
    await readArchive(chunked(bytes), limits, sink);
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["manifest", "records", "home"]);
    expect(sink.files.at(-1)?.bytes).toEqual(inner);
  });

  it("imports a nested zip as an opaque artifact", async () => {
    const inner = buildArchive([
      ["f0.bin", incompressibleBytes(64 * 1024)],
      ["f1.bin", incompressibleBytes(64 * 1024)],
      ["f2.bin", incompressibleBytes(64 * 1024)],
      ["f3.bin", incompressibleBytes(64 * 1024)],
    ]);
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", ""],
      ["spaces/s1/artifacts/a1", inner],
    ]);
    const sink = new RecordingSink();
    await readArchive(chunked(bytes), { ...limits, artifactBytes: 1024 * 1024 }, sink);
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["manifest", "records", "artifact"]);
    expect(sink.files.at(-1)?.bytes).toEqual(inner);
  });

  it("imports a zero-byte nested zip as an opaque home file", async () => {
    const inner = buildArchive([]);
    const bytes = buildArchive([
      ["manifest.json", JSON.stringify(manifestFor([{ id: "s1", name: "Home" }]))],
      ["spaces/s1/records.jsonl", ""],
      ["spaces/s1/homes/b1/empty.zip", inner],
    ]);
    const sink = new RecordingSink();
    await readArchive(chunked(bytes), limits, sink);
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["manifest", "records", "home"]);
    expect(sink.files.at(-1)?.bytes).toEqual(inner);
  });

  it("reads entries in local-header order, not central-directory order", async () => {
    const bytes = reverseCentralDirectory(
      buildArchive([
        ["manifest.json", "{}"],
        ["spaces/s1/records.jsonl", "line\n"],
      ]),
    );
    const sink = new RecordingSink();
    await readArchive(chunked(bytes), limits, sink);
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["manifest", "records"]);
  });

  it("rejects an entry whose bytes do not match its recorded checksum", async () => {
    const bytes = corruptCrc(
      buildArchive([
        ["manifest.json", "{}"],
        ["spaces/s1/records.jsonl", "line\n"],
      ]),
    );
    await expect(readArchive(chunked(bytes), limits, new RecordingSink())).rejects.toThrow(
      "not a readable Rakazo export",
    );
  });

  it("rejects a body over the body limit while spooling", async () => {
    const bytes = buildArchive([["manifest.json", "{}"]]);
    await expect(
      readArchive(chunked(bytes), { ...limits, bodyBytes: 100 }, new RecordingSink()),
    ).rejects.toThrow("too large");
  });

  it("leaves no spooled archive behind, on success or failure", async () => {
    const dir = await spoolDir();
    try {
      const bytes = buildArchive([
        ["manifest.json", "{}"],
        ["spaces/s1/records.jsonl", ""],
      ]);
      await readArchive(chunked(bytes), limits, new RecordingSink(), { spoolDir: dir });
      await expect(
        readArchive(chunked(new TextEncoder().encode("hello")), limits, new RecordingSink(), {
          spoolDir: dir,
        }),
      ).rejects.toThrow("not a readable Rakazo export");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never writes an entry through a file planted at the spill path", async () => {
    const dir = await spoolDir();
    try {
      const victim = join(dir, "victim");
      await writeFile(victim, "keep");
      const bytes = buildArchive([["manifest.json", "{}"]]);
      async function* planting(): AsyncIterable<Uint8Array> {
        yield bytes.subarray(0, 4);
        // The spool exists now: plant a link where its spill will be opened.
        const spool = (await readdir(dir)).find((name) => name.startsWith(SPOOL_PREFIX));
        await symlink(victim, join(dir, `${spool}.entry`));
        yield bytes.subarray(4);
      }
      await expect(
        readArchive(planting(), limits, new RecordingSink(), { spoolDir: dir }),
      ).rejects.toThrow("EEXIST");
      expect(await readFile(victim, "utf8")).toBe("keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes the spool when the upload aborts mid-stream", async () => {
    async function* aborting(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      throw new Error("Synthetic abort");
    }
    const dir = await spoolDir();
    try {
      await expect(
        readArchive(aborting(), limits, new RecordingSink(), { spoolDir: dir }),
      ).rejects.toThrow("Synthetic abort");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("hands every entry to the sink in order, empty ones included", async () => {
    const sink = new RecordingSink();
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", "line\n".repeat(10_000)],
      ["spaces/s1/artifacts/a1", ""],
      ["spaces/s1/homes/b1/a.md", "hello"],
    ]);
    await readArchive(chunked(bytes, 333), limits, sink);
    expect(sink.files.map((file) => [file.entry.kind, file.text.length])).toEqual([
      ["manifest", 2],
      ["records", 50_000],
      ["artifact", 0],
      ["home", 5],
    ]);
  });

  it("imports a large records entry whole, through the spill", async () => {
    // A multi-megabyte records entry inflates into the spill file, so the
    // sink still receives every line in order, byte for byte.
    const lines = "line\n".repeat(400_000);
    const bytes = buildArchive([
      ["manifest.json", "{}"],
      ["spaces/s1/records.jsonl", lines],
    ]);
    const sink = new RecordingSink();
    await readArchive(chunked(bytes), limits, sink);
    expect(sink.files.map((file) => file.entry.kind)).toEqual(["manifest", "records"]);
    expect(sink.files.at(-1)?.text).toBe(lines);
  });
});

describe("remapIds", () => {
  it("replaces exact id strings anywhere in the blocks and nothing else", () => {
    const ids = new Map([
      ["old-artifact", "new-artifact"],
      ["old-bot", "new-bot"],
    ]);
    const blocks = [
      { kind: "text", text: "see old-artifact" },
      { kind: "artifact", artifactId: "old-artifact", meta: { by: ["old-bot", 3, null] } },
    ];
    expect(remapIds(blocks, ids)).toEqual([
      { kind: "text", text: "see old-artifact" },
      { kind: "artifact", artifactId: "new-artifact", meta: { by: ["new-bot", 3, null] } },
    ]);
  });
});
