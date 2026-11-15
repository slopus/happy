import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MessagingSurface } from "@rakazo/adapter-kit";
import { messagingReplyJobKey, messagingSendJobKey, RetryJobLaterError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createPool,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MessagingSendError } from "./chat-sdk-surface.js";
import type { OutboundLane } from "./messaging-delivery.js";
import {
  MESSAGING_SEND_BACKUP_MS,
  MESSAGING_SEND_STALE_MS,
  MessagingDelivery,
} from "./messaging-delivery.js";
import { GraphileJobPublisher } from "./wakeup.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner, as
// `pnpm test:integration` provides; Graphile's schema is installed by the migration.
const url = process.env.DATABASE_URL;
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url && ownerUrl ? describe : describe.skip;

describePostgres("chat delivery with Graphile backup jobs (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let owner: Pool;
  let system: PrismaClient;
  let jobs: GraphileJobPublisher;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  let identityId: string;
  const address = `delivery-${randomUUID()}`;
  let seq = 1000;

  beforeAll(async () => {
    db = createDb(url!);
    owner = createPool(ownerUrl!);
    system = asSystem(db.prisma);
    jobs = new GraphileJobPublisher(db.pool);
    const provisioned = await runAsSystem("delivery fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "telegram", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    identity = {
      userId: provisioned.userId,
      spaceId: provisioned.spaceId,
      botId: provisioned.botId,
      threadId: provisioned.threadId,
    };
    identityId = (await system.messagingIdentity.findUniqueOrThrow({
      where: { botId: identity.botId },
    }))!.id;
    await system.messagingIdentity.update({
      where: { id: identityId },
      data: { dmThreadId: `telegram:${address}` },
    });
  });

  afterAll(async () => {
    if (system) {
      await system.messagingOutbound.deleteMany({ where: { identityId } });
      await system.messagingOutbound.deleteMany({
        where: { threadId: { startsWith: "pg-lane-" } },
      });
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity?.spaceId } });
      await system.user.deleteMany({ where: { id: identity?.userId } });
    }
    await jobs?.close();
    await owner?.end();
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  function surface(send?: (body: string) => Promise<{ handle: string }>) {
    const sent: string[] = [];
    const sendToThread = vi.fn(async ({ body }: { body: string }) => {
      const result = send ? await send(body) : { handle: `handle-${sent.length + 1}` };
      sent.push(body);
      return result;
    });
    const messaging: MessagingSurface = {
      describe: () => ({
        id: "fake",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { providers: [] },
      }),
      platforms: () => [],
      handleWebhook: () => null,
      onInbound: () => undefined,
      sendToThread,
      openDirectThread: vi.fn(async () => "fake:dm"),
      acknowledge: vi.fn(async () => undefined),
    };
    return { messaging, sendToThread, sent };
  }

  function delivery(messaging: MessagingSurface) {
    return new MessagingDelivery({
      prisma: system,
      messaging,
      events: { sendUserMessage: vi.fn(), notify: vi.fn(async () => undefined) },
      jobs,
      artifacts: { get: vi.fn(async () => new Uint8Array()) },
    });
  }

  async function job(key: string) {
    const { rows } = await owner.query<{
      run_at: Date;
      attempts: number;
      locked_at: Date | null;
      identifier: string;
    }>(
      `select jobs.run_at, jobs.attempts, jobs.locked_at, tasks.identifier
       from graphile_worker._private_jobs as jobs
       join graphile_worker._private_tasks as tasks on tasks.id = jobs.task_id
       where jobs.key = $1`,
      [key],
    );
    return rows[0];
  }

  function lane(): OutboundLane & { threadId: string } {
    return { identityId: null, threadId: `pg-lane-${randomUUID()}` };
  }

  async function record(target: OutboundLane & { threadId: string }, bodies: string[]) {
    const recorder = delivery(surface().messaging);
    return system.$transaction((tx) =>
      recorder.recordIn(
        tx,
        target,
        bodies.map((body) => ({
          idempotencyKey: `${target.threadId}:${body}`,
          kind: "team",
          threadId: target.threadId,
          body,
        })),
      ),
    );
  }

  async function statuses(threadId: string) {
    const rows = await system.messagingOutbound.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { body: true, status: true, providerHandle: true },
    });
    // A claimed row is marked sent before its handle is known, as the previous release marks its own.
    return rows.map(
      (row) =>
        `${row.body}:${row.status === "sent" && row.providerHandle === null ? "in-flight" : row.status}`,
    );
  }

  it("records a message and its backup job in one transaction", async () => {
    const committed = lane();
    const before = Date.now();
    const [id] = await record(committed, ["kept"]);
    const backup = await job(messagingSendJobKey(id!));
    expect(backup?.identifier).toBe("messaging.send");
    expect(backup!.run_at.getTime()).toBeGreaterThanOrEqual(
      before + MESSAGING_SEND_BACKUP_MS - 1_000,
    );

    const rolledBack = lane();
    const recorder = delivery(surface().messaging);
    let recordedId: string | undefined;
    await system
      .$transaction(async (tx) => {
        [recordedId] = await recorder.recordIn(tx, rolledBack, [
          {
            idempotencyKey: `${rolledBack.threadId}:lost`,
            kind: "team",
            threadId: rolledBack.threadId,
            body: "lost",
          },
        ]);
        throw new Error("roll back");
      })
      .catch(() => undefined);
    expect(recordedId).toBeDefined();
    expect({
      row: await system.messagingOutbound.findUnique({ where: { id: recordedId! } }),
      job: await job(messagingSendJobKey(recordedId!)),
    }).toEqual({ row: null, job: undefined });
  });

  it("sends straight away in the recording process and removes the backup job", async () => {
    const target = lane();
    const { messaging, sent } = surface();
    const sender = delivery(messaging);
    const ids = await record(target, ["one", "two"]);
    await sender.send([target]);
    expect(sent).toEqual(["one", "two"]);
    expect(await statuses(target.threadId)).toEqual(["one:sent", "two:sent"]);
    for (const id of ids) expect(await job(messagingSendJobKey(id))).toBeUndefined();
  });

  it("lets the backup job send what a process that stopped never sent", async () => {
    const target = lane();
    const [first, second] = await record(target, ["never sent", "after it"]);
    // The process that recorded these stopped before sending; the first backup job fires.
    const { messaging, sent } = surface();
    await delivery(messaging).sendJob(first!, { number: 1, max: 5 });
    expect(sent).toEqual(["never sent", "after it"]);
    expect(await statuses(target.threadId)).toEqual(["never sent:sent", "after it:sent"]);
    expect(await job(messagingSendJobKey(second!))).toBeUndefined();
  });

  it("resends a claim whose sender died once the claim is stale, but not a fresh one", async () => {
    const target = lane();
    const [id] = await record(target, ["claimed"]);
    await system.messagingOutbound.update({ where: { id: id! }, data: { status: "sent" } });
    const { messaging, sent } = surface();
    const backup = delivery(messaging);

    // Still within the sender's time: the job looks again once it has run out.
    await backup.sendJob(id!, { number: 1, max: 5 });
    expect(sent).toEqual([]);
    const rescheduled = await job(messagingSendJobKey(id!));
    expect(rescheduled!.run_at.getTime()).toBeGreaterThan(
      Date.now() + MESSAGING_SEND_STALE_MS - 5_000,
    );

    await owner.query(
      `update messaging_outbound set "updatedAt" = now() - interval '3 minutes' where id = $1`,
      [id],
    );
    await backup.sendJob(id!, { number: 1, max: 5 });
    expect(sent).toEqual(["claimed"]);
    expect(await statuses(target.threadId)).toEqual(["claimed:sent"]);
  });

  it("moves the backup job to now on a clean failure, or to the provider's retry-after", async () => {
    const retryAfter = lane();
    const [limited] = await record(retryAfter, ["limited"]);
    const rateLimited = surface(async () => {
      throw new MessagingSendError(new Error("429"), { permanent: false, retryAfterMs: 30_000 });
    });
    const before = Date.now();
    await delivery(rateLimited.messaging).send([retryAfter]);
    const limitedJob = await job(messagingSendJobKey(limited!));
    expect({
      status: await statuses(retryAfter.threadId),
      attempts: limitedJob?.attempts,
    }).toEqual({ status: ["limited:retry"], attempts: 0 });
    expect(limitedJob!.run_at.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(limitedJob!.run_at.getTime()).toBeLessThan(before + 40_000);

    const now = lane();
    const [failed] = await record(now, ["flaky"]);
    const flaky = surface(async () => {
      throw new MessagingSendError(new Error("503"), { permanent: false, retryAfterMs: null });
    });
    await delivery(flaky.messaging).send([now]);
    expect((await job(messagingSendJobKey(failed!)))!.run_at.getTime()).toBeLessThan(
      Date.now() + 1_000,
    );
  });

  it("retries through the job queue, then gives up after the last attempt and sends what waited", async () => {
    const target = lane();
    const [head] = await record(target, ["stubborn", "waiting"]);
    await system.messagingOutbound.update({ where: { id: head! }, data: { status: "retry" } });
    let fail = true;
    const { messaging, sent } = surface(async (body) => {
      if (fail && body === "stubborn")
        throw new MessagingSendError(new Error("429"), { permanent: false, retryAfterMs: 5_000 });
      return { handle: `handle-${body}` };
    });
    const backup = delivery(messaging);

    // A middle attempt hands the failure back to the queue, keeping its retry-after.
    await expect(backup.sendJob(head!, { number: 2, max: 5 })).rejects.toBeInstanceOf(
      RetryJobLaterError,
    );
    expect(await statuses(target.threadId)).toEqual(["stubborn:retry", "waiting:pending"]);

    // The last attempt gives the message up and lets the conversation move on.
    await backup.sendJob(head!, { number: 5, max: 5 });
    expect(sent).toEqual(["waiting"]);
    expect(await statuses(target.threadId)).toEqual(["stubborn:failed", "waiting:sent"]);
    fail = false;
  });

  it("does not let a new message jump a conversation that waits on a retry", async () => {
    const target = lane();
    const [head] = await record(target, ["backing off"]);
    await system.messagingOutbound.update({ where: { id: head! }, data: { status: "retry" } });
    await record(target, ["newer"]);
    const { messaging, sent } = surface();
    await delivery(messaging).send([target]);
    expect(sent).toEqual([]);
    expect(await statuses(target.threadId)).toEqual(["backing off:retry", "newer:pending"]);
  });

  it("sends each message once when two processes send one conversation at the same time", async () => {
    const target = lane();
    await record(target, ["a", "b", "c"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const slow = surface(async (body) => {
      if (body === "a") await gate;
      sent.push(body);
      return { handle: `handle-${body}` };
    });
    const fast = surface(async (body) => {
      sent.push(body);
      return { handle: `handle-${body}` };
    });
    const first = delivery(slow.messaging).send([target]);
    await vi.waitFor(async () =>
      expect(await statuses(target.threadId)).toEqual(["a:in-flight", "b:pending", "c:pending"]),
    );
    // The second process finds the head in flight and leaves the conversation to it.
    await delivery(fast.messaging).send([target]);
    release();
    await first;
    expect(sent).toEqual(["a", "b", "c"]);
    expect(await statuses(target.threadId)).toEqual(["a:sent", "b:sent", "c:sent"]);
  });

  it("never interleaves two writers of one conversation, not even on a clock tie", async () => {
    const target = lane();
    const recorder = delivery(surface().messaging);
    const rows = (prefix: string) =>
      [1, 2, 3].map((part) => ({
        idempotencyKey: `${target.threadId}:${prefix}${part}`,
        kind: "team",
        threadId: target.threadId,
        body: `${prefix}${part}`,
      }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      await Promise.all([
        system.$transaction((tx) => recorder.recordIn(tx, target, rows("x"))),
        system.$transaction((tx) => recorder.recordIn(tx, target, rows("y"))),
      ]);
    } finally {
      clock.mockRestore();
    }
    const order = (await statuses(target.threadId)).map((row) => row.split(":")[0]!).join(",");
    expect(["x1,x2,x3,y1,y2,y3", "y1,y2,y3,x1,x2,x3"]).toContain(order);
  });

  it("finishes what the previous release recorded and never resends its in-flight claims", async () => {
    const target = lane();
    // Rows the previous release wrote: no backup job, one claimed (sent without a handle).
    await system.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: `${target.threadId}:claimed`,
          kind: "team",
          threadId: target.threadId,
          body: "claimed by the old release",
          status: "sent",
          createdAt: new Date(Date.now() - 600_000),
        },
        {
          idempotencyKey: `${target.threadId}:queued`,
          kind: "team",
          threadId: target.threadId,
          body: "queued by the old release",
          createdAt: new Date(Date.now() - 590_000),
        },
      ],
    });
    await owner.query(
      `update messaging_outbound set "updatedAt" = now() - interval '10 minutes' where "threadId" = $1`,
      [target.threadId],
    );
    const queued = await system.messagingOutbound.findUniqueOrThrow({
      where: { idempotencyKey: `${target.threadId}:queued` },
    });
    const { messaging, sent } = surface();
    const current = delivery(messaging);

    // The safety sweep gives the job-less row a backup job, due now.
    for (let page = 0; page < 50 && !(await job(messagingSendJobKey(queued.id))); page += 1)
      await current.sweepStalled();
    expect((await job(messagingSendJobKey(queued.id)))?.identifier).toBe("messaging.send");
    // And the previous release's drain job sends it through the new path, with whatever else
    // is still unsent in the database.
    await current.drainAll();
    expect(sent).toContain("queued by the old release");
    expect(sent).not.toContain("claimed by the old release");
    expect(await statuses(target.threadId)).toEqual([
      // A stale claim of the previous release: done for this conversation, never sent again.
      "claimed by the old release:in-flight",
      "queued by the old release:sent",
    ]);
  });

  it("holds a conversation behind its own dead send until that send's job resends it, then sends the rest", async () => {
    const target = lane();
    const [first] = await record(target, ["died mid-send", "behind it"]);
    // This release claimed the first message, then its process died: stale, but still its own.
    await owner.query(
      `UPDATE messaging_outbound
       SET status = 'sent', "claimedAt" = (now() AT TIME ZONE 'UTC') - interval '10 minutes',
         "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '10 minutes'
       WHERE id = $1`,
      [first],
    );
    await owner.query(`DELETE FROM graphile_worker._private_jobs WHERE key = $1`, [
      messagingSendJobKey(first!),
    ]);
    const { messaging, sent } = surface();
    const current = delivery(messaging);
    await current.send([target]);
    expect(sent).toEqual([]);

    // Its job gave up, so the safety sweep gives it a new one, which sends both in order.
    for (let page = 0; page < 50 && !(await job(messagingSendJobKey(first!))); page += 1)
      await current.sweepStalled();
    expect((await job(messagingSendJobKey(first!)))?.identifier).toBe("messaging.send");
    await current.sendJob(first!);
    expect(sent).toEqual(["died mid-send", "behind it"]);
    expect(await statuses(target.threadId)).toEqual(["died mid-send:sent", "behind it:sent"]);
  });

  it("works beside the previous release, which takes over and settles a marked send without the mark", async () => {
    const target = lane();
    const [first] = await record(target, ["taken over", "next"]);
    const stale = await owner.query<{ at: Date }>(
      `UPDATE messaging_outbound
       SET status = 'sent', "claimedAt" = (now() AT TIME ZONE 'UTC') - interval '10 minutes',
         "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '10 minutes'
       WHERE id = $1 RETURNING "updatedAt" AS at`,
      [first],
    );
    // The previous release's backup job takes the stale claim over and settles it, as it writes
    // both: compare-and-sets that never touch the mark.
    const claimed = await owner.query<{ at: Date }>(
      `UPDATE messaging_outbound SET status = 'sent', "updatedAt" = now() AT TIME ZONE 'UTC'
       WHERE id = $1 AND status = 'sent' AND "providerHandle" IS NULL AND "updatedAt" = $2
       RETURNING "updatedAt" AS at`,
      [first, stale.rows[0]!.at],
    );
    expect(claimed.rowCount).toBe(1);
    await owner.query(
      `UPDATE messaging_outbound SET "providerHandle" = 'h-previous'
       WHERE id = $1 AND status = 'sent' AND "providerHandle" IS NULL AND "updatedAt" = $2`,
      [first, claimed.rows[0]!.at],
    );
    await owner.query(`DELETE FROM graphile_worker._private_jobs WHERE key = $1`, [
      messagingSendJobKey(first!),
    ]);

    // A settled row that kept a stale mark holds nothing and is never sent again.
    const { messaging, sent } = surface();
    const current = delivery(messaging);
    await current.send([target]);
    expect(sent).toEqual(["next"]);
    for (let page = 0; page < 50; page += 1) await current.sweepStalled();
    expect(await job(messagingSendJobKey(first!))).toBeUndefined();
    expect(await statuses(target.threadId)).toEqual(["taken over:sent", "next:sent"]);
  });

  async function dmRun(status: "running" | "completed", reply: string) {
    seq += 2;
    const source = await system.message.create({
      data: {
        threadId: identity.threadId,
        seq,
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
        clientNonce: `delivery-src-${seq}-${address}`,
      },
    });
    const task = await system.task.create({
      data: { ...identity, prompt: "delivery fixture", status: "completed" },
    });
    const run = await system.run.create({
      data: {
        ...identity,
        taskId: task.id,
        status,
        trigger: "messaging",
        sourceMessageId: source.id,
      },
    });
    await system.message.create({
      data: {
        threadId: identity.threadId,
        seq: seq + 1,
        role: "bot",
        botId: identity.botId,
        runId: run.id,
        blocks: [{ kind: "text", text: reply }],
      },
    });
    return run;
  }

  it("schedules a backup for every chat run's reply as the run ends, which a direct delivery removes", async () => {
    const run = await dmRun("running", "the answer");
    // However the run ends, its reply job commits with the status change.
    await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
    const backup = await job(messagingReplyJobKey(run.id));
    expect(backup?.identifier).toBe("messaging.reply");
    expect(backup!.run_at.getTime()).toBeGreaterThan(Date.now() + 60_000);

    const cancelled = await dmRun("running", "never finished");
    await system.run.update({ where: { id: cancelled.id }, data: { status: "cancelled" } });
    expect((await job(messagingReplyJobKey(cancelled.id)))!.run_at.getTime()).toBeLessThan(
      Date.now() + 1_000,
    );

    // The process that finished the run delivers at once, without any polling.
    const { messaging, sent } = surface();
    await delivery(messaging).deliverRun(run.id);
    expect(sent).toEqual(["the answer"]);
    expect(await job(messagingReplyJobKey(run.id))).toBeUndefined();
    expect(
      (await system.run.findUniqueOrThrow({ where: { id: run.id } })).messagingMirroredAt,
    ).not.toBeNull();
  });

  it("records a run's reply once when the reply job and the finishing process both deliver it", async () => {
    const run = await dmRun("completed", "only once");
    const { messaging, sent } = surface();
    await Promise.all([
      delivery(messaging).deliverRun(run.id),
      delivery(messaging).deliverRun(run.id),
    ]);
    expect(sent).toEqual(["only once"]);
    expect(await system.messagingOutbound.count({ where: { identityId, body: "only once" } })).toBe(
      1,
    );
  });
  it("waits behind a message the previous release claimed under the same lock, never beside it", async () => {
    const target = lane();
    await system.messagingChannel.create({
      data: { provider: "telegram", threadId: target.threadId, name: "Overlap" },
    });
    const [first] = await record(target, ["claimed by the old drain", "next"]);
    const { messaging, sent } = surface();
    // The previous release's drain: the channel row lock, then pending -> sent before its send.
    const old = await owner.connect();
    try {
      await old.query("BEGIN");
      await old.query(`SELECT id FROM messaging_channels WHERE "threadId" = $1 FOR UPDATE`, [
        target.threadId,
      ]);
      const sending = delivery(messaging).send([target]);
      await old.query(
        `UPDATE messaging_outbound SET status = 'sent', "updatedAt" = now() WHERE id = $1 AND status = 'pending'`,
        [first],
      );
      await old.query("COMMIT");
      await sending;
    } finally {
      old.release();
    }
    // Its send may still be running, so the next message waits.
    expect({ sent, status: await statuses(target.threadId) }).toEqual({
      sent: [],
      status: ["claimed by the old drain:in-flight", "next:pending"],
    });

    // Once the old drain saved its handle, the conversation moves on.
    await system.messagingOutbound.update({
      where: { id: first! },
      data: { providerHandle: "h-1" },
    });
    await delivery(messaging).send([target]);
    expect(sent).toEqual(["next"]);
  });

  it("marks its own sends in flight the way the previous release recognises them", async () => {
    const target = lane();
    const [first, second] = await record(target, ["in flight", "behind it"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = surface(async () => {
      await gate;
      return { handle: "h-1" };
    });
    const sending = delivery(slow.messaging).send([target]);
    await vi.waitFor(async () =>
      expect(await statuses(target.threadId)).toEqual(["in flight:in-flight", "behind it:pending"]),
    );
    // The previous release's blocker check for the row behind it.
    const { rows } = await owner.query(
      `SELECT id FROM messaging_outbound
       WHERE "identityId" IS NULL AND "threadId" = $1
         AND ((status = 'pending' AND id <> $2 AND "createdAt" < (SELECT "createdAt" FROM messaging_outbound WHERE id = $2))
           OR (status = 'sent' AND "providerHandle" IS NULL AND "updatedAt" > now() - interval '2 minutes'))`,
      [target.threadId, second],
    );
    expect(rows.map((row) => row.id)).toEqual([first]);
    release();
    await sending;
    expect(await statuses(target.threadId)).toEqual(["in flight:sent", "behind it:sent"]);
  });

  it("queues reply jobs for chat runs the previous release left to its recovery scan", async () => {
    const left = await dmRun("completed", "left for the scan");
    const delivered = await dmRun("completed", "already mirrored");
    await system.run.update({
      where: { id: delivered.id },
      data: { messagingMirroredAt: new Date() },
    });
    const old = await dmRun("completed", "too old to send now");
    // Runs that ended before the run-end trigger existed have no reply job.
    await owner.query(`DELETE FROM graphile_worker._private_jobs WHERE key = ANY($1::text[])`, [
      [left.id, delivered.id, old.id].map(messagingReplyJobKey),
    ]);
    await owner.query(
      `UPDATE runs SET "completedAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE id = ANY($1::text[])`,
      [[left.id, delivered.id]],
    );
    await owner.query(
      `UPDATE runs SET "completedAt" = (now() AT TIME ZONE 'UTC') - interval '3 days' WHERE id = $1`,
      [old.id],
    );
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../db/prisma/migrations/20261214120006_queue_unsent_run_replies/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      // Applied before the deferred drop of the column it reads.
      await client.query(
        `ALTER TABLE runs ADD COLUMN IF NOT EXISTS "teamChatMirroredAt" TIMESTAMP(3)`,
      );
      await client.query(migration);
      const { rows } = await client.query<{ key: string; payload: unknown; due: boolean }>(
        `SELECT key, payload, run_at > now() + interval '9 minutes' AS due
         FROM graphile_worker._private_jobs WHERE key = ANY($1::text[])`,
        [[left.id, delivered.id, old.id].map(messagingReplyJobKey)],
      );
      // Due once the previous release has stopped.
      expect(rows).toEqual([
        { key: messagingReplyJobKey(left.id), payload: { runId: left.id }, due: true },
      ]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
