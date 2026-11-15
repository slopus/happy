import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { PortableFile } from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspaceArchive } from "./workspace-archive.js";
import type { TarEntry } from "./workspace-archive.test-support.js";
import { paxRecord, tarBytes, workspaceArchive } from "./workspace-archive.test-support.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function* chunks(bytes: Uint8Array, size = 997): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

/** Every file with its bytes; a streamed one is read in full and marked. */
async function read(gzipped: Uint8Array): Promise<Array<PortableFile & { streamed?: true }>> {
  const files: Array<PortableFile & { streamed?: true }> = [];
  for await (const file of readWorkspaceArchive(chunks(gzipped))) {
    if (!("body" in file)) {
      files.push(file);
      continue;
    }
    const parts: Uint8Array[] = [];
    for await (const part of file.body) parts.push(part);
    files.push({
      path: file.path,
      content: Uint8Array.from(Buffer.concat(parts)),
      ...(file.executable ? { executable: true } : {}),
      streamed: true,
    });
  }
  return files;
}

function archive(entries: TarEntry[]): Buffer {
  return gzipSync(tarBytes(entries));
}

describe("readWorkspaceArchive", () => {
  it("reads every file a real tar archived, with names and bytes intact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-archive-test-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const binary = Buffer.from(Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256));
    const deep = `${"nested-directory/".repeat(8)}file with a long name.txt`;
    const files: [string, Buffer, boolean][] = [
      ["notes.txt", Buffer.from("hello\n"), false],
      ["bin/tool", Buffer.from("#!/bin/sh\necho hi\n"), true],
      ["data/blob.bin", binary, false],
      ["data/empty", Buffer.alloc(0), false],
      ["with space/and\nnewline.md", Buffer.from("odd"), false],
      ["unicode/café-日本語-🙂.txt", Buffer.from("unicode"), false],
      [deep, Buffer.from("deep"), false],
    ];
    for (const [name, content, executable] of files) {
      const target = path.join(workspace, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      await chmod(target, executable ? 0o755 : 0o644);
    }
    await mkdir(path.join(workspace, "empty-dir"));
    await symlink("/etc/passwd", path.join(workspace, "escape"));
    const output = path.join(root, "workspace.tar.gz");
    execFileSync("tar", ["--format=pax", "-czf", output, "-C", workspace, "."], {
      // macOS tar would otherwise add AppleDouble files for extended attributes.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    const exported = await read(await readFile(output));

    expect(
      exported
        .map((file) => [file.path, Buffer.from(file.content), file.executable ?? false])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual(files.sort(([a], [b]) => a.localeCompare(b)));
  });

  it("reads the archive the Boat fake writes, so adapter tests see real tar framing", async () => {
    const content = Buffer.alloc(3 * 1024 * 1024 + 17, 0xab);
    const exported = await read(
      workspaceArchive([
        ["a/b.bin", { content, executable: true }],
        [`${"x".repeat(150)}.txt`, { content: Buffer.from("long"), executable: false }],
      ]),
    );
    expect(exported.map((file) => [file.path, file.content.byteLength, file.executable])).toEqual([
      ["a/b.bin", content.byteLength, true],
      [`${"x".repeat(150)}.txt`, 4, undefined],
    ]);
    expect(Buffer.from(exported[0]!.content).equals(content)).toBe(true);
  });

  it("streams files too large to hold, in order, and skips what the caller leaves unread", async () => {
    const large = Buffer.alloc(6 * 1024 * 1024, 0x5a);
    large[large.length - 1] = 1;
    const bytes = archive([
      { name: "./first.bin", content: large, mode: 0o755 },
      { name: "./unread.bin", content: large },
      { name: "./small.txt", content: Buffer.from("small") },
    ]);

    const exported = await read(bytes);
    expect(exported.map((file) => [file.path, file.streamed, file.executable])).toEqual([
      ["first.bin", true, true],
      ["unread.bin", true, undefined],
      ["small.txt", undefined, undefined],
    ]);
    expect(Buffer.from(exported[0]!.content).equals(large)).toBe(true);

    const paths: string[] = [];
    let late: AsyncIterable<Uint8Array> | undefined;
    for await (const file of readWorkspaceArchive(chunks(bytes, 64 * 1024))) {
      paths.push(file.path);
      if ("body" in file) late ??= file.body;
      else expect(Buffer.from(file.content).toString()).toBe("small");
    }
    expect(paths).toEqual(["first.bin", "unread.bin", "small.txt"]);
    // A body read after the export moved on would be another file's bytes, so it refuses.
    await expect(
      (async () => {
        for await (const _part of late!) {
          // Nothing is read.
        }
      })(),
    ).rejects.toThrow("read after the next one");
  });

  it("skips directories, symbolic links and devices without following them", async () => {
    const exported = await read(
      archive([
        { name: "./dir/", type: "5" },
        { name: "./link", type: "2" },
        { name: "./fifo", type: "6" },
        { name: "./link/passwd", content: Buffer.from("inside") },
      ]),
    );
    expect(exported).toEqual([
      { path: "link/passwd", content: Uint8Array.from(Buffer.from("inside")) },
    ]);
  });

  it("keeps absolute names inside the workspace", async () => {
    const exported = await read(archive([{ name: "/etc/passwd", content: Buffer.from("x") }]));
    expect(exported.map((file) => file.path)).toEqual(["etc/passwd"]);
  });

  it.each([
    ["a parent segment", [{ name: "./../escape.txt", content: Buffer.from("x") }]],
    ["a nested parent segment", [{ name: "./a/../../escape.txt", content: Buffer.from("x") }]],
    [
      "a parent segment in an extended header",
      [
        { name: "./PaxHeaders/x", type: "x", content: Buffer.from(paxRecord("path", "../x")) },
        { name: "./safe.txt", content: Buffer.from("x") },
      ],
    ],
  ])("refuses a path with %s", async (_, entries) => {
    await expect(read(archive(entries))).rejects.toThrow("Path escapes the computer workspace");
  });

  it("refuses hard links instead of dropping their content", async () => {
    await expect(read(archive([{ name: "./copy", type: "1" }]))).rejects.toThrow("hard link");
  });

  it.each(["L", "S"])("refuses the GNU %s extension", async (type) => {
    await expect(read(archive([{ name: "./x", type, content: Buffer.from("x") }]))).rejects.toThrow(
      "unsupported tar extension",
    );
  });

  it("refuses an archive without its end marker", async () => {
    const bytes = gzipSync(tarBytes([{ name: "./a", content: Buffer.from("a") }], { end: false }));
    await expect(read(bytes)).rejects.toThrow("ended early");
  });

  it("refuses an archive whose last file is cut short", async () => {
    const whole = tarBytes([{ name: "./a", content: Buffer.alloc(4096, 1) }], { end: false });
    await expect(read(gzipSync(whole.subarray(0, 2048)))).rejects.toThrow("ended early");
  });

  it("refuses a gzip stream cut short, even after the files it held", async () => {
    const bytes = archive([{ name: "./a", content: Buffer.from("a") }]);
    await expect(read(bytes.subarray(0, bytes.length - 4))).rejects.toThrow();
  });

  it("refuses a corrupt header", async () => {
    const bytes = tarBytes([{ name: "./a", content: Buffer.from("a") }]);
    bytes[0] = "b".charCodeAt(0);
    await expect(read(gzipSync(bytes))).rejects.toThrow("header is corrupt");
  });

  it("refuses an archive that is not gzipped tar", async () => {
    await expect(read(Buffer.from("not an archive"))).rejects.toThrow();
  });

  it("takes sizes from extended headers and base-256 fields", async () => {
    const content = Buffer.from("twelve bytes");
    const base256 = tarBytes([{ name: "./big", content }]);
    // GNU tar writes sizes too large for octal in base 256.
    base256.fill(0, 124, 136);
    base256[124] = 0x80;
    base256[135] = content.length;
    base256.write("        ", 148, "latin1");
    let sum = 0;
    for (const byte of base256.subarray(0, 512)) sum += byte;
    base256.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");

    expect((await read(gzipSync(base256)))[0]?.content.byteLength).toBe(content.length);

    const extended = await read(
      archive([
        { name: "./PaxHeaders/x", type: "x", content: Buffer.from(paxRecord("size", "5")) },
        { name: "./five", content: Buffer.from("12345"), size: 0 },
      ]),
    );
    expect(Buffer.from(extended[0]!.content).toString()).toBe("12345");
  });

  it("refuses data hidden after the end marker", async () => {
    const tar = tarBytes([{ name: "./a", content: Buffer.from("a") }]);
    const bytes = gzipSync(Buffer.concat([tar, Buffer.alloc(2 * 1024 * 1024)]));
    await expect(read(bytes)).rejects.toThrow("data after its end");
  });

  it("never decompresses past the save limits, even for entries it skips", async () => {
    const limits = { maxBytes: 1024, maxFiles: 1 };
    const within = archive([{ name: "./a", content: Buffer.alloc(1024, 1) }]);
    const files = [];
    for await (const file of readWorkspaceArchive(chunks(within), limits)) files.push(file);
    expect(files).toHaveLength(1);

    const skipped = archive([
      { name: "./link", type: "2", content: Buffer.alloc(4 * 1024 * 1024) },
    ]);
    const error = await (async () => {
      for await (const _file of readWorkspaceArchive(chunks(skipped), limits)) {
        // Nothing is a file.
      }
    })().catch((failure: unknown) => failure);
    expect(error).toEqual(new WorkspaceTooLargeError("bytes"));
  });

  it("stops reading the download when the caller stops early", async () => {
    let cancelled = false;
    const bytes = archive([
      { name: "./a", content: Buffer.from("a") },
      { name: "./b", content: Buffer.from("b") },
    ]);
    async function* source() {
      try {
        yield* chunks(bytes, 64);
      } finally {
        cancelled = true;
      }
    }
    for await (const _file of readWorkspaceArchive(source())) break;
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });
});
