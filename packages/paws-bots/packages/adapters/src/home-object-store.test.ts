import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PortableFile, SandboxProvider, StreamedPortableFile } from "@rakazo/adapter-kit";
import { WorkspaceTooLargeError } from "@rakazo/adapter-kit";
import type { PrismaClient, SpaceKeyRecord, SpaceKeyStore } from "@rakazo/db";
import { ContentDecryptionError, ContentKeyRing, LocalKeyProvider } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointComputerWorkspace, restoreComputerWorkspace } from "./computer-workspace.js";
import { LocalAgentHomeStore } from "./home.js";
import {
  createAgentHomeStore,
  HomeSaveConflictError,
  ObjectAgentHomeStore,
  PrismaAgentHomeRecords,
} from "./home-object-store.js";
import { MemoryObjectStorage } from "./object-storage.test-support.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
};
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ComputerRow {
  id: string;
  spaceId: string;
  homeKey: string;
  homeStorageId: string | null;
  homeStorageKey: string | null;
  homeStorageRevision: string | null;
  kind: string;
  updatedAt: Date;
}

/** The slice of `prisma.computer` the records use, over an array of rows. */
function fakeComputers(rows: ComputerRow[]) {
  const matches = (row: ComputerRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => {
      const actual = row[field as keyof ComputerRow];
      if (value instanceof Date)
        return actual instanceof Date && actual.getTime() === value.getTime();
      if (value && typeof value === "object" && "in" in value)
        return (value.in as unknown[]).includes(actual);
      return actual === value;
    });
  const pick = (row: ComputerRow, select: Record<string, boolean>) =>
    Object.fromEntries(
      Object.keys(select).map((field) => [field, row[field as keyof ComputerRow]]),
    );
  return {
    computer: {
      findUnique: async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }) => {
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? pick(row, select) : null;
      },
      findMany: async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select: Record<string, boolean>;
      }) => rows.filter((row) => matches(row, where)).map((row) => pick(row, select)),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<ComputerRow>;
      }) => {
        const updated = rows.filter((row) => matches(row, where));
        // Like Prisma's @updatedAt: bumped on every write that doesn't set it.
        for (const row of updated) Object.assign(row, { updatedAt: new Date() }, data);
        return { count: updated.length };
      },
    },
  } as unknown as Pick<PrismaClient, "computer">;
}

function memoryRing() {
  const keys: SpaceKeyRecord[] = [];
  const store: SpaceKeyStore = {
    forSpace: async (spaceId) => keys.filter((row) => row.spaceId === spaceId),
    byId: async (id) => keys.find((row) => row.id === id),
    insert: async (record) => {
      keys.push(record);
      return record;
    },
    rowContext: async () => undefined,
    sampleByMasterKey: async () => [],
  };
  return new ContentKeyRing(new LocalKeyProvider([{ id: "k1", key: randomBytes(32) }]), store);
}

async function setup(homeKeys = ["bot-1"]) {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-object-homes-"));
  dirs.push(root);
  const rows: ComputerRow[] = homeKeys.map((homeKey, index) => ({
    id: `computer-${index + 1}`,
    spaceId: "space-1",
    homeKey,
    homeStorageId: null,
    homeStorageKey: null,
    homeStorageRevision: null,
    kind: "boat",
    updatedAt: new Date(0),
  }));
  const storage = new MemoryObjectStorage();
  const records = new PrismaAgentHomeRecords(fakeComputers(rows), memoryRing());
  const store = new ObjectAgentHomeStore(root, storage, records);
  /** Another API or worker host: same bucket and database, its own empty cache. */
  const otherHost = async () => {
    const otherRoot = await mkdtemp(path.join(tmpdir(), "rakazo-object-homes-"));
    dirs.push(otherRoot);
    return new ObjectAgentHomeStore(otherRoot, storage, records);
  };
  return { root, rows, storage, records, store, otherHost };
}

/** A sandbox export staged for `commit`. */
async function staged(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), "rakazo-object-staging-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

async function exported(store: LocalAgentHomeStore, homeKey: string) {
  const files: Record<string, string> = {};
  for await (const file of store.exportHome(homeKey, context))
    files[file.path] = Buffer.from(file.content).toString("utf8");
  return files;
}

