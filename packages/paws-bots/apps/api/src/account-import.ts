import { createHash, randomUUID } from "node:crypto";
import type { WriteStream } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { normalizeWorkspacePath, resolveBotWorkspacePath } from "@rakazo/adapters";
import type {
  AccountExportManifest,
  AccountExportRecord,
  AccountImportResult,
  Actor,
} from "@rakazo/contracts";
import {
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_MANIFEST_PATH,
  ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
  ACCOUNT_EXPORT_VERSION,
  AccountExportExecutablesSchema,
  AccountExportManifestSchema,
  AccountExportRecordSchema,
  attachmentSizeLabel,
  resolveBotAvatarSet,
} from "@rakazo/contracts";
import { organicAvatarFamily, STOPPED_HELPER_RESULT } from "@rakazo/core";
import {
  createRepos,
  createSpaceForMember,
  InvalidSpaceNameError,
  Prisma,
  parseComputerMode,
  runAsSystem,
  runAsTenant,
  SpaceLimitError,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { pageViewerCode } from "@rakazo/page-kit/compile";
import { checkPageSource } from "@rakazo/page-kit/validate";
import type { Hono } from "hono";
import { inflateEntry, parseZipArchive, readExact, ZipFormatError } from "./account-zip-reader.js";
import { cancelBody } from "./http-body.js";
import type { SpaceDeletionDeps } from "./space-deletion.js";
import { deleteSpaceWithContent } from "./space-deletion.js";

export const ACCOUNT_IMPORT_LIMITS = {
  /** The uploaded zip as sent. */
  bodyBytes: 4 * 1024 ** 3,
  /** Everything the zip inflates to, so a bomb stops early. */
  unpackedBytes: 16 * 1024 ** 3,
  manifestBytes: 1024 * 1024,
  /** Room for about a million executable paths, more than a space's workspace files could hold. */
  executablesBytes: 64 * 1024 * 1024,
  recordLineBytes: 64 * 1024 * 1024,
  homeFileBytes: ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
};
type ArchiveLimits = typeof ACCOUNT_IMPORT_LIMITS & { artifactBytes: number };

/** Bounds what one push can inflate to (deflate expands at most ~1032x). */
const MESSAGE_BATCH_SIZE = 500;

/** Prefix of the private spool files, exposed so tests can assert cleanup. */
export const SPOOL_PREFIX = "rakazo-account-import-archive-";

/** Slice size for streaming a spilled entry back to its sink. */
const READ_SPILL_BYTES = 16 * 1024;

export class AccountImportError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 = 400,
  ) {
    super(message);
    this.name = "AccountImportError";
  }
}

const unreadable = () => new AccountImportError("The file is not a readable Rakazo export.");
const invalidEntry = () => new AccountImportError("The export contains an unexpected file.");
const outOfOrder = () => new AccountImportError("The export's files are out of order.");
const missingRecord = () => new AccountImportError("The export refers to a missing record.");
const tooLarge = () => new AccountImportError("The export is too large.", 413);

export type AccountImportDeps = SpaceDeletionDeps & { maxArtifactBytes: number };

export type ArchiveEntry =
  | { kind: "manifest" }
  | { kind: "records"; spaceId: string }
  | { kind: "artifact"; spaceId: string; artifactId: string }
  | { kind: "home"; spaceId: string; botId: string; path: string }
  | { kind: "executables"; spaceId: string };

/** Only the documented layout is accepted; anything else, including `..` or absolute paths, fails. */
export function parseEntryName(name: string, index: number): ArchiveEntry {
  if (index === 0) {
    if (name !== ACCOUNT_EXPORT_MANIFEST_PATH) throw unreadable();
    return { kind: "manifest" };
  }
  if (/[\\\0]/.test(name)) throw invalidEntry();
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw invalidEntry();
  const [root, spaceId, section, id, ...rest] = segments;
  if (root !== "spaces" || !spaceId) throw invalidEntry();
  if (section === "records.jsonl" && id === undefined) return { kind: "records", spaceId };
  if (section === "executables.json" && id === undefined) return { kind: "executables", spaceId };
  if (section === "artifacts" && id && rest.length === 0)
    return { kind: "artifact", spaceId, artifactId: id };
  if (section === "homes" && id && rest.length > 0)
    return { kind: "home", spaceId, botId: id, path: normalizeWorkspacePath(rest.join("/")) };
  throw invalidEntry();
}

