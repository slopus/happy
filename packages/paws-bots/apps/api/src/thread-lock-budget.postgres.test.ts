import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEvent,
  asSystem,
  claimSteering,
  createDb,
  createThreadMessage,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
  sendUserMessage,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { destroyBot } from "../../../packages/adapters/src/child-bots.js";
import { publishMessage } from "../../../packages/adapters/src/run-messages.js";
import type { ThreadTarget } from "./thread-target.js";
import { sendThreadMessage } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

// Longer than Prisma's default five-second interactive transaction, so a write that
// waits out this hold only survives on the explicit thread-lock budget.
const THREAD_LOCK_HOLD_MS = 6_000;
// The write under test must be observed queued on the reader within this budget.
const BLOCKED_BUDGET_MS = 5_000;
const BLOCKED_INTERVAL_MS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)("thread writes behind a long read (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let actor: Actor;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `thread-lock-budget-${randomUUID()}`;
  const notify = vi.fn().mockResolvedValue(undefined);
  const enqueue = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    pool = db.pool;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    ({ userId, spaceId, botId, threadId } = identity);
    actor = { spaceId, userId } as Actor;
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await system.messagingIdentity.deleteMany({ where: { provider: "test", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  /**
   * A thread snapshot holds the thread row FOR SHARE until released. The gate, not a
   * timer, ends the hold: the timed window starts only once the write under test is
   * observed queued on this transaction, so connection checkout or replay delays
   * cannot shorten what the write actually waits.
   */
  function holdThreadShare(heldThreadId = threadId) {
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
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${heldThreadId} FOR SHARE`;
        const rows = await tx.$queryRaw<Array<{ xactId: string }>>`
          SELECT pg_current_xact_id()::text AS "xactId"`;
        locked(rows[0]?.xactId ?? "");
        await opened;
      },
      { timeout: 30_000 },
    );
    return { lockTaken, open: () => open(), done };
  }

  async function connectProbe() {
    const client = await runAsSystem("lock probe", () => pool.connect());
    return {
      /** Backends waiting on the reader's transaction: the write under test, blocked. */
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
    const deadline = Date.now() + BLOCKED_BUDGET_MS;
    for (;;) {
      if ((await probe.waitingOnHolder(xactId)) > 0) return;
      if (Date.now() >= deadline) {
        throw new Error("the write under test did not block on the held thread row");
      }
      await sleep(BLOCKED_INTERVAL_MS);
    }
  }

  /** The write's state after the timed hold: still waiting, or settled with why. */
  async function heldOutcome(work: Promise<unknown>): Promise<string> {
    return Promise.race([
      Promise.resolve(work).then(
        () => "committed",
        (error: Error) => {
          const reason =
            error.message
              .split("\n")
              .find((line) => /expired|timeout/i.test(line))
              ?.trim() ??
            error.message.split("\n")[0] ??
            error.message;
          return `settled: ${reason.slice(0, 160)}`;
        },
      ),
      sleep(75).then(() => "waiting"),
    ]);
  }

  /**
   * Runs one thread write behind a held snapshot read and checks it still waits after the
   * timed hold, then lets it finish and returns its result.
   */
  async function writeBehindHold<T>(write: () => Promise<T>, heldThreadId = threadId): Promise<T> {
    const { lockTaken, open, done } = holdThreadShare(heldThreadId);
    const xactId = await lockTaken;
    let probe: Probe | undefined;
    let work: Promise<T> | undefined;
    try {
      // Inside the try, so a failed checkout still opens the gate and drains the reader.
      probe = await connectProbe();
      work = write();
      work.catch(() => undefined);
      await untilBlocked(probe, xactId);
      await sleep(THREAD_LOCK_HOLD_MS);
      // On Prisma's default five-second budget the write has already expired here.
      expect(await heldOutcome(work)).toBe("waiting");
      open();
      return await work;
    } finally {
      open();
      await done.catch(() => undefined);
      await work?.catch(() => undefined);
      probe?.release();
    }
  }

  it(
    "delivers an incoming message that waited behind a long thread read",
    async () => {
      const clientNonce = randomUUID();
      await writeBehindHold(() =>
        runAsTenant({ spaceId, userId }, () =>
          sendUserMessage(prisma, {
            spaceId,
            threadId,
            botId,
            userId,
            blocks: [{ kind: "text", text: "webhook while a snapshot held the thread" }],
            prompt: "webhook while a snapshot held the thread",
            trigger: "webhook",
            clientNonce,
            createRun: false,
          }),
        ),
      );
      expect(
        await system.message.findFirstOrThrow({ where: { threadId, clientNonce } }),
      ).toMatchObject({ role: "user" });
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "appends a run event that waited behind a long thread read",
    async () => {
      const event = await writeBehindHold(() =>
        runAsTenant({ spaceId, userId }, () =>
          appendEvent(prisma, {
            spaceId,
            threadId,
            botId,
            type: "thread.message.created",
            payload: {},
          }),
        ),
      );
      expect(await system.event.findFirst({ where: { threadId, seq: event.seq } })).not.toBeNull();
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "saves a bot reply that waited behind a long thread read",
    async () => {
      const task = await system.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "reply", status: "running" },
      });
      const run = await system.run.create({
        data: {
          spaceId,
          botId,
          threadId,
          taskId: task.id,
          userId,
          status: "running",
          trigger: "user",
          startedAt: new Date(),
        },
      });
      try {
        const message = await writeBehindHold(() =>
          runAsTenant({ spaceId, userId }, () =>
            publishMessage({ prisma, events: { notify } } as never, run, "bot", [
              { kind: "text", text: "finished while a snapshot held the thread" },
            ]),
          ),
        );
        expect(message).toMatchObject({ role: "bot", runId: run.id });
      } finally {
        // Keep the active-run set empty for the sends below.
        await system.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      }
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "writes a standalone thread message that waited behind a long thread read",
    async () => {
      // The group-invitation note (announceInvite) is one of this helper's callers.
      const message = await writeBehindHold(() =>
        runAsTenant({ spaceId, userId }, () =>
          createThreadMessage(prisma, {
            threadId,
            role: "system",
            blocks: [{ kind: "meta", text: "added to a group while a snapshot held the thread" }],
          }),
        ),
      );
      expect(await system.message.findUnique({ where: { id: message.id } })).not.toBeNull();
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "sends a message that waited behind a long thread read",
    async () => {
      const target = { kind: "bot", botId, threadId, bot: { computer: null } } as ThreadTarget;
      const clientNonce = randomUUID();
      const { lockTaken, open, done } = holdThreadShare();
      const xactId = await lockTaken;
      let probe: Probe | undefined;
      let work: Promise<unknown> = Promise.resolve();
      try {
        // Inside the try, so a failed checkout still opens the gate and drains the reader.
        probe = await connectProbe();
        const sendWork = runAsTenant({ spaceId, userId }, () =>
          sendThreadMessage(
            {
              prisma,
              sandbox: {} as never,
              events: { notify } as never,
              jobs: { enqueue } as never,
            },
            actor,
            target,
            { text: "sent while a snapshot held the thread", mentions: [], clientNonce },
          ),
        );
        work = sendWork;
        work.catch(() => undefined);

        await untilBlocked(probe, xactId);
        await sleep(THREAD_LOCK_HOLD_MS);
        // The send must still be waiting out the hold: on Prisma's default budget it
        // has already expired here, which is the failure this change removes.
        expect(await heldOutcome(work)).toBe("waiting");

        open();
        const sent = await sendWork;
        expect(
          await system.message.findFirstOrThrow({ where: { threadId, clientNonce } }),
        ).toMatchObject({ role: "user" });
        expect(
          await system.run.findUniqueOrThrow({
            where: { id: sent.runId },
            select: { status: true, sourceMessage: { select: { clientNonce: true } } },
          }),
        ).toMatchObject({ status: "queued", sourceMessage: { clientNonce } });
        // Keep the active-run set empty so the steering claim below sees only its own run.
        await system.run.update({ where: { id: sent.runId }, data: { status: "cancelled" } });
      } finally {
        open();
        await done.catch(() => undefined);
        await work.catch(() => undefined);
        probe?.release();
      }
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "claims steering that waited behind a long thread read",
    async () => {
      const task = await system.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "keep working", status: "running" },
      });
      const run = await system.run.create({
        data: {
          spaceId,
          botId,
          threadId,
          taskId: task.id,
          userId,
          status: "running",
          trigger: "user",
          startedAt: new Date(),
          leaseOwner: "worker-1",
          leaseFence: 1,
        },
      });
      const steering = await createThreadMessage(system, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: `mid-run request ${randomUUID()}` }],
      });
      const steeringRow = await system.steeringMessage.create({
        data: { messageId: steering.id, botId, userId },
      });

      const { lockTaken, open, done } = holdThreadShare();
      const xactId = await lockTaken;
      let probe: Probe | undefined;
      let work: Promise<unknown> = Promise.resolve();
      try {
        // Inside the try, so a failed checkout still opens the gate and drains the reader.
        probe = await connectProbe();
        const claimWork = runAsTenant({ spaceId, userId }, () =>
          claimSteering(prisma, {
            threadId,
            botId,
            runId: run.id,
            leaseOwner: "worker-1",
            leaseFence: 1,
            seenIds: [],
          }),
        );
        work = claimWork;
        work.catch(() => undefined);

        await untilBlocked(probe, xactId);
        await sleep(THREAD_LOCK_HOLD_MS);
        // The claim must still be waiting out the hold; expiring here fails the run's turn.
        expect(await heldOutcome(work)).toBe("waiting");

        open();
        const claimed = await claimWork;
        expect(claimed.map((item) => item.messageId)).toEqual([steering.id]);
        expect(
          await system.steeringMessage.findUniqueOrThrow({ where: { id: steeringRow.id } }),
        ).toMatchObject({ runId: run.id, claimedAt: expect.any(Date) });
        await system.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
      } finally {
        open();
        await done.catch(() => undefined);
        await work.catch(() => undefined);
        probe?.release();
      }
    },
    THREAD_LOCK_HOLD_MS * 4,
  );

  it(
    "deletes a bot whose thread a long read held",
    async () => {
      const removed = await runAsSystem("test fixture", () =>
        provisionMessagingIdentity(
          prisma,
          { provider: "test", address: `${address}-removed` },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
      try {
        const bot = await system.bot.findUniqueOrThrow({
          where: { id: removed.botId },
          select: { id: true, spaceId: true, userId: true, name: true, archivedAt: true },
        });
        await writeBehindHold(
          () =>
            runAsSystem("account deletion", () =>
              destroyBot(
                {
                  prisma: system,
                  sandbox: {} as never,
                  home: {} as never,
                  jobs: { cancel: vi.fn() } as never,
                },
                bot,
                {
                  operationId: "thread-lock-budget",
                  traceId: "thread-lock-budget",
                  spaceId: bot.spaceId,
                  userId: bot.userId,
                  botId: bot.id,
                  signal: new AbortController().signal,
                },
                { deleteMemories: true },
              ),
            ),
          removed.threadId,
        );
        expect(await system.thread.findUnique({ where: { id: removed.threadId } })).toBeNull();
      } finally {
        await system.messagingIdentity.deleteMany({
          where: { provider: "test", address: `${address}-removed` },
        });
        await system.organization.deleteMany({ where: { id: removed.spaceId } });
        await system.user.deleteMany({ where: { id: removed.userId } });
      }
    },
    THREAD_LOCK_HOLD_MS * 4,
  );
});
