import type * as Db from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

const appendEventInTransaction = vi.hoisted(() => vi.fn(async () => ({ seq: 9 })));
const createPendingSteeringRun = vi.hoisted(() => vi.fn(async () => "run-2"));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  appendEventInTransaction,
  createPendingSteeringRun,
}));

describe("a run whose sender has left the space", () => {
  it("is cancelled without starting, so it cannot use their accounts", async () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      spaceId: "space-1",
      userId: "former-member",
      status: "queued",
      trigger: "user",
      leaseFence: 0,
    };
    const tx = {
      run: {
        findUnique: vi.fn(async () => run),
        findMany: vi.fn(async () => [run]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        updateManyAndReturn: vi.fn(async () => [{ id: run.id }]),
      },
      message: { findMany: vi.fn(async () => []) },
      secret: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      externalEffect: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
      task: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      run: {
        findUnique: vi.fn(async () => run),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      spaceMember: { findUnique: vi.fn(async () => null) },
      user: { findUnique: vi.fn(async () => null) },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    };
    const runtimeRun = vi.fn();
    const notify = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const executor = createRunExecutor({
      prisma,
      runtime: { describe: () => ({ capabilities: { scripted: false } }), run: runtimeRun },
      events: { notify },
      jobs: { enqueue },
      secrets: [],
    } as unknown as Parameters<typeof createRunExecutor>[0]);

    await executor.continueRun(run.id, "worker-1");

    expect(prisma.spaceMember.findUnique).toHaveBeenCalledWith({
      where: { spaceId_userId: { spaceId: "space-1", userId: "former-member" } },
      select: { id: true },
    });
    // Never claimed, never ran.
    expect(prisma.run.updateMany).not.toHaveBeenCalled();
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(tx.run.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["run-1"] } }),
        data: expect.objectContaining({ status: "cancelled", leaseOwner: null }),
      }),
    );
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["task-1"] } },
      data: { status: "cancelled" },
    });
    expect(appendEventInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ runId: "run-1", type: "run.cancelled" }),
    );
    expect(notify).toHaveBeenCalledWith("thread-1", 9);
    // Another member's message waiting behind it starts their own run.
    expect(createPendingSteeringRun).toHaveBeenCalledWith(tx, expect.objectContaining(run));
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: { runId: "run-2" } }));
  });
});
