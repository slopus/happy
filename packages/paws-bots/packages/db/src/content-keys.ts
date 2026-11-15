import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { KeyProvider, KeyWrapContext, WrappedDataKey } from "@rakazo/adapter-kit";
import { resolveEncryptionKey } from "@rakazo/core";
import type { DataKey } from "./content-crypto.js";
import { createRowId } from "./row-id.js";
import { runAsSystem } from "./row-security.js";

export interface MasterKey {
  id: string;
  key: Uint8Array;
}

/** Master key id derived from ENCRYPTION_KEY when no explicit master keys are configured. */
export const DERIVED_MASTER_KEY_ID = "env";
const MASTER_KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

function parseKeyMaterial(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error("Each master key must be 32 bytes as hex or base64");
  return key;
}

/**
 * `ENCRYPTION_MASTER_KEYS="id:key,older-id:key"`: the first key wraps new data
 * keys, the rest only unwrap. A key derived from ENCRYPTION_KEY is always
 * available for unwrap so deployments that never set master keys keep working,
 * and it is the active key when none are set.
 */
export function masterKeysFromEnv(env: NodeJS.ProcessEnv = process.env): MasterKey[] {
  const derived: MasterKey = {
    id: DERIVED_MASTER_KEY_ID,
    key: Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(resolveEncryptionKey(env), "utf8"),
        Buffer.from("rakazo"),
        "rakazo/content-master-key/v1",
        32,
      ),
    ),
  };
  const configured = (env.ENCRYPTION_MASTER_KEYS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      const id = entry.slice(0, separator);
      if (separator < 1 || !MASTER_KEY_ID.test(id) || id === DERIVED_MASTER_KEY_ID)
        throw new Error("ENCRYPTION_MASTER_KEYS entries must look like id:key");
      return { id, key: parseKeyMaterial(entry.slice(separator + 1)) };
    });
  if (new Set(configured.map((key) => key.id)).size !== configured.length)
    throw new Error("ENCRYPTION_MASTER_KEYS ids must be unique");
  return [...configured, derived];
}

function wrapAad(context: KeyWrapContext): Buffer {
  return Buffer.from(`rakazo/space-key/v1\0${context.spaceId}\0${context.version}`);
}

/** Default provider: AES-256-GCM key wrapping under master keys held in process memory. */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys: Map<string, Uint8Array>;

  constructor(private readonly masterKeys: MasterKey[]) {
    if (!masterKeys.length) throw new Error("At least one master key is required");
    this.keys = new Map(masterKeys.map((key) => [key.id, key.key]));
  }

  describe() {
    return {
      id: "local-master-keys",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { rotate: true },
    };
  }

  activeKeyId(): string {
    return this.masterKeys[0]!.id;
  }

  has(masterKeyId: string): boolean {
    return this.keys.has(masterKeyId);
  }

  async wrap(dataKey: Uint8Array, context: KeyWrapContext): Promise<WrappedDataKey> {
    const masterKeyId = this.activeKeyId();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(masterKeyId)!, iv);
    cipher.setAAD(wrapAad(context));
    const enc = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return {
      masterKeyId,
      wrappedKey: Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64url"),
    };
  }

  async unwrap(wrapped: WrappedDataKey, context: KeyWrapContext): Promise<Uint8Array> {
    const master = this.keys.get(wrapped.masterKeyId);
    if (!master) throw new Error(`Master key ${wrapped.masterKeyId} is not configured`);
    const body = Buffer.from(wrapped.wrappedKey, "base64url");
    try {
      const decipher = createDecipheriv("aes-256-gcm", master, body.subarray(0, 12));
      decipher.setAAD(wrapAad(context));
      decipher.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([
        decipher.update(body.subarray(12, body.length - 16)),
        decipher.final(),
      ]);
    } catch {
      throw new Error(`Space key could not be unwrapped with master key ${wrapped.masterKeyId}`);
    }
  }
}

/**
 * Wraps new space keys with an external key manager while keys wrapped by the local
 * master keys keep unwrapping, so `content-encryption rotate` can move them over.
 */
