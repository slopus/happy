import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import type { AppendEventInput } from "./events.js";
import { appendEvent } from "./events.js";
import { RunHistoryWriteError } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("appending a thread event (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  let runId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  const append = (input: Partial<AppendEventInput> = {}) =>
    runAsTenant({ spaceId, userId }, () =>
      appendEvent(prisma, {
        spaceId,
        threadId,
        botId,
        runId,
        type: "thread.progress",
        payload: { delta: "working", streaming: true },
        ...input,
      }),
    );

  /** Holds the thread lock as a cancel, finalize or snapshot would, until `release`. */
  async function holdThreadLock(work: (tx: PrismaClient) => Promise<void>) {
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = system.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
        locked();
        await released;
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await work(tx as unknown as PrismaClient);
      },
      { timeout: 20_000 },
    );
    await lockTaken;
    return { release, holder };
  }

  async function waitForBlockedAppend() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await system.$queryRaw<Array<{ waiting: bigint }>>`
        SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%"nextEventSeq" + 1%'`;
      if (row && row.waiting > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The append never waited for the thread lock");
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
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

  beforeEach(async () => {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "stream a reply", status: "running" },
    });
    ({ id: runId } = await system.run.create({
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
    }));
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

  it("stores encrypted content readable through the client, in seq order", async () => {
    const first = await append({ payload: { text: "secret plan", streaming: true } });
    const second = await append();
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(first.payload).toEqual({ text: "secret plan", streaming: true });

    const stored = await system.event.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored).toMatchObject({ seq: first.seq, payload: first.payload, runId });
    const [raw] = await system.$queryRaw<Array<{ payload: string }>>`
      SELECT payload::text AS payload FROM events WHERE id = ${first.id}`;
    expect(raw!.payload).not.toContain("secret plan");
  });

  it("records the run's first response once, at the event's time", async () => {
    const reply = await append();
    await append({ payload: { delta: " more", streaming: true } });
    const run = await system.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.firstResponseAt?.toISOString()).toBe(reply.createdAt);
  });

  it("gives concurrent writers distinct seqs in commit order", async () => {
    const events = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        append({ payload: { delta: `${index}`, streaming: true } }),
      ),
    );
    const seqs = events.map((event) => event.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.at(-1)! - seqs[0]!).toBe(seqs.length - 1);
  });

  it("keeps the run lock free while it waits, and rejects a run cancelled meanwhile", async () => {
    const { release, holder } = await holdThreadLock(async (tx) => {
      // Times out (or deadlocks) if the waiting append had locked the run before the thread.
      await tx.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    });
    const waiting = append();
    const rejected = expect(waiting).rejects.toThrow(RunHistoryWriteError);
    await waitForBlockedAppend();
    release();
    await holder;
    await rejected;
    expect(await system.event.count({ where: { runId } })).toBe(0);
  });

  it("rejects a superseded lease that changed while it waited", async () => {
    const { release, holder } = await holdThreadLock(async (tx) => {
      await tx.run.update({
        where: { id: runId },
        data: { leaseOwner: "worker-2", leaseFence: 2 },
      });
    });
    const waiting = append({
      type: "thread.meta",
      payload: { activity: { thinking: true } },
      lease: { owner: "worker-1", fence: 1 },
    });
    // Attach the expectation first: the append can reject while the holder is still finishing.
    const rejected = expect(waiting).rejects.toThrow(RunHistoryWriteError);
    await waitForBlockedAppend();
    release();
    await holder;
    await rejected;
  });

  it("applies the run's history rules", async () => {
    const lease = { owner: "worker-1", fence: 1 };
    await expect(
      append({ type: "thread.meta", payload: { activity: { thinking: true } }, lease }),
    ).resolves.toMatchObject({ type: "thread.meta" });
    await expect(append({ lease: { owner: "worker-1", fence: 2 } })).rejects.toThrow(
      RunHistoryWriteError,
    );
    await expect(append({ type: "run.cancelled", payload: {} })).rejects.toThrow(
      RunHistoryWriteError,
    );

    await system.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    await expect(append()).rejects.toThrow(RunHistoryWriteError);
    await expect(
      append({ type: "thread.meta", payload: { activity: { thinking: false } }, lease }),
    ).rejects.toThrow(RunHistoryWriteError);
    await expect(append({ allowCancelledRun: true })).resolves.toMatchObject({ runId });
    await expect(append({ type: "run.cancelled", payload: {} })).resolves.toMatchObject({
      type: "run.cancelled",
    });
    await expect(append({ runId: "missing-run" })).rejects.toThrow(RunHistoryWriteError);
  });
});
