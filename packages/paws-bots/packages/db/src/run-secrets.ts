import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { clearRunTurnCheckpoints } from "./run-turn-checkpoint.js";

/** A secret card's answer waits under this kind until the resumed run reads it once. */
export function runSecretKind(runId: string): string {
  return `run-secret:${runId}`;
}

/** A login card answered with "Save to Vault" off, kept for this run only under its name. */
export function runLoginKind(runId: string, name: string): string {
  return `run-login:${runId}:${name}`;
}

/** A texted or emailed code answered in chat, kept until it is typed into the page or the run ends. */
export function runCodeKind(runId: string): string {
  return `run-code:${runId}`;
}

/**
 * A code the page took. It is never typed again, and stays only so the run keeps hiding it from
 * what the model reads.
 */
export function runCodeSpentKind(runId: string): string {
  return `run-code-spent:${runId}`;
}

/**
 * An ended run never reads its waiting answer or uses its run-only logins and codes, so drop them
 * with the run. All are stored under the run's user and space, which also keeps this delete on the
 * secrets index.
 */
export async function deleteRunSecretsInTransaction(
  tx: Pick<Prisma.TransactionClient, "secret">,
  runs: ReadonlyArray<{ id: string; userId: string; spaceId: string }>,
): Promise<void> {
  if (runs.length === 0) return;
  await tx.secret.deleteMany({
    where: {
      OR: runs.flatMap((run) => [
        { userId: run.userId, spaceId: run.spaceId, kind: runSecretKind(run.id) },
        { userId: run.userId, spaceId: run.spaceId, kind: runCodeKind(run.id) },
        { userId: run.userId, spaceId: run.spaceId, kind: runCodeSpentKind(run.id) },
        {
          userId: run.userId,
          spaceId: run.spaceId,
          kind: { startsWith: runLoginKind(run.id, "") },
        },
      ]),
    },
  });
}

/**
 * Clear what cancelled runs kept for resuming: the turn checkpoint, any waiting one-time
 * answer, and open approval effects, which a dead run can no longer settle. Paths that cancel
 * by id read each run's user and space here for the secrets index.
 */
export async function clearEndedRunState(
  prisma: Pick<PrismaClient, "run" | "externalEffect" | "secret" | "message">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) return;
  await clearRunTurnCheckpoints(prisma, runIds);
  // Only effects behind an unanswered card: a tool that needs no approval also runs as intended.
  const messages = await prisma.message.findMany({
    where: { runId: { in: [...runIds] }, role: "bot" },
    select: { blocks: true },
  });
  const openCards = messages.flatMap(({ blocks }) =>
    (MessageBlockSchema.array().safeParse(blocks).data ?? []).flatMap((block) =>
      block.kind === "ask" && block.status !== "answered" && block.approvalEffectId
        ? [block.approvalEffectId]
        : [],
    ),
  );
  if (openCards.length > 0) {
    await prisma.externalEffect.updateMany({
      where: { id: { in: openCards }, runId: { in: [...runIds] }, status: "intended" },
      data: { status: "denied" },
    });
  }
  const runs = await prisma.run.findMany({
    where: { id: { in: [...runIds] } },
    select: { id: true, userId: true, spaceId: true },
  });
  await deleteRunSecretsInTransaction(prisma, runs);
}
