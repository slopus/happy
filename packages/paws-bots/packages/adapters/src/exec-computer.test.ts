import { describe, expect, it, vi } from "vitest";
import { encodeTarEntry, TarReader } from "./exec-computer.js";

describe("workspace archive packets", () => {
  it("reads a large file without repeatedly copying its accumulated bytes", () => {
    const content = Buffer.alloc(8 * 1024 * 1024, 173);
    const archive = Buffer.concat([
      ...encodeTarEntry("large.bin", content, false),
      ...encodeTarEntry("next.txt", Buffer.from("next"), true),
      Buffer.alloc(1024),
    ]);
    const concat = Buffer.concat;
    let copiedBytes = 0;
    const spy = vi.spyOn(Buffer, "concat").mockImplementation((chunks, length) => {
      copiedBytes += chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      return concat(chunks, length);
    });
    try {
      const reader = new TarReader(content.length);
      const files = [];
      for (let offset = 0; offset < archive.length; offset += 16381) {
        files.push(...reader.push(archive.subarray(offset, offset + 16381)));
      }
      reader.finish();
      expect(files.map((file) => file.path)).toEqual(["large.bin", "next.txt"]);
      expect(Buffer.compare(Buffer.from(files[0]!.content), content)).toBe(0);
      expect(Buffer.from(files[1]!.content).toString()).toBe("next");
      expect(files[1]!.executable).toBe(true);
      expect(copiedBytes).toBeLessThanOrEqual(archive.length * 2);
    } finally {
      spy.mockRestore();
    }
  });

  it("handles split headers, long paths, empty files and padding", () => {
    const name = `${"directory/".repeat(15)}file.txt`;
    const archive = Buffer.concat([
      ...encodeTarEntry("empty", Buffer.alloc(0), false),
      ...encodeTarEntry(name, Buffer.from("abc"), false),
      Buffer.alloc(1024),
    ]);
    const reader = new TarReader(10);
    const files = [];
    for (const byte of archive) files.push(...reader.push(Buffer.from([byte])));
    reader.finish();
    expect(files.map((file) => file.path)).toEqual(["empty", name]);
    expect(files[0]!.content.length).toBe(0);
    expect(Buffer.from(files[1]!.content).toString()).toBe("abc");
  });

  it("rejects truncated bodies and oversized files", () => {
    const archive = Buffer.concat([...encodeTarEntry("file", Buffer.from("abc"), false)]);
    const reader = new TarReader(3);
    reader.push(archive.subarray(0, 513));
    expect(() => reader.finish()).toThrow("ended inside a file");
    expect(() => new TarReader(2).push(archive)).toThrow("exceeds");
  });
});
