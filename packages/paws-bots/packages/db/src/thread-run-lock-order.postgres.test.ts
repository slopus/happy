import { TAKEOVER_COMPUTER_PENDING_STATE } from "@rakazo/core";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb, Prisma } from "./client.js";
import { clearThread } from "./events.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { answerTakeoverRequest } from "./thread-takeover.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

// Both paths must be observed blocked on the held row within this budget.
const WAIT_BUDGET_MS = 5_000;
const WAIT_INTERVAL_MS = 20;
// Once blocked, each path is sampled over this window; a run-row lock taken before
// the thread row appears in every sample, because the blocker never releases.
const SAMPLE_COUNT = 10;
const SAMPLE_INTERVAL_MS = 25;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Clearing a thread and releasing computer control once deadlocked against each other:
 * clearing held the thread row and reached for the control run (or, on rows written by
 * pre-lease releases, the computer row), while the release held the computer and the
 * run and reached for the thread. The release path now locks computer, then thread,
 * then run, and clearing locks the thread before any run and touches no computer row
 * inside its transaction. Each test holds a row from a second transaction and proves
 * the function under test blocks where the lock order says, holding nothing else.
 */
describePostgres("thread row before run rows for clear and control release (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: Pool;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  let stamp = 0;

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
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    ));
    provisioned = true;
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

  /** A second transaction holding one row, standing in for the concurrent actor. */
  function holdRow(table: "threads" | "computers", id: string) {
    let locked!: (xactId: string) => void;
    const lockTaken = new Promise<string>((resolve) => {
      locked = resolve;
    });
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const done = system.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM ${Prisma.raw(table)} WHERE id = ${id} FOR UPDATE`,
        );
        const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
          SELECT pg_current_xact_id()::text AS "xactId"`;
        locked(rows[0]?.xactId ?? "");
        await opened;
      },
      { timeout: 30_000 },
    );
    return { lockTaken, open: () => open(), done };
  }

  /**
   * Lock probes on their own connection, checked out under the system bypass: runs and
   * computers are row-level-security tables, so an unscoped connection sees no rows and
   * every probe would silently report "not locked".
   */
  async function connectProbe() {
    const client = await runAsSystem("lock probe", () => pool.connect());
    return {
      async rowLocked(table: "runs" | "computers", id: string): Promise<boolean> {
        try {
          const result = await client.query(
            `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`,
            [id],
          );
          // A blind probe passes every test; make invisibility a failure of its own.
          expect(result.rows, `probe must see the ${table} row it probes`).toHaveLength(1);
          return false;
        } catch (error) {
          if ((error as { code?: string }).code === "55P03") return true;
          throw error;
        }
      },
      async runStatus(id: string): Promise<string | null> {
        const result = await client.query<{ status: string | null }>(
          "SELECT status FROM runs WHERE id = $1",
          [id],
        );
        return result.rows[0]?.status ?? null;
      },
      /** Backends waiting on the holder's transaction: the function under test, blocked. */
      async waitingOnHolder(xactId: string): Promise<number> {
        const result = await client.query(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [xactId],
        );
        return result.rows[0].waiting as number;
      },
      release: () => client.release(),
    };
  }

  type Probe = Awaited<ReturnType<typeof connectProbe>>;

  async function untilBlocked(probe: Probe, xactId: string) {
    const deadline = Date.now() + WAIT_BUDGET_MS;
    for (;;) {
      if ((await probe.waitingOnHolder(xactId)) > 0) return;
      if (Date.now() >= deadline) {
        throw new Error("the function under test did not block on the held thread row");
      }
      await sleep(WAIT_INTERVAL_MS);
    }
  }

  async function untilRunCancelled(probe: Probe, runId: string) {
    const deadline = Date.now() + WAIT_BUDGET_MS;
    for (;;) {
      if ((await probe.runStatus(runId)) === "cancelled") return;
      if (Date.now() >= deadline) {
        throw new Error("the cancellation did not commit while the computer row was held");
      }
      await sleep(WAIT_INTERVAL_MS);
    }
  }

  async function isPending(work: Promise<unknown>): Promise<boolean> {
    const state = await Promise.race([
      Promise.resolve(work).then(
        () => "settled",
        () => "settled",
      ),
      sleep(75).then(() => "pending"),
    ]);
    return state === "pending";
  }

  /** A run in this thread, paused to wait for control handback. */
  async function createWaitingTakeoverRun(): Promise<string> {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "hand back control", status: "running" },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: "waiting_takeover",
        trigger: "user",
        startedAt: new Date(),
      },
    });
    // The run asked for help with a card, as a paused run always has.
    const cardSeq = await system.thread.update({
      where: { id: threadId },
      data: { nextMessageSeq: { increment: 1 } },
      select: { nextMessageSeq: true },
    });
    await system.message.create({
      data: {
        threadId,
        botId,
        runId: run.id,
        seq: cardSeq.nextMessageSeq - 1,
        role: "bot",
        blocks: [{ kind: "computer", state: TAKEOVER_COMPUTER_PENDING_STATE, text: "Sign in." }],
      },
    });
    return run.id;
  }

  it("answering a takeover blocks on the thread row without holding the waiting run", async () => {
    const runId = await createWaitingTakeoverRun();

    const holder = holdRow("threads", threadId);
    let probe: Probe | undefined;
    let work: Promise<unknown> = Promise.resolve();
    try {
      const xactId = await holder.lockTaken;
      probe = await connectProbe();
      work = runAsTenant({ spaceId, userId }, () =>
        answerTakeoverRequest(prisma, { spaceId, botId, runId, reason: "done" }),
      );
      work.catch(() => undefined);

      await untilBlocked(probe, xactId);
      // The run row stays free the whole time: taking it before the thread row is
      // the inverted half of the old cycle.
      for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
        expect(await probe.rowLocked("runs", runId)).toBe(false);
        await sleep(SAMPLE_INTERVAL_MS);
      }
      expect(await isPending(work)).toBe(true);

      holder.open();
      await holder.done;
      expect(await work).toBe(true);
      expect(await system.run.findUnique({ where: { id: runId } })).toMatchObject({
        status: "queued",
        checkpoint: "takeover",
      });
      // Keep the active-run set empty so the clears below cancel exactly their own runs.
      await system.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    } finally {
      await settle(holder, work, probe);
    }
  }, 20_000);

  it("clear blocks on the thread row without holding the thread's runs", async () => {
    const runId = await createWaitingTakeoverRun();

    const holder = holdRow("threads", threadId);
    let probe: Probe | undefined;
    let work: Promise<unknown> = Promise.resolve();
    try {
      const xactId = await holder.lockTaken;
      probe = await connectProbe();
      work = runAsTenant({ spaceId, userId }, () =>
        clearThread(prisma, { spaceId, threadId, botId }),
      );
      work.catch(() => undefined);

      await untilBlocked(probe, xactId);
      // Clearing queues on the thread row it locks first; cancelling the runs before
      // that is the other half of the old cycle against the computer-control release.
      for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
        expect(await probe.rowLocked("runs", runId)).toBe(false);
        await sleep(SAMPLE_INTERVAL_MS);
      }
      expect(await isPending(work)).toBe(true);

      holder.open();
      await holder.done;
      const cleared = await work;
      expect(cleared).toMatchObject({
        event: { type: "thread.cleared" },
        cancelledRunIds: [runId],
      });
      expect(await system.run.findUnique({ where: { id: runId } })).toMatchObject({
        status: "cancelled",
      });
    } finally {
      await settle(holder, work, probe);
    }
  }, 20_000);

  it("clear commits without a legacy-bound computer and cleans the binding after", async () => {
    const runId = await createWaitingTakeoverRun();
    stamp += 1;
    const computer = await system.computer.create({
      data: {
        spaceId,
        userId,
        scope: "dedicated",
        scopeKey: `thread-run-lock-${address}-${stamp}`,
        homeKey: `thread-run-lock-home-${address}-${stamp}`,
        kind: "fake",
        // A pre-lease release left this run bound as the computer's execution.
        executionRunId: runId,
        executionBotId: botId,
      },
    });

    const holder = holdRow("computers", computer.id);
    let probe: Probe | undefined;
    let work: Promise<unknown> = Promise.resolve();
    try {
      await holder.lockTaken;
      probe = await connectProbe();
      work = runAsTenant({ spaceId, userId }, () =>
        clearThread(prisma, { spaceId, threadId, botId }),
      );
      work.catch(() => undefined);

      // The cancellation commits while the computer row is held elsewhere: the clear
      // transaction no longer reaches for the computer row under the thread lock,
      // which is what closed the cycle with a concurrent control release.
      await untilRunCancelled(probe, runId);
      expect(await probe.rowLocked("computers", computer.id)).toBe(true);
      // The legacy cleanup follows the transaction and waits out the computer holder.
      expect(await isPending(work)).toBe(true);

      holder.open();
      await holder.done;
      const cleared = await work;
      expect(cleared).toMatchObject({ cancelledRunIds: [runId] });
      expect(await system.computer.findUnique({ where: { id: computer.id } })).toMatchObject({
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      });
    } finally {
      await settle(holder, work, probe);
    }
  }, 20_000);

  /** Unblock the holder, drain the work and release the probe, whatever failed. */
  async function settle(
    holder: { open(): void; done: Promise<unknown> },
    work: Promise<unknown>,
    probe: Probe | undefined,
  ): Promise<void> {
    holder.open();
    await holder.done.catch(() => undefined);
    await work.catch(() => undefined);
    probe?.release();
  }
});
