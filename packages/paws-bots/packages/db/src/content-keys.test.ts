import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SpaceKeyRecord, SpaceKeyStore } from "./content-keys.js";
import {
  ContentKeyRing,
  DERIVED_MASTER_KEY_ID,
  LocalKeyProvider,
  masterKeysFromEnv,
} from "./content-keys.js";

function memoryStore() {
  const rows: SpaceKeyRecord[] = [];
  let lookups = 0;
  const store: SpaceKeyStore & { rows: SpaceKeyRecord[]; lookups: () => number } = {
    rows,
    lookups: () => lookups,
    async forSpace(spaceId) {
      lookups += 1;
      return rows.filter((row) => row.spaceId === spaceId).sort((a, b) => a.version - b.version);
    },
    async byId(id) {
      return rows.find((row) => row.id === id);
    },
    async insert(record) {
      const existing = rows.find(
        (row) => row.spaceId === record.spaceId && row.version === record.version,
      );
      if (existing) return existing;
      rows.push(record);
      return record;
    },
    async sampleByMasterKey() {
      return [...new Map(rows.map((row) => [row.masterKeyId, row])).values()];
    },
    async rowContext(_source, id) {
      return id.startsWith("thread-") ? { spaceId: "space-1", owner: "user-1" } : undefined;
    },
  };
  return store;
}

const master = (id: string) => ({ id, key: randomBytes(32) });

describe("masterKeysFromEnv", () => {
  it("derives a key from ENCRYPTION_KEY when no master keys are set", () => {
    const keys = masterKeysFromEnv({ ENCRYPTION_KEY: "a".repeat(40), NODE_ENV: "production" });
    expect(keys.map((key) => key.id)).toEqual([DERIVED_MASTER_KEY_ID]);
    expect(
      masterKeysFromEnv({ ENCRYPTION_KEY: "a".repeat(40), NODE_ENV: "production" })[0]!.key,
    ).toEqual(keys[0]!.key);
  });

  it("puts configured keys first and keeps the derived key for unwrap", () => {
    const hex = randomBytes(32).toString("hex");
    const base64 = randomBytes(32).toString("base64");
    const keys = masterKeysFromEnv({
      ENCRYPTION_KEY: "a".repeat(40),
      NODE_ENV: "production",
      ENCRYPTION_MASTER_KEYS: `k2:${hex}, k1:${base64}`,
    });
    expect(keys.map((key) => key.id)).toEqual(["k2", "k1", DERIVED_MASTER_KEY_ID]);
    expect(Buffer.from(keys[0]!.key).toString("hex")).toBe(hex);
  });

  it("rejects malformed, short, duplicate and reserved keys", () => {
    const env = (value: string) => ({
      ENCRYPTION_KEY: "a".repeat(40),
      ENCRYPTION_MASTER_KEYS: value,
    });
    const valid = randomBytes(32).toString("hex");
    expect(() => masterKeysFromEnv(env("nocolon"))).toThrow();
    expect(() => masterKeysFromEnv(env(`k1:${randomBytes(16).toString("hex")}`))).toThrow();
    expect(() => masterKeysFromEnv(env(`k1:${valid},k1:${valid}`))).toThrow();
    expect(() => masterKeysFromEnv(env(`env:${valid}`))).toThrow();
    expect(() => masterKeysFromEnv(env(`bad id:${valid}`))).toThrow();
  });
});

describe("LocalKeyProvider", () => {
  it("wraps under the active key and unwraps under any configured key", async () => {
    const [a, b] = [master("a"), master("b")];
    const context = { spaceId: "space-1", version: 1 };
    const dataKey = randomBytes(32);
    const wrapped = await new LocalKeyProvider([a]).wrap(dataKey, context);
    expect(wrapped.masterKeyId).toBe("a");
    const rotated = new LocalKeyProvider([b, a]);
    expect(Buffer.from(await rotated.unwrap(wrapped, context))).toEqual(dataKey);
    expect((await rotated.wrap(dataKey, context)).masterKeyId).toBe("b");
    await expect(new LocalKeyProvider([b]).unwrap(wrapped, context)).rejects.toThrow(
      /not configured/,
    );
  });

  it("binds the wrap to its space and version", async () => {
    const provider = new LocalKeyProvider([master("a")]);
    const wrapped = await provider.wrap(randomBytes(32), { spaceId: "space-1", version: 1 });
    await expect(provider.unwrap(wrapped, { spaceId: "space-2", version: 1 })).rejects.toThrow();
    await expect(provider.unwrap(wrapped, { spaceId: "space-1", version: 2 })).rejects.toThrow();
  });
});

