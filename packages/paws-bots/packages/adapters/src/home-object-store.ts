import type { Hash } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ObjectStorage,
  PortableFile,
} from "@rakazo/adapter-kit";
import type { ContentKeyRing, ContentLocation, DataKey, PrismaClient } from "@rakazo/db";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
  openArtifact,
  runAsSystem,
  sealArtifact,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { LocalAgentHomeStore, newRevision } from "./home.js";
import type { HomeArchiveLimits } from "./home-archive.js";
import {
  checkHomeArchive,
  DEFAULT_HOME_ARCHIVE_LIMITS,
  packHome,
  unpackHome,
} from "./home-archive.js";
import { objectStorageConfigFromEnv, S3ObjectStorage } from "./s3-object-storage.js";

const HOMES_PREFIX = "homes/";
const SWEEP_INTERVAL_MS = 60 * 60_000;
/** Leftover staging and idle cached copies are cleared this often. */
const CACHE_SWEEP_INTERVAL_MS = 10 * 60_000;
/** A remote computer's cached copy nothing has read for this long is removed. */
const IDLE_CACHE_MS = 60 * 60_000;
/** An export in progress marks its copy as used this often. */
const READER_HEARTBEAT_MS = 5 * 60_000;
/** Revisions left by a crashed save are removed once they are clearly not in progress. */
const STALE_REVISION_MS = 24 * 60 * 60_000;
/** Folder removal starts over this many times when another process saves the home meanwhile. */
const REMOVE_FOLDERS_ATTEMPTS = 3;

/** Where a home's revisions are stored and the key that seals them. */
export interface StoredHome {
  /** Random, so object keys say nothing about the bot, user or space. */
  storageId: string;
  /** The current revision, or null before the first save. */
  revision: string | null;
  key: DataKey;
}

/** The database side of stored homes: one row per home, deleted with its computer. */
export interface AgentHomeRecords {
  /** Undefined until the home is first saved, or when it has no computer. */
  load(homeKey: string): Promise<StoredHome | undefined>;
  /** Creates the storage id and data key on first save. Undefined when there is no computer. */
  create(homeKey: string): Promise<StoredHome | undefined>;
  /** Moves the current revision from `from` to `to`; false when another save got there first. */
  advance(homeKey: string, storageId: string, from: string | null, to: string): Promise<boolean>;
  /** The current revision of each storage id that still belongs to a home. */
  revisions(storageIds: readonly string[]): Promise<Map<string, string | null>>;
  /** The computer kind of each home that still has a computer. */
  kinds(homeKeys: readonly string[]): Promise<Map<string, string>>;
}

class StaleHomeCacheError extends Error {
  constructor() {
    super("The cached home is older than its stored revision");
    this.name = "StaleHomeCacheError";
  }
}

export class HomeSaveConflictError extends Error {
  constructor() {
    super("Agent home was saved elsewhere at the same time");
    this.name = "HomeSaveConflictError";
  }
}

/**
 * Homes whose source of truth is object storage, with `DATA_DIR/homes` as a local cache.
 *
 * Each save packs the home into one archive, seals it with the home's data key (64 KiB
 * AES-256-GCM segments bound to the storage id and revision), and uploads it as
 * `homes/<storage id>/<revision>`. The database then moves the home to that revision and the
 * previous object is deleted. Reads first bring the cache up to the stored revision, so a cache
 * that was removed, or that another host replaced, is downloaded again.
 *
 * Docker computers keep mounting the cached directory (this extends `LocalAgentHomeStore`);
 * their checkpoints upload it. Remote computers' saves upload straight from their staged files,
 * and their cached copy, used only to restore and read them, is removed after an hour unread.
 * Sandboxes never see storage credentials or object URLs: files still reach them only through
 * checkout and workspace import.
 */
export class ObjectAgentHomeStore extends LocalAgentHomeStore {
  /** Exports in progress per home, which eviction waits out. */
  private readonly readers = new Map<string, number>();