function entryLimit(entry: ArchiveEntry, limits: ArchiveLimits): number {
  switch (entry.kind) {
    case "manifest":
      return limits.manifestBytes;
    case "executables":
      return limits.executablesBytes;
    case "records":
      return limits.unpackedBytes;
    case "artifact":
      return limits.artifactBytes;
    case "home":
      return limits.homeFileBytes;
  }
}

export interface ArchiveSink {
  open(entry: ArchiveEntry): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * Spools the upload to a private temp file, enforcing the body limit as it
 * arrives. The spool is deleted on every failure here — a body error, a
 * limit breach, or a write failure — and the original error is rethrown.
 */
async function spoolBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  spoolDir = tmpdir(),
): Promise<{ handle: FileHandle; path: string }> {
  const spoolPath = path.join(spoolDir, `${SPOOL_PREFIX}${randomUUID()}`);
  // Exclusive: the temp dir is shared, so a file or link already at the path is never reused.
  const handle = await open(spoolPath, "wx+", 0o600);
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw tooLarge();
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(spoolPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { handle, path: spoolPath };
}

/**
 * Reads the archive from its spooled file. Entries come from the central
 * directory in local-header order and are inflated incrementally, so a zip
 * stored inside the export is opaque data — its inner headers are never
 * mistaken for entries. Each entry inflates into a spill file first, so a
 * whole entry never sits in memory — and a failed entry never reaches the
 * sink. The spool and spill are deleted on every path.
 */
export async function readArchive(
  body: AsyncIterable<Uint8Array>,
  limits: ArchiveLimits,
  sink: ArchiveSink,
  options?: { spoolDir?: string },
): Promise<void> {
  const spool = await spoolBody(body, limits.bodyBytes, options?.spoolDir);
  try {
    const entries = await parseZipArchive(spool.handle);
    let failure: unknown;
    let index = 0;
    let unpacked = 0;
    let entryOpen = false;
    for (const zipEntry of entries) {
      if (failure) break;
      // The spill holds this entry's inflated bytes until the whole entry
      // verifies, so a limit breach or corrupt stream discards it before
      // the sink ever sees the entry — and heap stays bounded no matter
      // how large the entry is.
      const spillPath = `${spool.path}.entry`;
      const spill = await open(spillPath, "wx+", 0o600);
      try {
        const entry = parseEntryName(zipEntry.name, index++);
        const maxBytes = entryLimit(entry, limits);
        let size = 0;
        const pending: Uint8Array[] = [];
        const flush = async () => {
          for (const chunk of pending.splice(0)) await spill.write(chunk);
        };
        await inflateEntry(
          spool.handle,
          zipEntry,
          (data) => {
            size += data.byteLength;
            unpacked += data.byteLength;
            if (size > maxBytes || unpacked > limits.unpackedBytes) {
              // Thrown out of the inflation at once: a bomb stops inflating
              // here instead of running to the end of the entry.
              throw entry.kind === "artifact"
                ? new AccountImportError(
                    `An artifact in the export exceeds the ${attachmentSizeLabel(maxBytes)} limit.`,
                  )
                : entry.kind === "home"
                  ? new AccountImportError(
                      `A workspace file in the export exceeds the ${attachmentSizeLabel(maxBytes)} limit.`,
                    )
                  : tooLarge();
            }
            pending.push(data);
          },
          flush,
        );
        await flush();
        // The whole entry verified: hand it to the sink from the spill.
        await sink.open(entry);
        entryOpen = true;
        let position = 0;
        while (position < size) {
          const want = Math.min(READ_SPILL_BYTES, size - position);
          const chunk = new Uint8Array(want);
          await readExact(spill, position, chunk);
          position += want;
          if (chunk.byteLength) await sink.write(chunk);
        }
        entryOpen = false;
        await sink.close();
      } catch (error) {
        failure ??= error;
      } finally {
        await spill.close().catch(() => undefined);
        await rm(spillPath, { force: true }).catch(() => undefined);
      }
      if (failure) throw failure;
    }
    if (index === 0 || entryOpen) throw unreadable();
  } catch (error) {
    if (error instanceof ZipFormatError) throw unreadable();
    throw error;
  } finally {
    await spool.handle.close().catch(() => undefined);
    await rm(spool.path, { force: true }).catch(() => undefined);
  }
}

/**
 * Bots name pages inside their words as `[title](page:id)`, which whole-value ids miss. Any
 * block's text can carry one (a reply, an ask, a message to another bot), so every string is
 * rewritten.
 */
function remapPageLinks(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string")
    return value.replace(
      /\(page:([A-Za-z0-9_-]{1,64})\)/g,
      (_link, id: string) => `(page:${ids.get(id) ?? id})`,
    );
  if (Array.isArray(value)) return value.map((item) => remapPageLinks(item, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, remapPageLinks(item, ids)]),
    );
  return value;
}

