import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createGroupRepos, lockSpaceGroup } from "./groups.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

const WAIT_BUDGET_MS = 5_000;
const WAIT_INTERVAL_MS = 20;
// Each transaction expires well inside the 20 s test, so its result and the cleanup land first.
const TRANSACTION_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Group writers (sends, handoffs, membership changes) lock the group row and then the
 * group's thread. A thread writer such as run finalization locks the thread and writes
 * its row twice (message counter, then event counter). Postgres re-checks the thread's
 * foreign keys on the second write of a row the transaction already wrote, which takes
 * a key share on the group row: the reverse order. A group lock that conflicts with key
 * shares closed the cycle; this test holds both transactions at that point.
 */
describePostgres("group and thread lock order (PostgreSQL)", { concurrent: false }, () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: Pool;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let groupId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    pool = db.pool;
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    provisioned = true;
    ({ userId, spaceId } = identity);
    const actor = { userId, spaceId, email: "group-lock@example.com", isDeploymentOwner: false };
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
      createGroupRepos(prisma).createGroup(actor, { name: "Lock order", botIds }),
    );
    botId = botIds[0]!;
    groupId = group.id;
    threadId = group.threadId!;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  async function connectProbe() {
    const client = await pool.connect();
    return {
      async waitingOn(xactId: string): Promise<number> {
        const result = await client.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        return result.rows[0].waiting as number;
      },
      release: () => client.release(),
    };
  }

  it("a group writer and a thread writer both commit", async () => {
    const probe = await connectProbe();
    let locked!: (xactId: string) => void;
    const threadLocked = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let proceed!: () => void;
    const resumed = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let threadWriter: Promise<unknown> = Promise.resolve();
    let groupWriter: Promise<unknown> = Promise.resolve();
    try {
      threadWriter = system.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
          await createThreadMessageInTransaction(tx, {
            threadId,
            role: "bot",
            blocks: [{ kind: "text", text: "done" }],
          });
          const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
          locked(rows[0]?.xactId ?? "");
          await resumed;
          await appendEventInTransaction(tx, {
            spaceId,
            threadId,
            botId,
            type: "thread.message.created",
            payload: {},
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      threadWriter.catch(() => undefined);
      // A thread writer that fails before it holds the lock reports its error, not a timeout.
      const xactId = await Promise.race([
        threadLocked,
        threadWriter.then(() => {
          throw new Error("the thread writer finished before it held the thread lock");
        }),
      ]);

      groupWriter = system.$transaction(
        async (tx) => {
          await lockSpaceGroup(tx, { spaceId }, groupId);
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      groupWriter.catch(() => undefined);

      // The group writer holds the group row and queues on the thread row.
      const deadline = Date.now() + WAIT_BUDGET_MS;
      while ((await probe.waitingOn(xactId)) === 0) {
        if (Date.now() >= deadline) throw new Error("the group writer never queued on the thread");
        await sleep(WAIT_INTERVAL_MS);
      }
      proceed();

      // A deadlock aborts one of the two, so both committing is the whole check; the
      // database-wide deadlock counter would also count other test files' transactions.
      const settled = await Promise.allSettled([threadWriter, groupWriter]);
      expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      proceed();
      await Promise.allSettled([threadWriter, groupWriter]);
      probe.release();
    }
  }, 20_000);
});