  constructor(
    root: string,
    private readonly storage: ObjectStorage,
    private readonly records: AgentHomeRecords,
    private readonly limits: HomeArchiveLimits = DEFAULT_HOME_ARCHIVE_LIMITS,
  ) {
    super(root);
  }

  override describe() {
    return {
      id: "object-storage",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: false },
    };
  }

  override async checkout(botId: string, dest: string, context: AdapterContext) {
    return this.reading(botId, () => super.checkout(botId, dest, context));
  }

  override async *exportHome(
    botId: string,
    context: AdapterContext,
    options?: { directory?: string; skipHidden?: boolean },
  ): AsyncGenerator<PortableFile> {
    const done = this.startReading(botId);
    try {
      await this.hydrate(botId);
      yield* super.exportHome(botId, context, options);
    } finally {
      done();
    }
  }

  override async readFile(
    botId: string,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return this.reading(botId, () => super.readFile(botId, filePath, context, options));
  }

  override async list(botId: string, dirPath: string, context: AdapterContext) {
    return this.reading(botId, () => super.list(botId, dirPath, context));
  }

  /** Hydrates, then reads the cached copy with eviction held off until the read ends. */
  private async reading<T>(botId: string, read: () => Promise<T>): Promise<T> {
    const done = this.startReading(botId);
    try {
      await this.hydrate(botId);
      return await read();
    } finally {
      done();
    }
  }

  /**
   * Counts a read of the cached copy, which eviction here waits out. A long read also keeps the
   * copy marked as used, so other processes' idle eviction leaves it alone.
   */
  private startReading(botId: string) {
    this.readers.set(botId, (this.readers.get(botId) ?? 0) + 1);
    const timer = setInterval(() => void this.touchRevision(botId), READER_HEARTBEAT_MS);
    timer.unref();
    return () => {
      clearInterval(timer);
      const left = (this.readers.get(botId) ?? 1) - 1;
      if (left) this.readers.set(botId, left);
      else this.readers.delete(botId);
    };
  }

  override async writeFile(
    botId: string,
    filePath: string,
    content: string,
    context: AdapterContext,
  ) {
    await this.hydrate(botId);
    await super.writeFile(botId, filePath, content, context);
    await this.revise(botId);
  }

  /**
   * Removes the folders from the stored copy too, so no host or later boot gets them back.
   * A remote computer can save between the download and this save (deleting a bot stops its
   * runs, which saves the computer); its files are then the stored copy, so removal starts
   * over from them. A Docker computer's mounted copy is never replaced, so that still fails.
   */
  override async removeFolders(botId: string, parent: string, names: readonly string[]) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.removeFoldersOnce(botId, parent, names);
      } catch (error) {
        const superseded =
          error instanceof StaleHomeCacheError || error instanceof HomeSaveConflictError;
        if (!superseded || attempt >= REMOVE_FOLDERS_ATTEMPTS || (await this.isLiveCache(botId)))
          throw error;
      }
    }
  }

  private async removeFoldersOnce(botId: string, parent: string, names: readonly string[]) {
    await this.hydrate(botId);
    const stored = Boolean((await this.records.load(botId))?.revision);
    const before = await this.localRevision(botId);
    if (!(await super.removeFolders(botId, parent, names))) return false;
    await this.revise(botId).catch(async (error) => {
      // Before publication, restore stored folders so a retry can remove them again.
      // After publication, keep the live copy: the UPDATE may have committed without a
      // reply. Hydration settles it before a retry inspects the folders. A home never
      // stored keeps its only copy.
      if (stored && (await this.localRevision(botId)) === before) await this.remove(botId);
      // The computer was deleted meanwhile, and its stored home with it.
      if (!(await this.records.kinds([botId])).has(botId)) return;
      throw error;
    });
    return true;
  }

  /**
   * Saves the cached copy, which a Docker computer has been changing in place. Refused when
   * the cache is missing or older than the stored revision, so a stale or empty copy never
   * replaces a newer one, even if another host saves while this one packs.
   */
  override async revise(botId: string): Promise<string> {
    return this.withBotWrite(botId, async () => {
      const { stored, local } = await this.loadCacheRevision(botId);
      const base = stored?.revision ?? null;
      if (base && (local !== base || !(await this.hasCache(botId))))
        throw new StaleHomeCacheError();
      return (await this.upload(botId, { base })).revision;
    });
  }

  /**
   * Saves a remote computer's exported files from `src` without copying them into the cache.
   * A cached copy this makes stale is downloaded again when next read, and removed once idle.
   */
  override async commit(botId: string, src: string, _context: AdapterContext): Promise<string> {
    return this.withBotWrite(
      botId,
      async () => (await this.upload(botId, { source: src })).revision,
    );
  }

  /**
   * Removes this host's copy of a remote computer's home once the bucket holds it and no export
   * here is reading it; it is downloaded again when next needed. A copy this host downloaded from
   * storage is still a cache when the record no longer names a revision (retention deleted the
   * home), so it goes too, as hydrate does on read. A home never stored keeps its only copy.
   * Never call it for a Docker computer, which works directly in the copy.
   */
  async evictCache(botId: string, { idleBefore }: { idleBefore?: number } = {}): Promise<boolean> {
    return this.withBotWrite(botId, async () => {
      if (this.readers.has(botId)) return false;
      if (idleBefore !== undefined) {
        // Checked under the lock: a read that started since the sweep looked keeps the copy.
        const used = await this.revisionUsedAt(botId);
        if (used === undefined || used > idleBefore) return false;
      }
      const stored = await this.records.load(botId);
      if (
        !stored?.revision &&
        !((await this.isDownloaded(botId)) && !(await this.isLiveCache(botId)))
      )
        return false;
      await this.removeCopy(botId);
      return true;
    });
  }

  /** Evicts cached copies of remote computers' homes that nothing read in the last hour. */
  async evictIdleCaches(now = Date.now()): Promise<number> {
    const homes = await this.localHomes();
    const kinds = await this.records.kinds(homes);
    let evicted = 0;
    for (const botId of homes) {
      const kind = kinds.get(botId);
      if (!kind || kind === "docker") continue;
      if (await this.evictCache(botId, { idleBefore: now - IDLE_CACHE_MS })) evicted += 1;
    }
    return evicted;
  }

  /**
   * Brings the cached copy up to the stored revision. A home never saved to object storage
   * keeps its local copy, so homes from before object storage keep working until they are
   * migrated or next saved. A remote computer's copy of a stored home whose stored copy was
   * since deleted is removed, so the deleted files never reach a computer again.
   */
  async hydrate(botId: string, { keepLiveCache = false } = {}): Promise<void> {
    await this.withBotWrite(botId, async () => {
      // A running computer's mounted copy can be newer than any save, so it is never replaced.
      // A folder whose revision was forgotten is not that copy, even once something recreates it.
      if (keepLiveCache && (await this.localRevision(botId)) && (await this.hasCache(botId)))
        return;
      const { stored, local, fromStorage } = await this.loadCacheRevision(botId);
      if (!stored?.revision) {
        if (fromStorage && !(await this.isLiveCache(botId))) await this.removeCopy(botId);
        return;
      }
      // A removed cache directory leaves its marker behind; only a present copy counts.
      if (local === stored.revision && (await this.hasCache(botId))) {
        // Copies downloaded before downloads were recorded are recognized by matching the revision.
        if (!fromStorage) await this.markDownloaded(botId);
        await this.touchRevision(botId);
        return;
      }
      const revision = stored.revision;
      await this.replaceHome(botId, (staging) =>
        unpackHome(this.download(stored, revision), staging, this.limits),
      );
      await this.markDownloaded(botId);
      await super.writeRevision(botId, revision);
    });
  }

  /**
   * Cached saves retain their proposed revision and base in the marker. Unlike a plain
   * downloaded revision, this is a live copy: an unresolved or competing save must never
   * cause hydration to replace it. Keeping the proposal after success also avoids a late
   * database reply overwriting a newer save's marker in another process.
   */
  private async loadCacheRevision(botId: string) {
    // Read in this order: a newly stored revision must see the proposal published before
    // its UPDATE, even when another process saves while the database read is in flight.
    const stored = await this.records.load(botId);
    const local = await this.localRevision(botId);
    if (!local?.startsWith("{"))
      return { stored, local, fromStorage: await this.isDownloaded(botId) };
    const pending = JSON.parse(local) as Record<string, unknown>;
    if (
      pending.version !== 1 ||
      typeof pending.storageId !== "string" ||
      typeof pending.revision !== "string" ||
      !(pending.base === null || typeof pending.base === "string")
    )
      throw new HomeSaveConflictError();
    // A published proposal means the copy is, or was, stored.
    const fromStorage = true;
    if (!(await this.hasCache(botId))) return { stored, local: undefined, fromStorage };
    if (
      stored?.storageId !== pending.storageId ||
      (stored.revision !== pending.revision && stored.revision !== pending.base)
    ) {
      // Only a Docker computer works in the cached copy. Any other computer saves from its own
      // files, so a revision stored since the proposal supersedes this copy.
      if (!(await this.isLiveCache(botId))) return { stored, local: undefined, fromStorage };
      // An unrelated revision cannot prove whether this save committed. Replacing the
      // cache or uploading over that revision could destroy either writer's work.
      throw new HomeSaveConflictError();
    }
    if (stored.revision === pending.revision)
      return { stored, local: pending.revision, fromStorage };
    // Still at the base: save the latest local bytes with the usual compare-and-swap.
    // Never republish the old upload: it may have been swept during the outage.
    const { revision } = await this.upload(botId, { base: stored.revision });
    return { stored: { ...stored, revision }, local: revision, fromStorage };
  }

  /**
   * Stops trusting the revision of a cached copy that is gone, so a folder recreated later (by a
   * boot, the Docker supervisor or a failed start) is downloaded into rather than taken for that
   * copy. Only the marker is cleared, never files: a read in another process may be restoring
   * the folder meanwhile, and that copy is then merely downloaded again before the next boot.
   */
  async forgetMissingCache(botId: string): Promise<void> {
    await this.withBotWrite(botId, async () => {
      if (!(await this.hasCache(botId)) && (await this.localRevision(botId)))
        await super.writeRevision(botId, "");
    });
  }

  private async isLiveCache(botId: string) {
    const kind = (await this.records.kinds([botId])).get(botId);
    return kind === undefined || kind === "docker";
  }

  private async hasCache(botId: string) {
    await this.recoverInterruptedCommit(botId);
    return stat(this.pathFor(botId)).then(
      (info) => info.isDirectory(),
      () => false,
    );
  }

  /**
   * Packs, seals and uploads the cached copy, or `source` when given, then moves the home to
   * it. `base` is the stored revision the copy was checked against (default: whatever is stored
   * now); the move fails if the home has moved past it. With `verify`, the object is downloaded
   * and checked before the home points at it.
   */
  private async upload(
    botId: string,
    options: { base?: string | null; verify?: boolean; source?: string } = {},
  ): Promise<{ revision: string }> {
    const stored = await this.records.create(botId);
    if (!stored) throw new Error("Agent home has no computer");
    const base = options.base === undefined ? stored.revision : options.base;
    const revision = newRevision();
    const key = objectKey(stored.storageId, revision);
    const digest = createHash("sha256");
    const home = options.source ?? this.pathFor(botId);
    await mkdir(home, { recursive: true });
    await this.storage.put(
      key,
      sealArtifact(
        stored.key,
        sealedId(stored.storageId, revision),
        tap(packHome(home, this.limits), digest),
      ),
    );
    const discard = () => this.storage.delete([key]).catch(() => undefined);
    if (options.verify)
      await this.verify(stored, revision, digest.digest("hex")).catch(async (error) => {
        await discard();
        throw error;
      });
    // Publish the proposal atomically before the UPDATE. The API and worker share this
    // marker, so either can recover a lost reply without replacing the mounted directory.
    const previous = !options.source ? await this.localRevision(botId) : undefined;
    const proposal = JSON.stringify({ version: 1, storageId: stored.storageId, base, revision });
    if (!options.source) await super.writeRevision(botId, proposal);
    // Only a confirmed refusal discards the upload. An error may hide a committed update, so
    // that object is left for the sweep, which keeps whatever revision the home points at.
    const advanced = await this.records
      .advance(botId, stored.storageId, base, revision)
      .catch(async (error: unknown) => {
        const current = await this.records.load(botId).catch(() => undefined);
        if (current?.storageId === stored.storageId && current.revision === revision) return true;
        throw error;
      });
    if (!advanced) {
      if (!options.source && (await this.localRevision(botId)) === proposal) {
        // A confirmed refusal is an ordinary stale cache again. A previous proposal
        // matching the base was confirmed by the pre-save read; otherwise it still
        // represents an uncertain save and must keep protecting the live files.
        const confirmed = previous?.startsWith("{") && JSON.parse(previous).revision === base;
        if (confirmed) await this.markDownloaded(botId);
        await super.writeRevision(botId, (confirmed ? base : previous) ?? "");
      }
      await discard();
      throw new HomeSaveConflictError();
    }
    if (base)
      await this.storage
        .delete([objectKey(stored.storageId, base)])
        .catch((error) => getLogger().error("previous home revision removal failed", error));
    return { revision };
  }

  /** Decrypted archive bytes of one revision; any tampering fails authentication. */
  private download(stored: StoredHome, revision: string): AsyncIterable<Uint8Array> {
    return openArtifact(
      async (keyId) => {
        if (keyId !== stored.key.id)
          throw new ContentDecryptionError("Stored home belongs to another home");
        return stored.key;
      },
      sealedId(stored.storageId, revision),
      this.storage.get(objectKey(stored.storageId, revision)),
    );
  }

  /**
   * Deletes objects whose home no longer exists (its computer, bot, space or account was
   * deleted, which also deleted its key) and revisions a crashed save left behind. Assumes the
   * bucket prefix belongs to this deployment alone; deletes nothing when the database knows
   * none of the stored homes.
   */
  async sweep(now = Date.now()): Promise<number> {
    const found = new Map<string, Array<{ key: string; revision: string; lastModified: Date }>>();
    for await (const object of this.storage.list(HOMES_PREFIX)) {
      const [storageId, revision, extra] = object.key.slice(HOMES_PREFIX.length).split("/");
      if (!storageId || !revision || extra !== undefined) continue;
      found.set(storageId, [...(found.get(storageId) ?? []), { ...object, revision }]);
    }
    const current = await this.records.revisions([...found.keys()]);
    // A database that knows none of the stored homes is more likely the wrong database (or
    // one this process cannot read) than one whose every home was deleted.
    if (found.size > 0 && current.size === 0) {
      getLogger().warn("home.storage.sweep_skipped", { "home.objects.unknown": found.size });
      return 0;
    }
    const doomed = [...found].flatMap(([storageId, objects]) =>
      objects
        .filter(
          (object) =>
            !current.has(storageId) ||
            (object.revision !== current.get(storageId) &&
              now - object.lastModified.getTime() > STALE_REVISION_MS),
        )
        .map((object) => object.key),
    );
    await this.storage.delete(doomed);
    return doomed.length;
  }

  /** Home keys with a directory in the local cache, for migration. */
  async localHomes(): Promise<string[]> {
    const entries = await readdir(path.join(this.root, "homes"), { withFileTypes: true }).catch(
      () => [],
    );
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.endsWith(".previous"),
      )
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * Uploads a home that exists only on local disk, downloads it again and checks it decrypts to
   * the same archive, and only then records it as stored. Homes already stored were verified
   * this way (or saved by a running computer), so a rerun after an interruption skips them.
   * Local files are never deleted.
   */
  async migrateLocal(
    botId: string,
    { dryRun = false }: { dryRun?: boolean } = {},
  ): Promise<"uploaded" | "would-upload" | "stored" | "no-computer"> {
    return this.withBotWrite(botId, async () => {
      if ((await this.records.load(botId))?.revision) return "stored";
      if (dryRun) return "would-upload";
      if (!(await this.records.create(botId))) return "no-computer";
      await this.upload(botId, { base: null, verify: true });
      return "uploaded";
    });
  }

  private async verify(stored: StoredHome, revision: string, expected: string) {
    const digest = createHash("sha256");
    await checkHomeArchive(tap(this.download(stored, revision), digest), this.limits);
    if (digest.digest("hex") !== expected)
      throw new Error("Stored home does not match what was uploaded");
  }
}

