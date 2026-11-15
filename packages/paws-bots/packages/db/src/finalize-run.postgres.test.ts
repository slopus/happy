import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

// Longer than Prisma's default five-second interactive transaction.
const THREAD_LOCK_HOLD_MS = 6_000;

describePostgres("finalizing a run (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

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

  it(
    "completes a run that waited behind a long thread read, steering included",
    async () => {
      const task = await system.task.create({
        data: { spaceId, botId, threadId, userId, prompt: "update the routine", status: "running" },
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
      const attempt = await system.attempt.create({
        data: { runId: run.id, fence: 1, status: "running" },
      });
      const steering = await createThreadMessage(system, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: `also this ${randomUUID()}` }],
      });
      await system.steeringMessage.create({
        data: { messageId: steering.id, botId, userId, runId: run.id },
      });

      // A thread snapshot reads under a share lock; finalizing waits for it.
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const reader = system.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR SHARE`;
          locked();
          await new Promise((resolve) => setTimeout(resolve, THREAD_LOCK_HOLD_MS));
        },
        { timeout: THREAD_LOCK_HOLD_MS * 3 },
      );
      await lockTaken;

      const finalized = runAsTenant({ spaceId, userId }, () =>
        finalizeRun(prisma, {
          spaceId,
          threadId,
          botId,
          runId: run.id,
          taskId: task.id,
          attemptId: attempt.id,
          leaseOwner: "worker-1",
          leaseFence: 1,
          outcome: "completed",
          blocks: [{ kind: "text", text: "Updated." }],
        }),
      );

      await expect(finalized).resolves.toEqual({ continuationRunId: expect.any(String) });
      await reader;
      expect(await system.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        status: "completed",
        error: null,
      });
    },
    THREAD_LOCK_HOLD_MS * 4,
  );
});
