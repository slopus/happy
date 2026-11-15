import type { ObjectStorage } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";

/** An in-memory bucket; `objects` is exposed so tests can tamper with stored bytes. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Buffer; lastModified: Date }>();

  async put(key: string, body: AsyncIterable<Uint8Array>) {
    const parts: Buffer[] = [];
    for await (const chunk of body) parts.push(Buffer.from(chunk));
    this.objects.set(key, { bytes: Buffer.concat(parts), lastModified: new Date() });
  }

  async *get(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error(`No object ${key}`);
    // Small chunks, so readers cannot rely on getting a whole object at once.
    for (let offset = 0; offset < object.bytes.length; offset += 1000)
      yield object.bytes.subarray(offset, offset + 1000);
  }

  async *list(prefix: string) {
    for (const [key, object] of [...this.objects].sort(([a], [b]) => a.localeCompare(b)))
      if (key.startsWith(prefix)) yield { key, lastModified: object.lastModified };
  }

  async delete(keys: readonly string[]) {
    for (const key of keys) this.objects.delete(key);
  }
}

async function* chunks(...parts: Buffer[]) {
  yield* parts;
}

async function read(storage: ObjectStorage, key: string) {
  const parts: Buffer[] = [];
  for await (const chunk of storage.get(key)) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

async function keys(storage: ObjectStorage, prefix: string) {
  const listed: string[] = [];
  for await (const object of storage.list(prefix)) listed.push(object.key);
  return listed.sort();
}

/** What every ObjectStorage must do; run against each implementation. */
export function objectStorageConformance(create: () => Promise<ObjectStorage>) {
  it("stores, lists and deletes objects", async () => {
    const storage = await create();
    await storage.put("homes/a/1", chunks(Buffer.from("first "), Buffer.from("object")));
    await storage.put("homes/a/2", chunks(Buffer.alloc(0)));
    await storage.put("other/b", chunks(Buffer.from("x")));

    expect((await read(storage, "homes/a/1")).toString()).toBe("first object");
    expect((await read(storage, "homes/a/2")).length).toBe(0);
    expect(await keys(storage, "homes/")).toEqual(["homes/a/1", "homes/a/2"]);

    await storage.delete(["homes/a/1", "homes/missing"]);
    expect(await keys(storage, "homes/")).toEqual(["homes/a/2"]);
    await expect(read(storage, "homes/a/1")).rejects.toThrow();
  });

  it("replaces an object written again under the same key", async () => {
    const storage = await create();
    await storage.put("k", chunks(Buffer.from("old")));
    await storage.put("k", chunks(Buffer.from("new")));
    expect((await read(storage, "k")).toString()).toBe("new");
  });

  it("streams objects larger than one upload part", async () => {
    const storage = await create();
    const block = Buffer.alloc(1024 * 1024, 7);
    const blocks = Array.from({ length: 17 }, (_, index) =>
      Buffer.concat([Buffer.from([index]), block.subarray(1)]),
    );
    await storage.put("big", chunks(...blocks));
    expect((await read(storage, "big")).equals(Buffer.concat(blocks))).toBe(true);
  });
}