/** Data keys live on the home's computer row, wrapped by the space's content key. */
export class PrismaAgentHomeRecords implements AgentHomeRecords {
  constructor(
    private readonly prisma: Pick<PrismaClient, "computer">,
    private readonly ring: Pick<ContentKeyRing, "current" | "byId">,
  ) {}

  // The caller already decided who may use this home; the row only says where it is stored.
  private row(homeKey: string) {
    return runAsSystem("resolve where an agent home is stored", () =>
      this.prisma.computer.findUnique({
        where: { homeKey },
        select: {
          id: true,
          spaceId: true,
          homeStorageId: true,
          homeStorageKey: true,
          homeStorageRevision: true,
          updatedAt: true,
        },
      }),
    );
  }

  /**
   * Lifecycle claims (booting, suspending) fence on the computer's updatedAt, so recording where
   * a home is stored must leave it unchanged. Writing it back would race a claim landing between
   * the read and the write, so the write also requires the value it read and retries if a claim
   * moved it.
   */
  private async updateKeepingClaim(
    reason: string,
    homeKey: string,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.row(homeKey);
      if (!row) return false;
      const { count } = await runAsSystem(reason, () =>
        this.prisma.computer.updateMany({
          where: { ...where, id: row.id, updatedAt: row.updatedAt },
          data: { ...data, updatedAt: row.updatedAt },
        }),
      );
      if (count === 1) return true;
      const current = await this.row(homeKey);
      if (!current || current.updatedAt.getTime() === row.updatedAt.getTime()) return false;
    }
    return false;
  }

  async load(homeKey: string): Promise<StoredHome | undefined> {
    const row = await this.row(homeKey);
    if (!row?.homeStorageId || !row.homeStorageKey) return undefined;
    return {
      storageId: row.homeStorageId,
      revision: row.homeStorageRevision,
      key: await this.unwrap({
        ...row,
        homeStorageId: row.homeStorageId,
        homeStorageKey: row.homeStorageKey,
      }),
    };
  }

  async create(homeKey: string): Promise<StoredHome | undefined> {
    const row = await this.row(homeKey);
    if (!row) return undefined;
    if (!row.homeStorageId) {
      const storageId = randomBytes(16).toString("hex");
      const wrapped = encryptText(
        await this.ring.current(row.spaceId),
        keyLocation(row.id, storageId),
        randomBytes(32).toString("base64"),
      );
      // Two first saves can race; the loser uses the winner's key.
      await this.updateKeepingClaim(
        "create an agent home's storage key",
        homeKey,
        { homeStorageId: null },
        { homeStorageId: storageId, homeStorageKey: wrapped, homeStorageRevision: null },
      );
    }
    return this.load(homeKey);
  }

  async advance(homeKey: string, storageId: string, from: string | null, to: string) {
    return this.updateKeepingClaim(
      "record an agent home's saved revision",
      homeKey,
      { homeStorageId: storageId, homeStorageRevision: from },
      { homeStorageRevision: to },
    );
  }

  async kinds(homeKeys: readonly string[]) {
    const kinds = new Map<string, string>();
    for (let start = 0; start < homeKeys.length; start += 1000) {
      const rows = await runAsSystem("find which cached agent homes this host may remove", () =>
        this.prisma.computer.findMany({
          where: { homeKey: { in: homeKeys.slice(start, start + 1000) } },
          select: { homeKey: true, kind: true },
        }),
      );
      for (const row of rows) kinds.set(row.homeKey, row.kind);
    }
    return kinds;
  }

  async revisions(storageIds: readonly string[]) {
    const current = new Map<string, string | null>();
    for (let start = 0; start < storageIds.length; start += 1000) {
      const rows = await runAsSystem("find which stored agent homes still exist", () =>
        this.prisma.computer.findMany({
          where: { homeStorageId: { in: storageIds.slice(start, start + 1000) } },
          select: { homeStorageId: true, homeStorageRevision: true },
        }),
      );
      for (const row of rows)
        if (row.homeStorageId) current.set(row.homeStorageId, row.homeStorageRevision);
    }
    return current;
  }

  /** A wrapped key copied to another computer row, or another space, fails to unwrap. */
  private async unwrap(row: {
    id: string;
    spaceId: string;
    homeStorageId: string;
    homeStorageKey: string;
  }): Promise<DataKey> {
    const spaceKeyId = ciphertextKeyId(row.homeStorageKey);
    if (!spaceKeyId) throw new ContentDecryptionError("Stored home key is malformed");
    const spaceKey = await this.ring.byId(spaceKeyId);
    if (spaceKey.spaceId !== row.spaceId)
      throw new ContentDecryptionError("Stored home key belongs to another space");
    const key = Buffer.from(
      decryptText(spaceKey, keyLocation(row.id, row.homeStorageId), row.homeStorageKey),
      "base64",
    );
    if (key.length !== 32) throw new ContentDecryptionError("Stored home key is malformed");
    return { id: row.homeStorageId, spaceId: row.spaceId, version: 1, key };
  }
}

