import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createGroupRepos } from "./groups.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

const WAIT_BUDGET_MS = 5_000;
const WAIT_INTERVAL_MS = 20;
// The thread writer expires well inside the 20 s test, so its result and the cleanup land first.
const TRANSACTION_TIMEOUT_MS = 8_000;
// How long an upload gets to commit before the test lets the delete go on.
const UPLOAD_SETTLE_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "committed", or the database error line that aborted the transaction. */
const outcome = (result: PromiseSettledResult<unknown>) => {
  if (result.status === "fulfilled") return "committed";
  const lines = String((result.reason as Error)?.message ?? result.reason).split("\n");
  return (lines.find((line) => /deadlock|40P01|expired/i.test(line)) ?? lines[0] ?? "").trim();
};

/**
 * A bot writing its reply locks the group's thread and writes the thread row twice
 * (message, then event counter); the second write takes a key share on the group row.
 * Deleting the group must not hold the group row exclusively while it waits for that
 * thread, or the two transactions wait on each other.
 */
describePostgres("group deletion lock order (PostgreSQL)", { concurrent: false }, () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let provisioned = false;
  let actor: { userId: string; spaceId: string; email: string; isDeploymentOwner: boolean };
  let botId: string;
  let botIds: string[];
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
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "group-delete@example.com",
      isDeploymentOwner: false,
    };
    botIds = [];
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
      createGroupRepos(prisma).createGroup(actor, { name: "Delete lock", botIds }),
    );
    botId = botIds[0]!;
    groupId = group.id;
    threadId = group.threadId!;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    } finally {
      await close?.();
    }
  });

  it("deleting a group and a bot writing in its thread both commit", async () => {
    const probe = await pool.connect();
    let locked!: (xactId: string) => void;
    const threadLocked = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let proceed!: () => void;
    const resumed = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let threadWriter: Promise<unknown> = Promise.resolve();
    let removal: Promise<unknown> = Promise.resolve();
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
            spaceId: actor.spaceId,
            threadId,
            botId,
            type: "thread.message.created",
            payload: {},
          });
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      threadWriter.catch(() => undefined);
      const xactId = await Promise.race([
        threadLocked,
        threadWriter.then(() => {
          throw new Error("the thread writer finished before it held the thread lock");
        }),
      ]);

      removal = runAsTenant(actor, () => createGroupRepos(prisma).removeGroup(actor, groupId));
      removal.catch(() => undefined);

      // Deleting queues on the thread writer before the writer's second thread write.
      const deadline = Date.now() + WAIT_BUDGET_MS;
      for (;;) {
        const result = await probe.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        if ((result.rows[0].waiting as number) > 0) break;
        if (Date.now() >= deadline) throw new Error("deleting never queued on the thread writer");
        await sleep(WAIT_INTERVAL_MS);
      }
      proceed();

      // A deadlock aborts one of the two, so both committing is the whole check.
      const settled = await Promise.allSettled([threadWriter, removal]);
      expect(settled.map(outcome)).toEqual(["committed", "committed"]);
      expect(await system.chatGroup.findUnique({ where: { id: groupId } })).toBeNull();
    } finally {
      proceed();
      await Promise.allSettled([threadWriter, removal]);
      probe.release();
    }
  }, 20_000);

  it("deleting a group returns the key of an artifact uploaded while it waited", async () => {
    const group = await runAsTenant(actor, () =>
      createGroupRepos(prisma).createGroup(actor, { name: "Delete upload", botIds }),
    );
    const groupThreadId = group.threadId!;
    const storageKey = `artifacts/${group.id}/uploaded-during-delete`;
    const probe = await pool.connect();
    let locked!: (xactId: string) => void;
    const threadLocked = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let proceed!: () => void;
    const resumed = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let threadHolder: Promise<unknown> = Promise.resolve();
    let removal: Promise<{ artifactStorageKeys: string[] }> = Promise.resolve({
      artifactStorageKeys: [],
    });
    let upload: Promise<unknown> = Promise.resolve();
    try {
      // A thread writer keeps the delete waiting on the group's thread.
      threadHolder = system.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${groupThreadId} FOR UPDATE`;
          const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
            SELECT pg_current_xact_id()::text AS "xactId"`;
          locked(rows[0]?.xactId ?? "");
          await resumed;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      threadHolder.catch(() => undefined);
      const xactId = await Promise.race([
        threadLocked,
        threadHolder.then(() => {
          throw new Error("the thread holder finished before it held the thread lock");
        }),
      ]);

      removal = runAsTenant(actor, () => createGroupRepos(prisma).removeGroup(actor, group.id));
      removal.catch(() => undefined);
      const deadline = Date.now() + WAIT_BUDGET_MS;
      for (;;) {
        const result = await probe.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        if ((result.rows[0].waiting as number) > 0) break;
        if (Date.now() >= deadline) throw new Error("deleting never queued on the thread holder");
        await sleep(WAIT_INTERVAL_MS);
      }

      // An upload into the group while the delete waits.
      upload = system.artifact.create({
        data: {
          spaceId: actor.spaceId,
          groupId: group.id,
          userId: actor.userId,
          name: "upload.txt",
          mimeType: "text/plain",
          size: 1,
          hash: "upload-hash",
          storageKey,
        },
      });
      upload.catch(() => undefined);
      // The upload either commits now or waits for the delete and then fails; both are fine.
      await Promise.race([upload.catch(() => undefined), sleep(UPLOAD_SETTLE_MS)]);
      proceed();

      const [uploaded, removed] = await Promise.allSettled([upload, removal]);
      expect(outcome(removed)).toBe("committed");
      // A committed upload's row cascades away with the group, so its stored file must be
      // in the cleanup list or it is left behind.
      if (uploaded.status === "fulfilled" && removed.status === "fulfilled") {
        expect(removed.value.artifactStorageKeys).toContain(storageKey);
      }
    } finally {
      proceed();
      await Promise.allSettled([threadHolder, removal, upload]);
      probe.release();
    }
  }, 20_000);
});
