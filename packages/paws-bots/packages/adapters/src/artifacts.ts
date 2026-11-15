import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  ArtifactPut,
  ArtifactStore,
  NotificationMessage,
  NotificationProvider,
} from "@rakazo/adapter-kit";
import type { ContentKeyRing } from "@rakazo/db";
import {
  artifactKeyId,
  ContentDecryptionError,
  isSealedArtifact,
  openArtifact,
  sealArtifact,
} from "@rakazo/db";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;
const HEAD_BYTES = 512;

export type ArtifactKeys = Pick<ContentKeyRing, "current" | "byId" | "encryptWrites">;

async function* once(bytes: Uint8Array) {
  yield bytes;
}

async function readHead(handle: FileHandle): Promise<Buffer> {
  const head = Buffer.alloc(HEAD_BYTES);
  const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
  return head.subarray(0, bytesRead);
}

/** Opens a file for reading, or returns undefined if it no longer exists. */
async function openExisting(file: string): Promise<FileHandle | undefined> {
  try {
    return await open(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAll(handle: FileHandle, chunks: AsyncIterable<Uint8Array>) {
  for await (const chunk of chunks) {
    // A write may accept only part of a chunk; keep going until all of it lands.
    for (let offset = 0; offset < chunk.byteLength; ) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
      if (bytesWritten <= 0) throw new Error("Artifact write made no progress");
      offset += bytesWritten;
    }
  }
}

/**
 * Artifact bytes on local disk. With keys, files are sealed with the space's
 * current key in 64 KiB authenticated segments, unless the keys have
 * `encryptWrites` off; plaintext files stay readable either way.
 */
export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly keys?: ArtifactKeys,
  ) {}

  describe() {
    return {
      id: "local-artifacts",
      contractVersion: "1",
      adapterVersion: "0.2.0",
      capabilities: { stream: true },
    };
  }

  /** Resolves a file's key, refusing one from another space (a file copied across spaces). */
  private keyIn(spaceId: string) {
    return async (keyId: string) => {
      const key = await this.keys!.byId(keyId);
      if (key.spaceId !== spaceId)
        throw new ContentDecryptionError("Encrypted artifact belongs to another space");
      return key;
    };
  }

  private file(spaceId: string, id: string) {
    return path.join(this.root, "artifacts", spaceId, id);
  }

  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    const dir = path.join(this.root, "artifacts", context.spaceId);
    await mkdir(dir, { recursive: true });
    const key = this.keys?.encryptWrites ? await this.keys.current(context.spaceId) : undefined;
    const handle = await open(path.join(dir, id), CREATE_FLAGS, 0o600);
    try {
      if (key) await writeAll(handle, sealArtifact(key, id, once(artifact.bytes)));
      else await handle.writeFile(artifact.bytes);
    } finally {
      await handle.close();
    }
    return { id, hash: String(artifact.bytes.byteLength) };
  }

  async get(id: string, context: AdapterContext) {
    const handle = await open(this.file(context.spaceId, id), constants.O_RDONLY | O_NOFOLLOW);
    try {
      if (!isSealedArtifact(await readHead(handle))) return new Uint8Array(await handle.readFile());
      if (!this.keys) throw new Error("Artifact is encrypted but no content keys are configured");
      const parts: Buffer[] = [];
      const stream = handle.createReadStream({ start: 0, autoClose: false });
      for await (const part of openArtifact(this.keyIn(context.spaceId), id, stream))
        parts.push(part);
      return new Uint8Array(Buffer.concat(parts));
    } finally {
      await handle.close();
    }
  }

  async remove(id: string, context: AdapterContext) {
    await rm(this.file(context.spaceId, id), { force: true });
  }

  /** False when the artifact directory is missing, for example when the volume is not mounted. */
  hasDirectory(): Promise<boolean> {
    return stat(path.join(this.root, "artifacts")).then(
      (info) => info.isDirectory(),
      () => false,
    );
  }

  /**
   * For `status`. Files removed while counting are skipped. `abandoned` counts
   * temporary files an interrupted rewrite left behind; they may hold plaintext.
   */
  async fileCounts(): Promise<{
    present: boolean;
    sealed: number;
    plaintext: number;
    abandoned: number;
  }> {
    const counts = { present: await this.hasDirectory(), sealed: 0, plaintext: 0, abandoned: 0 };
    for await (const file of this.entries()) {
      if (file.temporary) {
        counts.abandoned += 1;
        continue;
      }
      const handle = await openExisting(this.file(file.spaceId, file.id));
      if (!handle) continue;
      try {
        if (isSealedArtifact(await readHead(handle))) counts.sealed += 1;
        else counts.plaintext += 1;
      } finally {
        await handle.close();
      }
    }
    return counts;
  }

  /**
   * Deletes temporary files left by an interrupted rewrite (a crash skips the
   * cleanup in `rewriteFile`). Only files older than `olderThanMs` are removed,
   * so a rewrite still in progress elsewhere keeps its file.
   */
  async removeAbandoned(olderThanMs = 10 * 60_000): Promise<number> {
    let removed = 0;
    for await (const file of this.entries()) {
      if (!file.temporary) continue;
      const target = this.file(file.spaceId, file.id);
      const info = await stat(target).catch(() => undefined);
      if (!info || (olderThanMs > 0 && Date.now() - info.mtimeMs < olderThanMs)) continue;
      await rm(target, { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Every stored file, for migrations. */
  async *files(): AsyncGenerator<{ spaceId: string; id: string }> {
    for await (const file of this.entries())
      if (!file.temporary) yield { spaceId: file.spaceId, id: file.id };
  }

  /** Directory listing; a space directory deleted while listing is skipped. */
  private async *entries(): AsyncGenerator<{ spaceId: string; id: string; temporary: boolean }> {
    const base = path.join(this.root, "artifacts");
    const spaces = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const space of spaces) {
      if (!space.isDirectory()) continue;
      const files = await readdir(path.join(base, space.name), { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const file of files)
        if (file.isFile())
          yield { spaceId: space.name, id: file.name, temporary: file.name.includes(".sealing-") };
    }
  }

  /**
   * Migration rewrite of one file: `encrypt` seals plaintext, `reencrypt` also
   * moves files off older key versions, `decrypt` restores plaintext for a
   * rollback. Writes beside the original, syncs, then renames over it, so an
   * interruption leaves the original intact.
   */
  async rewriteFile(
    spaceId: string,
    id: string,
    mode: "encrypt" | "reencrypt" | "decrypt",
  ): Promise<"rewritten" | "unchanged"> {
    if (!this.keys) throw new Error("Content keys are required to rewrite artifacts");
    const file = this.file(spaceId, id);
    // Removed since it was listed: a concurrent delete, not a failure.
    const source = await openExisting(file);
    if (!source) return "unchanged";
    const temp = `${file}.sealing-${randomUUID()}`;
    try {
      const head = await readHead(source);
      const sealed = isSealedArtifact(head);
      const key = mode === "decrypt" ? undefined : await this.keys.current(spaceId);
      if (
        mode === "decrypt"
          ? !sealed
          : sealed && (mode === "encrypt" || artifactKeyId(head) === key!.id)
      )
        return "unchanged";
      const stream = source.createReadStream({ start: 0, autoClose: false });
      const plaintext = sealed ? openArtifact(this.keyIn(spaceId), id, stream) : stream;
      const target = await open(temp, CREATE_FLAGS, 0o600);
      try {
        await writeAll(target, key ? sealArtifact(key, id, plaintext) : plaintext);
        await target.sync();
      } finally {
        await target.close();
      }
      // A file removed while it was being copied must stay removed. The open handle
      // still sees the original: no remaining links means it was deleted, so drop the
      // copy instead of renaming it back into place. Only the instant between this
      // check and the rename remains, and a file restored there is encrypted and has
      // no database row pointing at it.
      if ((await source.stat()).nlink === 0) return "unchanged";
      await rename(temp, file);
      return "rewritten";
    } finally {
      await source.close();
      await rm(temp, { force: true });
    }
  }
}

export class CapturingNotificationProvider implements NotificationProvider {
  readonly sent: NotificationMessage[] = [];

  describe() {
    return {
      id: "capturing",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { push: false, email: false },
    };
  }

  async send(message: NotificationMessage, _context: AdapterContext): Promise<void> {
    this.sent.push(message);
  }
}
