import type { PrismaClient } from "./client.js";
import { ciphertextKeyId, decryptText, encryptText } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";

// A reserved effect kind/status keeps transcripts out of approval queues and
// client events while reusing run/space cascades and latest-only upsert storage.
export const RUN_TURN_CHECKPOINT_KIND = "runtime_checkpoint";
const keyOf = (runId: string) => JSON.stringify([RUN_TURN_CHECKPOINT_KIND, runId]);
const locationOf = (runId: string) => ({
  table: "external_effects",
  column: "result",
  rowId: keyOf(runId),
  owner: runId,
});

export async function loadRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
): Promise<string | undefined> {
  const rows = await prisma.externalEffect.findMany({
    where: {
      runId: run.id,
      spaceId: run.spaceId,
      kind: RUN_TURN_CHECKPOINT_KIND,
      status: RUN_TURN_CHECKPOINT_KIND,
      idempotencyKey: keyOf(run.id),
    },
    select: { result: true },
  });
  const blob = rows[0]?.result;
  if (typeof blob !== "string") return undefined;
  const keyId = ciphertextKeyId(blob);
  if (!keyId) return blob;
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Turn checkpoint encryption is unavailable");
  const key = await encryption.ring.byId(keyId);
  if (key.spaceId !== run.spaceId) throw new Error("Turn checkpoint space mismatch");
  return decryptText(key, locationOf(run.id), blob);
}

export async function saveRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  leaseOwner: string,
  leaseFence: number,
  blob: string,
): Promise<void> {
  const encryption = contentEncryptionOf(prisma);
  const result = encryption?.ring.encryptWrites
    ? encryptText(await encryption.ring.current(run.spaceId), locationOf(run.id), blob)
    : blob;
  await prisma.$transaction(async (tx) => {
    // Lock and fence the run before writing: cancellation/finalization must either
    // follow this write and remove it, or win first and reject it.
    const locked = await tx.run.updateMany({
      where: { id: run.id, spaceId: run.spaceId, status: "running", leaseOwner, leaseFence },
      data: { leaseFence },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before checkpoint");
    await tx.externalEffect.upsert({
      where: { idempotencyKey: keyOf(run.id) },
      create: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: RUN_TURN_CHECKPOINT_KIND,
        status: RUN_TURN_CHECKPOINT_KIND,
        idempotencyKey: keyOf(run.id),
        request: {},
        result,
      },
      update: { result },
    });
  });
}

/** Drop a running run's saved turn, only while this worker still holds its lease. */
export async function dropRunTurnCheckpoint(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
  leaseOwner: string,
  leaseFence: number,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.run.updateMany({
      where: { id: run.id, spaceId: run.spaceId, status: "running", leaseOwner, leaseFence },
      data: { leaseFence },
    });
    if (locked.count !== 1) throw new Error("Run lease expired before checkpoint");
    await clearRunTurnCheckpoints(tx, [run.id]);
  });
}

/** Call after the terminal status write; its fence rejects later checkpoint writes. */
export async function clearRunTurnCheckpoints(
  prisma: Pick<PrismaClient, "externalEffect">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) return;
  await prisma.externalEffect.deleteMany({
    where: {
      runId: { in: [...runIds] },
      kind: RUN_TURN_CHECKPOINT_KIND,
      status: RUN_TURN_CHECKPOINT_KIND,
    },
  });
}