describe("ObjectAgentHomeStore", () => {
  it("stores each revision as one encrypted object under an opaque key", async () => {
    const { store, storage, rows } = await setup(["bot-named-ada"]);
    const revision = await store.commit(
      "bot-named-ada",
      await staged({
        ".browser-profiles/default/Cookies": "session=very-secret-cookie",
        "notes/todo.txt": "write the report",
      }),
      context,
    );

    expect(storage.objects.size).toBe(1);
    const [key, object] = [...storage.objects][0]!;
    expect(key).toBe(`homes/${rows[0]!.homeStorageId}/${revision}`);
    expect(key).not.toContain("bot-named-ada");
    expect(key).not.toContain("space-1");
    expect(object!.bytes.includes(Buffer.from("very-secret-cookie"))).toBe(false);
    expect(object!.bytes.includes(Buffer.from("todo.txt"))).toBe(false);
    expect(rows[0]!.homeStorageRevision).toBe(revision);
    expect(rows[0]!.homeStorageKey).toMatch(/^rkz1:/);
  });

  it("excludes rebuildable content from a mounted Docker home without deleting it", async () => {
    const { store, otherHost } = await setup();
    const durable = {
      "packages/core/notes.txt": "keep",
      ".browser-profiles/chromium/Default/Cookies": "session",
    };
    const excluded = {
      "project/node_modules/pkg/index.js": "dependency",
      ".cache/uv/data": "cache",
      ".yarn/cache/pkg": "cache",
      "run.log": "log",
      "core.123": "dump",
    };
    for (const [filePath, content] of Object.entries({ ...durable, ...excluded })) {
      await store.writeFile("bot-1", filePath, content, context);
    }
    await store.revise("bot-1");
    for (const [filePath, content] of Object.entries(excluded)) {
      expect(await store.readFile("bot-1", filePath, context)).toBe(content);
    }
    const restored = await otherHost();
    await restored.hydrate("bot-1");
    expect(await exported(restored, "bot-1")).toEqual(durable);
    for (const filePath of Object.keys(excluded)) {
      await expect(readFile(path.join(restored.pathFor("bot-1"), filePath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("saves without moving the computer's updatedAt, which lifecycle claims fence on", async () => {
    const { store, rows } = await setup();
    const claimedAt = new Date("2026-01-01T00:00:00Z");
    rows[0]!.updatedAt = claimedAt;

    await store.commit("bot-1", await staged({ "a.txt": "one" }), context);
    await store.commit("bot-1", await staged({ "a.txt": "two" }), context);

    expect(rows[0]!.homeStorageRevision).not.toBeNull();
    expect(rows[0]!.updatedAt.getTime()).toBe(claimedAt.getTime());
  });

  it("retries a save when a lifecycle claim lands between its read and write", async () => {
    const { rows } = await setup();
    const claimedAt = new Date("2026-01-01T00:00:00Z");
    const computers = fakeComputers(rows);
    const updateMany = computers.computer.updateMany;
    let claims = 0;
    computers.computer.updateMany = ((args: { where: { updatedAt?: Date } }) => {
      if (args.where.updatedAt && claims < 2) {
        claims += 1;
        rows[0]!.updatedAt = new Date(claimedAt.getTime() + claims);
      }
      return updateMany(args as Parameters<typeof updateMany>[0]);
    }) as unknown as typeof updateMany;
    const records = new PrismaAgentHomeRecords(computers, memoryRing());

    const stored = await records.create("bot-1");
    expect(await records.advance("bot-1", stored!.storageId, null, "rev-1")).toBe(true);

    expect(claims).toBe(2);
    expect(rows[0]!.homeStorageRevision).toBe("rev-1");
    expect(rows[0]!.updatedAt.getTime()).toBe(claimedAt.getTime() + 2);
    expect(await records.advance("bot-1", stored!.storageId, null, "rev-2")).toBe(false);
  });

  it("restores a home on a host whose cache is empty", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "one", "dir/b.txt": "two" }), context);

    const other = await otherHost();
    expect(await exported(other, "bot-1")).toEqual({ "a.txt": "one", "dir/b.txt": "two" });
    expect(await other.readFile("bot-1", "dir/b.txt", context)).toBe("two");
  });

  it("downloads again after the cache is evicted, and replaces a stale cache", async () => {
    const { root, store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "first" }), context);
    await rm(path.join(root, "homes"), { recursive: true, force: true });
    await rm(path.join(root, "home-revisions"), { recursive: true, force: true });
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("first");

    const other = await otherHost();
    await other.commit("bot-1", await staged({ "a.txt": "second" }), context);
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("second");
  });

  it("downloads again when the cache directory is gone but its marker remains", async () => {
    const { root, store, storage, rows } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "stored" }), context);
    await store.hydrate("bot-1");
    await store.revise("bot-1");
    await rm(path.join(root, "homes"), { recursive: true });
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("stored");

    // A save of a missing cache must not replace the stored home with an empty one.
    await rm(path.join(root, "homes"), { recursive: true });
    await expect(store.revise("bot-1")).rejects.toThrow(/older than its stored revision/);
    expect([...storage.objects.keys()]).toEqual([
      `homes/${rows[0]!.homeStorageId}/${rows[0]!.homeStorageRevision}`,
    ]);

    // A reconnecting computer's live cache is kept only while it is there.
    await store.hydrate("bot-1", { keepLiveCache: true });
    expect(await readFile(path.join(store.pathFor("bot-1"), "a.txt"), "utf8")).toBe("stored");
  });

  it("forgets a missing cache without deleting what a concurrent read restores", async () => {
    const { root, storage, records, store } = await setup();
    await store.commit("bot-1", await staged({ "saved.txt": "saved" }), context);
    await store.hydrate("bot-1");
    await rm(store.pathFor("bot-1"), { recursive: true });
    // The API and the worker share the data directory: a files read in one restores the folder
    // while the starting computer, in the other, is between seeing it missing and forgetting it.
    const api = new ObjectAgentHomeStore(root, storage, records);
    class Worker extends ObjectAgentHomeStore {
      protected override async localRevision(botId: string) {
        await api.readFile(botId, "saved.txt", context);
        return super.localRevision(botId);
      }
    }

    await new Worker(root, storage, records).forgetMissingCache("bot-1");

    expect(await readdir(store.pathFor("bot-1"))).toEqual(["saved.txt"]);
    // Only the revision is forgotten, so the computer's start downloads again before it boots.
    expect(await readFile(path.join(root, "home-revisions", "bot-1.txt"), "utf8")).toBe("");
  });

  it("does not let a save that started before a newer one replace it", async () => {
    const { root, storage, records, otherHost } = await setup();
    let interleave: (() => Promise<unknown>) | undefined;
    const racing = new ObjectAgentHomeStore(root, storage, {
      ...records,
      load: (homeKey) => records.load(homeKey),
      advance: (...args) => records.advance(...args),
      revisions: (ids) => records.revisions(ids),
      kinds: (keys) => records.kinds(keys),
      create: async (homeKey) => {
        await interleave?.();
        return records.create(homeKey);
      },
    });
    await racing.commit("bot-1", await staged({ "a.txt": "first" }), context);
    await racing.hydrate("bot-1");
    const other = await otherHost();
    interleave = async () => {
      interleave = undefined;
      await other.commit("bot-1", await staged({ "a.txt": "newer" }), context);
    };

    await expect(racing.revise("bot-1")).rejects.toThrow(HomeSaveConflictError);
    expect(await (await otherHost()).readFile("bot-1", "a.txt", context)).toBe("newer");
    expect(storage.objects.size).toBe(1);
  });

  it.each([false, true])(
    "recovers after a confirmed refusal (previous proposal: %s)",
    async (previousProposal) => {
      const { root, store, storage, records, otherHost } = await setup();
      await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
      await store.hydrate("bot-1");
      if (previousProposal) await store.revise("bot-1");
      const advance = records.advance.bind(records);
      records.advance = async (...args) => {
        records.advance = advance;
        await (await otherHost()).commit(
          "bot-1",
          await staged({ "a.txt": "winning writer" }),
          context,
        );
        return advance(...args);
      };
      await expect(store.revise("bot-1")).rejects.toThrow(HomeSaveConflictError);
      expect(storage.objects.size).toBe(1);
      const restarted = new ObjectAgentHomeStore(root, storage, records);
      await expect(restarted.revise("bot-1")).rejects.toThrow(/older than its stored revision/);
      await restarted.hydrate("bot-1");
      expect(await readFile(path.join(store.pathFor("bot-1"), "a.txt"), "utf8")).toBe(
        "winning writer",
      );
      await writeFile(path.join(store.pathFor("bot-1"), "recent.txt"), "after recovery");
      await restarted.revise("bot-1");
      expect(await (await otherHost()).readFile("bot-1", "recent.txt", context)).toBe(
        "after recovery",
      );
    },
  );

  it("recognizes its own committed revision when the database reply is lost", async () => {
    const { root, storage, records, rows } = await setup();
    const store = new ObjectAgentHomeStore(root, storage, {
      load: (homeKey) => records.load(homeKey),
      create: (homeKey) => records.create(homeKey),
      revisions: (ids) => records.revisions(ids),
      kinds: (keys) => records.kinds(keys),
      // The update commits, then the connection drops before the reply.
      advance: async (...args) => {
        await records.advance(...args);
        throw new Error("connection terminated");
      },
    });
    const revision = await store.commit("bot-1", await staged({ "a.txt": "x" }), context);
    expect(revision).toBe(rows[0]!.homeStorageRevision);
    expect([...storage.objects.keys()]).toEqual([
      `homes/${rows[0]!.homeStorageId}/${rows[0]!.homeStorageRevision}`,
    ]);
  });

  it("recovers a committed cached save after its database reply is lost", async () => {
    const { root, store, storage, records, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
    await store.hydrate("bot-1");
    const advance = records.advance.bind(records);
    records.advance = async (...args) => {
      await advance(...args);
      throw new Error("connection terminated");
    };
    await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "checkpoint");
    await store.revise("bot-1").catch(() => undefined);
    records.advance = advance;
    await writeFile(path.join(store.pathFor("bot-1"), "recent.txt"), "after the lost reply");

    // A fresh instance represents the API or worker sharing the mounted cache.
    const restarted = new ObjectAgentHomeStore(root, storage, records);
    await restarted.hydrate("bot-1");
    expect(await readFile(path.join(store.pathFor("bot-1"), "recent.txt"), "utf8")).toBe(
      "after the lost reply",
    );
    await restarted.revise("bot-1");
    expect(await (await otherHost()).readFile("bot-1", "recent.txt", context)).toBe(
      "after the lost reply",
    );
  });

  it.each([
    { first: false, committed: true, recover: "hydrate" },
    { first: false, committed: true, recover: "revise" },
    { first: true, committed: true, recover: "hydrate" },
    { first: true, committed: true, recover: "revise" },
    { first: false, committed: false, recover: "hydrate" },
    { first: false, committed: false, recover: "revise" },
    { first: true, committed: false, recover: "hydrate" },
    { first: true, committed: false, recover: "revise" },
  ] as const)(
    "preserves an uncertain save across instances ($first, $committed, $recover)",
    async ({ first, committed, recover }) => {
      const { root, store, storage, records, otherHost } = await setup();
      if (!first) {
        await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
        await store.hydrate("bot-1");
      }
      await mkdir(store.pathFor("bot-1"), { recursive: true });
      await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "checkpoint");
      const load = records.load.bind(records);
      const advance = records.advance.bind(records);
      let unavailable = false;
      records.load = async (key) => {
        if (unavailable) throw new Error("database unavailable");
        return load(key);
      };
      records.advance = async (...args) => {
        if (committed) await advance(...args);
        unavailable = true;
        throw new Error("connection terminated");
      };
      await expect(store.revise("bot-1")).rejects.toThrow("connection terminated");
      const recent = path.join(store.pathFor("bot-1"), "recent.txt");
      await writeFile(recent, "after the lost reply");
      const restarted = new ObjectAgentHomeStore(root, storage, records);
      await expect(restarted.hydrate("bot-1")).rejects.toThrow("database unavailable");
      expect(await readFile(recent, "utf8")).toBe("after the lost reply");
      unavailable = false;
      records.advance = advance;
      // An uncommitted upload may already have been swept before recovery.
      await store.sweep(Date.now() + 2 * 24 * 60 * 60_000);

      await restarted[recover]("bot-1");
      expect(await readFile(recent, "utf8")).toBe("after the lost reply");
      await restarted.revise("bot-1");
      expect(await (await otherHost()).readFile("bot-1", "recent.txt", context)).toBe(
        "after the lost reply",
      );
    },
  );

  it.each([true, false])(
    "preserves the live cache when another writer wins after an uncertain save (committed: %s)",
    async (committed) => {
      const { root, rows, store, storage, records, otherHost } = await setup();
      rows[0]!.kind = "docker";
      await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
      await store.hydrate("bot-1");
      const advance = records.advance.bind(records);
      records.advance = async (...args) => {
        if (committed) await advance(...args);
        throw new Error("connection terminated");
      };
      await store.revise("bot-1").catch(() => undefined);
      records.advance = advance;
      const recent = path.join(store.pathFor("bot-1"), "recent.txt");
      await writeFile(recent, "local work");
      await (await otherHost()).commit("bot-1", await staged({ "a.txt": "other writer" }), context);

      const restarted = new ObjectAgentHomeStore(root, storage, records);
      await expect(restarted.revise("bot-1")).rejects.toThrow(HomeSaveConflictError);
      await expect(restarted.hydrate("bot-1")).rejects.toThrow(HomeSaveConflictError);
      expect(await readFile(recent, "utf8")).toBe("local work");
      expect(await (await otherHost()).readFile("bot-1", "a.txt", context)).toBe("other writer");
    },
  );

  it("keeps an uncertain proposal when its recovery save is refused", async () => {
    const { root, rows, store, storage, records, otherHost } = await setup();
    rows[0]!.kind = "docker";
    await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
    await store.hydrate("bot-1");
    const advance = records.advance.bind(records);
    records.advance = async () => {
      throw new Error("connection terminated");
    };
    await expect(store.revise("bot-1")).rejects.toThrow("connection terminated");
    const markerFile = path.join(root, "home-revisions/bot-1.txt");
    const pending = await readFile(markerFile, "utf8");
    const recent = path.join(store.pathFor("bot-1"), "recent.txt");
    await writeFile(recent, "after the lost reply");
    records.advance = async (...args) => {
      records.advance = advance;
      await (await otherHost()).commit(
        "bot-1",
        await staged({ "a.txt": "winning writer" }),
        context,
      );
      return advance(...args);
    };
    const restarted = new ObjectAgentHomeStore(root, storage, records);
    await expect(restarted.hydrate("bot-1")).rejects.toThrow(HomeSaveConflictError);
    expect(await readFile(markerFile, "utf8")).toBe(pending);
    await expect(restarted.hydrate("bot-1")).rejects.toThrow(HomeSaveConflictError);
    await expect(restarted.revise("bot-1")).rejects.toThrow(HomeSaveConflictError);
    expect(await readFile(recent, "utf8")).toBe("after the lost reply");
  });

  it.each([true, false])(
    "downloads a remote computer's newer save over a cached proposal (committed: %s)",
    async (committed) => {
      const { root, store, storage, records, otherHost } = await setup();
      await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
      await store.hydrate("bot-1");
      const advance = records.advance.bind(records);
      records.advance = async (...args) => {
        if (committed) return advance(...args);
        throw new Error("connection terminated");
      };
      await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "folder removed");
      await store.revise("bot-1").catch(() => undefined);
      records.advance = advance;
      await (await otherHost()).commit(
        "bot-1",
        await staged({ "a.txt": "saved by the computer" }),
        context,
      );

      const restarted = new ObjectAgentHomeStore(root, storage, records);
      expect(await restarted.readFile("bot-1", "a.txt", context)).toBe("saved by the computer");
      await restarted.writeFile("bot-1", "b.txt", "after the save", context);
      expect(await (await otherHost()).readFile("bot-1", "b.txt", context)).toBe("after the save");
    },
  );

  it("reads the marker after the database when another process saves during hydration", async () => {
    const { root, store, storage, records } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
    await store.hydrate("bot-1");
    const load = records.load.bind(records);
    let resume = () => {};
    let reading = () => {};
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let paused = false;
    records.load = async (key) => {
      if (!paused) {
        paused = true;
        reading();
        await delayed;
      }
      return load(key);
    };
    const markerFile = path.join(root, "home-revisions/bot-1.txt");
    let marker = await readFile(markerFile, "utf8");
    // Make the marker snapshot immediate, so a parallel read deterministically sees
    // the old marker while the database response is held back.
    class ReadingStore extends ObjectAgentHomeStore {
      protected override async localRevision() {
        return marker;
      }
    }
    const otherProcess = new ReadingStore(root, storage, records);
    const hydrating = otherProcess.hydrate("bot-1");
    await started;
    await store.revise("bot-1");
    marker = await readFile(markerFile, "utf8");
    const recent = path.join(store.pathFor("bot-1"), "recent.txt");
    await writeFile(recent, "after the checkpoint");
    resume();
    await hydrating;
    expect(await readFile(recent, "utf8")).toBe("after the checkpoint");
  });

  it.each([true, false])(
    "keeps a shared cache's newer marker after a delayed reply (advanced: %s)",
    async (advanced) => {
      const { root, store, storage, records, otherHost } = await setup();
      await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
      await store.hydrate("bot-1");
      const advance = records.advance.bind(records);
      let reply = () => {};
      let updated = () => {};
      const waiting = new Promise<void>((resolve) => {
        updated = resolve;
      });
      const delayed = new Promise<void>((resolve) => {
        reply = resolve;
      });
      records.advance = async (...args) => {
        const result = advanced ? await advance(...args) : undefined;
        updated();
        await delayed;
        return result ?? advance(...args);
      };
      const saving = store.revise("bot-1");
      await waiting;
      records.advance = advance;
      const otherProcess = new ObjectAgentHomeStore(root, storage, records);
      await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "newer checkpoint");
      await otherProcess.revise("bot-1");
      reply();
      if (advanced) await saving;
      else await expect(saving).rejects.toThrow(HomeSaveConflictError);
      const recent = path.join(store.pathFor("bot-1"), "recent.txt");
      await writeFile(recent, "after both saves");

      await new ObjectAgentHomeStore(root, storage, records).hydrate("bot-1");
      expect(await readFile(recent, "utf8")).toBe("after both saves");
      expect(await (await otherHost()).readFile("bot-1", "a.txt", context)).toBe(
        "newer checkpoint",
      );
    },
  );

  it("keeps only the current revision once a newer one is saved", async () => {
    const { store, storage, rows } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "first" }), context);
    const second = await store.commit("bot-1", await staged({ "a.txt": "second" }), context);
    expect([...storage.objects.keys()]).toEqual([`homes/${rows[0]!.homeStorageId}/${second}`]);
  });

  it("saves the cached copy a Docker computer changed in place", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "booted" }), context);
    await store.hydrate("bot-1");
    await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "edited by the computer");
    await store.revise("bot-1");
    expect(await (await otherHost()).readFile("bot-1", "a.txt", context)).toBe(
      "edited by the computer",
    );
  });

  it("refuses to save a stale cache over a newer stored revision", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "first" }), context);
    await (await otherHost()).commit("bot-1", await staged({ "a.txt": "newer" }), context);
    await expect(store.revise("bot-1")).rejects.toThrow(/older than its stored revision/);
  });

  it("fails closed when a stored object is modified", async () => {
    const { store, storage, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "original" }), context);
    const object = [...storage.objects.values()][0]!;
    object.bytes[object.bytes.length - 20]! ^= 1;

    const other = await otherHost();
    await expect(other.readFile("bot-1", "a.txt", context)).rejects.toThrow(ContentDecryptionError);
  });

  it("rejects another home's object, or an older revision, moved into place", async () => {
    const { store, storage, rows, otherHost } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "bot one" }), context);
    const older = [...storage.objects.values()][0]!.bytes;
    await store.commit("bot-1", await staged({ "a.txt": "bot one, later" }), context);
    await store.commit("bot-2", await staged({ "a.txt": "bot two" }), context);
    const keyOf = (index: number) =>
      `homes/${rows[index]!.homeStorageId}/${rows[index]!.homeStorageRevision}`;

    // Another home's object under this home's key: a different data key.
    storage.objects.set(keyOf(1), { ...storage.objects.get(keyOf(0))! });
    await expect((await otherHost()).readFile("bot-2", "a.txt", context)).rejects.toThrow(
      ContentDecryptionError,
    );
    // This home's older revision under its current key: bound to its own revision.
    storage.objects.set(keyOf(0), { bytes: older, lastModified: new Date() });
    await expect((await otherHost()).readFile("bot-1", "a.txt", context)).rejects.toThrow(
      ContentDecryptionError,
    );
  });

  it("cannot unwrap a home key copied to another computer", async () => {
    const { store, rows, records } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "x" }), context);
    Object.assign(rows[1]!, {
      homeStorageId: rows[0]!.homeStorageId,
      homeStorageKey: rows[0]!.homeStorageKey,
      homeStorageRevision: rows[0]!.homeStorageRevision,
    });
    rows[0]!.homeStorageId = "moved-away";
    await expect(records.load("bot-2")).rejects.toThrow(ContentDecryptionError);
  });

  it("deletes the objects of a deleted computer, and stale revisions, when sweeping", async () => {
    const { store, storage, rows } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "keep" }), context);
    await store.commit("bot-2", await staged({ "a.txt": "delete" }), context);
    const kept = `homes/${rows[0]!.homeStorageId}/${rows[0]!.homeStorageRevision}`;
    const crashed = `homes/${rows[0]!.homeStorageId}/rev-crashed`;
    storage.objects.set(crashed, { bytes: Buffer.from("x"), lastModified: new Date(0) });
    const inProgress = `homes/${rows[0]!.homeStorageId}/rev-in-progress`;
    storage.objects.set(inProgress, { bytes: Buffer.from("x"), lastModified: new Date() });
    // Deleting the bot deletes its computer row, and with it the wrapped data key.
    rows.splice(1, 1);

    expect(await store.sweep()).toBe(2);
    expect([...storage.objects.keys()].sort()).toEqual([kept, inProgress].sort());
  });

  it("removes folders from the stored copy, so another host never gets them back", async () => {
    const { store, otherHost } = await setup(["team-1"]);
    await store.commit(
      "team-1",
      await staged({
        "bots/gone/notes.txt": "deleted bot",
        "bots/kept/notes.txt": "other bot",
        ".browser-profiles/chromium-bot-gone/Cookies": "session",
        "shared/plan.txt": "shared",
      }),
      context,
    );

    await expect(store.removeFolders("team-1", "bots", ["gone", "missing"])).resolves.toBe(true);
    await store.removeFolders("team-1", ".browser-profiles", ["chromium-bot-gone"]);
    // Nothing left to remove does not save a new revision.
    await expect(store.removeFolders("team-1", "bots", ["gone"])).resolves.toBe(false);

    expect(await exported(await otherHost(), "team-1")).toEqual({
      "bots/kept/notes.txt": "other bot",
      "shared/plan.txt": "shared",
    });
  });

  it("removes folders from a remote computer's copy saved elsewhere during removal", async () => {
    const { store, otherHost } = await setup(["team-1"]);
    await store.commit("team-1", await staged({ "bots/gone/notes.txt": "deleted bot" }), context);
    const worker = await otherHost();
    const hydrate = store.hydrate.bind(store);
    let saved = false;
    store.hydrate = async (...args) => {
      await hydrate(...args);
      if (saved) return;
      saved = true;
      await worker.commit(
        "team-1",
        await staged({ "bots/gone/notes.txt": "deleted bot", "shared/plan.txt": "new work" }),
        context,
      );
    };

    await expect(store.removeFolders("team-1", "bots", ["gone"])).resolves.toBe(true);

    expect(await exported(await otherHost(), "team-1")).toEqual({ "shared/plan.txt": "new work" });
  });

  it("never replaces a Docker computer's copy saved elsewhere during removal", async () => {
    const { store, rows, otherHost } = await setup(["team-1"]);
    rows[0]!.kind = "docker";
    await store.commit("team-1", await staged({ "bots/gone/notes.txt": "deleted bot" }), context);
    const worker = await otherHost();
    const hydrate = store.hydrate.bind(store);
    store.hydrate = async (...args) => {
      await hydrate(...args);
      await worker.commit("team-1", await staged({ "shared/plan.txt": "new work" }), context);
    };

    await expect(store.removeFolders("team-1", "bots", ["gone"])).rejects.toThrow(
      "The cached home is older than its stored revision",
    );
  });

  it("leaves the folders to a retry when the stored copy cannot be saved", async () => {
    const { store, storage, otherHost } = await setup(["team-1"]);
    await store.commit("team-1", await staged({ "bots/gone/notes.txt": "deleted bot" }), context);
    const put = storage.put.bind(storage);
    storage.put = async () => {
      throw new Error("bucket unavailable");
    };

    await expect(store.removeFolders("team-1", "bots", ["gone"])).rejects.toThrow(
      "bucket unavailable",
    );
    storage.put = put;
    await expect(store.removeFolders("team-1", "bots", ["gone"])).resolves.toBe(true);

    expect(await exported(await otherHost(), "team-1")).toEqual({});
  });

  it.each([true, false])(
    "keeps folder removal's live cache after a lost reply (committed: %s)",
    async (committed) => {
      const { root, store, storage, records, otherHost } = await setup(["team-1"]);
      await store.commit("team-1", await staged({ "bots/gone/work.txt": "old" }), context);
      const advance = records.advance.bind(records);
      const load = records.load.bind(records);
      let unavailable = false;
      records.load = async (key) => {
        if (unavailable) throw new Error("database unavailable");
        return load(key);
      };
      records.advance = async (...args) => {
        if (committed) await advance(...args);
        unavailable = true;
        throw new Error("connection terminated");
      };
      await expect(store.removeFolders("team-1", "bots", ["gone"])).rejects.toThrow(
        "connection terminated",
      );
      await writeFile(path.join(store.pathFor("team-1"), "recent.txt"), "local work");
      unavailable = false;
      records.advance = advance;
      const restarted = new ObjectAgentHomeStore(root, storage, records);
      await restarted.removeFolders("team-1", "bots", ["gone"]);
      expect(await readFile(path.join(store.pathFor("team-1"), "recent.txt"), "utf8")).toBe(
        "local work",
      );
      await restarted.revise("team-1");
      expect(await exported(await otherHost(), "team-1")).toEqual({ "recent.txt": "local work" });
    },
  );

  it("finishes removing folders when the computer is deleted during the save", async () => {
    const { store, rows, records } = await setup(["team-1"]);
    await store.commit("team-1", await staged({ "bots/gone/notes.txt": "deleted bot" }), context);
    const create = records.create.bind(records);
    records.create = async (homeKey) => {
      rows.splice(0, 1);
      return create(homeKey);
    };

    await expect(store.removeFolders("team-1", "bots", ["gone"])).resolves.toBe(true);
  });

  it("keeps the rest of a home never stored when its first save fails", async () => {
    const { store, storage } = await setup(["team-1"]);
    await mkdir(path.join(store.pathFor("team-1"), "bots/gone"), { recursive: true });
    await mkdir(path.join(store.pathFor("team-1"), "bots/kept"), { recursive: true });
    await writeFile(path.join(store.pathFor("team-1"), "bots/kept/work.txt"), "other bot");
    storage.put = async () => {
      throw new Error("bucket unavailable");
    };

    await expect(store.removeFolders("team-1", "bots", ["gone"])).rejects.toThrow(
      "bucket unavailable",
    );

    await expect(readdir(path.join(store.pathFor("team-1"), "bots"))).resolves.toEqual(["kept"]);
  });

  it("removes a deleted home's cache, previous copy and revision marker", async () => {
    const { root, store } = await setup(["team-1", "team-2"]);
    await store.commit("team-1", await staged({ "a.txt": "gone" }), context);
    await store.commit("team-2", await staged({ "a.txt": "kept" }), context);
    await store.hydrate("team-1");
    await store.hydrate("team-2");
    await mkdir(`${store.pathFor("team-1")}.previous`, { recursive: true });
    await writeFile(path.join(`${store.pathFor("team-1")}.previous`, "a.txt"), "gone");

    await store.remove("team-1");
    await store.remove("team-1");

    await expect(readdir(path.join(root, "homes"))).resolves.toEqual(["team-2"]);
    await expect(readdir(path.join(root, "home-revisions"))).resolves.toEqual(["team-2.txt"]);
  });

  it("deletes nothing when the database knows none of the stored homes", async () => {
    const { store, storage, rows } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "keep" }), context);
    rows.splice(0);
    expect(await store.sweep()).toBe(0);
    expect(storage.objects.size).toBe(1);
  });

  it("migrates local homes once, verifies them and keeps the local copy", async () => {
    const { root, store, storage, otherHost } = await setup(["bot-1", "bot-2"]);
    const plain = new LocalAgentHomeStore(root);
    await plain.commit("bot-1", await staged({ "a.txt": "local one" }), context);
    await plain.commit("bot-2", await staged({ "b.txt": "local two" }), context);
    await plain.commit("orphan", await staged({ "c.txt": "no computer" }), context);
    expect(await store.localHomes()).toEqual(["bot-1", "bot-2", "orphan"]);

    expect(await store.migrateLocal("bot-1", { dryRun: true })).toBe("would-upload");
    expect(storage.objects.size).toBe(0);
    const first = await Promise.all(
      (await store.localHomes()).map((key) => store.migrateLocal(key)),
    );
    expect(first).toEqual(["uploaded", "uploaded", "no-computer"]);
    const second = await Promise.all(
      (await store.localHomes()).map((key) => store.migrateLocal(key)),
    );
    expect(second).toEqual(["stored", "stored", "no-computer"]);

    expect(storage.objects.size).toBe(2);
    expect(await readFile(path.join(root, "homes/bot-1/a.txt"), "utf8")).toBe("local one");
    expect(await exported(await otherHost(), "bot-2")).toEqual({ "b.txt": "local two" });
  });

  it("records a migrated home only after its upload verifies", async () => {
    const { root, storage, records, rows } = await setup();
    await new LocalAgentHomeStore(root).commit("bot-1", await staged({ "a.txt": "x" }), context);
    const corrupting = Object.assign(Object.create(storage) as MemoryObjectStorage, {
      async *get(key: string) {
        const bytes = Buffer.from(storage.objects.get(key)!.bytes);
        bytes[bytes.length - 20]! ^= 1;
        yield bytes;
      },
    });

    await expect(
      new ObjectAgentHomeStore(root, corrupting, records).migrateLocal("bot-1"),
    ).rejects.toThrow(ContentDecryptionError);
    expect(rows[0]!.homeStorageRevision).toBeNull();
    expect(storage.objects.size).toBe(0);

    const store = new ObjectAgentHomeStore(root, storage, records);
    expect(await store.migrateLocal("bot-1")).toBe("uploaded");
    expect(await store.migrateLocal("bot-1")).toBe("stored");
  });

  it("keeps using a home's local copy until it is first saved", async () => {
    const { root, store, storage } = await setup();
    await new LocalAgentHomeStore(root).commit(
      "bot-1",
      await staged({ "a.txt": "local" }),
      context,
    );
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("local");
    expect(storage.objects.size).toBe(0);
  });
});

