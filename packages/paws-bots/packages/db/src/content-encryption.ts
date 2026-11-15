import type { ContentLocation, DataKey, SearchTokenDomain } from "./content-crypto.js";
import {
  ContentDecryptionError,
  ciphertextKeyId,
  decryptText,
  encryptText,
  jsonKeyIds,
  openJson,
  querySearchTokens,
  sealJson,
  searchTokens,
} from "./content-crypto.js";
import type { ContentKeyRing, RowContext, SpaceSource } from "./content-keys.js";
import { ROW_OWNER } from "./content-keys.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import { historySearchText } from "./history-text.js";
import { createRowId } from "./row-id.js";

/**
 * Scalars that stay readable beside each sealed block because queries filter on
 * them (`array_contains`, `path`, artifact lookups). Everything else in a block,
 * including these values, is only authoritative inside the sealed copy.
 */
const MESSAGE_BLOCK_PLAIN_KEYS = new Set(["kind", "status", "channelId", "serverId", "artifactId"]);
/** Event payload keys that event queries filter on. */
const EVENT_PAYLOAD_PLAIN_KEYS = new Set([
  "messageId",
  "notice",
  "state",
  "updatedAt",
  "streaming",
]);

interface FieldSpec {
  /** Present for JSON columns: the scalar keys kept queryable beside the sealed copy. */
  plainKeys?: ReadonlySet<string>;
  /**
   * Read only by code that selects it: reads leave it out by default (as searchTokens), and
   * search never indexes it, so it never reaches a client through an ordinary read.
   */
  hidden?: boolean;
}

interface ModelSpec {
  table: SpaceSource;
  fields: Record<string, FieldSpec>;
  /** Where the owning space comes from: a column on the row, or a parent row. */
  space: { column: "spaceId" } | { parent: SpaceSource };
  /** Relation field for the owner column (ROW_OWNER), for `connect` writes. */
  ownerRelation: string;
  searchTokens?: boolean;
}

/** Further content columns (external messages, steering, skills, …) add an entry here. */
export const ENCRYPTED_MODELS: Record<string, ModelSpec> = {
  Message: {
    table: "messages",
    fields: { blocks: { plainKeys: MESSAGE_BLOCK_PLAIN_KEYS }, toolHistory: { hidden: true } },
    space: { parent: "threads" },
    ownerRelation: "thread",
    searchTokens: true,
  },
  Event: {
    table: "events",
    fields: { payload: { plainKeys: EVENT_PAYLOAD_PLAIN_KEYS } },
    space: { column: "spaceId" },
    ownerRelation: "thread",
  },
  MemoryDocument: {
    table: "memory_documents",
    fields: { content: {} },
    space: { column: "spaceId" },
    ownerRelation: "user",
  },
  MemoryRevision: {
    table: "memory_revisions",
    fields: { content: {} },
    space: { parent: "memory_documents" },
    ownerRelation: "document",
  },
  /** The compacted summary of older history is derived message content. */
  Thread: {
    table: "threads",
    fields: { historyCompactionSummary: {} },
    space: { column: "spaceId" },
    ownerRelation: "user",
  },
  /** A bot's inbox. Recipients and file names stay plaintext; `key` and `messageId` are lookups. */
  BotEmailMessage: {
    table: "bot_email_messages",
    fields: { fromAddress: {}, fromName: {}, subject: {}, text: {} },
    space: { column: "spaceId" },
    ownerRelation: "bot",
    searchTokens: true,
  },
};

/** Rows whose id → space mapping the ring learns from results, for child writes. */
const PARENT_SOURCES: Record<string, SpaceSource> = {
  Thread: "threads",
  MemoryDocument: "memory_documents",
  Event: "events",
};

type RecordValue = Record<string, unknown>;
type RuntimeDataModel = {
  models: Record<string, { fields: Array<{ name: string; kind: string; type: string }> }>;
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Nulls (SQL or JSON) are stored as nulls: there is nothing to encrypt. */
function writable(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== Prisma.DbNull &&
    value !== Prisma.JsonNull &&
    value !== Prisma.AnyNull
  );
}

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

const ownerOf = (spec: ModelSpec) => ROW_OWNER[spec.table];

/** Columns a row needs beside its encrypted fields to be decrypted and verified. */
function contextColumns(spec: ModelSpec): string[] {
  return ["id", ownerOf(spec), ...("column" in spec.space ? [spec.space.column] : [])];
}