/** No run comes across with an archive, so a helper card still working there shows as stopped. */
function settleRunningHelpers(blocks: unknown[]): unknown[] {
  return blocks.map((block) =>
    block &&
    typeof block === "object" &&
    "kind" in block &&
    block.kind === "subagent" &&
    "status" in block &&
    block.status === "running"
      ? { ...block, status: "failed", result: STOPPED_HELPER_RESULT }
      : block,
  );
}

/** Replaces every string that is exactly a mapped id; ids are random, so text never collides. */
export function remapIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapIds(item, ids));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, remapIds(item, ids)]),
    );
  return value;
}

type RecordOf<T extends AccountExportRecord["type"]> = Extract<AccountExportRecord, { type: T }>;

type PendingArtifact = {
  record: RecordOf<"artifact">;
  id: string;
  stored?: { storageKey: string; hash: string; size: number };
};

/** One source space being written into a new space owned by the importer. */
class SpaceImport {
  readonly ids = new Map<string, string>();
  readonly bots = new Map<
    string,
    { id: string; threadId: string; homeKey: string; directory: string }
  >();
  readonly groupThreads = new Map<string, string>();
  readonly threadSeqs = new Map<string, number>();
  /** Each page's newest version so far, which it opens on; 0 until one arrives. */
  readonly pageVersions = new Map<string, number>();
  readonly seenPageVersions = new Set<string>();
  readonly artifacts = new Map<string, PendingArtifact>();
  readonly parentLinks: Array<{ botId: string; parentBotId: string }> = [];
  readonly homes = new Map<string, string>();
  readonly receivedArtifacts = new Set<string>();
  readonly receivedHomeFiles = new Set<string>();
  boardId: string | null = null;
  maxTicketNumber = 0;
  recordsDone = false;
  executablesDone = false;
  messages: WriteStream | null = null;

  constructor(
    readonly sourceId: string,
    readonly actor: Actor,
    readonly tempDir: string,
  ) {}

  get spaceId() {
    return this.actor.spaceId;
  }

  get messagesPath() {
    return path.join(this.tempDir, "messages.jsonl");
  }

  mapped(id: string): string {
    const next = this.ids.get(id);
    if (!next) throw missingRecord();
    return next;
  }

  optional(id: string | null): string | null {
    return id === null ? null : (this.ids.get(id) ?? null);
  }

  context(botId?: string): AdapterContext {
    return {
      operationId: "account-import",
      traceId: "account-import",
      spaceId: this.actor.spaceId,
      userId: this.actor.userId,
      ...(botId ? { botId } : {}),
      signal: new AbortController().signal,
    };
  }
}

class AccountImporter implements ArchiveSink {
  private manifest: AccountExportManifest | null = null;
  private readonly created: Array<{ id: string; name: string; sourceId: string }> = [];
  private readonly finished = new Set<string>();
  private current: SpaceImport | null = null;
  private entry: ArchiveEntry | null = null;
  private chunks: Uint8Array[] = [];
  private decoder = new TextDecoder();
  private lineParts: string[] = [];
  private lineLength = 0;
  private readonly repos;

  constructor(
    private readonly deps: AccountImportDeps,
    private readonly actor: Actor,
  ) {
    this.repos = createRepos(deps.prisma);
  }

  async open(entry: ArchiveEntry) {
    this.entry = entry;
    this.chunks = [];
    if (entry.kind === "manifest") return;
    const manifest = this.manifest;
    if (!manifest) throw unreadable();
    if (entry.kind === "records") {
      if (this.finished.has(entry.spaceId) || this.current?.sourceId === entry.spaceId)
        throw outOfOrder();
      const space = manifest.spaces.find((candidate) => candidate.id === entry.spaceId);
      if (!space) throw invalidEntry();
      await this.finishSpace();
      this.current = await this.startSpace(space);
      this.decoder = new TextDecoder();
      this.takeLine();
      return;
    }
    const space = this.current;
    if (!space || space.sourceId !== entry.spaceId || !space.recordsDone) throw outOfOrder();
    if (entry.kind === "executables") {
      if (space.executablesDone) throw invalidEntry();
      space.executablesDone = true;
      return;
    }
    if (entry.kind === "artifact") {
      if (!space.artifacts.has(entry.artifactId) || space.receivedArtifacts.has(entry.artifactId))
        throw invalidEntry();
      space.receivedArtifacts.add(entry.artifactId);
      return;
    }
    const key = `${entry.botId}/${entry.path}`;
    if (!space.bots.has(entry.botId) || space.receivedHomeFiles.has(key)) throw invalidEntry();
    space.receivedHomeFiles.add(key);
  }

