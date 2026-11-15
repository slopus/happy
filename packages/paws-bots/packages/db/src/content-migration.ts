import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { ciphertextKeyId, isCiphertext, jsonKeyIds, jsonNeedsSealing } from "./content-crypto.js";
import { contentEncryptionOf, ENCRYPTED_MODELS } from "./content-encryption.js";
import type { ContentKeyRing } from "./content-keys.js";

/**
 * - encrypt: seal plaintext rows (the rollout migration).
 * - reencrypt: also rewrite rows sealed under an older data key version.
 * - decrypt: write plaintext back, for rolling back to a release without encryption.
 */
export type ContentMigrationMode = "encrypt" | "reencrypt" | "decrypt";

interface TableSpec {
  model: keyof typeof ENCRYPTED_MODELS;
  delegate:
    | "message"
    | "event"
    | "memoryDocument"
    | "memoryRevision"
    | "thread"
    | "botEmailMessage";
  /** Scans return them in this order as `values`. */
  columns: string[];
  json: boolean;
  /** Preserve @updatedAt so a migration does not reorder recently edited documents. */
  updatedAt?: boolean;
  scan: (cursor: string, limit: number) => Prisma.Sql;
  writePlaintext: (id: string, row: Record<string, unknown>) => Prisma.Sql;
}

interface ScannedRow {
  id: string;
  values: unknown[];
  spaceId: string | null;
  owner: string;
  tokens?: boolean;
}

const TABLES: TableSpec[] = [
  {
    model: "Message",
    delegate: "message",
    columns: ["blocks"],
    json: true,
    scan: (cursor, limit) => Prisma.sql`
      SELECT m.id, jsonb_build_array(m.blocks) AS values, t."spaceId", m."threadId" AS owner,
        m."searchTokens" IS NOT NULL AS tokens
      FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE m.id > ${cursor} ORDER BY m.id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE messages SET blocks = ${JSON.stringify(row.blocks)}::jsonb, "searchTokens" = NULL WHERE id = ${id}`,
  },
  {
    // A reply's kept tool calls: scalar ciphertext beside the blocks, never search-indexed.
    model: "Message",
    delegate: "message",
    columns: ["toolHistory"],
    json: false,
    scan: (cursor, limit) => Prisma.sql`
      SELECT m.id, jsonb_build_array(m."toolHistory") AS values, t."spaceId", m."threadId" AS owner
      FROM messages m JOIN threads t ON t.id = m."threadId"
      WHERE m.id > ${cursor} AND m."toolHistory" IS NOT NULL ORDER BY m.id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE messages SET "toolHistory" = ${row.toolHistory as string} WHERE id = ${id}`,
  },
  {
    model: "Event",
    delegate: "event",
    columns: ["payload"],
    json: true,
    scan: (cursor, limit) => Prisma.sql`
      SELECT id, jsonb_build_array(payload) AS values, "spaceId", "threadId" AS owner FROM events
      WHERE id > ${cursor} ORDER BY id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE events SET payload = ${JSON.stringify(row.payload)}::jsonb WHERE id = ${id}`,
  },
  {
    model: "MemoryDocument",
    delegate: "memoryDocument",
    columns: ["content"],
    json: false,
    updatedAt: true,
    scan: (cursor, limit) => Prisma.sql`
      SELECT id, jsonb_build_array(content) AS values, "spaceId", "userId" AS owner FROM memory_documents
      WHERE id > ${cursor} ORDER BY id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE memory_documents SET content = ${row.content as string} WHERE id = ${id}`,
  },
  {
    model: "MemoryRevision",
    delegate: "memoryRevision",
    columns: ["content"],
    json: false,
    scan: (cursor, limit) => Prisma.sql`
      SELECT r.id, jsonb_build_array(r.content) AS values, d."spaceId", r."documentId" AS owner
      FROM memory_revisions r JOIN memory_documents d ON d.id = r."documentId"
      WHERE r.id > ${cursor} ORDER BY r.id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE memory_revisions SET content = ${row.content as string} WHERE id = ${id}`,
  },
  {
    model: "Thread",
    delegate: "thread",
    columns: ["historyCompactionSummary"],
    json: false,
    scan: (cursor, limit) => Prisma.sql`
      SELECT id, jsonb_build_array("historyCompactionSummary") AS values, "spaceId", "userId" AS owner FROM threads
      WHERE id > ${cursor} AND "historyCompactionSummary" IS NOT NULL ORDER BY id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE threads SET "historyCompactionSummary" = ${row.historyCompactionSummary as string} WHERE id = ${id}`,
  },
  {
    model: "BotEmailMessage",
    delegate: "botEmailMessage",
    columns: ["fromAddress", "fromName", "subject", "text"],
    json: false,
    scan: (cursor, limit) => Prisma.sql`
      SELECT id, jsonb_build_array("fromAddress", "fromName", subject, text) AS values,
        "spaceId", "botId" AS owner, "searchTokens" IS NOT NULL AS tokens
      FROM bot_email_messages WHERE id > ${cursor} ORDER BY id LIMIT ${limit}`,
    writePlaintext: (id, row) =>
      Prisma.sql`UPDATE bot_email_messages SET "fromAddress" = ${row.fromAddress as string},
        "fromName" = ${row.fromName as string}, subject = ${row.subject as string},
        text = ${row.text as string}, "searchTokens" = NULL WHERE id = ${id}`,
  },
];