/**
 * Messages carrying blind-index tokens, for queries aliasing messages as `m`.
 * NULL (never encrypted) and an empty list (rewritten with encryption off) both
 * mean the blocks are searched as plaintext.
 */
export const INDEXED_MESSAGE = Prisma.sql`COALESCE(cardinality(m."searchTokens"), 0) > 0`;
export const UNINDEXED_MESSAGE = Prisma.sql`COALESCE(cardinality(m."searchTokens"), 0) = 0`;

export interface ContentEncryption {
  ring: ContentKeyRing;
  /**
   * Decrypts rows read with raw SQL. Rows must include `id` and the owner column
   * (`threadId` for messages and events, `documentId` for revisions, `userId` otherwise).
   */
  openRows<T extends { id: string }>(model: keyof typeof ENCRYPTED_MODELS, rows: T[]): Promise<T[]>;
  /**
   * Seals a row for a raw SQL insert, as `create` would. The row needs its final `id`
   * and the columns that name its owner and space.
   */
  sealRow<T extends { id: string }>(model: keyof typeof ENCRYPTED_MODELS, row: T): Promise<T>;
  /**
   * One token list per key version of the space; a match must contain every token
   * of one list. Empty when the space has no keys, so it has no encrypted rows.
   */
  messageSearchTokens(
    spaceId: string,
    query: string,
    domain: SearchTokenDomain,
  ): Promise<number[][]>;
}

/** Undefined for clients built without content encryption (fakes and temp-table tests). */
export function contentEncryptionOf(prisma: unknown): ContentEncryption | undefined {
  const accessor = (prisma as { $contentEncryption?: () => ContentEncryption } | null)
    ?.$contentEncryption;
  return typeof accessor === "function" ? accessor.call(prisma) : undefined;
}

/**
 * Boot check for composition roots. A malformed master key configuration throws,
 * so the process fails at startup instead of on the first message; master key
 * ids that stored space keys need but cannot use are returned for reporting.
 */
export async function verifyContentKeys(prisma: unknown): Promise<string[]> {
  return (await contentEncryptionOf(prisma)?.ring.unreadableMasterKeys()) ?? [];
}

interface Plan {
  model: string;
  /** Context columns added to the selection only for decryption; removed afterwards. */
  strip: string[];
  relations: Map<string, Plan>;
}

const NESTED_WRITES = ["create", "createMany", "connectOrCreate", "upsert", "update", "updateMany"];
const NO_ROWS = new Set([
  "count",
  "aggregate",
  "groupBy",
  "createMany",
  "updateMany",
  "deleteMany",
]);

/**
 * Encrypts user content at the data-access layer. Writes to the columns in
 * ENCRYPTED_MODELS are sealed with the owning space's current key (unless the
 * ring has `encryptWrites` off, which stores them in plaintext); reads decrypt
 * anywhere the rows appear, including nested `include`/`select`. Plaintext rows
 * from before the migration read unchanged. Nested writes into encrypted models
 * are rejected rather than silently stored in plaintext. Raw SQL is the one
 * bypass: callers that read these columns with `$queryRaw` use `openRows`.
 */
