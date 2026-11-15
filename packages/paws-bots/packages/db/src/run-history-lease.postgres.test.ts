import { TAKEOVER_COMPUTER_PENDING_STATE, TAKEOVER_COMPUTER_SKIPPED_STATE } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { appendEvent } from "./events.js";
import type { RunLease } from "./messages.js";
import { createThreadMessage, RunHistoryWriteError } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { settleReleasedTakeoverCards } from "./thread-takeover.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

describePostgres("run history writes under a lease (PostgreSQL)", () => {
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

  it("rejects writes from a superseded lease and accepts the current one", async () => {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "answer", status: "running" },
    });
    // Another worker reclaimed the run after the first lease expired.
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
        leaseOwner: "worker-2",
        leaseFence: 2,
      },
    });
    const writeMessage = (lease: RunLease) =>
      runAsTenant({ spaceId, userId }, () =>
        createThreadMessage(prisma, {
          threadId,
          role: "bot",
          blocks: [{ kind: "text", text: `from ${lease.owner}` }],
          botId,
          runId: run.id,
          lease,
        }),
      );
    const writeEvent = (lease: RunLease) =>
      runAsTenant({ spaceId, userId }, () =>
        appendEvent(prisma, {
          spaceId,
          threadId,
          botId,
          runId: run.id,
          type: "agent.tool.called",
          payload: { name: "shell", executionId: lease.owner },
          lease,
        }),
      );

    for (const stale of [
      { owner: "worker-1", fence: 1 },
      { owner: "worker-1", fence: 2 },
    ]) {
      await expect(writeMessage(stale)).rejects.toBeInstanceOf(RunHistoryWriteError);
      await expect(writeEvent(stale)).rejects.toBeInstanceOf(RunHistoryWriteError);
    }
    await writeMessage({ owner: "worker-2", fence: 2 });
    await writeEvent({ owner: "worker-2", fence: 2 });

    expect(
      await system.message.findMany({ where: { runId: run.id }, select: { blocks: true } }),
    ).toEqual([{ blocks: [{ kind: "text", text: "from worker-2" }] }]);
    expect(
      await system.event.findMany({ where: { runId: run.id }, select: { payload: true } }),
    ).toEqual([{ payload: { name: "shell", executionId: "worker-2" } }]);
  });

  it("keeps a superseded attempt from settling the current attempt's takeover card", async () => {
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "sign in", status: "running" },
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
        leaseOwner: "worker-2",
        leaseFence: 2,
      },
    });
    const card = await runAsTenant({ spaceId, userId }, () =>
      createThreadMessage(prisma, {
        threadId,
        role: "bot",
        blocks: [
          {
            kind: "computer",
            state: TAKEOVER_COMPUTER_PENDING_STATE,
            text: "Sign in to continue.",
          },
        ],
        botId,
        runId: run.id,
      }),
    );
    const settle = (lease: RunLease) =>
      runAsTenant({ spaceId, userId }, () =>
        settleReleasedTakeoverCards(prisma, {
          spaceId,
          threadId,
          botId,
          runId: run.id,
          reason: "takeover-skipped",
          lease,
        }),
      );
    const cardState = async () =>
      (
        (await system.message.findUniqueOrThrow({ where: { id: card.id } })).blocks as Array<{
          state?: string;
        }>
      )[0]?.state;

    await expect(settle({ owner: "worker-1", fence: 1 })).rejects.toBeInstanceOf(
      RunHistoryWriteError,
    );
    expect(await cardState()).toBe(TAKEOVER_COMPUTER_PENDING_STATE);

    await settle({ owner: "worker-2", fence: 2 });
    expect(await cardState()).toBe(TAKEOVER_COMPUTER_SKIPPED_STATE);
  });
});