describe("object-backed Kubernetes workspaces", () => {
  it("restores a replacement from object storage when its local cache was lost", async () => {
    const { store, otherHost } = await setup();
    await store.commit("bot-1", await staged({ "saved.txt": "stored bytes" }), context);
    const restored: PortableFile[] = [];
    const sandbox = {
      describe: () => ({ capabilities: { persistentHome: true } }),
      hasMountedHome: async () => true,
      importWorkspace: async (_computer: unknown, files: AsyncIterable<PortableFile>) => {
        for await (const file of files) restored.push(file);
      },
      exportWorkspace: async function* () {
        yield { path: "new.txt", content: Buffer.from("new bytes") };
      },
    } as unknown as SandboxProvider;
    const computer = {
      id: "replacement",
      botId: "bot-1",
      providerRef: "replacement",
      kind: "kubernetes" as const,
    };
    const freshCache = await otherHost();
    await restoreComputerWorkspace(freshCache, sandbox, "bot-1", computer, context);
    expect(restored.map((file) => [file.path, Buffer.from(file.content).toString()])).toEqual([
      ["saved.txt", "stored bytes"],
    ]);
    await checkpointComputerWorkspace(freshCache, sandbox, "bot-1", computer, context);
    expect(await (await otherHost()).readFile("bot-1", "new.txt", context)).toBe("new bytes");
  });
});

