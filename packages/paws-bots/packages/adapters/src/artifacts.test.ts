import { randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { ContentKeyRing, LocalKeyProvider } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "./artifacts.js";

const dirs: string[] = [];
const context = { spaceId: "space-1" } as never;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LocalArtifactStore", () => {
  it("creates artifact files with owner-only permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);

    const stored = await store.put(
      { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
      context,
    );

    const info = await stat(path.join(root, "artifacts", "space-1", stored.id));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("does not follow a replacement symlink when reading an artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const store = new LocalArtifactStore(root);
    const stored = await store.put(
      { name: "private.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("private") },
      context,
    );
    const file = path.join(root, "artifacts", "space-1", stored.id);
    const target = path.join(root, "outside.txt");
    await writeFile(target, "outside");
    await rm(file);
    await symlink(target, file);

    await expect(store.get(stored.id, context)).rejects.toThrow();
  });
});

/** A key ring over in-memory keys; `withWrites` gives another ring over the same keys. */
function memoryKeys() {
  const rows: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => rows.filter((row) => row.spaceId === spaceId),
    byId: async (id) => rows.find((row) => row.id === id),
    insert: async (record) => {
      rows.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  const provider = new LocalKeyProvider([{ id: "a", key: randomBytes(32) }]);
  return Object.assign(new ContentKeyRing(provider, store), {
    withWrites: (encryptWrites: boolean) => new ContentKeyRing(provider, store, { encryptWrites }),
  });
}

describe("LocalArtifactStore with encryption off", () => {
  it("writes plaintext and still reads files sealed while encryption was on", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const on = memoryKeys();
    const off = on.withWrites(false);
    const sealedBytes = new TextEncoder().encode("sealed while on");
    const sealed = await new LocalArtifactStore(root, on).put(
      { name: "on.txt", mimeType: "text/plain", bytes: sealedBytes },
      context,
    );
    const store = new LocalArtifactStore(root, off);
    const plain = await store.put(
      {
        name: "off.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("plain while off"),
      },
      context,
    );
    expect(await readFile(path.join(root, "artifacts", "space-1", plain.id), "utf8")).toBe(
      "plain while off",
    );
    expect(new TextDecoder().decode(await store.get(sealed.id, context))).toBe("sealed while on");
    expect(await store.fileCounts()).toMatchObject({ sealed: 1, plaintext: 1 });

    // Switching back on seals new files and the migration seals the rest.
    const again = new LocalArtifactStore(root, on);
    expect(await again.rewriteFile("space-1", plain.id, "encrypt")).toBe("rewritten");
    expect(await again.fileCounts()).toMatchObject({ sealed: 2, plaintext: 0 });
    expect(new TextDecoder().decode(await again.get(plain.id, context))).toBe("plain while off");
  });
});

describe("LocalArtifactStore with content keys", () => {
  async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-artifacts-"));
    dirs.push(root);
    const keys = memoryKeys();
    return { root, keys, store: new LocalArtifactStore(root, keys) };
  }

  it("stores ciphertext on disk and returns the original bytes", async () => {
    const { root, store } = await setup();
    const bytes = new Uint8Array(randomBytes(150_000));
    const stored = await store.put(
      { name: "a.bin", mimeType: "application/octet-stream", bytes },
      context,
    );
    const onDisk = await readFile(path.join(root, "artifacts", "space-1", stored.id));
    expect(onDisk.includes(Buffer.from(bytes.subarray(0, 64)))).toBe(false);
    expect(stored.hash).toBe(String(bytes.byteLength));
    expect(Buffer.from(await store.get(stored.id, context)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("reads legacy plaintext files and rewrites them in place", async () => {
    const { root, keys, store } = await setup();
    const legacy = await new LocalArtifactStore(root).put(
      {
        name: "old.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("before encryption"),
      },
      context,
    );
    const file = path.join(root, "artifacts", "space-1", legacy.id);
    const read = async () => new TextDecoder().decode(await store.get(legacy.id, context));
    expect(await read()).toBe("before encryption");
    const files = [];
    for await (const entry of store.files()) files.push(entry);
    expect(files).toEqual([{ spaceId: "space-1", id: legacy.id }]);

    expect(await store.fileCounts()).toEqual({
      present: true,
      sealed: 0,
      plaintext: 1,
      abandoned: 0,
    });
    expect(await store.rewriteFile("space-1", legacy.id, "encrypt")).toBe("rewritten");
    expect(await store.rewriteFile("space-1", legacy.id, "encrypt")).toBe("unchanged");
    expect(await store.fileCounts()).toEqual({
      present: true,
      sealed: 1,
      plaintext: 0,
      abandoned: 0,
    });
    expect(await new LocalArtifactStore(path.join(root, "missing"), keys).fileCounts()).toEqual({
      present: false,
      sealed: 0,
      plaintext: 0,
      abandoned: 0,
    });
    expect((await readFile(file)).toString()).not.toContain("before encryption");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await read()).toBe("before encryption");

    await keys.rotate("space-1");
    expect(await store.rewriteFile("space-1", legacy.id, "encrypt")).toBe("unchanged");
    expect(await store.rewriteFile("space-1", legacy.id, "reencrypt")).toBe("rewritten");
    expect(await read()).toBe("before encryption");

    expect(await store.rewriteFile("space-1", legacy.id, "decrypt")).toBe("rewritten");
    expect((await readFile(file)).toString()).toBe("before encryption");
  });

  it("counts and removes temporary files an interrupted rewrite left behind", async () => {
    const { root, store } = await setup();
    const dir = path.join(root, "artifacts", "space-1");
    await mkdir(dir, { recursive: true });
    const leftover = path.join(dir, "file-1.sealing-abc");
    await writeFile(leftover, "plaintext from an interrupted decrypt");
    expect(await store.fileCounts()).toMatchObject({ plaintext: 0, abandoned: 1 });
    expect(await store.removeAbandoned()).toBe(0);
    expect(await store.removeAbandoned(0)).toBe(1);
    expect(await store.fileCounts()).toMatchObject({ abandoned: 0 });
  });

  it("treats a file removed since it was listed as unchanged", async () => {
    const { store } = await setup();
    expect(await store.rewriteFile("space-1", "already-deleted", "encrypt")).toBe("unchanged");
  });

  it("refuses a sealed file copied into another space", async () => {
    const { root, store } = await setup();
    const stored = await store.put(
      { name: "a.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("space one") },
      context,
    );
    await mkdir(path.join(root, "artifacts", "space-2"), { recursive: true });
    await copyFile(
      path.join(root, "artifacts", "space-1", stored.id),
      path.join(root, "artifacts", "space-2", stored.id),
    );
    await expect(store.get(stored.id, { spaceId: "space-2" } as never)).rejects.toThrow(
      /another space/,
    );
  });

  it("refuses to serve a sealed file without keys or with a tampered body", async () => {
    const { root, store } = await setup();
    const stored = await store.put(
      { name: "a.txt", mimeType: "text/plain", bytes: new TextEncoder().encode("sealed") },
      context,
    );
    await expect(new LocalArtifactStore(root).get(stored.id, context)).rejects.toThrow(/encrypted/);
    const file = path.join(root, "artifacts", "space-1", stored.id);
    const sealed = await readFile(file);
    sealed[sealed.length - 1]! ^= 1;
    await writeFile(file, sealed);
    await expect(store.get(stored.id, context)).rejects.toThrow(/authentication/);
  });
});
