import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitBotUpdate } from "./bot-update.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { installDbContext, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

/** One deadline for every poll of a barrier, inside the transactions' 20s budget. */
const BARRIER_POLL_BUDGET_MS = 4_000;

/** The fixture rows one restyle addresses. */
type Fixture = { spaceId: string; userId: string; threadId: string; botId: string };

/**
 * A restyle of one unpinned bot, as the account route issues it: the same
 * expectation the route passes, inside the bot's space.
 */
function restyle(prisma: PrismaClient, botAvatarSet: string, ids: Fixture) {
  return runAsTenant({ spaceId: ids.spaceId, userId: ids.userId }, () =>
    commitBotUpdate({
      prisma,
      notify: async () => undefined,
      spaceId: ids.spaceId,
      threadId: ids.threadId,
      botId: ids.botId,
      emitBotUpdated: true,
      expectedSettings: { avatarSetPinned: false },
      expectedUserAvatarSet: { userId: ids.userId, botAvatarSet },
      data: { avatarSet: botAvatarSet },
    }),
  );
}

describePostgres("commitBotUpdate against a moving default avatar set (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ids: Fixture & { organizationId: string; routineId: string } = {
    organizationId: `bot-style-org-${suffix}`,
    spaceId: `bot-style-space-${suffix}`,
    userId: `bot-style-user-${suffix}`,
    threadId: `bot-style-thread-${suffix}`,
    botId: `bot-style-bot-${suffix}`,
    routineId: `bot-style-routine-${suffix}`,
  };
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = db.prisma;
    await runAsSystem("test fixture", async () => {
      await prisma.organization.create({
        data: {
          id: ids.organizationId,
          name: "Style",
          slug: ids.organizationId,
          createdAt: new Date(),
        },
      });
      await prisma.space.create({
        data: { id: ids.spaceId, organizationId: ids.organizationId, name: "General" },
      });
      await prisma.user.create({
        data: {
          id: ids.userId,
          name: ids.userId,
          email: `${ids.userId}@rakazo.test`,
          emailVerified: false,
          botAvatarSet: "organic",
        },
      });
      await prisma.bot.create({
        data: {
          id: ids.botId,
          spaceId: ids.spaceId,
          userId: ids.userId,
          name: "Chief",
          color: "#000",
          avatarSet: "organic",
          avatarSetPinned: false,
        },
      });
      await prisma.thread.create({
        data: { id: ids.threadId, spaceId: ids.spaceId, userId: ids.userId, botId: ids.botId },
      });
      await prisma.routine.create({
        data: {
          id: ids.routineId,
          spaceId: ids.spaceId,
          botId: ids.botId,
          userId: ids.userId,
          name: "Weekly",
          prompt: "fixture",
          crons: [],
          active: true,
        },
      });
    });
  });

  afterAll(async () => {
    if (!db) return;
    await runAsSystem("test cleanup", async () => {
      await prisma.organization.deleteMany({ where: { id: ids.organizationId } });
      await prisma.user.deleteMany({ where: { id: ids.userId } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  /**
   * Wait until PostgreSQL itself shows a session blocked on a lock `holder` holds, so a
   * barrier step proves SQL progress instead of assuming it from elapsed time. Returns
   * the blocked backend's pid; all polls of one barrier share its deadline.
   */
  async function waitForBlockedOn(holder: number, what: string, deadline: number): Promise<number> {
    const monitor = await db.pool.connect();
    try {
      while (performance.now() < deadline) {
        const { rows } = await monitor.query(
          "SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pg_blocking_pids(pid) @> ARRAY[$1::int]",
          [holder],
        );
        if (rows.length > 0) return rows[0]!.pid;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timed out waiting for ${what} to block on backend ${holder}`);
    } finally {
      monitor.release();
    }
  }

  /**
   * A barrier client checked out as the job system, as the runtime role sees it.
   * The lock probes below run against row-level-security tables, which hide
   * their rows from a context-free connection, so the probe would lock nothing;
   * the settings the checkout applies stay on the client for its transaction.
   */
  const barrierClient = (reason: string) => runAsSystem(reason, () => db.pool.connect());

  /** An operation set whose failures are handled at once and drained at cleanup. */
  function started() {
    const ops: Array<Promise<unknown>> = [];
    return {
      track: (op: Promise<unknown>) => {
        ops.push(
          op.then(
            () => undefined,
            () => undefined,
          ),
        );
        return op;
      },
      settle: () => Promise.allSettled(ops),
    };
  }

  /**
   * The runtime client with its interactive transactions given twenty seconds, so a
   * restyle sitting at a barrier cannot be expired by Prisma's five-second default.
   */
  const unhurried = () =>
    new Proxy(prisma, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        const transaction = Reflect.get(target, "$transaction").bind(target) as (
          work: unknown,
          options?: Record<string, unknown>,
        ) => unknown;
        return (work: unknown, options?: Record<string, unknown>) =>
          transaction(work, { timeout: 20_000, ...options });
      },
    }) as PrismaClient;

  const rows = () =>
    runAsSystem("test assertion", async () => ({
      user: await prisma.user.findUniqueOrThrow({
        where: { id: ids.userId },
        select: { botAvatarSet: true },
      }),
      bot: await prisma.bot.findUniqueOrThrow({
        where: { id: ids.botId },
        select: { avatarSet: true, avatarSetPinned: true },
      }),
    }));

  it("leaves the bot on the newest default when a newer save lands while the restyle waits on the thread lock", async () => {
    const ops = started();
    const holder = await barrierClient("thread lock barrier");
    try {
      // Request A saves the default rakazo, then its restyle reads the owner's row
      // and waits on the thread lock with the share held.
      await runAsSystem("test fixture", () =>
        prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "rakazo" } }),
      );
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM threads WHERE id = $1 FOR UPDATE", [ids.threadId]);
      const { rows: own } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
      const update = ops.track(restyle(unhurried(), "rakazo", ids));
      const updatePid = await waitForBlockedOn(own[0]!.pid, "the restyle", deadline);
      // Request B saves the default organic while A waits: it queues on A's share of
      // the owner's row, so it cannot slip between A's read and A's write.
      const newer = ops.track(
        runAsSystem("test fixture", () =>
          prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "organic" } }),
        ),
      );
      await waitForBlockedOn(updatePid, "the newer save of the default", deadline);
      await holder.query("COMMIT");
      await update;
      await newer;
      // B's own pass lists the bot (now rakazo) and styles it to its own default.
      await restyle(prisma, "organic", ids);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await ops.settle();
    }

    const state = await rows();
    expect(state.user.botAvatarSet).toBe("organic");
    expect(state.bot).toMatchObject({ avatarSet: "organic", avatarSetPinned: false });
  });

  it("holds off a newer save of the default until the restyle's bot write commits", async () => {
    const ops = started();
    const holder = await barrierClient("bot row lock barrier");
    try {
      await runAsSystem("test fixture", () =>
        prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "rakazo" } }),
      );
      // The bot row is held, so the restyle sits between its FOR SHARE read of the
      // default and its bot write, provably past the read.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM bots WHERE id = $1 FOR UPDATE", [ids.botId]);
      const { rows: own } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
      const update = ops.track(restyle(unhurried(), "rakazo", ids));
      const updatePid = await waitForBlockedOn(own[0]!.pid, "the restyle", deadline);
      const newer = ops.track(
        runAsSystem("test fixture", () =>
          prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "organic" } }),
        ),
      );
      // The newer save waits on the restyle's share of the user row instead of
      // slipping between its read and its write.
      await waitForBlockedOn(updatePid, "the newer save of the default", deadline);
      await holder.query("COMMIT");
      await update;
      await newer;
      // The newer pass lists the bot (now rakazo) and styles it to its own default.
      await restyle(prisma, "organic", ids);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await ops.settle();
    }

    const state = await rows();
    expect(state.user.botAvatarSet).toBe("organic");
    expect(state.bot.avatarSet).toBe("organic");
  });

  it("does not deadlock when a timezone save and a routine wake hold the user and the thread", async () => {
    const ops = started();
    // The probe legs and their monitor get their own pool: the app pool's four
    // connections must stay free for the restyle's transaction. The pool carries
    // the database contexts, so each leg runs as the job system would under the
    // runtime role; a context-free leg sees no routines to lock.
    const side = new Pool({ connectionString: databaseUrl, max: 4 });
    installDbContext(side);
    const routineWake = await runAsSystem("routine wake probe leg", () => side.connect());
    const zoneSave = await runAsSystem("timezone save probe leg", () => side.connect());
    const monitor = await side.connect();
    const deadlocks = async () => {
      const { rows } = await monitor.query<{ deadlocks: string }>(
        "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
      );
      return Number(rows[0]!.deadlocks);
    };
    try {
      await runAsSystem("test fixture", () =>
        prisma.user.update({ where: { id: ids.userId }, data: { botAvatarSet: "rakazo" } }),
      );
      const before = await deadlocks();
      // A routine wake holds its routine row and then inserts a task whose foreign
      // key takes a key-share on the bot's thread.
      await routineWake.query("BEGIN");
      await routineWake.query("SELECT id FROM routines WHERE id = $1 FOR UPDATE", [ids.routineId]);
      const { rows: wakePid } = await routineWake.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      // A timezone save holds the user row and then locks the routine to move it.
      await zoneSave.query("BEGIN");
      await zoneSave.query('UPDATE "user" SET timezone = $1 WHERE id = $2', [
        "Europe/London",
        ids.userId,
      ]);
      const { rows: zonePid } = await zoneSave.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const deadline = performance.now() + BARRIER_POLL_BUDGET_MS;
      const movingRoutine = ops.track(
        zoneSave.query("SELECT id FROM routines WHERE id = $1 FOR UPDATE", [ids.routineId]),
      );
      await waitForBlockedOn(wakePid[0]!.pid, "the timezone save", deadline);
      // The restyle takes the user share first; taking the thread first instead would
      // close the cycle thread ← task ← routine ← user around its own write.
      const update = ops.track(restyle(unhurried(), "rakazo", ids));
      await waitForBlockedOn(zonePid[0]!.pid, "the restyle", deadline);
      const task = ops.track(
        routineWake.query(
          'INSERT INTO tasks (id, "spaceId", "botId", "threadId", "userId", prompt, status, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())',
          [`${ids.routineId}-task`, ids.spaceId, ids.botId, ids.threadId, ids.userId, "x", "open"],
        ),
      );
      // Give the deadlock detector its window; with the user share taken first there
      // is no cycle and the counter never moves.
      for (let waited = 0; waited < 3_000; waited += 100) {
        if ((await deadlocks()) > before) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await routineWake.query("COMMIT").catch(() => routineWake.query("ROLLBACK"));
      await Promise.allSettled([movingRoutine, task]);
      await zoneSave.query("COMMIT").catch(() => zoneSave.query("ROLLBACK"));
      await update;
      expect(await deadlocks()).toBe(before);
      expect((await rows()).bot.avatarSet).toBe("rakazo");
    } finally {
      await routineWake.query("ROLLBACK").catch(() => undefined);
      await zoneSave.query("ROLLBACK").catch(() => undefined);
      routineWake.release();
      zoneSave.release();
      monitor.release();
      await side.end();
      await ops.settle();
    }
  });
});
