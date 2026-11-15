import type { PrismaClient } from "@rakazo/db";
import { RunHistoryWriteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { handoffToGroupBot, loadBotGroupDirectory } from "./group-handoff.js";

const run = {
  id: "run-a",
  spaceId: "workspace-1",
  threadId: "thread-1",
  botId: "bot-a",
  userId: "user-1",
};

function harness(
  sourceBlocks: unknown,
  existing?: { id?: string; sourceRuns: { id: string; botId: string }[] },
) {
  const runCreate = vi.fn(async () => ({ id: "run-b" }));
  const messageCreate = vi.fn(async (_args: unknown) => ({ id: "message-1" }));
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (..._args: unknown[]) => [{ id: "group-1" }]),
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group-1",
        name: "Project",
        thread: { id: run.threadId },
        members: ["bot-a", "bot-b", "bot-c"].map((id) => ({
          bot: { id, name: id.toUpperCase() },
        })),
      })),
      update: vi.fn(async () => ({ id: "group-1" })),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        trigger: "user",
        thread: { groupId: "group-1" as string | null },
        sourceMessage: { blocks: sourceBlocks, role: "user" },
      })),
      findUnique: vi.fn(async () => ({ status: "running" })),
      create: runCreate,
    },
    message: {
      findUnique: vi.fn(async (_args: unknown) => existing ?? null),
      create: messageCreate,
    },
    thread: {
      update: vi.fn(async (args: { select: { nextMessageSeq?: boolean } }) =>
        args.select.nextMessageSeq ? { nextMessageSeq: 2 } : { nextEventSeq: 2 },
      ),
    },
    task: { create: vi.fn(async (_args: unknown) => ({ id: "task-b" })) },
    event: {
      findFirst: vi.fn(async () => ({ seq: 1 })),
      create: vi.fn(async () => ({ seq: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return {
    deps: {
      prisma,
      events: { notify: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined) },
    },
    messageCreate,
    runCreate,
    tx,
  };
}

describe("group handoff ownership", () => {
  it("marks a new ownership transfer as a follow-up with a chain hop", async () => {
    const { deps, messageCreate, runCreate } = harness([{ kind: "text", text: "user request" }]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Do the distinct next stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [
            expect.objectContaining({
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              hop: 1,
            }),
          ],
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ trigger: "follow_up" }) }),
    );
    expect(deps.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 20_000,
    });
  });

  it("carries files on the handoff the next bot starts from", async () => {
    const { deps, messageCreate } = harness([{ kind: "text", text: "user request" }]);
    const file = {
      kind: "file" as const,
      artifactId: "artifact-zip",
      name: "project.zip",
      mimeType: "application/zip",
      size: 19_000,
    };

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Deploy this",
        files: [file],
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b" });

    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blocks: [expect.objectContaining({ kind: "handoff" }), file],
        }),
      }),
    );
  });

  it("does not hand off from an attempt a newer claim superseded", async () => {
    const { deps, runCreate, tx } = harness([{ kind: "text", text: "user request" }]);
    tx.run.findUnique.mockResolvedValue({
      status: "running",
      leaseOwner: "worker-2",
      leaseFence: 2,
    } as never);

    await expect(
      handoffToGroupBot(
        { ...deps, runLease: { runId: run.id, owner: "worker-1", fence: 1 } } as never,
        run,
        "group-1",
        { bot_id: "bot-b", message: "Do the distinct next stage" },
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(runCreate).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to bounce a handed-off stage straight back to its sender", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Investigate", hop: 1 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "You investigate it",
      }),
    ).resolves.toEqual({
      error:
        "do not hand this stage back to its sender; post the result in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("caps longer multi-agent handoff chains", async () => {
    const { deps, runCreate } = harness([
      { kind: "handoff", fromBotId: "bot-b", toBotId: "bot-a", text: "Stage six", hop: 6 },
    ]);

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "Stage seven",
      }),
    ).resolves.toEqual({
      error:
        "group handoff limit reached for this chain; finish the current stage in the shared thread instead",
    });
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("reuses the recorded transfer when a source run is retried", async () => {
    const { deps, messageCreate, runCreate } = harness([], {
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-c",
        message: "A duplicate stage",
      }),
    ).resolves.toMatchObject({ ok: true, botId: "bot-b", runId: "run-b" });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed source ancestry instead of restarting its hop count", async () => {
    const { deps, runCreate } = harness({ kind: "not-an-array" });

    await expect(
      handoffToGroupBot(deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toEqual({ error: "cannot verify the group handoff chain" });
    expect(runCreate).not.toHaveBeenCalled();
  });
});