function keyIds(table: TableSpec, values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (table.json) return jsonKeyIds(value);
    const id = ciphertextKeyId(value);
    return id ? [id] : [];
  });
}

async function needsWork(
  table: TableSpec,
  row: ScannedRow,
  mode: ContentMigrationMode,
  ring: ContentKeyRing,
): Promise<boolean> {
  const ids = keyIds(table, row.values);
  if (mode === "decrypt") return ids.length > 0 || row.tokens === true;
  const plaintext = row.values.some((value) =>
    table.json ? jsonNeedsSealing(value) : !isCiphertext(value),
  );
  if (plaintext || row.tokens === false) return true;
  if (mode !== "reencrypt" || !row.spaceId) return false;
  const current = await ring.current(row.spaceId);
  return ids.some((id) => id !== current.id);
}

export interface ContentMigrationProgress {
  table: string;
  scanned: number;
  updated: number;
}

/**
 * Walks each encrypted table by id in batches. Rows that need work are locked,
 * re-read through the encrypting client and rewritten in one transaction, so a
 * concurrent application write is never overwritten with stale content. Safe to
 * interrupt and rerun: finished rows are skipped.
 */
export async function migrateContent(
  prisma: PrismaClient,
  options: {
    mode: ContentMigrationMode;
    batchSize?: number;
    dryRun?: boolean;
    signal?: AbortSignal;
    report?: (progress: ContentMigrationProgress) => void;
  },
): Promise<ContentMigrationProgress[]> {
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Content migration needs an encrypting database client");
  const batchSize = options.batchSize ?? 200;
  const results: ContentMigrationProgress[] = [];
  for (const table of TABLES) {
    const progress = { table: ENCRYPTED_MODELS[table.model]!.table, scanned: 0, updated: 0 };
    let cursor = "";
    while (true) {
      options.signal?.throwIfAborted();
      const batch = await prisma.$queryRaw<ScannedRow[]>(table.scan(cursor, batchSize));
      if (!batch.length) break;
      cursor = batch.at(-1)!.id;
      progress.scanned += batch.length;
      const ids: string[] = [];
      for (const row of batch) {
        if (row.spaceId)
          encryption.ring.remember(ENCRYPTED_MODELS[table.model]!.table, row.id, {
            spaceId: row.spaceId,
            owner: row.owner,
          });
        if (await needsWork(table, row, options.mode, encryption.ring)) ids.push(row.id);
      }
      if (ids.length && !options.dryRun) await rewrite(prisma, table, ids, options.mode);
      progress.updated += ids.length;
      options.report?.({ ...progress });
      if (batch.length < batchSize) break;
    }
    results.push(progress);
  }
  return results;
}

async function rewrite(
  prisma: PrismaClient,
  table: TableSpec,
  ids: string[],
  mode: ContentMigrationMode,
) {
  const name = ENCRYPTED_MODELS[table.model]!.table;
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM ${Prisma.raw(`"${name}"`)} WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
      );
      const delegate = Reflect.get(tx, table.delegate);
      const rows = (await Reflect.apply(delegate.findMany, delegate, [
        {
          where: { id: { in: ids } },
          select: {
            id: true,
            ...Object.fromEntries(table.columns.map((column) => [column, true])),
            ...(table.updatedAt ? { updatedAt: true } : {}),
          },
        },
      ])) as Array<Record<string, unknown> & { id: string }>;
      for (const row of rows) {
        const columns = table.columns.filter((column) => row[column] != null);
        if (!columns.length) continue;
        if (mode === "decrypt") {
          // Decrypted text that looks like ciphertext would read as a value under a missing key.
          const plain = Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              typeof value === "string" && ciphertextKeyId(value) ? `\u200b${value}` : value,
            ]),
          );
          await tx.$executeRaw(table.writePlaintext(row.id, { ...plain, id: row.id }));
          continue;
        }
        await Reflect.apply(delegate.update, delegate, [
          {
            where: { id: row.id },
            data: {
              ...Object.fromEntries(columns.map((column) => [column, row[column]])),
              ...(table.updatedAt ? { updatedAt: row.updatedAt } : {}),
            },
            select: { id: true },
          },
        ]);
      }
    },
    { timeout: 60_000 },
  );
}

