import { stuckWorkStatusMessage } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { expireStuckRun } from "./expire-stuck-run.js";

const updatedAt = new Date("2026-09-27T12:00:00.000Z");
const now = new Date("2026-09-28T13:00:00.000Z");

function tx(options?: {
  cancelled?: number;
  sibling?: boolean;
  steering?: boolean;
  openCardEffectId?: string;
  status?: "queued" | "waiting_input" | "waiting_takeover";
}) {
  let reads = 0;
  const messages: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const client = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    externalEffect: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    run: {
      updateMany: vi.fn(async () => ({ count: options?.cancelled ?? 1 })),
      findUnique: vi.fn(async () => {
        reads += 1;
        if (reads === 1) {
          return { status: options?.status ?? "queued", updatedAt, startedAt: null };
        }
        return { status: "cancelled", startedAt: null };
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        spaceId: "space-1",
        threadId: "thread-1",
        botId: "bot-1",
        taskId: "task-1",
      })),
      findMany: vi.fn(async () => [{ id: "run-1", userId: "user-1", spaceId: "space-1" }]),
      findFirst: vi.fn(async (args: { where?: { taskId?: string } }) =>
        args.where?.taskId && options?.sibling ? { id: "run-sibling" } : null,
      ),
      create: vi.fn(async () => ({ id: "run-next" })),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ id: "task-next" })),
    },
    thread: { update: vi.fn(async () => ({ nextMessageSeq: 2, nextEventSeq: 9 })) },
    message: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () =>
        options?.openCardEffectId
          ? [
              {
                blocks: [
                  {
                    kind: "ask",
                    approvalEffectId: options.openCardEffectId,
                    text: "Review before sending",
                    status: "pending",
                    actions: [
                      { id: "allow", label: "Allow once" },
                      { id: "deny", label: "Deny" },
                    ],
                  },
                ],
              },
            ]
          : [],
      ),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: "message-expired", ...args.data };
        messages.push(row);
        return row;
      }),
    },
    event: {
      create: vi.fn(async (args: { data: { seq: number } & Record<string, unknown> }) => {
        events.push(args.data);
        return { seq: args.data.seq };
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    steeringMessage: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () =>
        options?.steering
          ? [
              {
                id: "steer-1",
                userId: "user-1",
                originTrigger: null,
                message: { id: "message-steer", blocks: [], seq: 1 },
              },
            ]
          : [],
      ),
    },
  };
  return Object.assign(client, {
    snapshot: () => ({
      messages: messages.map((row) => ({ ...row })),
      events: events.map((row) => ({ ...row })),
    }),
  });
}

describe("expireStuckRun", () => {
  it("cancels the wait, leaves the status line, and continues pending steering", async () => {
    const client = tx({ steering: true });
    const result = await expireStuckRun(client as unknown as Prisma.TransactionClient, {
      runId: "run-1",
      threadId: "thread-1",
      status: "queued",
      updatedAt,
      now,
    });

    expect(result).toEqual({ seq: 8, continuationRunId: "run-next" });
    expect(client.run.updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "queued", updatedAt },
      data: {
        status: "cancelled",
        error: stuckWorkStatusMessage("queued"),
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    expect(client.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: "system",
        clientNonce: "stuck-expired:run-1",
        blocks: [{ kind: "meta", text: stuckWorkStatusMessage("queued") }],
      }),
    });
    expect(client.snapshot().messages).toEqual([
      expect.objectContaining({
        role: "system",
        clientNonce: "stuck-expired:run-1",
        blocks: [{ kind: "meta", text: stuckWorkStatusMessage("queued") }],
      }),
    ]);
    expect(client.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.message.created",
          payload: expect.objectContaining({ messageId: "message-expired", role: "system" }),
        }),
        expect.objectContaining({ type: "run.cancelled", runId: "run-1" }),
      ]),
    );
    expect(client.computerExecutionLease.updateMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
      data: { expiresAt: new Date(0) },
    });
    expect(client.task.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1" },
      data: { status: "cancelled" },
    });
    expect(client.secret.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "user-1", spaceId: "space-1", kind: "run-secret:run-1" },
          { userId: "user-1", spaceId: "space-1", kind: "run-code:run-1" },
          { userId: "user-1", spaceId: "space-1", kind: "run-code-spent:run-1" },
          { userId: "user-1", spaceId: "space-1", kind: { startsWith: "run-login:run-1:" } },
        ],
      },
    });
  });

  describe("a takeover wait whose bot's screen someone holds", () => {
    function holdingScreen(controlUserId: string) {
      const client = tx({ status: "waiting_takeover" });
      client.$queryRaw.mockImplementation((async (sql: TemplateStringsArray) =>
        sql.join("").includes('"controlLeaseId"')
          ? [
              {
                botId: "bot-1",
                userId: "user-1",
                controlBotId: "bot-1",
                controlLeaseId: "lease-1",
                controlUserId,
                computerUserId: "user-1",
              },
            ]
          : []) as never);
      return client;
    }
    const expire = (client: ReturnType<typeof tx>) =>
      expireStuckRun(client as unknown as Prisma.TransactionClient, {
        runId: "run-1",
        threadId: "thread-1",
        status: "waiting_takeover",
        updatedAt,
        now,
      });

    it("keeps waiting while the person it asked is on the screen", async () => {
      const client = holdingScreen("user-1");
      await expect(expire(client)).resolves.toBeNull();
      expect(client.run.updateMany).not.toHaveBeenCalled();
    });

    it("ends the wait when only another member holds the screen", async () => {
      const client = holdingScreen("user-2");
      await expect(expire(client)).resolves.not.toBeNull();
      expect(client.run.updateMany).toHaveBeenCalled();
    });
  });

  it("denies the effect behind an unanswered approval card", async () => {
    const client = tx({ status: "waiting_input", openCardEffectId: "effect-1" });
    await expireStuckRun(client as unknown as Prisma.TransactionClient, {
      runId: "run-1",
      threadId: "thread-1",
      status: "waiting_input",
      updatedAt,
      now,
    });
    expect(client.externalEffect.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["effect-1"] }, runId: { in: ["run-1"] }, status: "intended" },
      data: { status: "denied" },
    });
  });

  it("does nothing when the run already moved on", async () => {
    const client = tx({ cancelled: 0, status: "waiting_takeover" });
    const result = await expireStuckRun(client as unknown as Prisma.TransactionClient, {
      runId: "run-1",
      threadId: "thread-1",
      status: "waiting_takeover",
      updatedAt,
      now,
    });
    expect(result).toBeNull();
    expect(client.message.create).not.toHaveBeenCalled();
    expect(client.secret.deleteMany).not.toHaveBeenCalled();
  });

  it("leaves the task running when a sibling attempt is still active", async () => {
    const client = tx({ sibling: true, status: "waiting_input" });
    await expireStuckRun(client as unknown as Prisma.TransactionClient, {
      runId: "run-1",
      threadId: "thread-1",
      status: "waiting_input",
      updatedAt,
      now,
    });
    expect(client.task.updateMany).not.toHaveBeenCalled();
    expect(client.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        blocks: [{ kind: "meta", text: stuckWorkStatusMessage("waiting_input") }],
      }),
    });
  });
});