describe("explicit group destinations", () => {
  function privateTurn() {
    const h = harness([{ kind: "text", text: "Private request" }]);
    h.tx.chatGroup.findFirst.mockResolvedValue({
      id: "group-1",
      name: "Project",
      thread: { id: "group-thread" },
      members: ["bot-a", "bot-b"].map((id) => ({ bot: { id, name: id } })),
    });
    h.tx.run.findFirst.mockResolvedValue({
      id: run.id,
      trigger: "user",
      thread: { groupId: null },
      sourceMessage: { blocks: [{ kind: "text", text: "Private request" }], role: "user" },
    });
    return h;
  }

  it("posts only the supplied task in the selected group and queues its next stage there", async () => {
    const h = privateTurn();
    const result = await handoffToGroupBot(h.deps as never, run, "group-1", {
      bot_id: "bot-b",
      message: "  Review the public plan  ",
    });
    expect(result).toMatchObject({ ok: true, groupId: "group-1" });
    expect(h.messageCreate).toHaveBeenCalledTimes(1);
    expect(h.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          runId: undefined,
          blocks: [
            {
              kind: "handoff",
              fromBotId: "bot-a",
              toBotId: "bot-b",
              text: "Review the public plan",
              hop: 1,
            },
          ],
        }),
      }),
    );
    expect(h.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          botId: "bot-b",
          trigger: "follow_up",
          sourceMessageId: "message-1",
        }),
      }),
    );
    expect(h.tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          prompt: "Review the public plan",
        }),
      }),
    );
    expect(h.tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: "group-thread",
          runId: undefined,
          type: "group.handoff",
        }),
      }),
    );
    expect(h.deps.events.notify).toHaveBeenCalledWith("group-thread", 1);
    expect(h.deps.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("cannot redirect an existing group's stage to another group", async () => {
    const h = privateTurn();
    h.tx.run.findFirst.mockResolvedValue({
      id: run.id,
      trigger: "user",
      thread: { groupId: "other-group" },
      sourceMessage: { blocks: [], role: "user" },
    });
    await expect(
      handoffToGroupBot(h.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toMatchObject({ error: "group handoffs must stay in the current group" });
    expect(h.messageCreate).not.toHaveBeenCalled();
  });

  it.each(["bot_message", "routine", "webhook", "follow_up"])(
    "lets a bot coordinate in its group from a %s run",
    async (trigger) => {
      const h = privateTurn();
      h.tx.run.findFirst.mockResolvedValue({
        id: run.id,
        trigger,
        thread: { groupId: null },
        sourceMessage: { blocks: [], role: "bot" },
      });
      await expect(
        handoffToGroupBot(h.deps as never, run, "group-1", {
          bot_id: "bot-b",
          message: "Continue",
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(h.runCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ threadId: "group-thread", trigger: "follow_up" }),
        }),
      );
    },
  );

  it("keeps the chain limit when a direct conversation continues in a group", async () => {
    const h = privateTurn();
    h.tx.run.findFirst.mockResolvedValue({
      id: run.id,
      trigger: "bot_message",
      thread: { groupId: null },
      sourceMessage: {
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-c",
            fromBotName: "Planner",
            text: "Continue",
            hop: 6,
          },
        ],
      },
    });
    await expect(
      handoffToGroupBot(h.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toHaveProperty("error");
    expect(h.runCreate).not.toHaveBeenCalled();
  });

  it("delivers distinct calls to the same group and replays only the matching call", async () => {
    const h = privateTurn();
    h.runCreate.mockResolvedValueOnce({ id: "run-b" }).mockResolvedValueOnce({ id: "run-c" });
    const nonceOf = (args: unknown) => (args as { data: { clientNonce: string } }).data.clientNonce;
    h.tx.message.findUnique.mockImplementation(async (args: unknown) => {
      const nonce = (args as { where: { threadId_clientNonce: { clientNonce: string } } }).where
        .threadId_clientNonce.clientNonce;
      const index = h.messageCreate.mock.calls.findIndex(([call]) => nonceOf(call) === nonce);
      return index < 0
        ? null
        : {
            id: "message-1",
            sourceRuns: [{ id: index === 0 ? "run-b" : "run-c", botId: "bot-b" }],
          };
    });
    const send = (message: string, deliveryKey: string) =>
      handoffToGroupBot(h.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message,
        deliveryKey,
      });
    await expect(send("Review the plan", "effect-1")).resolves.toMatchObject({
      ok: true,
      runId: "run-b",
    });
    await expect(send("Check the sources", "effect-2")).resolves.toMatchObject({
      ok: true,
      runId: "run-c",
    });
    await expect(send("Review the plan", "effect-1")).resolves.toMatchObject({
      ok: true,
      runId: "run-b",
    });
    expect(h.runCreate).toHaveBeenCalledTimes(2);
    expect(h.messageCreate).toHaveBeenCalledTimes(2);
    expect(h.messageCreate.mock.calls.map(([args]) => nonceOf(args))).toEqual([
      "group-handoff:effect-1",
      "group-handoff:effect-2",
    ]);
    expect(
      h.tx.task.create.mock.calls.map(
        ([args]) => (args as { data: { prompt: string } }).data.prompt,
      ),
    ).toEqual(["Review the plan", "Check the sources"]);
  });

  it("does not start group work after the source run stops", async () => {
    const h = privateTurn();
    h.tx.run.findFirst.mockResolvedValue(null as never);
    await expect(
      handoffToGroupBot(h.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toMatchObject({ error: "source run is no longer active" });
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.runCreate).not.toHaveBeenCalled();
  });

  it("replays an explicit destination without creating another message or run", async () => {
    const h = privateTurn();
    h.tx.message.findUnique.mockResolvedValue({
      id: "message-1",
      sourceRuns: [{ id: "run-b", botId: "bot-b" }],
    });
    await expect(
      handoffToGroupBot(h.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toMatchObject({ ok: true, runId: "run-b" });
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.runCreate).not.toHaveBeenCalled();
    expect(h.deps.events.notify).toHaveBeenCalledWith("group-thread", 1);
  });

  it("rejects unavailable or cross-space groups", async () => {
    const h = privateTurn();
    h.tx.$queryRaw.mockResolvedValue([]);
    await expect(
      handoffToGroupBot(h.deps as never, run, "group-1", {
        bot_id: "bot-b",
        message: "Continue",
      }),
    ).resolves.toMatchObject({ error: "group is no longer available" });
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual(["group-1", run.spaceId]);
  });

  it("requires both bots to be active members of the destination", async () => {
    for (const memberIds of [["bot-b"], ["bot-a"]]) {
      const h = privateTurn();
      h.tx.chatGroup.findFirst.mockResolvedValue({
        id: "group-1",
        name: "Project",
        thread: { id: "group-thread" },
        members: memberIds.map((id) => ({ bot: { id, name: id } })),
      });
      await expect(
        handoffToGroupBot(h.deps as never, run, "group-1", {
          bot_id: "bot-b",
          message: "Continue",
        }),
      ).resolves.toHaveProperty("error");
      expect(h.runCreate).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "empty", message: "" },
    { label: "blank", message: " " },
    { label: "oversized", message: "x".repeat(8001) },
  ])("rejects $label tasks", async ({ message }) => {
    const h = privateTurn();
    await expect(
      handoffToGroupBot(h.deps as never, run, "group-1", { bot_id: "bot-b", message }),
    ).resolves.toHaveProperty("error");
    expect(h.runCreate).not.toHaveBeenCalled();
  });
});

it("discovers only active groups the bot belongs to in its space, whoever created them", async () => {
  const findMany = vi.fn(async () => []);
  await expect(
    loadBotGroupDirectory({ chatGroup: { findMany } } as unknown as PrismaClient, run),
  ).resolves.toBeUndefined();
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        spaceId: run.spaceId,
        archivedAt: null,
        members: { some: { botId: run.botId, bot: { archivedAt: null } } },
        thread: { isNot: null },
      },
    }),
  );
});