  async write(chunk: Uint8Array) {
    if (this.entry?.kind !== "records") {
      this.chunks.push(chunk);
      return;
    }
    const text = this.decoder.decode(chunk, { stream: true });
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      this.lineParts.push(text.slice(start, end));
      await this.recordLine(this.takeLine());
      start = end + 1;
    }
    const rest = text.slice(start);
    this.lineParts.push(rest);
    this.lineLength += rest.length;
    if (this.lineLength > ACCOUNT_IMPORT_LIMITS.recordLineBytes) throw tooLarge();
  }

  async close() {
    const entry = this.entry;
    this.entry = null;
    if (!entry) return;
    const bytes = Buffer.concat(this.chunks);
    this.chunks = [];
    switch (entry.kind) {
      case "manifest":
        this.manifest = parseManifest(bytes);
        return;
      case "records":
        return this.closeRecords();
      case "artifact":
        return this.storeArtifact(entry.artifactId, bytes);
      case "home":
        return this.stageHomeFile(entry.botId, entry.path, bytes);
      case "executables":
        return this.markExecutables(bytes);
    }
  }

  async finish(): Promise<AccountImportResult> {
    const manifest = this.manifest;
    if (!manifest || this.entry) throw unreadable();
    await this.finishSpace();
    for (const space of manifest.spaces) {
      if (this.finished.has(space.id)) continue;
      this.current = await this.startSpace(space);
      this.current.recordsDone = true;
      await this.finishSpace();
    }
    const byId = new Map(this.created.map((space) => [space.sourceId, space]));
    return {
      spaces: manifest.spaces.flatMap((space) => {
        const created = byId.get(space.id);
        return created ? [{ id: created.id, name: created.name }] : [];
      }),
    };
  }

  /** All or nothing: every space this import created goes, with its files. */
  async rollback() {
    const space = this.current;
    this.current = null;
    if (space) {
      space.messages?.destroy();
      await Promise.allSettled(
        [...space.artifacts.values()].flatMap((artifact) =>
          artifact.stored
            ? [this.deps.artifacts.remove(artifact.stored.storageKey, space.context())]
            : [],
        ),
      );
      await rm(space.tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const created of [...this.created].reverse()) {
      const owner = { spaceId: this.actor.spaceId, userId: this.actor.userId };
      await runAsTenant({ spaceId: created.id, userId: this.actor.userId }, () =>
        deleteSpaceWithContent(this.deps, owner, created.id),
      ).catch((error) => getLogger().error("account import rollback failed", error));
    }
  }

  private takeLine() {
    const line = this.lineParts.join("");
    this.lineParts = [];
    this.lineLength = 0;
    return line;
  }

  private tenant<T>(fn: () => Promise<T>): Promise<T> {
    const space = this.current;
    if (!space) throw outOfOrder();
    return runAsTenant({ spaceId: space.spaceId, userId: this.actor.userId }, fn);
  }

  private async startSpace(space: AccountExportManifest["spaces"][number]) {
    const { prisma } = this.deps;
    const userId = this.actor.userId;
    const created = await runAsSystem("create a Space for an account import", async () => {
      try {
        return await createSpaceForMember(prisma, {
          currentSpaceId: this.actor.spaceId,
          userId,
          name: space.name,
        });
      } catch (error) {
        if (error instanceof SpaceLimitError || error instanceof InvalidSpaceNameError)
          throw new AccountImportError(error.message);
        throw error;
      }
    });
    this.created.push({ ...created, sourceId: space.id });
    const tempDir = await mkdtemp(path.join(tmpdir(), "rakazo-account-import-"));
    return new SpaceImport(space.id, { ...this.actor, spaceId: created.id }, tempDir);
  }

  private async recordLine(line: string) {
    if (!line) throw unreadable();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw unreadable();
    }
    const record = AccountExportRecordSchema.safeParse(parsed);
    if (!record.success) throw unreadable();
    await this.tenant(() => this.importRecord(record.data));
  }

  private async closeRecords() {
    this.lineParts.push(this.decoder.decode());
    const tail = this.takeLine();
    if (tail) await this.recordLine(tail);
    const space = this.current!;
    // A page without a version could never open.
    if ([...space.pageVersions.values()].includes(0)) throw missingRecord();
    await this.tenant(async () => {
      await this.writeMessages(space);
      const { prisma } = this.deps;
      // The page opens on, and its next save follows, the newest version the archive holds.
      for (const [sourceId, currentVersion] of space.pageVersions)
        await prisma.page.update({
          where: { id: space.mapped(sourceId) },
          data: { currentVersion },
        });
      for (const link of space.parentLinks) {
        const parentBotId = space.ids.get(link.parentBotId);
        if (parentBotId)
          await prisma.bot.update({ where: { id: link.botId }, data: { parentBotId } });
      }
      if (space.boardId)
        await prisma.board.update({
          where: { id: space.boardId },
          data: { nextNumber: space.maxTicketNumber + 1 },
        });
    });
    space.recordsDone = true;
  }

  private async importRecord(record: AccountExportRecord) {
    const space = this.current!;
    const { prisma } = this.deps;
    const { spaceId } = space;
    const userId = this.actor.userId;
    const newId = () => {
      if (space.ids.has(record.id)) throw unreadable();
      const id = randomUUID();
      space.ids.set(record.id, id);
      return id;
    };
    switch (record.type) {
      case "bot_section":
        await prisma.botSection.create({
          data: {
            id: newId(),
            spaceId,
            userId,
            name: record.name,
            position: record.position,
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      case "bot":
        return this.importBot(record);
      case "chat_group": {
        const id = newId();
        await prisma.chatGroup.create({
          data: {
            id,
            spaceId,
            userId,
            name: record.name,
            pinned: record.pinned,
            sectionId: space.optional(record.sectionId),
            archivedAt: date(record.archivedAt),
            createdAt: new Date(record.createdAt),
          },
        });
        const botIds = [...new Set(record.botIds.flatMap((botId) => space.ids.get(botId) ?? []))];
        if (botIds.length)
          await prisma.chatGroupMember.createMany({
            data: botIds.map((botId) => ({ groupId: id, botId })),
          });
        const thread = await prisma.thread.create({ data: { spaceId, groupId: id, userId } });
        space.groupThreads.set(record.id, thread.id);
        return;
      }
      case "thread": {
        if (record.helperBotId) {
          // A helper's thread is one of many per bot, so it gets a new row rather than the bot's.
          const helperBotId = space.bots.get(record.helperBotId)?.id;
          if (!helperBotId) throw missingRecord();
          if (space.ids.has(record.id)) throw unreadable();
          const thread = await prisma.thread.create({
            data: {
              spaceId,
              userId,
              helperBotId,
              historyCompactedUpToSeq: record.historyCompactedUpToSeq,
              historyCompactionSummary: record.historyCompactionSummary,
              createdAt: new Date(record.createdAt),
            },
          });
          space.ids.set(record.id, thread.id);
          space.threadSeqs.set(thread.id, -1);
          return;
        }
        const threadId = record.botId
          ? space.bots.get(record.botId)?.threadId
          : record.groupId
            ? space.groupThreads.get(record.groupId)
            : undefined;
        if (!threadId || space.threadSeqs.has(threadId)) throw missingRecord();
        if (space.ids.has(record.id)) throw unreadable();
        space.ids.set(record.id, threadId);
        space.threadSeqs.set(threadId, -1);
        await prisma.thread.update({
          where: { id: threadId },
          data: {
            historyCompactedUpToSeq: record.historyCompactedUpToSeq,
            historyCompactionSummary: record.historyCompactionSummary,
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      }
      case "message": {
        newId();
        // Blocks may name records later in the file (artifacts), so messages wait for every id.
        space.messages ??= createWriteStream(space.messagesPath);
        await writeLine(space.messages, `${JSON.stringify(record)}\n`);
        return;
      }
      case "page":
        space.pageVersions.set(record.id, 0);
        await prisma.page.create({
          data: {
            id: newId(),
            spaceId,
            userId,
            botId: space.optional(record.botId),
            groupId: space.optional(record.groupId),
            title: record.title,
            pinnedAt: date(record.pinnedAt),
            currentVersion: record.currentVersion,
            createdAt: new Date(record.createdAt),
            updatedAt: new Date(record.updatedAt),
          },
        });
        return;
      case "page_version": {
        const newest = space.pageVersions.get(record.pageId);
        if (newest === undefined) throw missingRecord();
        const pageId = space.mapped(record.pageId);
        const key = `${record.pageId}:${record.version}`;
        if (space.seenPageVersions.has(key)) throw unreadable();
        space.seenPageVersions.add(key);
        space.pageVersions.set(record.pageId, Math.max(newest, record.version));
        // The checker tightens over time and is not the security boundary (the viewer's sandbox
        // is), so a version an older release saved still imports and opens on its own error.
        const check = checkPageSource(record.source);
        await prisma.pageVersion.create({
          data: {
            id: newId(),
            pageId,
            version: record.version,
            title: record.title,
            source: record.source,
            code: check.ok ? check.code : pageViewerCode(record.source),
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      }
      case "artifact":
        space.artifacts.set(record.id, { record, id: newId() });
        if (record.rootArtifactId) space.mapped(record.rootArtifactId);
        return;
      case "memory_document": {
        const botId = record.botId === null ? null : space.mapped(record.botId);
        const existing = await prisma.memoryDocument.findFirst({
          where: { spaceId, scope: record.scope, botId, path: record.path },
          select: { id: true },
        });
        const data = {
          content: record.content,
          revision: record.revision,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
        };
        if (existing) {
          if (space.ids.has(record.id)) throw unreadable();
          space.ids.set(record.id, existing.id);
          await prisma.memoryDocument.update({ where: { id: existing.id }, data });
          return;
        }
        await prisma.memoryDocument.create({
          data: {
            id: newId(),
            spaceId,
            userId,
            botId,
            scope: record.scope,
            path: record.path,
            ...data,
          },
        });
        return;
      }
      case "memory_revision": {
        const documentId = space.mapped(record.documentId);
        await prisma.memoryRevision.create({
          data: {
            id: newId(),
            documentId,
            revision: record.revision,
            content: record.content,
            sourceThreadId: space.optional(record.sourceThreadId),
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      }
      case "routine": {
        const botId = space.mapped(record.botId);
        await prisma.routine.create({
          data: {
            id: newId(),
            spaceId,
            botId,
            userId,
            threadId: space.optional(record.threadId),
            name: record.name,
            prompt: record.prompt,
            crons: record.crons,
            timezone: record.timezone,
            // Nothing fires on the new install until its owner turns the routine on.
            active: false,
            notify: record.notify,
            messageProvider: record.messageProvider,
            modelProvider: record.modelProvider,
            modelId: record.modelId,
            thinkingLevel: record.thinkingLevel,
            watch: jsonValue(record.watch),
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      }
      case "scratchpad_item": {
        const botId = space.mapped(record.botId);
        await prisma.scratchpadItem.create({
          data: {
            id: newId(),
            spaceId,
            botId,
            userId,
            title: record.title,
            status: record.status,
            notes: record.notes,
            createdAt: new Date(record.createdAt),
            updatedAt: new Date(record.updatedAt),
          },
        });
        return;
      }
      case "agent_skill":
        // Scoped to the imported space so a second import cannot shadow skills elsewhere.
        await prisma.agentSkill.create({
          data: {
            id: newId(),
            spaceId,
            userId,
            name: record.name,
            description: record.description,
            content: record.content,
            files: jsonValue(record.files),
            source: "user",
            allSpaces: false,
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      case "board":
        if (space.boardId) throw unreadable();
        space.boardId = newId();
        await prisma.board.create({
          data: {
            id: space.boardId,
            spaceId,
            name: record.name,
            ticketPrefix: record.ticketPrefix,
          },
        });
        return;
      case "ticket": {
        if (!space.boardId) throw missingRecord();
        space.maxTicketNumber = Math.max(space.maxTicketNumber, record.number);
        await prisma.ticket.create({
          data: {
            id: newId(),
            boardId: space.boardId,
            spaceId,
            number: record.number,
            title: record.title,
            description: record.description,
            status: record.status,
            priority: record.priority,
            assigneeBotId: space.optional(record.assigneeBotId),
            createdByBotId: space.optional(record.createdByBotId),
            createdByUserId: record.createdByExporter ? userId : null,
            createdAt: new Date(record.createdAt),
            updatedAt: new Date(record.updatedAt),
            completedAt: date(record.completedAt),
          },
        });
        return;
      }
      case "ticket_comment": {
        const ticketId = space.mapped(record.ticketId);
        await prisma.ticketComment.create({
          data: {
            id: newId(),
            ticketId,
            spaceId,
            authorBotId: space.optional(record.authorBotId),
            authorUserId: record.authoredByExporter ? userId : null,
            body: record.body,
            createdAt: new Date(record.createdAt),
          },
        });
        return;
      }
    }
  }

  /** The normal creation path, so the bot gets its thread, computer, browser profile and memory. */
  private async importBot(record: RecordOf<"bot">) {
    const space = this.current!;
    if (space.ids.has(record.id)) throw unreadable();
    const bot = await this.repos.createBot(space.actor, {
      name: record.name,
      description: record.description,
      instructions: record.instructions,
      notifyOnFinish: record.notifyOnFinish,
      fleetManagement: record.fleetManagement,
      color: record.color,
      avatarSet: resolveBotAvatarSet(record.avatarSet),
      // Bot ids pick the avatar shape; keep the look the bot had.
      avatarFamily: organicAvatarFamily(record.id),
      modelProvider: record.modelProvider,
      modelId: record.modelId,
      thinkingLevel: record.thinkingLevel,
      disabledBuiltinTools: record.disabledBuiltinTools,
      seed: async (tx, botId) => {
        await tx.bot.update({
          where: { id: botId },
          data: {
            pinned: record.pinned,
            position: record.position,
            sectionId: space.optional(record.sectionId),
            archivedAt: date(record.archivedAt),
            memoryScope: record.memoryScope,
            voiceId: record.voiceId,
            autoSpeak: record.autoSpeak,
            teamChatAmbientEnabled: record.teamChatAmbientEnabled,
            teamChatRules: record.teamChatRules,
            crossSpaceCommunication: record.crossSpaceCommunication,
            dailyCheckIns: record.dailyCheckIns,
            replyMode: record.replyMode,
            createdAt: new Date(record.createdAt),
          },
        });
      },
    });
    const { computer, thread } = await this.deps.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: {
        computer: { select: { homeKey: true, scope: true } },
        thread: { select: { id: true } },
      },
    });
    if (!computer || !thread) throw new Error("Imported bot is missing its computer or thread");
    space.ids.set(record.id, bot.id);
    space.bots.set(record.id, {
      id: bot.id,
      threadId: thread.id,
      homeKey: computer.homeKey,
      directory: resolveBotWorkspacePath(parseComputerMode(computer.scope), bot.id, ""),
    });
    if (record.parentBotId)
      space.parentLinks.push({ botId: bot.id, parentBotId: record.parentBotId });
  }

  private async writeMessages(space: SpaceImport) {
    const stream = space.messages;
    if (!stream) return;
    space.messages = null;
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(resolve);
    });
    let batch: Prisma.MessageCreateManyInput[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.deps.prisma.message.createMany({ data: batch });
      batch = [];
    };
    const lines = createInterface({
      input: createReadStream(space.messagesPath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      const record = JSON.parse(line) as RecordOf<"message">;
      const threadId = space.mapped(record.threadId);
      const lastSeq = space.threadSeqs.get(threadId);
      if (lastSeq === undefined) throw missingRecord();
      if (!Array.isArray(record.blocks)) throw unreadable();
      space.threadSeqs.set(threadId, Math.max(lastSeq, record.seq));
      batch.push({
        id: space.mapped(record.id),
        threadId,
        seq: record.seq,
        role: record.role,
        blocks: settleRunningHelpers(
          remapPageLinks(remapIds(record.blocks, space.ids), space.ids) as unknown[],
        ) as Prisma.InputJsonValue,
        botId: space.optional(record.botId),
        replyToMessageId: space.optional(record.replyToMessageId),
        replyQuote: record.replyQuote,
        createdAt: new Date(record.createdAt),
      });
      if (batch.length >= MESSAGE_BATCH_SIZE) await flush();
    }
    await flush();
    await rm(space.messagesPath, { force: true });
    for (const [threadId, lastSeq] of space.threadSeqs) {
      if (lastSeq < 0) continue;
      await this.deps.prisma.thread.update({
        where: { id: threadId },
        data: { nextMessageSeq: lastSeq + 1 },
      });
    }
  }

  private async storeArtifact(sourceId: string, bytes: Uint8Array) {
    const space = this.current!;
    const artifact = space.artifacts.get(sourceId)!;
    const { record } = artifact;
    const botId = space.optional(record.botId) ?? undefined;
    const stored = await this.deps.artifacts.put(
      { name: record.name, mimeType: record.mimeType, bytes },
      space.context(botId),
    );
    artifact.stored = {
      storageKey: stored.id,
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  }

  private async stageHomeFile(sourceBotId: string, relativePath: string, bytes: Uint8Array) {
    const space = this.current!;
    const bot = space.bots.get(sourceBotId)!;
    let staging = space.homes.get(bot.homeKey);
    if (!staging) {
      staging = path.join(space.tempDir, `home-${space.homes.size}`);
      await this.deps.home.checkout(bot.homeKey, staging, space.context(bot.id));
      space.homes.set(bot.homeKey, staging);
    }
    const target = path.join(staging, bot.directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  /** Only files already in this archive can be marked, after they were staged. */
  private async markExecutables(bytes: Uint8Array) {
    const space = this.current!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw unreadable();
    }
    const executables = AccountExportExecutablesSchema.safeParse(parsed);
    if (!executables.success) throw unreadable();
    for (const { botId, path: filePath } of executables.data) {
      const bot = space.bots.get(botId);
      let relativePath: string;
      try {
        relativePath = normalizeWorkspacePath(filePath);
      } catch {
        throw invalidEntry();
      }
      const staging = bot && space.homes.get(bot.homeKey);
      if (!bot || !staging || !space.receivedHomeFiles.has(`${botId}/${relativePath}`))
        throw invalidEntry();
      await chmod(path.join(staging, bot.directory, relativePath), 0o755);
    }
  }

  private async finishSpace() {
    const space = this.current;
    if (!space) return;
    if (!space.recordsDone) throw unreadable();
    await this.tenant(async () => {
      const rows: Prisma.ArtifactCreateManyInput[] = [];
      const kept = new Set<string>();
      for (const { record, id, stored } of space.artifacts.values()) {
        // The exporter skips files it could not read; their versions go with them.
        if (!stored) continue;
        if (record.rootArtifactId && !kept.has(record.rootArtifactId)) {
          await this.deps.artifacts.remove(stored.storageKey, space.context());
          continue;
        }
        kept.add(record.id);
        rows.push({
          id,
          spaceId: space.spaceId,
          userId: this.actor.userId,
          botId: space.optional(record.botId),
          groupId: space.optional(record.groupId),
          name: record.name,
          description: record.description,
          mimeType: record.mimeType,
          size: stored.size,
          hash: stored.hash,
          storageKey: stored.storageKey,
          rootArtifactId: space.optional(record.rootArtifactId),
          version: record.version,
          standalone: record.standalone === true,
          createdAt: new Date(record.createdAt),
        });
      }
      if (rows.length) await this.deps.prisma.artifact.createMany({ data: rows });
    });
    for (const [homeKey, staging] of space.homes)
      await this.deps.home.commit(homeKey, staging, space.context());
    this.finished.add(space.sourceId);
    this.current = null;
    await rm(space.tempDir, { recursive: true, force: true });
  }
}

function parseManifest(bytes: Uint8Array): AccountExportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw unreadable();
  }
  const format = (parsed as { format?: unknown } | null)?.format;
  const version = (parsed as { version?: unknown } | null)?.version;
  if (format !== ACCOUNT_EXPORT_FORMAT) throw unreadable();
  const manifest = AccountExportManifestSchema.safeParse(parsed);
  if (manifest.success) return manifest.data;
  if (version !== ACCOUNT_EXPORT_VERSION)
    throw new AccountImportError("This export is from a newer version of Rakazo.");
  throw unreadable();
}

function date(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

async function writeLine(stream: WriteStream, line: string) {
  if (stream.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

export async function importAccount(
  deps: AccountImportDeps,
  actor: Actor,
  body: AsyncIterable<Uint8Array>,
): Promise<AccountImportResult> {
  const importer = new AccountImporter(deps, actor);
  try {
    await readArchive(
      body,
      { ...ACCOUNT_IMPORT_LIMITS, artifactBytes: deps.maxArtifactBytes },
      importer,
    );
    return await importer.finish();
  } catch (error) {
    await importer.rollback();
    throw error;
  }
}

async function* boundedBody(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      yield value;
    }
  } finally {
    cancelBody(reader);
  }
}

export function mountAccountImportRoute(
  app: Hono,
  deps: AccountImportDeps,
  authenticate: (request: Request) => Promise<Actor | null>,
) {
  app.post("/api/account/import", async (c) => {
    const request = c.req.raw;
    const actor = await authenticate(request);
    if (!actor) {
      cancelBody(request.body);
      return c.json({ error: "Unauthorized" }, 401);
    }
    // A non-simple content type keeps cross-site form posts from reaching the importer.
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/zip" || !request.body) {
      cancelBody(request.body);
      return c.json({ error: "Send the export as application/zip." }, 415);
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > ACCOUNT_IMPORT_LIMITS.bodyBytes) {
      cancelBody(request.body);
      return c.json({ error: tooLarge().message }, 413);
    }
    try {
      return c.json(
        await importAccount(
          deps,
          actor,
          boundedBody(request.body, ACCOUNT_IMPORT_LIMITS.bodyBytes),
        ),
      );
    } catch (error) {
      if (error instanceof AccountImportError)
        return c.json({ error: error.message }, error.status);
      getLogger().error("account import failed", error);
      return c.json({ error: "The import failed." }, 500);
    }
  });
}
