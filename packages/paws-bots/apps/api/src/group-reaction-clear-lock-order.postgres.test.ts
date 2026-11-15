import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  clearThread,
  createDb,
  createGroupRepos,
  createRepos,
  createThreadMessage,
  lockSpaceGroup,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reactToThreadMessage } from "./thread-reactions.js";
import type { ThreadTarget } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const WAIT_BUDGET_MS = 5_000;
const WAIT_INTERVAL_MS = 20;
// The group writer expires well inside the 20 s test, so its result and the cleanup land first.
const TRANSACTION_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "committed", or the database error line that aborted the transaction. */
const outcome = (result: PromiseSettledResult<unknown>) => {
  if (result.status === "fulfilled") return "committed";
  const lines = String((result.reason as Error)?.message ?? result.reason).split("\n");
  return (lines.find((line) => /deadlock|40P01|expired/i.test(line)) ?? lines[0] ?? "").trim();
};

/**
 * Group writers (sends, handoffs, follow-ups) lock the group row and then its thread.
 * A reaction or a clear in the group must take the two locks in the same order, or the
 * two transactions wait on each other.
 */
describe.skipIf(!enabled)("group reaction and clear lock order (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let provisioned = false;
  let actor: Actor;
  let userId: string;
  let spaceId: string;
  let target: ThreadTarget;
  const address = `group-reaction-lock-${randomUUID()}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    pool = db.pool;
    close = async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    provisioned = true;
    ({ userId, spaceId } = identity);
    actor = { userId, spaceId, email: "group-reaction@example.com", isDeploymentOwner: false };
    const botIds: string[] = [];
    for (const name of ["Ada", "Ben"]) {
      const bot = await runAsTenant(actor, () =>
        createRepos(prisma).createBot(actor, {
          name,
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      );
      botIds.push(bot.id);
    }
    const group = await runAsTenant(actor, () =>
      createGroupRepos(prisma).createGroup(actor, { name: "Reaction lock", botIds }),
    );
    target = {
      kind: "group",
      groupId: group.id,
      threadId: group.threadId!,
      groupName: group.name,
      members: [],
      memberBotIds: botIds,
    };
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  /**
   * Holds a group writer on the group lock, starts the write under test, waits until it
   * queues on that writer, then lets the writer reach for the thread. A deadlock aborts
   * one of the two, so both committing is the whole check.
   */
  async function bothCommitWithGroupWriter(write: () => Promise<unknown>) {
    if (target.kind !== "group") throw new Error("group target expected");
    const { groupId, threadId } = target;
    const probe = await runAsSystem("lock probe", () => pool.connect());
    let locked!: (xactId: string) => void;
    const groupLocked = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let proceed!: () => void;
    const resumed = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let groupWriter: Promise<unknown> = Promise.resolve();
    let work: Promise<unknown> = Promise.resolve();
    try {
      groupWriter = system.$transaction(
        async (tx) => {
          await lockSpaceGroup(tx, actor, groupId);
          const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
          locked(rows[0]?.xactId ?? "");
          await resumed;
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      groupWriter.catch(() => undefined);
      const xactId = await Promise.race([
        groupLocked,
        groupWriter.then(() => {
          throw new Error("the group writer finished before it held the group lock");
        }),
      ]);

      work = write();
      work.catch(() => undefined);

      const deadline = Date.now() + WAIT_BUDGET_MS;
      for (;;) {
        const result = await probe.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        if ((result.rows[0].waiting as number) > 0) break;
        if (Date.now() >= deadline) throw new Error("the write never queued on the group writer");
        await sleep(WAIT_INTERVAL_MS);
      }
      proceed();

      const settled = await Promise.allSettled([groupWriter, work]);
      expect(settled.map(outcome)).toEqual(["committed", "committed"]);
    } finally {
      proceed();
      await Promise.allSettled([groupWriter, work]);
      probe.release();
    }
  }

  it("a reaction and a group writer both commit", async () => {
    if (target.kind !== "group") throw new Error("group target expected");
    const parent = await createThreadMessage(system, {
      threadId: target.threadId,
      role: "bot",
      botId: target.memberBotIds[0],
      blocks: [{ kind: "text", text: "done" }],
    });
    await bothCommitWithGroupWriter(() =>
      runAsTenant(actor, () =>
        reactToThreadMessage(
          { prisma, jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as never },
          actor,
          target,
          { messageId: parent.id, reaction: "👍", clientNonce: randomUUID(), mayStartTurn: false },
        ),
      ),
    );
  }, 20_000);

  it("clearing the group's chat and a group writer both commit", async () => {
    if (target.kind !== "group") throw new Error("group target expected");
    const { groupId, threadId, memberBotIds } = target;
    await bothCommitWithGroupWriter(() =>
      runAsTenant(actor, () =>
        clearThread(prisma, { spaceId, threadId, botId: memberBotIds[0]!, groupId }),
      ),
    );
  }, 20_000);
});