describe("createAgentHomeStore", () => {
  it("keeps homes on local disk when object storage is not configured", async () => {
    const store = createAgentHomeStore("/tmp/unused", {} as PrismaClient, {});
    expect(store).toBeInstanceOf(LocalAgentHomeStore);
    expect(store).not.toBeInstanceOf(ObjectAgentHomeStore);
  });

  it("refuses object storage without content keys", () => {
    expect(() =>
      createAgentHomeStore("/tmp/unused", {} as PrismaClient, {
        OBJECT_STORAGE_BUCKET: "b",
        OBJECT_STORAGE_ACCESS_KEY_ID: "id",
        OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
      }),
    ).toThrow(/content encryption keys/);
  });
});

describe("the local cache of object-backed homes", () => {
  const boatComputer = {
    id: "computer-1",
    botId: "bot-1",
    providerRef: "sb-1",
    kind: "boat" as const,
  };

  /** A remote computer whose export yields `files`, read lazily. */
  function remoteSandbox(files: () => AsyncIterable<PortableFile | StreamedPortableFile>) {
    const restored: string[] = [];
    const sandbox = {
      describe: () => ({ capabilities: {} }),
      importWorkspace: async (_computer: unknown, imported: AsyncIterable<PortableFile>) => {
        for await (const file of imported) restored.push(file.path);
      },
      exportWorkspace: files,
    } as unknown as SandboxProvider;
    return { sandbox, restored };
  }

  it("saves a remote computer straight from its staged files and keeps no copy", async () => {
    const { root, store, otherHost } = await setup();
    const { sandbox } = remoteSandbox(async function* () {
      yield { path: "notes/a.txt", content: Buffer.from("saved") };
    });

    await checkpointComputerWorkspace(store, sandbox, "bot-1", boatComputer, context);

    expect(await entries(path.join(root, "homes"))).toEqual([]);
    expect(await entries(path.join(root, "home-revisions"))).toEqual([]);
    expect(await entries(path.join(root, "staging"))).toEqual([]);
    expect(await (await otherHost()).readFile("bot-1", "notes/a.txt", context)).toBe("saved");
    expect(await store.readFile("bot-1", "notes/a.txt", context)).toBe("saved");
  });

  it("never evicts a copy an export is still reading", async () => {
    const { store } = await setup();
    await store.commit("bot-1", await staged({ "a.txt": "one", "b.txt": "two" }), context);
    const reading = store.exportHome("bot-1", context)[Symbol.asyncIterator]();
    await reading.next();

    expect(await store.evictCache("bot-1")).toBe(false);
    expect((await reading.next()).done).toBe(false);
    await reading.return?.(undefined);
    expect(await store.evictCache("bot-1")).toBe(true);
  });

  it("moves a local save into place instead of copying it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-local-homes-"));
    dirs.push(root);
    const store = new LocalAgentHomeStore(root);
    const { sandbox } = remoteSandbox(async function* () {
      yield { path: "a.txt", content: Buffer.from("saved") };
    });

    await checkpointComputerWorkspace(store, sandbox, "bot-1", boatComputer, context);

    expect(await store.readFile("bot-1", "a.txt", context)).toBe("saved");
    expect(await entries(path.join(root, "staging"))).toEqual([]);
  });

  it("keeps the only copy of a home that was never stored", async () => {
    const { store } = await setup();
    await mkdir(store.pathFor("bot-1"), { recursive: true });
    await writeFile(path.join(store.pathFor("bot-1"), "a.txt"), "local only");

    expect(await store.evictCache("bot-1")).toBe(false);
    expect(await store.readFile("bot-1", "a.txt", context)).toBe("local only");
  });

  it("never restores a cached copy into a fresh computer once its stored copy is deleted", async () => {
    const { root, rows, store } = await setup(["bot-1", "bot-2"]);
    await store.commit("bot-1", await staged({ "a.txt": "deleted" }), context);
    await store.commit("bot-2", await staged({ "a.txt": "deleted too" }), context);
    await store.hydrate("bot-1");
    await store.hydrate("bot-2");
    // The marker keeps the bare revision a previous release reads, during a rollout or rollback.
    expect(await readFile(path.join(root, "home-revisions", "bot-1.txt"), "utf8")).toBe(
      rows[0]!.homeStorageRevision,
    );
    // A copy an older release downloaded has no download record until it is next read.
    await rm(path.join(root, "home-downloads", "bot-2"));
    expect(await store.readFile("bot-2", "a.txt", context)).toBe("deleted too");
    for (const row of rows)
      Object.assign(row, { homeStorageId: null, homeStorageKey: null, homeStorageRevision: null });

    for (const homeKey of ["bot-1", "bot-2"]) {
      const { sandbox, restored } = remoteSandbox(async function* () {});
      await restoreComputerWorkspace(
        store,
        sandbox,
        homeKey,
        { ...boatComputer, botId: homeKey },
        context,
      );
      expect(restored).toEqual([]);
    }
    expect(await entries(path.join(root, "homes"))).toEqual([]);
  });

  it("evicts idle copies of remote computers' homes, never a Docker computer's", async () => {
    const { root, rows, store } = await setup(["remote-idle", "remote-recent", "docker-idle"]);
    rows[2]!.kind = "docker";
    for (const homeKey of ["remote-idle", "remote-recent", "docker-idle"]) {
      await store.commit(homeKey, await staged({ "a.txt": homeKey }), context);
      await store.hydrate(homeKey);
    }
    const now = Date.now();
    const hoursAgo = new Date(now - 2 * 60 * 60_000);
    for (const homeKey of ["remote-idle", "docker-idle"])
      await utimes(path.join(root, "home-revisions", `${homeKey}.txt`), hoursAgo, hoursAgo);

    expect(await store.evictIdleCaches(now)).toBe(1);
    expect((await readdir(path.join(root, "homes"))).sort()).toEqual([
      "docker-idle",
      "remote-recent",
    ]);
    expect(await store.readFile("remote-idle", "a.txt", context)).toBe("remote-idle");
  });

  it("evicts a downloaded copy once retention has cleared the stored home", async () => {
    const { root, rows, store } = await setup(["retention-cleared"]);
    await store.commit("retention-cleared", await staged({ "a.txt": "secret" }), context);
    await store.hydrate("retention-cleared");
    // Retention deleted the stored home: the record names no revision, so only this
    // host's downloaded copy is left, and nobody will read it again to clear it.
    Object.assign(rows[0]!, {
      homeStorageId: null,
      homeStorageKey: null,
      homeStorageRevision: null,
    });
    const now = Date.now();
    const hoursAgo = new Date(now - 2 * 60 * 60_000);
    await utimes(path.join(root, "home-revisions", "retention-cleared.txt"), hoursAgo, hoursAgo);

    expect(await store.evictIdleCaches(now)).toBe(1);
    expect(await entries(path.join(root, "homes"))).toEqual([]);
  });

  it("saves a large file streamed to disk and storage one chunk at a time", async () => {
    const { root, rows } = await setup();
    const storage = new CountingStorage();
    const records = new PrismaAgentHomeRecords(fakeComputers(rows), memoryRing());
    const store = new ObjectAgentHomeStore(root, storage, records);
    const chunk = 1024 * 1024;
    const chunks = 64;
    const { sandbox } = remoteSandbox(async function* () {
      yield {
        path: "big.bin",
        body: (async function* () {
          for (let index = 0; index < chunks; index++) {
            // Each chunk reaches the disk before the next one is asked for.
            if (index > 0) expect((await stagedFile(root, "big.bin")).size).toBe(index * chunk);
            yield Buffer.alloc(chunk, index);
          }
        })(),
      };
    });

    await checkpointComputerWorkspace(store, sandbox, "bot-1", boatComputer, context);

    expect(storage.bytes).toBeGreaterThan(chunks * chunk);
    // Packing reads files in 1 MiB pieces and sealing cuts them smaller still.
    expect(storage.largestChunk).toBeLessThanOrEqual(chunk);
  });

  it("refuses a workspace over the save limits and leaves no staged files", async () => {
    const { root, store } = await setup();
    const { sandbox } = remoteSandbox(async function* () {
      for (let index = 0; ; index++) yield { path: `f${index}.txt`, content: Buffer.from("x") };
    });

    const limits = { maxBytes: 1024 ** 3, maxFiles: 100 };

    await expect(
      checkpointComputerWorkspace(
        store,
        sandbox,
        "bot-1",
        boatComputer,
        context,
        undefined,
        limits,
      ),
    ).rejects.toEqual(new WorkspaceTooLargeError("files"));
    await expect(readdir(path.join(root, "staging"))).resolves.toEqual([]);

    const { sandbox: huge } = remoteSandbox(async function* () {
      yield {
        path: "endless.bin",
        body: (async function* () {
          for (;;) yield Buffer.alloc(1024 * 1024);
        })(),
      };
    });
    await expect(
      checkpointComputerWorkspace(store, huge, "bot-1", boatComputer, context, undefined, {
        maxBytes: 8 * 1024 * 1024,
        maxFiles: 100,
      }),
    ).rejects.toEqual(new WorkspaceTooLargeError("bytes"));
    await expect(readdir(path.join(root, "staging"))).resolves.toEqual([]);
  });

  it("removes staging that a killed process left, but not staging in use", async () => {
    const { root, store } = await setup();
    const now = Date.now();
    const old = new Date(now - 60 * 60_000);
    const leftovers = [
      path.join(root, "staging", "rakazo-workspace-dead"),
      path.join(root, "homes", ".bot-1.staging-dead"),
    ];
    for (const dir of leftovers) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "file"), "x");
      await utimes(dir, old, old);
    }
    const live = await store.createStaging();
    await mkdir(path.join(root, "homes", "bot-2"), { recursive: true });
    await utimes(path.join(root, "homes", "bot-2"), old, old);

    // Leftovers of older releases in the shared temp directory may count too.
    expect(await store.removeStaleStaging(now)).toBeGreaterThanOrEqual(2);
    expect(await readdir(path.join(root, "staging"))).toEqual([path.basename(live.path)]);
    expect(await readdir(path.join(root, "homes"))).toEqual(["bot-2"]);
    await live.remove();
  });
});

/** Keeps no bytes; records how much it was sent and in what pieces. */
class CountingStorage extends MemoryObjectStorage {
  bytes = 0;
  largestChunk = 0;

  override async put(key: string, body: AsyncIterable<Uint8Array>) {
    for await (const chunk of body) {
      this.bytes += chunk.byteLength;
      this.largestChunk = Math.max(this.largestChunk, chunk.byteLength);
    }
    this.objects.set(key, { bytes: Buffer.alloc(0), lastModified: new Date() });
  }
}

async function entries(dir: string) {
  return readdir(dir).catch(() => []);
}

async function stagedFile(root: string, name: string) {
  const [dir] = await readdir(path.join(root, "staging"));
  return stat(path.join(root, "staging", dir!, name));
}