/**
 * The home store for this deployment: object storage when `OBJECT_STORAGE_BUCKET` is set,
 * otherwise homes stay on local disk under `DATA_DIR`, exactly as before.
 */
export function createAgentHomeStore(
  dataDir: string,
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): LocalAgentHomeStore {
  const config = objectStorageConfigFromEnv(env);
  if (!config) return new LocalAgentHomeStore(dataDir);
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring) throw new Error("Storing homes in object storage needs content encryption keys");
  return new ObjectAgentHomeStore(
    dataDir,
    new S3ObjectStorage(config),
    new PrismaAgentHomeRecords(prisma, ring),
  );
}

/**
 * Home cleanup for the worker's reconciler: staging left by killed processes and idle cached
 * copies every ten minutes, and unowned objects hourly when homes are in object storage.
 */
export function homeStorageSweeper(home: AgentHomeStore): (() => Promise<void>) | undefined {
  if (!(home instanceof LocalAgentHomeStore)) return undefined;
  let lastCache: number | undefined;
  let lastObjects: number | undefined;
  return async () => {
    const now = Date.now();
    if (lastCache === undefined || now - lastCache >= CACHE_SWEEP_INTERVAL_MS) {
      lastCache = now;
      const staging = await home.removeStaleStaging(now);
      const cached = home instanceof ObjectAgentHomeStore ? await home.evictIdleCaches(now) : 0;
      if (staging || cached)
        getLogger().info("home.cache.swept", {
          "home.staging.removed": staging,
          "home.cache.evicted": cached,
        });
    }
    if (!(home instanceof ObjectAgentHomeStore)) return;
    if (lastObjects !== undefined && now - lastObjects < SWEEP_INTERVAL_MS) return;
    lastObjects = now;
    const removed = await home.sweep(now);
    if (removed) getLogger().info("home.storage.swept", { "home.objects.removed": removed });
  };
}

function objectKey(storageId: string, revision: string) {
  return `${HOMES_PREFIX}${storageId}/${revision}`;
}

/** Bound into every sealed segment, so an object moved to another home or revision fails. */
function sealedId(storageId: string, revision: string) {
  return `home/${storageId}/${revision}`;
}

function keyLocation(computerId: string, storageId: string): ContentLocation {
  return { table: "computers", column: "homeStorageKey", rowId: computerId, owner: storageId };
}

async function* tap<T extends Uint8Array>(source: AsyncIterable<T>, hash: Hash): AsyncGenerator<T> {
  for await (const chunk of source) {
    hash.update(chunk);
    yield chunk;
  }
}