/**
 * Re-wraps every space key under the provider's active master key. Each new
 * wrap is unwrapped and compared before it replaces the old one, and the
 * replacement is a compare-and-set, so a failure leaves the old wrap in place.
 */
export async function rewrapSpaceKeys(
  prisma: PrismaClient,
  ring: ContentKeyRing,
  options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<{ rewrapped: number; current: number }> {
  const active = ring.provider.activeKeyId();
  const counts = { rewrapped: 0, current: 0 };
  let cursor = "";
  while (true) {
    options.signal?.throwIfAborted();
    const batch = await prisma.spaceKey.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: 200,
    });
    if (!batch.length) break;
    cursor = batch.at(-1)!.id;
    for (const record of batch) {
      if (record.masterKeyId === active) {
        counts.current += 1;
        continue;
      }
      const context = { spaceId: record.spaceId, version: record.version };
      const dataKey = await ring.provider.unwrap(record, context);
      const wrapped = await ring.provider.wrap(dataKey, context);
      const check = await ring.provider.unwrap(wrapped, context);
      if (!Buffer.from(check).equals(Buffer.from(dataKey)))
        throw new Error("Re-wrapped space key did not round-trip");
      if (!options.dryRun)
        await prisma.spaceKey.updateMany({
          where: { id: record.id, masterKeyId: record.masterKeyId, wrappedKey: record.wrappedKey },
          data: wrapped,
        });
      counts.rewrapped += 1;
    }
  }
  return counts;
}

/** Adds a new data key version to every space; older versions keep decrypting. */
export async function rotateSpaceDataKeys(
  prisma: PrismaClient,
  ring: ContentKeyRing,
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  let cursor = "";
  let rotated = 0;
  while (true) {
    options.signal?.throwIfAborted();
    const spaces = await prisma.space.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      select: { id: true },
      take: 200,
    });
    if (!spaces.length) break;
    cursor = spaces.at(-1)!.id;
    for (const space of spaces) {
      await ring.rotate(space.id);
      rotated += 1;
    }
  }
  return rotated;
}

export interface ContentEncryptionStatus {
  table: string;
  rows: number;
  plaintext: number;
}

/** Row counts still waiting for `migrate`, per table. */
export async function contentEncryptionStatus(
  prisma: PrismaClient,
): Promise<{ tables: ContentEncryptionStatus[]; masterKeys: Record<string, number> }> {
  const tables = await prisma.$queryRaw<Array<{ table: string; rows: bigint; plaintext: bigint }>>`
    SELECT 'messages' AS table, count(*) AS rows, count(*) FILTER (WHERE "searchTokens" IS NULL
      OR (cardinality("searchTokens") = 0 AND blocks <> '[]'::jsonb)) AS plaintext FROM messages
    UNION ALL
    SELECT 'messages.toolHistory', count(*) FILTER (WHERE "toolHistory" IS NOT NULL),
      count(*) FILTER (WHERE "toolHistory" NOT LIKE 'rkz1:%') FROM messages
    UNION ALL
    SELECT 'events', count(*), count(*) FILTER (WHERE NOT CASE jsonb_typeof(payload)
      WHEN 'object' THEN jsonb_exists(payload, '$sealed')
      WHEN 'array' THEN jsonb_array_length(payload) = 0 OR jsonb_exists(payload->0, '$sealed')
      ELSE false END) FROM events
    UNION ALL
    SELECT 'memory_documents', count(*), count(*) FILTER (WHERE content NOT LIKE 'rkz1:%') FROM memory_documents
    UNION ALL
    SELECT 'memory_revisions', count(*), count(*) FILTER (WHERE content NOT LIKE 'rkz1:%') FROM memory_revisions
    UNION ALL
    SELECT 'threads', count(*) FILTER (WHERE "historyCompactionSummary" IS NOT NULL),
      count(*) FILTER (WHERE "historyCompactionSummary" NOT LIKE 'rkz1:%') FROM threads
    UNION ALL
    SELECT 'bot_email_messages', count(*), count(*) FILTER (WHERE NOT (text LIKE 'rkz1:%'
      AND subject LIKE 'rkz1:%' AND "fromAddress" LIKE 'rkz1:%' AND "fromName" LIKE 'rkz1:%'))
      FROM bot_email_messages
  `;
  const keys = await prisma.spaceKey.groupBy({ by: ["masterKeyId"], _count: { _all: true } });
  return {
    tables: tables.map((row) => ({
      table: row.table,
      rows: Number(row.rows),
      plaintext: Number(row.plaintext),
    })),
    masterKeys: Object.fromEntries(keys.map((row) => [row.masterKeyId, row._count._all])),
  };
}
