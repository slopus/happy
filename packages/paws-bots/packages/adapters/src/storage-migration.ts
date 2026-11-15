import { constants } from "node:fs";
import { open, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { LocalArtifactStore } from "./artifacts.js";
import type { PushTokenStore } from "./push-token-store.js";
import { PushSessionEndedError } from "./push-token-store.js";

/** Verify the new bytes before atomically moving the database pointer. Keep originals. */
export async function migrateLocalArtifacts(
  prisma: PrismaClient,
  local: LocalArtifactStore,
  target: ArtifactStore,
  { dryRun = false, signal = new AbortController().signal } = {},
) {
  if (target.describe().id !== "object-artifacts")
    throw new Error("Configure object storage before migrating artifacts");
  return runAsSystem("migrate local artifact contents to encrypted object storage", async () => {
    const counts = { migrated: 0, pending: 0 };
    let cursor: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      const rows = await prisma.artifact.findMany({
        where: {
          storageKey: { not: { startsWith: "object:" } },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: 100,
        select: {
          id: true,
          storageKey: true,
          spaceId: true,
          userId: true,
          name: true,
          mimeType: true,
        },
      });
      if (!rows.length) return counts;
      for (const row of rows) {
        cursor = row.id;
        if (dryRun) {
          counts.pending++;
          continue;
        }
        const context: AdapterContext = {
          spaceId: row.spaceId,
          userId: row.userId,
          operationId: "artifact.migrate",
          traceId: "artifact.migrate",
          signal,
        };
        let bytes: Uint8Array;
        try {
          bytes = await local.get(row.storageKey, context);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // The file can belong to another original volume. Keep scanning this one.
          counts.pending++;
          continue;
        }
        const saved = await target.put({ name: row.name, mimeType: row.mimeType, bytes }, context);
        try {
          if (!Buffer.from(await target.get(saved.id, context)).equals(Buffer.from(bytes)))
            throw new Error("Artifact migration verification failed");
        } catch (error) {
          await target.remove(saved.id, context);
          throw error;
        }
        // A failed DB response may hide a committed update: leave the object on errors.
        const updated = await prisma.artifact.updateMany({
          where: { id: row.id, spaceId: row.spaceId, storageKey: row.storageKey },
          data: { storageKey: saved.id },
        });
        if (updated.count) counts.migrated++;
        else await target.remove(saved.id, context);
      }
    }
  });
}

/** Maintenance-only import. Old processes must be stopped before importing their final files. */
export async function migrateLocalPushTokens(
  dataDir: string,
  tokens: PushTokenStore,
  dryRun = false,
) {
  const dir = path.join(dataDir, "push-tokens");
  const files = await readdir(dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const counts = { migrated: 0, skipped: 0, pending: 0 };
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".txt") || file.name.startsWith(".")) continue;
    if (dryRun) {
      counts.pending++;
      continue;
    }
    const userId = file.name.slice(0, -4);
    const location = path.join(dir, file.name);
    const handle = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let record: string;
    try {
      if ((await handle.stat()).size > 16_384)
        throw new Error("Legacy push registration is too large");
      record = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const [token, sessionId] = record.trim().split("\n");
    if (!token || !sessionId) counts.skipped++;
    else {
      try {
        if (await tokens.importLegacy(userId, token, sessionId)) counts.migrated++;
        else counts.skipped++;
      } catch (error) {
        if (!(error instanceof PushSessionEndedError)) throw error;
        counts.skipped++;
      }
    }
    // No runtime fallback: archived files cannot resurrect a revoked registration.
    await rename(location, `${location}.migrated`);
  }
  return counts;
}