export function withLocalMasterKeys(external: KeyProvider, local: LocalKeyProvider): KeyProvider {
  const owner = (masterKeyId: string) => (local.has(masterKeyId) ? local : external);
  return {
    describe: () => external.describe(),
    activeKeyId: () => external.activeKeyId(),
    wrap: (dataKey, context) => external.wrap(dataKey, context),
    unwrap: (wrapped, context) => owner(wrapped.masterKeyId).unwrap(wrapped, context),
  };
}

/** Defers reading master keys until content is first encrypted or decrypted. */
export function lazyKeyProvider(create: () => KeyProvider): KeyProvider {
  let provider: KeyProvider | undefined;
  const get = () => (provider ??= create());
  return {
    describe: () => get().describe(),
    activeKeyId: () => get().activeKeyId(),
    wrap: (dataKey, context) => get().wrap(dataKey, context),
    unwrap: (wrapped, context) => get().unwrap(wrapped, context),
  };
}

export interface SpaceKeyRecord {
  id: string;
  spaceId: string;
  version: number;
  masterKeyId: string;
  wrappedKey: string;
}

/** Tables whose rows the ring can resolve to a space and an owner. */
export type SpaceSource =
  | "threads"
  | "messages"
  | "events"
  | "memory_documents"
  | "memory_revisions"
  | "bot_email_messages";

export interface SpaceKeyStore {
  forSpace(spaceId: string): Promise<SpaceKeyRecord[]>;
  byId(id: string): Promise<SpaceKeyRecord | undefined>;
  /** Inserts unless the (space, version) pair exists; returns the stored record either way. */
  insert(record: SpaceKeyRecord): Promise<SpaceKeyRecord>;
  rowContext(source: SpaceSource, id: string): Promise<RowContext | undefined>;
  /** One stored key per master key id in use, to check each can still be unwrapped. */
  sampleByMasterKey(): Promise<SpaceKeyRecord[]>;
}

/**
 * The space a row belongs to and the parent it is bound to (its thread, document
 * or user). Both go into the ciphertext AAD, so a row moved to another thread,
 * document or user fails to decrypt.
 */
export interface RowContext {
  spaceId: string;
  owner: string;
}

/** Column holding each table's owner. Application code never changes these. */
export const ROW_OWNER: Record<SpaceSource, string> = {
  threads: "userId",
  messages: "threadId",
  events: "threadId",
  memory_documents: "userId",
  memory_revisions: "documentId",
  bot_email_messages: "botId",
};

export interface Queryable {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const COLUMNS = `id, "spaceId", version, "masterKeyId", "wrappedKey"`;

/** A vault key was not created because its member or Space was deleted, with all it held. */
export class VaultKeyOwnerGoneError extends Error {
  constructor() {
    super("The member or Space that owns this vault key was deleted");
    this.name = "VaultKeyOwnerGoneError";
  }
}
const ROW_CONTEXT: Record<SpaceSource, string> = {
  threads: `SELECT "spaceId", "userId" AS owner FROM threads WHERE id = $1`,
  events: `SELECT "spaceId", "threadId" AS owner FROM events WHERE id = $1`,
  memory_documents: `SELECT "spaceId", "userId" AS owner FROM memory_documents WHERE id = $1`,
  messages: `SELECT t."spaceId", m."threadId" AS owner FROM messages m JOIN threads t ON t.id = m."threadId" WHERE m.id = $1`,
  memory_revisions: `SELECT d."spaceId", r."documentId" AS owner FROM memory_revisions r JOIN memory_documents d ON d.id = r."documentId" WHERE r.id = $1`,
  bot_email_messages: `SELECT "spaceId", "botId" AS owner FROM bot_email_messages WHERE id = $1`,
};

/**
 * Runs on its own small pool, outside any caller transaction: keys commit
 * immediately, so a rolled-back caller never leaves rows encrypted under a key
 * that does not exist, and key lookups cannot starve the main pool.
 */
export class PgSpaceKeyStore implements SpaceKeyStore {
  constructor(private readonly db: Queryable) {}

  async forSpace(spaceId: string) {
    const { rows } = await this.db.query<SpaceKeyRecord>(
      `SELECT ${COLUMNS} FROM space_keys WHERE "spaceId" = $1 ORDER BY version`,
      [spaceId],
    );
    return rows;
  }