export function withContentEncryption(prisma: PrismaClient, ring: ContentKeyRing): PrismaClient {
  const dataModel = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModel })
    ._runtimeDataModel;
  if (!dataModel?.models) throw new Error("Prisma runtime data model is unavailable");
  const relations = new Map<string, Map<string, string>>();
  for (const [model, { fields }] of Object.entries(dataModel.models))
    relations.set(
      model,
      new Map(
        fields.filter((field) => field.kind === "object").map((field) => [field.name, field.type]),
      ),
    );
  const relationTarget = (model: string, field: string) => relations.get(model)?.get(field);

  function plan(model: string, args: RecordValue | undefined): { args: RecordValue; plan?: Plan } {
    const spec = ENCRYPTED_MODELS[model];
    const next: RecordValue = { ...args };
    const result: Plan = { model, strip: [], relations: new Map() };
    const walk = (selection: RecordValue) => {
      for (const [field, value] of Object.entries(selection)) {
        const target = relationTarget(model, field);
        if (!target || !value) continue;
        const child = plan(target, isRecord(value) ? value : undefined);
        if (!child.plan) continue;
        result.relations.set(field, child.plan);
        selection[field] = Object.keys(child.args).length ? child.args : value;
      }
    };
    if (isRecord(next.select)) {
      const select = { ...next.select };
      walk(select);
      if (spec && Object.keys(spec.fields).some((field) => select[field]))
        for (const column of contextColumns(spec))
          if (!select[column]) {
            select[column] = true;
            result.strip.push(column);
          }
      next.select = select;
    } else {
      if (spec) {
        const omit: RecordValue = isRecord(next.omit) ? { ...next.omit } : {};
        if (spec.searchTokens && omit.searchTokens === undefined) omit.searchTokens = true;
        for (const [field, fieldSpec] of Object.entries(spec.fields))
          if (fieldSpec.hidden && omit[field] === undefined) omit[field] = true;
        for (const column of contextColumns(spec))
          if (omit[column]) {
            delete omit[column];
            result.strip.push(column);
          }
        if (Object.keys(omit).length) next.omit = omit;
        else delete next.omit;
      }
      if (isRecord(next.include)) {
        const include = { ...next.include };
        walk(include);
        next.include = include;
      }
    }
    const relevant = Boolean(spec) || model in PARENT_SOURCES || result.relations.size > 0;
    return { args: next, plan: relevant ? result : undefined };
  }

  type Pending = { row: RecordValue; spec: ModelSpec };
  type Collected = { pending: Pending[]; strip: Array<{ row: RecordValue; columns: string[] }> };
  function collect(value: unknown, node: Plan, out: Collected) {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, node, out);
      return;
    }
    if (!isRecord(value)) return;
    const spec = ENCRYPTED_MODELS[node.model];
    if (spec) out.pending.push({ row: value, spec });
    const source = PARENT_SOURCES[node.model];
    const owner = source ? value[ROW_OWNER[source]] : undefined;
    if (
      source &&
      typeof value.id === "string" &&
      typeof value.spaceId === "string" &&
      typeof owner === "string"
    )
      ring.remember(source, value.id, { spaceId: value.spaceId, owner });
    for (const [field, child] of node.relations) collect(value[field], child, out);
    if (node.strip.length) out.strip.push({ row: value, columns: node.strip });
  }

  async function openAll(value: unknown, node: Plan) {
    const collected: Collected = { pending: [], strip: [] };
    collect(value, node, collected);
    await open(collected.pending);
    for (const { row, columns } of collected.strip)
      for (const column of columns) delete row[column];
  }

  function keyIdsOf(pending: Pending): string[] {
    return Object.entries(pending.spec.fields).flatMap(([field, spec]) => {
      const value = pending.row[field];
      if (spec.plainKeys) return jsonKeyIds(value);
      const id = ciphertextKeyId(value);
      return id ? [id] : [];
    });
  }

  /** The space the row belongs to now: its own column, or its parent's. */
  function rowSpace(spec: ModelSpec, row: RecordValue, owner: string): Promise<string> | string {
    if ("parent" in spec.space) return ring.spaceOf(spec.space.parent, owner);
    const spaceId = row[spec.space.column];
    if (typeof spaceId !== "string")
      throw new ContentDecryptionError(`Encrypted ${spec.table} rows need their space`);
    return spaceId;
  }

  async function open(pending: Pending[]) {
    const encrypted = pending.filter((entry) => keyIdsOf(entry).length);
    const ids = [...new Set(encrypted.flatMap(keyIdsOf))];
    const keys = new Map(
      await Promise.all(ids.map(async (id) => [id, await ring.byId(id)] as const)),
    );
    for (const { row, spec } of encrypted) {
      const rowKeyIds = keyIdsOf({ row, spec });
      const owner = row[ownerOf(spec)];
      if (typeof row.id !== "string" || typeof owner !== "string")
        throw new ContentDecryptionError("Encrypted rows need their id and owner");
      const rowId = row.id;
      // The key names a space; the row must still belong to it. Together with the
      // owner in the AAD, a row moved to another thread, user or space fails here.
      const spaceId = await rowSpace(spec, row, owner);
      for (const [field, fieldSpec] of Object.entries(spec.fields)) {
        if (!(field in row)) continue;
        const location: ContentLocation = { table: spec.table, column: field, rowId, owner };
        const decrypt = (ciphertext: string) => {
          const key = keys.get(ciphertextKeyId(ciphertext)!)!;
          if (key.spaceId !== spaceId)
            throw new ContentDecryptionError("Encrypted content belongs to another space");
          return decryptText(key, location, ciphertext);
        };
        const value = row[field];
        row[field] = fieldSpec.plainKeys
          ? openJson(value, decrypt)
          : ciphertextKeyId(value)
            ? decrypt(value as string)
            : value;
      }
      ring.remember(spec.table, rowId, { spaceId: keys.get(rowKeyIds[0]!)!.spaceId, owner });
    }
  }

  async function seal(spec: ModelSpec, data: RecordValue, rowId: string, context: RowContext) {
    const fields = Object.keys(spec.fields).filter((field) => writable(data[field]));
    if (!fields.length) return data;
    const key: DataKey = await ring.current(context.spaceId);
    const next = { ...data };
    const words: string[] = [];
    const strings: string[] = [];
    for (const field of fields) {
      const location: ContentLocation = {
        table: spec.table,
        column: field,
        rowId,
        owner: context.owner,
      };
      const encrypt = (plaintext: string) => encryptText(key, location, plaintext);
      const plainKeys = spec.fields[field]!.plainKeys;
      let value = next[field];
      if (!plainKeys && isRecord(value) && "set" in value) value = value.set;
      const indexed = !spec.fields[field]!.hidden;
      if (value === null) next[field] = null;
      else if (plainKeys) {
        words.push(historySearchText(value as Prisma.JsonValue));
        strings.push(...stringsIn(value));
        next[field] = sealJson(value, plainKeys, encrypt);
      } else if (typeof value === "string") {
        if (indexed) {
          words.push(value);
          strings.push(value);
        }
        next[field] = encrypt(value);
      } else throw new Error(`Unsupported write to encrypted ${spec.table}.${field}`);
    }
    // Tokens cover the fields written here: indexed models write all of them together.
    if (spec.searchTokens && fields.some((field) => !spec.fields[field]!.hidden))
      next.searchTokens = searchTokens(key, { words: words.join("\n"), strings });
    ring.remember(spec.table, rowId, context);
    return next;
  }

  function touches(spec: ModelSpec, data: unknown, options: { indexedOnly?: boolean } = {}) {
    const rows = Array.isArray(data) ? data : [data];
    const fields = Object.entries(spec.fields)
      .filter(([, field]) => !options.indexedOnly || !field.hidden)
      .map(([name]) => name);
    return rows.some((row) => isRecord(row) && fields.some((field) => writable(row[field])));
  }

  function assertNoNestedEncryptedWrites(model: string, data: unknown) {
    for (const item of Array.isArray(data) ? data : [data]) {
      if (!isRecord(item)) continue;
      for (const [field, value] of Object.entries(item)) {
        const target = relationTarget(model, field);
        if (!target || !isRecord(value)) continue;
        for (const operation of NESTED_WRITES) {
          const nested = value[operation];
          if (nested === undefined) continue;
          // `createMany: { data: [...] }` nests an array of rows one level deeper.
          const payloads = (Array.isArray(nested) ? nested : [nested]).flatMap((entry) =>
            isRecord(entry) ? [entry.data, entry.create, entry.update, entry].flat() : [],
          );
          const spec = ENCRYPTED_MODELS[target];
          if (spec && payloads.some((payload) => touches(spec, payload)))
            throw new Error(`Write encrypted ${target} rows directly, not through a nested write`);
          for (const payload of payloads) assertNoNestedEncryptedWrites(target, payload);
        }
      }
    }
  }

  function connected(data: RecordValue, column: string, relation: string): unknown {
    const value = data[relation];
    return (
      data[column] ?? (isRecord(value) && isRecord(value.connect) ? value.connect.id : undefined)
    );
  }

  async function createContext(spec: ModelSpec, data: RecordValue): Promise<RowContext> {
    const owner = connected(data, ownerOf(spec), spec.ownerRelation);
    if (typeof owner !== "string")
      throw new Error(`Encrypted ${spec.table} writes must name their ${ownerOf(spec)}`);
    if ("parent" in spec.space)
      return { spaceId: await ring.spaceOf(spec.space.parent, owner), owner };
    const spaceId = connected(data, spec.space.column, "space");
    if (typeof spaceId !== "string")
      throw new Error(`Encrypted ${spec.table} writes must name their ${spec.space.column}`);
    return { spaceId, owner };
  }

  async function sealCreate(spec: ModelSpec, data: unknown): Promise<unknown> {
    if (!isRecord(data) || !touches(spec, data)) return data;
    const row = { ...data, id: typeof data.id === "string" ? data.id : createRowId() };
    return seal(spec, row, row.id, await createContext(spec, row));
  }

  /**
   * Encryption off: content is stored as given. A message rewritten in plaintext
   * drops its blind-index tokens (an empty list, since Prisma cannot write NULL to
   * a list), so search matches its text instead of tokens of what it used to say.
   */
  function plainWrite(spec: ModelSpec, operation: string, args: RecordValue): RecordValue {
    args = inertPlaintext(spec, args);
    if (
      spec.searchTokens &&
      ["update", "updateMany", "updateManyAndReturn"].includes(operation) &&
      touches(spec, args.data, { indexedOnly: true })
    )
      return { ...args, data: { ...(args.data as RecordValue), searchTokens: { set: [] } } };
    return args;
  }

  /**
   * Encryption off: text that merely looks like ciphertext (an email subject, say) would
   * later be read as a value under a key that does not exist and fail every read of its
   * row, so a zero-width space keeps it plaintext.
   */
  function inertPlaintext(spec: ModelSpec, args: RecordValue): RecordValue {
    const inert = (row: unknown): unknown => {
      if (!isRecord(row)) return row;
      let out = row;
      for (const [field, fieldSpec] of Object.entries(spec.fields))
        if (!fieldSpec.plainKeys && ciphertextKeyId(row[field]))
          out = { ...out, [field]: `\u200b${row[field]}` };
      return out;
    };
    const data = Array.isArray(args.data) ? args.data.map(inert) : inert(args.data);
    return data === args.data ? args : { ...args, data };
  }

  async function sealWrites(
    model: string,
    operation: string,
    args: RecordValue,
  ): Promise<RecordValue> {
    if (
      [
        "create",
        "createMany",
        "createManyAndReturn",
        "update",
        "updateMany",
        "updateManyAndReturn",
        "upsert",
      ].includes(operation)
    ) {
      assertNoNestedEncryptedWrites(model, args.data);
      if (operation === "upsert") {
        assertNoNestedEncryptedWrites(model, args.create);
        assertNoNestedEncryptedWrites(model, args.update);
      }
    }
    const spec = ENCRYPTED_MODELS[model];
    if (!spec) return args;
    if (operation === "upsert") {
      if (touches(spec, args.create) || touches(spec, args.update))
        throw new Error(`Upserts of encrypted ${model} content are not supported`);
      return args;
    }
    if (!ring.encryptWrites) return plainWrite(spec, operation, args);
    if (operation === "create") return { ...args, data: await sealCreate(spec, args.data) };
    if (operation === "createMany" || operation === "createManyAndReturn") {
      const data = Array.isArray(args.data)
        ? await Promise.all(args.data.map((row) => sealCreate(spec, row)))
        : await sealCreate(spec, args.data);
      return { ...args, data };
    }
    if (
      ["update", "updateMany", "updateManyAndReturn"].includes(operation) &&
      touches(spec, args.data)
    ) {
      const where = isRecord(args.where) ? args.where : {};
      if (typeof where.id !== "string")
        throw new Error(`Encrypted ${model} content must be updated by id`);
      const context = await ring.rowContext(spec.table, where.id);
      return { ...args, data: await seal(spec, args.data as RecordValue, where.id, context) };
    }
    return args;
  }

  const handle: ContentEncryption = {
    ring,
    async openRows(model, rows) {
      await openAll(rows, { model, strip: [], relations: new Map() });
      return rows;
    },
    async sealRow(model, row) {
      if (!ring.encryptWrites) return row;
      return (await sealCreate(ENCRYPTED_MODELS[model]!, row)) as typeof row;
    },
    async messageSearchTokens(spaceId, query, domain) {
      const keys = await ring.allFresh(spaceId);
      return keys.map((key) => querySearchTokens(key, query, domain));
    },
  };

  return prisma.$extends({
    client: {
      $contentEncryption: () => handle,
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (model === "Space" && ["delete", "deleteMany"].includes(operation)) {
            const where = (args as RecordValue).where;
            if (isRecord(where) && typeof where.id === "string") {
              ring.forget(where.id);
              ring.forget(`vault:${where.id}`);
            }
          }
          if (model === "User" && ["delete", "deleteMany"].includes(operation)) {
            const where = (args as RecordValue).where;
            if (isRecord(where) && typeof where.id === "string") ring.forget(`user:${where.id}`);
          }
          let next = await sealWrites(model, operation, (args ?? {}) as RecordValue);
          if (NO_ROWS.has(operation)) return query(next);
          const planned = plan(model, next);
          if (!planned.plan) return query(next);
          next = planned.args;
          const result = await query(next);
          await openAll(result, planned.plan);
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
}