describe("ContentKeyRing", () => {
  it("creates one key per space on first use, even under concurrency, and caches it", async () => {
    const store = memoryStore();
    const ring = new ContentKeyRing(new LocalKeyProvider([master("a")]), store);
    const [first, second] = await Promise.all([ring.current("space-1"), ring.current("space-1")]);
    expect(first.id).toBe(second.id);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.wrappedKey).not.toContain(Buffer.from(first.key).toString("base64url"));
    const lookups = store.lookups();
    await ring.current("space-1");
    expect(store.lookups()).toBe(lookups);
    const fresh = new ContentKeyRing(new LocalKeyProvider([master("b")]), store);
    await expect(fresh.byId(first.id)).rejects.toThrow(/not configured/);
  });

  it("rotates to a new current version while older versions still resolve", async () => {
    const store = memoryStore();
    const provider = new LocalKeyProvider([master("a")]);
    const ring = new ContentKeyRing(provider, store);
    const v1 = await ring.current("space-1");
    const v2 = await ring.rotate("space-1");
    expect(v2.version).toBe(2);
    expect((await ring.current("space-1")).id).toBe(v2.id);
    expect((await ring.all("space-1")).map((key) => key.version)).toEqual([1, 2]);
    const other = new ContentKeyRing(provider, store);
    expect(Buffer.from((await other.byId(v1.id)).key)).toEqual(Buffer.from(v1.key));
  });

  it.each(["current", "rotate"] as const)(
    "stores no key from a %s call whose signal aborted while the key manager was wrapping",
    async (call) => {
      const store = memoryStore();
      const provider = new LocalKeyProvider([master("a")]);
      const ring = new ContentKeyRing(provider, store);
      if (call === "rotate") await ring.current("space-1");
      const before = store.rows.length;
      const controller = new AbortController();
      // The key manager answers only once the command has given up.
      const wrap = provider.wrap.bind(provider);
      provider.wrap = async (key, context) => {
        controller.abort(new Error("interrupted"));
        return wrap(key, context);
      };
      await expect(ring[call]("space-1", controller.signal)).rejects.toThrow("interrupted");
      expect(store.rows).toHaveLength(before);
      // A later run, or one that is not interrupted, still gets the key.
      expect((await ring[call]("space-1")).version).toBe(before + 1);
      expect(store.rows).toHaveLength(before + 1);
    },
  );

  it("resolves row spaces from its cache or the store and forgets deleted spaces", async () => {
    const ring = new ContentKeyRing(new LocalKeyProvider([master("a")]), memoryStore());
    await expect(ring.spaceOf("threads", "thread-1")).resolves.toBe("space-1");
    await expect(ring.spaceOf("threads", "other")).rejects.toThrow(/Cannot resolve/);
    ring.remember("threads", "other", { spaceId: "space-2", owner: "user-2" });
    await expect(ring.rowContext("threads", "other")).resolves.toEqual({
      spaceId: "space-2",
      owner: "user-2",
    });
    await expect(ring.spaceOf("threads", "other")).resolves.toBe("space-2");
    ring.forget("space-2");
    await expect(ring.spaceOf("threads", "other")).rejects.toThrow(/Cannot resolve/);
  });

  it("reports master keys that stored space keys need but cannot use", async () => {
    const store = memoryStore();
    const a = master("a");
    await new ContentKeyRing(new LocalKeyProvider([a]), store).current("space-1");
    const b = master("b");
    await new ContentKeyRing(new LocalKeyProvider([b]), store).current("space-2");
    expect(
      await new ContentKeyRing(new LocalKeyProvider([b, a]), store).unreadableMasterKeys(),
    ).toEqual([]);
    expect(
      await new ContentKeyRing(new LocalKeyProvider([b]), store).unreadableMasterKeys(),
    ).toEqual(["a"]);
  });

  it("fails closed when a key no longer exists", async () => {
    const ring = new ContentKeyRing(new LocalKeyProvider([master("a")]), memoryStore());
    await expect(ring.byId("missing")).rejects.toThrow(/no longer exists/);
  });
});