  async byId(id: string) {
    const { rows } = await this.db.query<SpaceKeyRecord>(
      `SELECT ${COLUMNS} FROM space_keys WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async insert(record: SpaceKeyRecord) {
    const values = [
      record.id,
      record.spaceId,
      record.version,
      record.masterKeyId,
      record.wrappedKey,
    ];
    // A vault key is created only while its member or Space exists. The statement locks that row
    // as a foreign key would, so a deletion either waits and then shreds the new key, or commits
    // first and leaves nothing to insert.
    const [, kind, owner] = /^(user|vault):(.+)$/.exec(record.spaceId) ?? [];
    const { rows } = await this.db.query<SpaceKeyRecord>(
      owner
        ? `WITH owner AS (SELECT 1 FROM ${kind === "user" ? `"user"` : "spaces"} WHERE id = $6 FOR KEY SHARE)
           INSERT INTO space_keys (${COLUMNS}) SELECT $1::text, $2::text, $3::int, $4::text, $5::text
           FROM owner ON CONFLICT ("spaceId", version) DO NOTHING RETURNING ${COLUMNS}`
        : `INSERT INTO space_keys (${COLUMNS}) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ("spaceId", version) DO NOTHING RETURNING ${COLUMNS}`,
      owner ? [...values, owner] : values,
    );
    if (rows[0]) return rows[0];
    const existing = (await this.forSpace(record.spaceId)).find(
      (row) => row.version === record.version,
    );
    if (existing) return existing;
    if (owner) throw new VaultKeyOwnerGoneError();
    throw new Error("Space key insert lost a race to a deleted key");
  }

  // Which Space owns a row decides its key, not who may read it: the caller's own
  // query still runs under row-level security, and results are shared across callers.
  async rowContext(source: SpaceSource, id: string) {
    return runAsSystem("resolve the Space that owns an encrypted row", async () => {
      const { rows } = await this.db.query<RowContext>(ROW_CONTEXT[source], [id]);
      return rows[0];
    });
  }

  async sampleByMasterKey() {
    const { rows } = await this.db.query<SpaceKeyRecord>(
      `SELECT DISTINCT ON ("masterKeyId") ${COLUMNS} FROM space_keys ORDER BY "masterKeyId", id`,
    );
    return rows;
  }
}

class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      return;
    }
    return entry.value;
  }
  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
  deleteWhere(predicate: (value: V, key: string) => boolean) {
    for (const [key, entry] of this.entries)
      if (predicate(entry.value, key)) this.entries.delete(key);
  }
  clear() {
    this.entries.clear();
  }
}

export interface ContentKeyRingOptions {
  /** How long unwrapped keys and the current version stay in memory. */
  ttlMs?: number;
  /**
   * False stores new content in plaintext (`CONTENT_ENCRYPTION=off`). Existing
   * ciphertext still decrypts, so turning encryption off never strands data.
   */
  encryptWrites?: boolean;
}

/**
 * Per-space data keys. The newest version encrypts; every version decrypts.
 * Keys are created on first use and cached unwrapped for a bounded time, so a
 * deleted space's key leaves process memory within the TTL.
 */
export class ContentKeyRing {
  private readonly keys: TtlCache<DataKey>;
  private readonly versions: TtlCache<DataKey[]>;
  private readonly rows = new TtlCache<RowContext>(60 * 60_000, 50_000);
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** Whether new content is sealed; reads decrypt either way. */
  readonly encryptWrites: boolean;

  constructor(
    readonly provider: KeyProvider,
    private readonly store: SpaceKeyStore,
    options: ContentKeyRingOptions = {},
  ) {
    this.encryptWrites = options.encryptWrites ?? true;
    const ttl = options.ttlMs ?? 10 * 60_000;
    this.keys = new TtlCache(ttl, 20_000);
    this.versions = new TtlCache(ttl, 20_000);
  }

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async unwrap(record: SpaceKeyRecord): Promise<DataKey> {
    const cached = this.keys.get(record.id);
    if (cached) return cached;
    const key: DataKey = {
      id: record.id,
      spaceId: record.spaceId,
      version: record.version,
      key: await this.provider.unwrap(record, { spaceId: record.spaceId, version: record.version }),
    };
    this.keys.set(record.id, key);
    return key;
  }

  /** Every key version of a space, oldest first. Empty when the space has none yet. */
  all(spaceId: string): Promise<DataKey[]> {
    const cached = this.versions.get(spaceId);
    if (cached) return Promise.resolve(cached);
    return this.once(`space:${spaceId}`, async () => {
      const keys = await Promise.all(
        (await this.store.forSpace(spaceId)).map((row) => this.unwrap(row)),
      );
      if (keys.length) this.versions.set(spaceId, keys);
      return keys;
    });
  }

  /**
   * The key new content is encrypted with, created on first use. A command's `signal` keeps a
   * creation it gave up on, as the key manager held its call open past an interruption, from
   * storing a key afterwards.
   */
  async current(spaceId: string, signal?: AbortSignal): Promise<DataKey> {
    const existing = (await this.all(spaceId)).at(-1);
    return existing ?? this.create(spaceId, 1, signal);
  }

  /** Adds a new version that becomes current. Older versions keep decrypting. */
  async rotate(spaceId: string, signal?: AbortSignal): Promise<DataKey> {
    this.versions.deleteWhere((_, key) => key === spaceId);
    const latest = (await this.all(spaceId)).at(-1);
    return this.create(spaceId, (latest?.version ?? 0) + 1, signal);
  }

  private create(spaceId: string, version: number, signal?: AbortSignal): Promise<DataKey> {
    return this.once(`create:${spaceId}:${version}`, async () => {
      const dataKey = randomBytes(32);
      const wrapped = await this.provider.wrap(dataKey, { spaceId, version });
      signal?.throwIfAborted();
      const stored = await this.store.insert({ id: createRowId(), spaceId, version, ...wrapped });
      this.versions.deleteWhere((_, key) => key === spaceId);
      const key = await this.unwrap(stored);
      await this.all(spaceId);
      return key;
    });
  }

  byId(id: string): Promise<DataKey> {
    const cached = this.keys.get(id);
    if (cached) return Promise.resolve(cached);
    return this.once(`key:${id}`, async () => {
      const record = await this.store.byId(id);
      if (!record) throw new Error("Encrypted content names a space key that no longer exists");
      return this.unwrap(record);
    });
  }

  remember(source: SpaceSource, id: string, context: RowContext) {
    this.rows.set(`${source}:${id}`, context);
  }

  /** A row's space and owner, from rows this process has seen or from the database. */
  async rowContext(source: SpaceSource, id: string): Promise<RowContext> {
    const cacheKey = `${source}:${id}`;
    const cached = this.rows.get(cacheKey);
    if (cached) return cached;
    const context = await this.once(`row:${cacheKey}`, () => this.store.rowContext(source, id));
    if (!context) throw new Error(`Cannot resolve the space for ${source} row`);
    this.rows.set(cacheKey, context);
    return context;
  }

  async spaceOf(source: SpaceSource, id: string): Promise<string> {
    return (await this.rowContext(source, id)).spaceId;
  }

  /**
   * Every key version straight from the store, for search: another process may
   * have rotated the space, and query tokens must cover its newest version.
   */
  async allFresh(spaceId: string): Promise<DataKey[]> {
    this.versions.deleteWhere((_, key) => key === spaceId);
    return this.all(spaceId);
  }

  /**
   * Startup check: reads the master key configuration (throwing if it is malformed)
   * and returns the master key ids that stored space keys use but that can no
   * longer be unwrapped, for example after a key was removed too early.
   */
  async unreadableMasterKeys(): Promise<string[]> {
    this.provider.activeKeyId();
    const unreadable: string[] = [];
    // A database that is not migrated yet (a process starting before the API ran
    // migrations) is not a key problem; content reads report it soon enough.
    const records = await this.store.sampleByMasterKey().catch(() => []);
    for (const record of records) {
      try {
        await this.provider.unwrap(record, { spaceId: record.spaceId, version: record.version });
      } catch {
        unreadable.push(record.masterKeyId);
      }
    }
    return unreadable;
  }

  /** Drops a deleted space's unwrapped keys from memory. */
  forget(spaceId: string) {
    this.keys.deleteWhere((key) => key.spaceId === spaceId);
    this.versions.deleteWhere((_, key) => key === spaceId);
    this.rows.deleteWhere((value) => value.spaceId === spaceId);
  }

  clear() {
    this.keys.clear();
    this.versions.clear();
    this.rows.clear();
  }
}
