import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { DataKey, PrismaClient } from "@rakazo/db";
import { isSealedArtifact } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArtifactStore,
  DeploymentArtifactStore,
  ObjectArtifactStore,
} from "./artifact-store-factory.js";
import type { ArtifactKeys } from "./artifacts.js";
import { LocalArtifactStore } from "./artifacts.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const context = (spaceId = "space-1"): AdapterContext => ({
  spaceId,
  userId: "user-1",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
});
const artifact = (bytes = Buffer.from("private artifact")) => ({
  bytes,
  name: "file.bin",
  mimeType: "application/octet-stream",
});
function setup(encryptWrites = true) {
  const rows = new Map<string, DataKey>();
  const keys: ArtifactKeys = {
    encryptWrites,
    async current(spaceId) {
      const key = { id: `key-${spaceId}`, spaceId, version: 1, key: randomBytes(32) };
      if (!rows.has(key.id)) rows.set(key.id, key);
      return rows.get(key.id)!;
    },
    async byId(id) {
      const key = rows.get(id);
      if (!key) throw new Error("Unknown key");
      return key;
    },
  };
  const storage = new MemoryObjectStorage();
  return { keys, storage, store: new ObjectArtifactStore(storage, keys) };
}

describe("object artifacts", () => {
  it.each([0, 20, 200_000])("encrypts and reads %i bytes through another replica", async (size) => {
    const { store, keys, storage } = setup(false);
    const bytes = Buffer.alloc(size, 65);
    const saved = await store.put(artifact(bytes), context());
    const object = [...storage.objects.values()][0]!.bytes;
    expect(isSealedArtifact(object)).toBe(true);
    if (size) expect(object.includes(bytes)).toBe(false);
    const replica = new ObjectArtifactStore(storage, keys);
    expect(await replica.get(saved.id, context())).toEqual(new Uint8Array(bytes));
    await replica.remove(saved.id, context());
    expect(storage.objects.size).toBe(0);
    await replica.remove(saved.id, context());
  });

  it("rejects tampering, truncation and ciphertext copied to another artifact or space", async () => {
    const { store, keys, storage } = setup();
    const a = await store.put(artifact(Buffer.alloc(150_000, 65)), context());
    const b = await store.put(artifact(), context());
    const entries = [...storage.objects.entries()];
    const [aKey, aObject] = entries[0]!;
    const [bKey] = entries[1]!;
    const original = Buffer.from(aObject.bytes);
    aObject.bytes[aObject.bytes.length - 1] = aObject.bytes[aObject.bytes.length - 1]! ^ 1;
    await expect(store.get(a.id, context())).rejects.toThrow();
    aObject.bytes = original.subarray(0, original.length - 1);
    await expect(store.get(a.id, context())).rejects.toThrow();
    storage.objects.set(bKey, { ...aObject, bytes: original });
    await expect(store.get(b.id, context())).rejects.toThrow();
    await keys.current("space-2");
    storage.objects.set(aKey.replace("space-1", "space-2"), { ...aObject, bytes: original });
    await expect(store.get(a.id, context("space-2"))).rejects.toThrow();
  });

  it("keeps legacy local artifacts readable and writes new ones to object storage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "artifact-routing-"));
    dirs.push(root);
    const local = new LocalArtifactStore(root);
    const old = await local.put(artifact(), context());
    const { store: remote, storage } = setup();
    const routed = new DeploymentArtifactStore(local, remote);
    expect(await routed.get(old.id, context())).toEqual(new Uint8Array(artifact().bytes));
    const saved = await routed.put(artifact(), context());
    expect(saved.id).toMatch(/^object:/);
    expect(storage.objects.size).toBe(1);
    // Taking away the bucket must fail explicitly, never silently read another backend.
    await expect(new DeploymentArtifactStore(local).get(saved.id, context())).rejects.toThrow(
      "object storage",
    );
    await routed.remove(old.id, context());
    await expect(local.get(old.id, context())).rejects.toThrow();
  });

  it("keeps local storage optional and refuses unencrypted object storage", () => {
    const db = {} as PrismaClient;
    expect(createArtifactStore("unused", db, {}).describe().id).toBe("local-artifacts");
    expect(() =>
      createArtifactStore("unused", db, {
        OBJECT_STORAGE_BUCKET: "fixture",
        OBJECT_STORAGE_ACCESS_KEY_ID: "fixture",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "fixture",
      }),
    ).toThrow("content encryption keys");
  });
});
