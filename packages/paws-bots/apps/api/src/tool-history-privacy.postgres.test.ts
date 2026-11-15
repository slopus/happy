import type { Actor, MessageBlock } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  finalizeRun,
  loadRunHistoryMessages,
  provisionMessagingIdentity,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMessagePage } from "./thread-message-pages.js";
import { threadSnapshot } from "./thread-snapshot.js";
import { resolveThreadTarget } from "./thread-target.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe : describe.skip;

const PRIVATE = "PRIVATE-TOOL-OUTPUT";

describePostgres("a reply's kept tool calls (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let actor: Actor;
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
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    ({ botId, threadId } = identity);
    actor = { ...identity, email: "fixture@example.test", isDeploymentOwner: false };
  });

  afterAll(async () => {
    try {
      if (actor) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    } finally {
      await close?.();
    }
  });

  it("reach the bot's later runs, never a snapshot, a message page, a live event or a plain read", async () => {
    const { spaceId, userId } = actor;
    const task = await system.task.create({
      data: { spaceId, botId, threadId, userId, prompt: "check the notes", status: "running" },
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
    // As a run assembles its reply: the step carries its tool and what each call returned.
    const blocks = [
      {
        kind: "steps",
        steps: [
          {
            label: "Shell",
            tool: "shell",
            count: 1,
            calls: [
              {
                arguments: '{"command":"cat notes.txt"}',
                result: PRIVATE,
                image: { artifactId: "screenshot-1" },
              },
            ],
            outcomes: { succeeded: 1 },
          },
        ],
      },
      { kind: "text", text: "Done." },
    ] as MessageBlock[];
    await runAsTenant(actor, () =>
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
        blocks,
      }),
    );
    const leaks = (value: unknown) => {
      const json = JSON.stringify(value);
      return [PRIVATE, "cat notes.txt", "screenshot-1", '"calls"', '"tool"', "toolHistory"].filter(
        (marker) => json.includes(marker),
      );
    };

    await runAsTenant(actor, async () => {
      const event = await prisma.event.findFirstOrThrow({
        where: { threadId, runId: run.id, type: "thread.message.created" },
      });
      expect(leaks(event.payload)).toEqual([]);
      const target = await resolveThreadTarget(prisma, actor, { botId });
      const snapshot = await threadSnapshot({ prisma }, target);
      expect(snapshot.messages.some((message) => message.runId === run.id)).toBe(true);
      expect(leaks(snapshot)).toEqual([]);
      expect(leaks(await loadMessagePage(prisma, threadId, undefined, 50))).toEqual([]);
      // An ordinary read leaves the column out; only a read that asks for it gets it.
      const row = await prisma.message.findFirstOrThrow({ where: { runId: run.id } });
      expect(row).not.toHaveProperty("toolHistory");
      expect(leaks(row)).toEqual([]);
      // The steps block keeps what the UI shows.
      expect((row.blocks as MessageBlock[])[0]).toEqual({
        kind: "steps",
        steps: [{ label: "Shell", count: 1, outcomes: { succeeded: 1 } }],
        durationMs: expect.any(Number),
      });
    });

    // The bot's next run reads the calls back.
    const history = await runAsTenant(actor, () =>
      loadRunHistoryMessages(prisma, { id: "next-run", threadId, botId, userId }, 50),
    );
    // Another member's run of the same bot sees the reply as everyone does, not its tool calls.
    const theirs = await runAsTenant(actor, () =>
      loadRunHistoryMessages(
        prisma,
        { id: "member-run", threadId, botId, userId: "another-member" },
        50,
      ),
    );
    expect(theirs.find((message) => message.runId === run.id)?.toolHistory).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain(PRIVATE);
    const reply = history.find((message) => message.runId === run.id);
    expect(JSON.parse(reply!.toolHistory!)).toEqual({
      steps: [
        {
          tool: "shell",
          calls: [
            {
              arguments: '{"command":"cat notes.txt"}',
              result: PRIVATE,
              image: { artifactId: "screenshot-1" },
            },
          ],
        },
      ],
    });
  });
});
